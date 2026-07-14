import { parse as parseToml } from 'smol-toml'

const HEADER =
  '# newsai config — edited via dashboard; comments are not preserved on save.'

export const SCHEDULE_FREQUENCIES = ['weekly', 'daily'] as const
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number]

export const SCHEDULE_WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const
export type ScheduleWeekday = (typeof SCHEDULE_WEEKDAYS)[number]

const DEFAULT_FREQUENCY: ScheduleFrequency = 'weekly'
const DEFAULT_WEEKDAY: ScheduleWeekday = 'friday'
const DEFAULT_HOUR = 18

export function parseConfig(tomlText: string): Record<string, any> {
  return parseToml(tomlText) as Record<string, any>
}

/** Deep-clone cfg and overwrite the dashboard form paths. */
export function applyForm(
  cfg: Record<string, any>,
  form: Record<string, string>,
): Record<string, any> {
  const out = structuredClone(cfg)

  if (!isPlainObject(out.llm)) out.llm = {}
  if (!isPlainObject(out.collect)) out.collect = {}
  if (!isPlainObject(out.prompt)) out.prompt = {}
  if (!isPlainObject(out.post)) out.post = {}
  if (!isPlainObject(out.collect.web)) out.collect.web = {}
  if (!isPlainObject(out.schedule)) out.schedule = {}
  if (!isPlainObject(out.llm.opencode)) out.llm.opencode = {}

  out.llm.provider = form.provider ?? ''
  out.llm.model = form.model ?? ''
  out.llm.opencode.base_url = form.opencode_base_url ?? ''
  if (typeof out.llm.opencode.npm !== 'string') {
    out.llm.opencode.npm = '@ai-sdk/openai-compatible'
  }
  if (typeof out.llm.opencode.provider_id !== 'string') {
    out.llm.opencode.provider_id = 'custom'
  }

  const daysRaw = Number.parseInt(form.days ?? '', 10)
  const days = Number.isFinite(daysRaw) ? daysRaw : 1
  out.collect.days = Math.min(90, Math.max(1, days))
  out.collect.source = form.source ?? ''
  out.collect.channel_filter = form.channel_filter ?? ''
  out.collect.exclude_channels = (form.exclude_channels ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  out.collect.web.mode = form.web_mode ?? ''
  out.collect.web.queries = linesToArray(form.web_queries ?? '')
  out.collect.web.feeds = linesToArray(form.web_feeds ?? '')

  out.prompt.system = normalizeNewlines(form.system ?? '')
  out.prompt.instruction = normalizeNewlines(form.instruction ?? '')

  out.post.channel = form.channel ?? ''
  out.post.header = form.header ?? ''

  out.schedule.frequency = form.frequency ?? DEFAULT_FREQUENCY
  out.schedule.weekday = form.weekday ?? DEFAULT_WEEKDAY
  const hourRaw = Number.parseInt(form.hour ?? '', 10)
  const hour = Number.isFinite(hourRaw) ? hourRaw : DEFAULT_HOUR
  out.schedule.hour = Math.min(23, Math.max(0, hour))

  return out
}

/** Return an error message if any feed URL is invalid; null if OK. */
export function validateWebFeeds(feedsText: string): string | null {
  const feeds = linesToArray(feedsText)
  for (const url of feeds) {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return `フィードURLは http:// または https:// で始まる必要があります: ${url}`
    }
  }
  return null
}

/** Return an error message if schedule fields are invalid; null if OK. */
export function validateSchedule(form: {
  frequency?: string
  weekday?: string
  hour?: string
}): string | null {
  const frequency = form.frequency ?? ''
  if (!(SCHEDULE_FREQUENCIES as readonly string[]).includes(frequency)) {
    return `frequency は weekly または daily である必要があります: ${frequency}`
  }
  const weekday = form.weekday ?? ''
  if (!(SCHEDULE_WEEKDAYS as readonly string[]).includes(weekday)) {
    return `weekday が不正です: ${weekday}`
  }
  const hourRaw = Number.parseInt(form.hour ?? '', 10)
  if (
    !Number.isFinite(hourRaw) ||
    String(hourRaw) !== String(form.hour ?? '').trim() ||
    hourRaw < 0 ||
    hourRaw > 23
  ) {
    return `hour は 0〜23 の整数である必要があります: ${form.hour ?? ''}`
  }
  return null
}

export type FormValues = {
  provider: string
  model: string
  opencode_base_url: string
  frequency: ScheduleFrequency
  weekday: ScheduleWeekday
  hour: number
  days: number
  source: string
  channel_filter: string
  exclude_channels: string
  web_mode: string
  web_queries: string
  web_feeds: string
  system: string
  instruction: string
  channel: string
  header: string
}

