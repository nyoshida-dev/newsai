/**
 * newsai-dispatcher — fires the AI News workflow via workflow_dispatch.
 *
 * GitHub's own `schedule` (cron) trigger is unreliable on forked repositories
 * (delayed or silently dropped), so delivery does not depend on it. This Worker
 * runs on a Cloudflare Cron Trigger — which fires on time — and calls the GitHub
 * REST API to dispatch the workflow, which works reliably on forks.
 */

export interface Env {
  /** Fine-grained PAT with Actions: write on REPO_OWNER/REPO_NAME. Secret. */
  GITHUB_TOKEN: string
  REPO_OWNER: string
  REPO_NAME: string
  WORKFLOW_FILE: string
  /** Git ref to dispatch against. */
  REF: string
  /** Optional shared key that guards the manual /trigger HTTP endpoint. */
  TRIGGER_KEY?: string
}

async function dispatchWorkflow(env: Env, dryRun = false): Promise<void> {
  const url = `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/actions/workflows/${env.WORKFLOW_FILE}/dispatches`
  // dry_run is a boolean workflow input; the dispatch API takes input values as
  // strings. Omit inputs entirely for the real path so the workflow default
  // (dry_run=false → posts to Slack) applies.
  const payload: { ref: string; inputs?: Record<string, string> } = {
    ref: env.REF || 'main',
  }
  if (dryRun) payload.inputs = { dry_run: 'true' }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'newsai-dispatcher',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  // A successful dispatch returns 204 No Content.
  if (res.status !== 204) {
    const body = await res.text()
    throw new Error(`workflow_dispatch failed: ${res.status} ${body}`)
  }
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(dispatchWorkflow(env))
  },

  // Manual trigger for verification: POST /trigger?key=<TRIGGER_KEY>.
  // Disabled unless TRIGGER_KEY is configured.
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (req.method === 'POST' && url.pathname === '/trigger') {
      if (!env.TRIGGER_KEY || url.searchParams.get('key') !== env.TRIGGER_KEY) {
        return new Response('unauthorized', { status: 401 })
      }
      const dryRun = url.searchParams.get('dry_run') === 'true'
      try {
        await dispatchWorkflow(env, dryRun)
        return new Response(`dispatched${dryRun ? ' (dry-run)' : ''}\n`, { status: 200 })
      } catch (e) {
        return new Response(`${e instanceof Error ? e.message : e}\n`, { status: 502 })
      }
    }
    return new Response('newsai-dispatcher: POST /trigger?key=… to dispatch\n', {
      status: 200,
    })
  },
}
