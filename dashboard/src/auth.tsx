import type { Context } from 'hono'
import type { Env } from './env'
import {
  exchangeCodeForToken,
  getRepo,
  getUser,
  GitHubError,
} from './github'
import {
  clearSessionCookie,
  clearStateCookie,
  getStateCookie,
  randomHex,
  seal,
  setSessionCookie,
  setStateCookie,
} from './session'
import { ForbiddenPage, LoginPage } from './views'

const SESSION_MAX_AGE = 604800

export async function loginHandler(c: Context<Env>): Promise<Response> {
  const state = randomHex(32)
  setStateCookie(c, state)
  const origin = new URL(c.req.url).origin
  const params = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID,
    redirect_uri: `${origin}/auth/callback`,
    scope: 'repo workflow',
    state,
  })
  return c.redirect(
    `https://github.com/login/oauth/authorize?${params}`,
    302,
  )
}

export async function callbackHandler(c: Context<Env>): Promise<Response> {
  const url = new URL(c.req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const expected = getStateCookie(c)
  clearStateCookie(c)

  if (!code || !state || !expected || state !== expected) {
    return c.html(
      <LoginPage error="OAuth state が一致しません。もう一度ログインしてください。" />,
      403,
    )
  }

  try {
    const token = await exchangeCodeForToken(
      c.env.GITHUB_CLIENT_ID,
      c.env.GITHUB_CLIENT_SECRET,
      code,
      `${url.origin}/auth/callback`,
    )
    const user = await getUser(token)
    const repo = await getRepo(token, c.env.REPO_OWNER, c.env.REPO_NAME)
    if (!repo.permissions?.push) {
      return c.html(<ForbiddenPage login={user.login} />, 403)
    }

    const sealed = await seal(c.env.SESSION_SECRET, {
      t: token,
      u: user.login,
      exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE,
    })
    setSessionCookie(c, sealed)
    return c.redirect('/', 302)
  } catch (e) {
    const message = e instanceof Error ? e.message : '認証に失敗しました'
    return c.html(<LoginPage error={message} />, 400)
  }
}

export function logoutHandler(c: Context<Env>): Response {
  clearSessionCookie(c)
  return c.redirect('/login', 302)
}

export function isUnauthorized(e: unknown): boolean {
  return e instanceof GitHubError && e.status === 401
}

export function isConflict(e: unknown): boolean {
  return e instanceof GitHubError && (e.status === 409 || e.status === 422)
}
