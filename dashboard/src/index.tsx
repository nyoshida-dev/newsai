import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import {
  callbackHandler,
  isConflict,
  isUnauthorized,
  loginHandler,
  logoutHandler,
} from './auth'
import {
  applyForm,
  formValuesFromConfig,
  parseConfig,
  serializeConfig,
  validateSchedule,
  validateWebFeeds,
} from './config'
import type { Env } from './env'
import {
  dispatchWorkflow,
  getConfigFile,
  getRepo,
  GitHubError,
  listWorkflowRuns,
  putConfigFile,
} from './github'
import { computeCron } from './schedule'
import {
  clearSessionCookie,
  getSessionCookie,
  unseal,
} from './session'
import {
  ConflictPage,
  Dashboard,
  ErrorPage,
  LoginPage,
  SetupErrorPage,
} from './views'

export type { Env }

type AppContext = Context<Env>

const app = new Hono<Env>()

const FORM_KEYS = [
  'provider',
  'model',
  'frequency',
  'weekday',
  'hour',
  'days',
  'source',
  'channel_filter',
  'exclude_channels',
  'web_mode',
  'web_queries',
  'web_feeds',
  'system',
  'instruction',
  'channel',
  'header',
] as const

function formRecord(form: FormData): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of FORM_KEYS) {
    const v = form.get(key)
    out[key] = typeof v === 'string' ? v : ''
  }
  return out
}

/** Origin check on all POSTs. */
app.post('*', async (c, next) => {
  const origin = c.req.header('Origin')
  const host = new URL(c.req.url).host
  if (origin) {
    try {
      if (new URL(origin).host !== host) {
        return c.html(<ErrorPage message="不正な Origin です。" />, 403)
      }
    } catch {
      return c.html(<ErrorPage message="不正な Origin です。" />, 403)
    }
  } else {
    const site = c.req.header('Sec-Fetch-Site')
    if (site && site !== 'same-origin') {
      return c.html(<ErrorPage message="不正なリクエスト元です。" />, 403)
    }
  }
  await next()
})

async function requireSession(c: AppContext, next: Next) {
  const raw = getSessionCookie(c)
  if (!raw) {
    return c.html(<LoginPage />)
  }
  const session = await unseal(c.env.SESSION_SECRET, raw)
  if (!session) {
    clearSessionCookie(c)
    return c.html(<LoginPage error="セッションの有効期限が切れました。" />)
  }
  c.set('session', session)
  await next()
}

function onUnauthorized(c: AppContext): Response | Promise<Response> {
  clearSessionCookie(c)
  return c.html(
    <LoginPage error="GitHub 認証が無効です。再ログインしてください。" />,
  )
}

app.get('/login', (c) => loginHandler(c))

app.get('/auth/callback', (c) => callbackHandler(c))

app.post('/logout', requireSession, (c) => logoutHandler(c))

app.get('/', requireSession, async (c) => {
  const session = c.get('session')
  const { REPO_OWNER: owner, REPO_NAME: repo, WORKFLOW_FILE, CONFIG_PATH } =
    c.env

  try {
    let configFile
    try {
      configFile = await getConfigFile(session.t, owner, repo, CONFIG_PATH)
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) {
        return c.html(<SetupErrorPage user={session.u} path={CONFIG_PATH} />)
      }
      throw e
    }

    const runs = await listWorkflowRuns(session.t, owner, repo, WORKFLOW_FILE)
    const values = formValuesFromConfig(parseConfig(configFile.content))

    const q = new URL(c.req.url).searchParams
    let flash: string | undefined
    if (q.get('saved') === '1') flash = '設定を保存しました。'
    if (q.get('dispatched') === '1') flash = 'ワークフローを起動しました。'

    return c.html(
      <Dashboard
        user={session.u}
        values={values}
        sha={configFile.sha}
        runs={runs}
        flash={flash}
      />,
    )
  } catch (e) {
    if (isUnauthorized(e)) return onUnauthorized(c)
    const msg = e instanceof Error ? e.message : 'エラーが発生しました'
    return c.html(<ErrorPage message={msg} user={session.u} />, 500)
  }
})

