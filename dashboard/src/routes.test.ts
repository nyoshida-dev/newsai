import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { seal } from './session'

const SESSION_SECRET = 'testsecret'
const ENV = {
  REPO_OWNER: 'o',
  REPO_NAME: 'r',
  WORKFLOW_FILE: 'weekly-news.yml',
  CONFIG_PATH: 'config.toml',
  SESSION_SECRET,
  GITHUB_CLIENT_ID: 'x',
  GITHUB_CLIENT_SECRET: 'y',
}

const ORIGIN = 'http://localhost'
const SHA_V1 = 'sha-v1-aaaaaaaa'
const SHA_V2 = 'sha-v2-bbbbbbbb'
const SHA_FRESH = 'sha-fresh-cccccc'

const PROMPT_JP = `#指示
以下のWeb/Xニュースから重要な情報を抽出してください。
【注目ニュース】を作成します 📰`

const PROMPT_JP_NEW = `#指示
保存後の新しいプロンプトです。
【番外編】も出力してください 🎉`

function tomlWithPrompt(instruction: string, provider = 'codex'): string {
  return `# newsai config

[llm]
provider = "${provider}"
model = ""

[prompt]
system = "あなたはAIニュースの専門家です。"
instruction = """
${instruction}
"""

[collect]
source = "web"
days = 7
channel_filter = ""
exclude_channels = []

[collect.web]
mode = "llm_search"
queries = ["AI 最新ニュース"]
feeds = []
max_items_per_feed = 20

[post]
channel = "general"
header = "📰 今週のAIニュース"
`
}

function toGitHubB64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin)
}

function fromGitHubB64(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

type FetchCall = { url: string; method: string; body?: string }

function stubGitHub(opts: {
  content: string
  sha: string
  onPut?: (toml: string) => void
}): { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  let content = opts.content
  let sha = opts.sha

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? init.body : undefined
      calls.push({ url, method, body })

      if (url.includes('/contents/config.toml') && method === 'GET') {
        return new Response(
          JSON.stringify({
            content: toGitHubB64(content),
            encoding: 'base64',
            sha,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (url.includes('/contents/config.toml') && method === 'PUT') {
        const parsed = JSON.parse(body!) as { content: string; sha: string }
        const toml = fromGitHubB64(parsed.content)
        opts.onPut?.(toml)
        content = toml
        sha = SHA_V2
        return new Response(JSON.stringify({ content: { sha } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (url.match(/\/repos\/o\/r$/) && method === 'GET') {
        return new Response(
          JSON.stringify({
            default_branch: 'main',
            permissions: { push: true },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (url.includes('/actions/workflows/') && url.includes('/runs')) {
        return new Response(JSON.stringify({ workflow_runs: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return new Response(`unexpected fetch: ${method} ${url}`, { status: 500 })
    }),
  )

  return { calls }
}

async function sessionCookie(): Promise<string> {
  const sealed = await seal(SESSION_SECRET, {
    t: 'gh-token',
    u: 'tester',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })
  return `__Host-session=${sealed}`
}

function formBody(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields)
}

describe('routes', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('GET / with session renders Japanese prompt, sha, and selected provider', async () => {
    stubGitHub({ content: tomlWithPrompt(PROMPT_JP, 'codex'), sha: SHA_V1 })
    const cookie = await sessionCookie()

    const res = await app.request(
      `${ORIGIN}/`,
      { headers: { Cookie: cookie } },
      ENV,
    )
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<textarea id="instruction"')
    expect(html).toContain('【注目ニュース】を作成します')
    expect(html).toContain(`name="sha" value="${SHA_V1}"`)
    expect(html).toMatch(/<option value="codex" selected="">/)
  })

  it('POST /settings commits Japanese text and redirects; GET shows updated form', async () => {
    let putToml = ''
    const gh = stubGitHub({
      content: tomlWithPrompt(PROMPT_JP, 'codex'),
      sha: SHA_V1,
      onPut: (toml) => {
        putToml = toml
      },
    })
    const cookie = await sessionCookie()

    const post = await app.request(
      `${ORIGIN}/settings`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: ORIGIN,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formBody({
          sha: SHA_V1,
          provider: 'codex',
          model: '',
          days: '7',
          source: 'web',
          channel_filter: '',
          exclude_channels: '',
          web_mode: 'llm_search',
          web_queries: 'AI 最新ニュース',
          web_feeds: '',
          system: 'あなたはAIニュースの専門家です。',
          instruction: PROMPT_JP_NEW,
          channel: 'general',
          header: '📰 今週のAIニュース',
        }),
      },
      ENV,
    )

    expect(post.status).toBe(303)
    expect(post.headers.get('Location')).toBe('/?saved=1')
    expect(putToml).toContain('保存後の新しいプロンプトです')
    expect(putToml).toContain('【番外編】も出力してください')
    const putCall = gh.calls.find(
      (c) => c.method === 'PUT' && c.url.includes('/contents/'),
    )
    expect(putCall).toBeTruthy()

    const get = await app.request(
      `${ORIGIN}/?saved=1`,
      { headers: { Cookie: cookie } },
      ENV,
    )
    expect(get.status).toBe(200)
    const html = await get.text()
    expect(html).toContain('設定を保存しました')
    expect(html).toContain('<textarea id="instruction"')
    expect(html).toContain('保存後の新しいプロンプトです')
    expect(html).toContain('【番外編】も出力してください')
    expect(html).not.toContain('【注目ニュース】を作成します')
  })

  it('POST /settings with stale sha returns 409 with fresh form values', async () => {
    const freshToml = tomlWithPrompt('最新の競合用プロンプトです', 'claude')
    stubGitHub({ content: freshToml, sha: SHA_FRESH })
    const cookie = await sessionCookie()

    const res = await app.request(
      `${ORIGIN}/settings`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: ORIGIN,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formBody({
          sha: 'stale-sha',
          provider: 'api',
          model: '',
          days: '7',
          source: 'web',
          channel_filter: '',
          exclude_channels: '',
          web_mode: 'feeds',
          web_queries: '',
          web_feeds: '',
          system: 'stale',
          instruction: 'stale instruction',
          channel: '',
          header: '',
        }),
      },
      ENV,
    )

    expect(res.status).toBe(409)
    const html = await res.text()
    expect(html).toContain('競合')
    expect(html).toContain('最新の競合用プロンプトです')
    expect(html).toContain(`name="sha" value="${SHA_FRESH}"`)
    expect(html).toMatch(/<option value="claude" selected="">/)
  })

  it('GET / without session shows login and does not call GitHub API', async () => {
    const gh = stubGitHub({ content: tomlWithPrompt(PROMPT_JP), sha: SHA_V1 })

    const res = await app.request(`${ORIGIN}/`, {}, ENV)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('ログイン')
    expect(html).not.toContain('管理ダッシュボード')
    expect(gh.calls).toHaveLength(0)
  })
})
