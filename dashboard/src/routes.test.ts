import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
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
const SHA_WF = 'sha-workflow-dddd'

const WORKFLOW_PATH = '.github/workflows/weekly-news.yml'

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

[llm.opencode]
base_url = ""
npm = "@ai-sdk/openai-compatible"
provider_id = "custom"

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

[schedule]
frequency = "weekly"
weekday = "friday"
hour = 18
timezone = "Asia/Tokyo"
`
}

function workflowYaml(cron = '0 9 * * 5'): string {
  return `name: AI News
on:
  schedule:
    - cron: "${cron}"
  workflow_dispatch:
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`
}

function toGitHubB64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin)
}

function bytesToBase64(bytes: Uint8Array): string {
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
  workflowContent?: string
  workflowSha?: string
  onPut?: (toml: string) => void
  onWorkflowPut?: (yml: string) => void
  workflowPutStatus?: number
  secrets?: { name: string; created_at: string; updated_at: string }[]
  publicKey?: string
  onSecretPut?: (name: string, body: string) => void
}): { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  let content = opts.content
  let sha = opts.sha
  let workflowContent = opts.workflowContent ?? workflowYaml()
  let workflowSha = opts.workflowSha ?? SHA_WF

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

      if (
        url.includes(`/contents/${WORKFLOW_PATH}`) &&
        method === 'GET'
      ) {
        return new Response(
          JSON.stringify({
            content: toGitHubB64(workflowContent),
            encoding: 'base64',
            sha: workflowSha,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (
        url.includes(`/contents/${WORKFLOW_PATH}`) &&
        method === 'PUT'
      ) {
        const status = opts.workflowPutStatus ?? 200
        if (status !== 200) {
          return new Response(
            JSON.stringify({
              message: 'Resource not accessible by integration',
              documentation_url:
                'https://docs.github.com/rest/overview/authenticating-to-the-rest-api#github-app-installation-access-tokens-and-workflow-scope',
            }),
            { status, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const parsed = JSON.parse(body!) as { content: string; sha: string }
        const yml = fromGitHubB64(parsed.content)
        opts.onWorkflowPut?.(yml)
        workflowContent = yml
        workflowSha = 'sha-wf-new'
        return new Response(JSON.stringify({ content: { sha: workflowSha } }), {
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

      if (url.endsWith('/actions/secrets/public-key') && method === 'GET') {
        return new Response(
          JSON.stringify({ key_id: 'key-id-1', key: opts.publicKey ?? '' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (url.includes('/actions/secrets?per_page=100') && method === 'GET') {
        return new Response(JSON.stringify({ secrets: opts.secrets ?? [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const secretMatch = url.match(/\/actions\/secrets\/([^/?]+)$/)
      if (secretMatch && method === 'PUT') {
        opts.onSecretPut?.(decodeURIComponent(secretMatch[1]!), body ?? '')
        return new Response(null, { status: 204 })
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

const BASE_SETTINGS = {
  provider: 'codex',
  model: '',
  opencode_base_url: '',
  days: '7',
  source: 'web',
  channel_filter: '',
  exclude_channels: '',
  web_mode: 'llm_search',
  web_queries: 'AI 最新ニュース',
  web_feeds: '',
  system: 'あなたはAIニュースの専門家です。',
  channel: 'general',
  header: '📰 今週のAIニュース',
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
    expect(html).toContain('id="opencode_base_url"')
    expect(html).toContain('値は書き込み専用です')
    expect(html).toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('POST /settings commits Japanese text and redirects; GET shows updated form', async () => {
    let putToml = ''
    let putWorkflow = ''
    const gh = stubGitHub({
      content: tomlWithPrompt(PROMPT_JP, 'codex'),
      sha: SHA_V1,
      onPut: (toml) => {
        putToml = toml
      },
      onWorkflowPut: (yml) => {
        putWorkflow = yml
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
          ...BASE_SETTINGS,
          sha: SHA_V1,
          opencode_base_url: 'https://opencode.example/v1',
          frequency: 'daily',
          weekday: 'wednesday',
          hour: '9',
          instruction: PROMPT_JP_NEW,
        }),
      },
      ENV,
    )

    expect(post.status).toBe(303)
    expect(post.headers.get('Location')).toBe('/?saved=1')
    expect(putToml).toContain('保存後の新しいプロンプトです')
    expect(putToml).toContain('【番外編】も出力してください')
    expect(putToml).toContain('[schedule]')
    expect(putToml).toContain('frequency = "daily"')
    expect(putToml).toContain('weekday = "wednesday"')
    expect(putToml).toContain('hour = 9')
    expect(putToml).toContain('[llm.opencode]')
    expect(putToml).toContain('base_url = "https://opencode.example/v1"')

    const puts = gh.calls.filter(
      (c) => c.method === 'PUT' && c.url.includes('/contents/'),
    )
    expect(puts).toHaveLength(2)
    expect(puts[1]!.url).toContain(WORKFLOW_PATH)
    expect(putWorkflow).toContain('cron: "0 0 * * *"')
    const wfBody = JSON.parse(puts[1]!.body!) as { content: string; message: string }
    expect(fromGitHubB64(wfBody.content)).toContain('0 0 * * *')
    expect(wfBody.message).toContain('by tester')

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

  it('POST /settings skips workflow PUT when cron is unchanged', async () => {
    const gh = stubGitHub({
      content: tomlWithPrompt(PROMPT_JP, 'codex'),
      sha: SHA_V1,
      workflowContent: workflowYaml('0 9 * * 5'),
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
          ...BASE_SETTINGS,
          sha: SHA_V1,
          frequency: 'weekly',
          weekday: 'friday',
          hour: '18',
          instruction: PROMPT_JP,
        }),
      },
      ENV,
    )

    expect(post.status).toBe(303)
    const puts = gh.calls.filter(
      (c) => c.method === 'PUT' && c.url.includes('/contents/'),
    )
    expect(puts).toHaveLength(1)
    expect(puts[0]!.url).toContain('config.toml')
    expect(
      gh.calls.some(
        (c) => c.method === 'PUT' && c.url.includes(WORKFLOW_PATH),
      ),
    ).toBe(false)
  })

  it('POST /settings with workflow PUT 403 shows re-login error', async () => {
    stubGitHub({
      content: tomlWithPrompt(PROMPT_JP, 'codex'),
      sha: SHA_V1,
      workflowPutStatus: 403,
    })
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
          ...BASE_SETTINGS,
          sha: SHA_V1,
          frequency: 'daily',
          weekday: 'wednesday',
          hour: '9',
          instruction: PROMPT_JP_NEW,
        }),
      },
      ENV,
    )

    expect(res.status).toBe(403)
    const html = await res.text()
    expect(html).toContain('workflow スコープがありません')
    expect(html).toContain('config.toml 自体は保存済み')
    expect(html).toContain('action="/logout"')
    expect(html).toContain('ログアウト')
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
          opencode_base_url: '',
          frequency: 'weekly',
          weekday: 'friday',
          hour: '18',
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

  it('GET / shows registered and unregistered credential badges', async () => {
    stubGitHub({
      content: tomlWithPrompt(PROMPT_JP),
      sha: SHA_V1,
      secrets: [
        {
          name: 'CODEX_AUTH_JSON',
          created_at: '2026-07-01T00:00:00Z',
          updated_at: '2026-07-14T03:04:05Z',
        },
      ],
    })
    const cookie = await sessionCookie()

    const res = await app.request(
      `${ORIGIN}/`,
      { headers: { Cookie: cookie } },
      ENV,
    )
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('登録済み（2026-07-14）')
    expect(html).toContain('未登録')
  })

  it('POST /credentials writes only non-empty fields and never sends plaintext', async () => {
    const recipient = nacl.box.keyPair()
    const writes: { name: string; body: string }[] = []
    const gh = stubGitHub({
      content: tomlWithPrompt(PROMPT_JP),
      sha: SHA_V1,
      publicKey: bytesToBase64(recipient.publicKey),
      onSecretPut: (name, body) => writes.push({ name, body }),
    })
    const cookie = await sessionCookie()

    const res = await app.request(
      `${ORIGIN}/credentials`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: ORIGIN,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formBody({
          claude_token: 'claude-secret-value',
          codex_auth_json: '{"tokens":{"access_token":"codex-secret"}}',
          opencode_api_key: '',
          opencode_auth_json: '',
          openai_api_key: '   ',
        }),
      },
      ENV,
    )

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/?credentials=1')
    expect(
      gh.calls.filter((call) =>
        call.url.endsWith('/actions/secrets/public-key'),
      ),
    ).toHaveLength(1)
    expect(writes.map((write) => write.name).sort()).toEqual([
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CODEX_AUTH_JSON',
    ])
    for (const write of writes) {
      const parsed = JSON.parse(write.body) as {
        encrypted_value: string
        key_id: string
      }
      expect(parsed.key_id).toBe('key-id-1')
      expect(parsed.encrypted_value).not.toContain('secret')
      expect(write.body).not.toContain('claude-secret-value')
      expect(write.body).not.toContain('codex-secret')
    }

    const get = await app.request(
      `${ORIGIN}/?credentials=1`,
      { headers: { Cookie: cookie } },
      ENV,
    )
    expect(get.status).toBe(200)
    expect(await get.text()).toContain(
      '認証情報を登録しました（GitHub Actions Secrets）',
    )
  })

  it('POST /credentials rejects invalid JSON without echoing or calling GitHub', async () => {
    const gh = stubGitHub({ content: tomlWithPrompt(PROMPT_JP), sha: SHA_V1 })
    const cookie = await sessionCookie()
    const submitted = '{"token":"must-not-be-rendered"'

    const res = await app.request(
      `${ORIGIN}/credentials`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: ORIGIN,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formBody({ codex_auth_json: submitted }),
      },
      ENV,
    )

    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('CODEX_AUTH_JSON は有効な JSON')
    expect(html).not.toContain('must-not-be-rendered')
    expect(gh.calls).toHaveLength(0)
  })
})
