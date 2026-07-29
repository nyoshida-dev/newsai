/**
 * newsai-dispatcher — fires the AI News workflow via workflow_dispatch.
 *
 * GitHub's own `schedule` (cron) trigger is unreliable on forked repositories
 * (delayed or silently dropped), so delivery does not depend on it. This Worker
 * runs on a Cloudflare Cron Trigger — which fires on time — and calls the GitHub
 * REST API to dispatch the workflow, which works reliably on forks.
 *
 * The Cron Trigger wakes the Worker every hour; the Worker reads `[schedule]`
 * from config.toml and decides whether this hour is the configured delivery
 * time. That keeps the dashboard authoritative: saving config.toml is enough to
 * change the delivery schedule, with no workflow-file edit or redeploy.
 */

import {
  DEFAULT_SCHEDULE,
  parseSchedule,
  shouldDispatch,
  type Schedule,
} from './schedule'

export interface Env {
  /**
   * Fine-grained PAT on REPO_OWNER/REPO_NAME. Secret.
   * Needs Actions: Read and write (dispatch + run listing) and
   * Contents: Read (reading config.toml).
   */
  GITHUB_TOKEN: string
  REPO_OWNER: string
  REPO_NAME: string
  WORKFLOW_FILE: string
  /** Git ref to dispatch against, and to read config.toml from. */
  REF: string
  /** Path to the config file holding `[schedule]`. */
  CONFIG_PATH: string
  /** Optional shared key that guards the manual /trigger HTTP endpoint. */
  TRIGGER_KEY?: string
}

/**
 * Skip dispatching if a run already started this recently. Guards against a
 * Cron Trigger retry firing twice inside the delivery hour, which the
 * workflow's non-cancelling concurrency group would turn into a double post.
 * Wider than the hourly wake interval so a retry is always caught; narrower
 * than a day so tomorrow's delivery is never suppressed.
 */
const DEDUPE_WINDOW_MS = 90 * 60 * 1000

function githubHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'newsai-dispatcher',
  }
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
    headers: { ...githubHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  // A successful dispatch returns 204 No Content.
  if (res.status !== 204) {
    const body = await res.text()
    throw new Error(`workflow_dispatch failed: ${res.status} ${body}`)
  }
}

/**
 * Fetch config.toml text from REF, trying two independent paths.
 *
 * 1. The authenticated Contents API — the only path that works if the repo is
 *    private, but it needs `Contents: Read` on the PAT.
 * 2. raw.githubusercontent.com, which needs no credentials at all for a public
 *    repo.
 *
 * Having both means a PAT scoped only to Actions still reads the real schedule
 * instead of silently reverting to the default. Raw is CDN-cached for a couple
 * of minutes, which is well inside the hourly tick.
 *
 * Throws with both failure reasons if neither path works.
 */
export async function fetchConfigText(env: Env): Promise<string> {
  const path = env.CONFIG_PATH || 'config.toml'
  const ref = env.REF || 'main'
  const attempts: [string, () => Promise<Response>][] = [
    [
      'contents API',
      () =>
        fetch(
          `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/${path}?ref=${encodeURIComponent(ref)}`,
          {
            headers: {
              ...githubHeaders(env),
              Accept: 'application/vnd.github.raw',
            },
          },
        ),
    ],
    [
      'raw',
      () =>
        fetch(
          `https://raw.githubusercontent.com/${env.REPO_OWNER}/${env.REPO_NAME}/${encodeURIComponent(ref)}/${path}`,
          { headers: { 'User-Agent': 'newsai-dispatcher' } },
        ),
    ],
  ]

  const errors: string[] = []
  for (const [label, send] of attempts) {
    try {
      const res = await send()
      if (res.ok) return await res.text()
      errors.push(`${label}: HTTP ${res.status}`)
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : e}`)
    }
  }
  throw new Error(errors.join('; '))
}

/** Read `[schedule]` from config.toml on REF. Throws on any fetch/parse error. */
async function loadSchedule(env: Env): Promise<Schedule> {
  return parseSchedule(await fetchConfigText(env))
}

/**
 * Has a run of this workflow started within DEDUPE_WINDOW_MS?
 * Fails open (returns false) — a listing error must never block delivery.
 */
async function recentlyDispatched(env: Env, now: Date): Promise<boolean> {
  const url = `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/actions/workflows/${env.WORKFLOW_FILE}/runs?per_page=1`
  try {
    const res = await fetch(url, { headers: githubHeaders(env) })
    if (!res.ok) return false
    const body = (await res.json()) as {
      workflow_runs?: { created_at?: string }[]
    }
    const created = body.workflow_runs?.[0]?.created_at
    if (!created) return false
    const age = now.getTime() - new Date(created).getTime()
    return age >= 0 && age < DEDUPE_WINDOW_MS
  } catch {
    return false
  }
}

/** Hourly tick: dispatch only if `now` is the configured delivery time. */
export async function runScheduled(env: Env, now: Date): Promise<void> {
  let schedule: Schedule
  try {
    schedule = await loadSchedule(env)
  } catch (e) {
    // Fall back rather than fail closed: an unreadable config must not turn
    // into silently missed deliveries.
    console.error(
      `config.toml を読めませんでした — 既定スケジュールで継続: ${
        e instanceof Error ? e.message : e
      }`,
    )
    schedule = DEFAULT_SCHEDULE
  }

  // Log every tick, including the 23 that do nothing: a silent Worker gives no
  // way to tell "read the schedule and it isn't time yet" from "broken".
  const fire = shouldDispatch(schedule, now)
  console.log(
    `スケジュール: ${schedule.frequency} ${schedule.weekday} ${schedule.hour}時 ${schedule.timezone} — ${fire ? '配信します' : '対象時刻ではありません'}`,
  )
  if (!fire) return

  if (await recentlyDispatched(env, now)) {
    console.log('直近に実行済みのためスキップしました（二重発火防止）')
    return
  }

  await dispatchWorkflow(env)
  console.log('workflow_dispatch を実行しました')
}

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env, new Date(event.scheduledTime)))
  },

  // Manual trigger for verification: POST /trigger?key=<TRIGGER_KEY>.
  // Dispatches immediately, bypassing the schedule check.
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
