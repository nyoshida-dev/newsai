import { describe, expect, it } from 'vitest'
import {
  applyForm,
  formValuesFromConfig,
  parseConfig,
  serializeConfig,
} from './config'
import { unseal } from './session'

const FIXTURE_A = `
[llm]
provider = "api"
model = "gpt-5.5"
base_url = ""
api_key_env = "OPENAI_API_KEY"
max_completion_tokens = 15000
timeout_seconds = 600
extra_cli_args = []

[prompt]
system = "あなたは社内コミュニケーションの専門家です。"
instruction = """
#指示
以下のSlackメッセージから重要な情報を抽出してください。

出力結果には【注目ニュース】と【番外編】の2つのセクションを作成してください 📰
絵文字も使います 🎉
チャンネル名は #channel の形式で書いてください。
"""

[collect]
source = "web"
days = 7
channel_filter = ""
exclude_channels = ["random", "bot"]
auto_join = true

[collect.web]
mode = "llm_search"
queries = ["AI 最新ニュース", "LLM リリース"]
feeds = ["https://hnrss.org/newest?q=AI"]
max_items_per_feed = 20

[post]
channel = "general"
header = "今週のニュース"
`

const FIXTURE_B = `
[llm]
provider = "api"
model = "gpt-5.5"
future_flag = true

[prompt]
system = "sys"
instruction = "one line"

[collect]
source = "slack"
days = 3
channel_filter = ""
exclude_channels = []

[collect.web]
mode = "feeds"
queries = []
feeds = []
max_items_per_feed = 15

[post]
channel = ""
header = ""

[custom]
keep_me = "yes"
nested_flag = false
`

const FIXTURE_C_OBJ = {
  prompt: {
    instruction: 'He said """hello""" and then path\ntriple: """',
  },
  other: {
    note: 'simple "quoted" string',
    path: 'C:\\path\\to',
  },
}

describe('serializeConfig round-trip', () => {
  it('round-trips fixtures A, B, C via parse(serialize(parse))', () => {
    for (const fixture of [FIXTURE_A, FIXTURE_B]) {
      const parsed = parseConfig(fixture)
      expect(parseConfig(serializeConfig(parsed))).toEqual(parsed)
    }
    const out = serializeConfig(FIXTURE_C_OBJ)
    expect(parseConfig(out)).toEqual(FIXTURE_C_OBJ)
  })

  it('preserves [collect.web] subtable through custom serializer', () => {
    const parsed = parseConfig(FIXTURE_A)
    const out = serializeConfig(parsed)
    expect(out).toContain('[collect.web]')
    expect(out).toContain('max_items_per_feed = 20')
    const round = parseConfig(out)
    expect(round.collect.web).toEqual({
      mode: 'llm_search',
      queries: ['AI 最新ニュース', 'LLM リリース'],
      feeds: ['https://hnrss.org/newest?q=AI'],
      max_items_per_feed: 20,
    })
    expect(round.collect.source).toBe('web')
  })

  it('emits multi-line """ blocks and raw Japanese (no unicode escapes)', () => {
    const out = serializeConfig(parseConfig(FIXTURE_A))
    expect(out).toContain('"""')
    expect(out).toContain('注目ニュース')
    expect(out).not.toMatch(/\\u6ce8/)
  })
})

describe('applyForm', () => {
  it('overwrites form paths, preserves unknowns, normalizes CRLF, clamps days', () => {
    const cfg = parseConfig(FIXTURE_B)
    const next = applyForm(cfg, {
      provider: 'codex',
      model: 'o3',
      days: '200',
      source: 'web',
      channel_filter: 'eng',
      exclude_channels: 'a, b,,c ',
      web_mode: 'hybrid',
      web_queries: 'AI 最新\n\n LLM リリース \n',
      web_feeds: 'https://a.example/feed\nhttp://b.example/rss\n',
      system: 'sys\r\nline',
      instruction: 'inst\r\nline2',
      channel: '#news',
      header: 'H',
    })

    expect(next.llm).toMatchObject({
      provider: 'codex',
      model: 'o3',
      future_flag: true,
    })
    expect(next.collect).toMatchObject({
      source: 'web',
      days: 90,
      channel_filter: 'eng',
      exclude_channels: ['a', 'b', 'c'],
    })
    expect(next.collect.web).toEqual({
      mode: 'hybrid',
      queries: ['AI 最新', 'LLM リリース'],
      feeds: ['https://a.example/feed', 'http://b.example/rss'],
      max_items_per_feed: 15,
    })
    expect(next.prompt.system).toBe('sys\nline')
    expect(next.prompt.instruction).toBe('inst\nline2')
    expect(next.post).toMatchObject({ channel: '#news', header: 'H' })
    expect(next.custom).toEqual({ keep_me: 'yes', nested_flag: false })
    expect(cfg.llm.provider).toBe('api')
    expect(cfg.collect.days).toBe(3)
    expect(cfg.collect.web.max_items_per_feed).toBe(15)
  })

  it('formValuesFromConfig joins web arrays with newlines', () => {
    const v = formValuesFromConfig(parseConfig(FIXTURE_A))
    expect(v.source).toBe('web')
    expect(v.web_mode).toBe('llm_search')
    expect(v.web_queries).toBe('AI 最新ニュース\nLLM リリース')
    expect(v.web_feeds).toBe('https://hnrss.org/newest?q=AI')
  })
})

describe('unseal', () => {
  it('returns null on garbage', async () => {
    expect(await unseal('secret', 'not-valid-base64!!!')).toBeNull()
    expect(await unseal('secret', 'YWJjZGVmZ2hpamts')).toBeNull()
  })
})