app.post('/settings', requireSession, async (c) => {
  const session = c.get('session')
  const {
    REPO_OWNER: owner,
    REPO_NAME: repo,
    CONFIG_PATH,
    WORKFLOW_FILE,
  } = c.env
  const form = await c.req.formData()
  const submittedSha = String(form.get('sha') ?? '')
  const fields = formRecord(form)

  const feedErr = validateWebFeeds(fields.web_feeds)
  if (feedErr) {
    return c.html(<ErrorPage message={feedErr} user={session.u} />, 400)
  }

  const scheduleErr = validateSchedule(fields)
  if (scheduleErr) {
    return c.html(<ErrorPage message={scheduleErr} user={session.u} />, 400)
  }

  try {
    const current = await getConfigFile(session.t, owner, repo, CONFIG_PATH)
    if (current.sha !== submittedSha) {
      const values = formValuesFromConfig(parseConfig(current.content))
      return c.html(
        <ConflictPage user={session.u} values={values} sha={current.sha} />,
        409,
      )
    }

    const config = applyForm(parseConfig(current.content), fields)
    const serialized = serializeConfig(config)
    const repoInfo = await getRepo(session.t, owner, repo)

    try {
      await putConfigFile(session.t, owner, repo, CONFIG_PATH, {
        message: `chore: update config.toml via dashboard (by ${session.u})`,
        content: serialized,
        sha: current.sha,
        branch: repoInfo.default_branch,
      })
    } catch (e) {
      if (isConflict(e)) {
        const fresh = await getConfigFile(session.t, owner, repo, CONFIG_PATH)
        const values = formValuesFromConfig(parseConfig(fresh.content))
        return c.html(
          <ConflictPage user={session.u} values={values} sha={fresh.sha} />,
          409,
        )
      }
      throw e
    }

    const frequency = (fields.frequency === 'daily' ? 'daily' : 'weekly') as
      | 'daily'
      | 'weekly'
    const timezone =
      typeof config.schedule?.timezone === 'string' &&
      config.schedule.timezone.length > 0
        ? config.schedule.timezone
        : 'Asia/Tokyo'
    const cron = computeCron(
      frequency,
      fields.weekday,
      Number.parseInt(fields.hour, 10),
      timezone,
    )

    const workflowPath = `.github/workflows/${WORKFLOW_FILE}`
    const workflowFile = await getConfigFile(
      session.t,
      owner,
      repo,
      workflowPath,
    )

    const cronRe = /^(\s*-\s*cron:\s*)"[^"]*"/m
    if (!cronRe.test(workflowFile.content)) {
      return c.html(
        <ErrorPage
          message="workflow の cron 行が見つかりませんでした（設定 config.toml 自体は保存済みです）"
          user={session.u}
        />,
        500,
      )
    }
    const updatedWorkflow = workflowFile.content.replace(
      cronRe,
      `$1"${cron}"`,
    )
    if (updatedWorkflow !== workflowFile.content) {
      try {
        await putConfigFile(session.t, owner, repo, workflowPath, {
          message: `chore: update schedule cron via dashboard (by ${session.u})`,
          content: updatedWorkflow,
          sha: workflowFile.sha,
          branch: repoInfo.default_branch,
        })
      } catch (e) {
        if (
          e instanceof GitHubError &&
          (e.status === 403 || e.status === 404)
        ) {
          return c.html(
            <ErrorPage
              message="workflow スコープがありません。一度ログアウトして再ログインしてください（設定 config.toml 自体は保存済みです）"
              user={session.u}
              logout
            />,
            403,
          )
        }
        throw e
      }
    }

    return c.redirect('/?saved=1', 303)
  } catch (e) {
    if (isUnauthorized(e)) return onUnauthorized(c)
    const msg = e instanceof Error ? e.message : '保存に失敗しました'
    return c.html(<ErrorPage message={msg} user={session.u} />, 500)
  }
})

app.post('/run', requireSession, async (c) => {
  const session = c.get('session')
  const { REPO_OWNER: owner, REPO_NAME: repo, WORKFLOW_FILE } = c.env

  try {
    const repoInfo = await getRepo(session.t, owner, repo)
    await dispatchWorkflow(
      session.t,
      owner,
      repo,
      WORKFLOW_FILE,
      repoInfo.default_branch,
    )
    return c.redirect('/?dispatched=1', 303)
  } catch (e) {
    if (isUnauthorized(e)) return onUnauthorized(c)
    const msg = e instanceof Error ? e.message : '実行に失敗しました'
    return c.html(<ErrorPage message={msg} user={session.u} />, 500)
  }
})

app.onError((err, c) => {
  console.error(err.message)
  return c.html(<ErrorPage message="エラーが発生しました。" />, 500)
})

export default app
