import { describe, expect, it } from 'vitest'
import { applyForm, parseConfig, serializeConfig } from './config'
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
days = 7
channel_filter = ""
exclude_channels = ["random", "bot"]
auto_join = true

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
days = 3
channel_filter = ""
exclude_channels = []

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

  it('emits multi-line """ blocks and raw Japanese (no unicode escapes)', () => {
    const out = serializeConfig(parseConfig(FIXTURE_A))
    expect(out).toContain('"""')
    expect(out).toContain('注目ニュース')
    expect(out).not.toMatch(/\\u6ce8/)
  })
})

describe('applyForm', () => {
  it('overwrites the 9 paths, preserves unknowns, normalizes CRLF, clamps days', () => {
    const cfg = parseConfig(FIXTURE_B)
    const next = applyForm(cfg, {
      provider: 'codex',
      model: 'o3',
      days: '200',
      channel_filter: 'eng',
      exclude_channels: 'a, b,,c ',
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
      days: 90,
      channel_filter: 'eng',
      exclude_channels: ['a', 'b', 'c'],
    })
    expect(next.prompt.system).toBe('sys\nline')
    expect(next.prompt.instruction).toBe('inst\nline2')
    expect(next.post).toMatchObject({ channel: '#news', header: 'H' })
    expect(next.custom).toEqual({ keep_me: 'yes', nested_flag: false })
    expect(cfg.llm.provider).toBe('api')
    expect(cfg.collect.days).toBe(3)
  })
})

describe('unseal', () => {
  it('returns null on garbage', async () => {
    expect(await unseal('secret', 'not-valid-base64!!!')).toBeNull()
    expect(await unseal('secret', 'YWJjZGVmZ2hpamts')).toBeNull()
  })
})