export function formValuesFromConfig(cfg: Record<string, any>): FormValues {
  const llm = isPlainObject(cfg.llm) ? cfg.llm : {}
  const opencode = isPlainObject(llm.opencode) ? llm.opencode : {}
  const prompt = isPlainObject(cfg.prompt) ? cfg.prompt : {}
  const collect = isPlainObject(cfg.collect) ? cfg.collect : {}
  const web = isPlainObject(collect.web) ? collect.web : {}
  const post = isPlainObject(cfg.post) ? cfg.post : {}
  const schedule = isPlainObject(cfg.schedule) ? cfg.schedule : {}
  const exclude = collect.exclude_channels
  const queries = web.queries
  const feeds = web.feeds
  const frequencyRaw = String(schedule.frequency ?? DEFAULT_FREQUENCY)
  const weekdayRaw = String(schedule.weekday ?? DEFAULT_WEEKDAY)
  const hourRaw =
    typeof schedule.hour === 'number' ? schedule.hour : DEFAULT_HOUR
  return {
    provider: String(llm.provider ?? 'api'),
    model: String(llm.model ?? ''),
    opencode_base_url: String(opencode.base_url ?? ''),
    frequency: (SCHEDULE_FREQUENCIES as readonly string[]).includes(
      frequencyRaw,
    )
      ? (frequencyRaw as ScheduleFrequency)
      : DEFAULT_FREQUENCY,
    weekday: (SCHEDULE_WEEKDAYS as readonly string[]).includes(weekdayRaw)
      ? (weekdayRaw as ScheduleWeekday)
      : DEFAULT_WEEKDAY,
    hour: Math.min(23, Math.max(0, Number.isFinite(hourRaw) ? hourRaw : DEFAULT_HOUR)),
    days: typeof collect.days === 'number' ? collect.days : 7,
    source: String(collect.source ?? 'web'),
    channel_filter: String(collect.channel_filter ?? ''),
    exclude_channels: Array.isArray(exclude)
      ? exclude.map(String).join(', ')
      : '',
    web_mode: String(web.mode ?? 'llm_search'),
    web_queries: Array.isArray(queries) ? queries.map(String).join('\n') : '',
    web_feeds: Array.isArray(feeds) ? feeds.map(String).join('\n') : '',
    system: String(prompt.system ?? ''),
    instruction: String(prompt.instruction ?? ''),
    channel: String(post.channel ?? ''),
    header: String(post.header ?? ''),
  }
}

export function serializeConfig(cfg: Record<string, any>): string {
  const lines: string[] = [HEADER, '']
  const scalars: [string, unknown][] = []
  const tables: [string, Record<string, any>][] = []

  for (const [key, value] of Object.entries(cfg)) {
    if (isPlainObject(value)) tables.push([key, value])
    else scalars.push([key, value])
  }

  for (const [key, value] of scalars) {
    lines.push(`${key} = ${emitValue(value)}`)
  }
  if (scalars.length > 0 && tables.length > 0) lines.push('')

  for (const [key, value] of tables) {
    emitTable(lines, key, value)
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n') + '\n'
}

function emitTable(
  lines: string[],
  path: string,
  table: Record<string, any>,
): void {
  const scalars: [string, unknown][] = []
  const nested: [string, Record<string, any>][] = []

  for (const [k, v] of Object.entries(table)) {
    if (isPlainObject(v)) nested.push([k, v])
    else scalars.push([k, v])
  }

  if (scalars.length > 0 || nested.length === 0) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
    lines.push(`[${path}]`)
    for (const [k, v] of scalars) {
      lines.push(`${k} = ${emitValue(v)}`)
    }
  }

  for (const [k, v] of nested) {
    emitTable(lines, `${path}.${k}`, v)
  }
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function emitValue(v: unknown): string {
  if (typeof v === 'string') return emitString(v)
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`non-finite number: ${v}`)
    return String(v)
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (Array.isArray(v)) {
    return `[${v.map((item) => emitValue(item)).join(', ')}]`
  }
  throw new Error('inline tables are not supported by this emitter')
}

function emitString(s: string): string {
  if (s.includes('\n')) return emitMultiline(s)
  return `"${escapeBasic(s)}"`
}

/** Multi-line basic string with escapes for \\ and runs of 3+ ". */
function emitMultiline(s: string): string {
  let body = ''
  let i = 0
  while (i < s.length) {
    const ch = s[i]!
    if (ch === '\\') {
      body += '\\\\'
      i++
      continue
    }
    if (ch === '"') {
      let run = 0
      while (i + run < s.length && s[i + run] === '"') run++
      for (let j = 0; j < run; j++) {
        if ((j + 1) % 3 === 0) body += '\\"'
        else body += '"'
      }
      i += run
      continue
    }
    body += ch
    i++
  }
  return `"""\n${body}"""`
}

function escapeBasic(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.charCodeAt(0)
    if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else if (ch === '\t') out += '\\t'
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += ch
  }
  return out
}

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function linesToArray(s: string): string[] {
  return normalizeNewlines(s)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}
