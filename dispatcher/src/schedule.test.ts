import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SCHEDULE,
  localParts,
  parseSchedule,
  shouldDispatch,
  type Schedule,
} from './schedule'

const toml = (body: string) => `[schedule]\n${body}\n`

describe('parseSchedule', () => {
  it('reads a well-formed [schedule] table', () => {
    expect(
      parseSchedule(
        toml(
          [
            'frequency = "weekly"',
            'weekday = "friday"',
            'hour = 18',
            'timezone = "America/New_York"',
          ].join('\n'),
        ),
      ),
    ).toEqual({
      frequency: 'weekly',
      weekday: 'friday',
      hour: 18,
      timezone: 'America/New_York',
    })
  })

  it('ignores unrelated tables', () => {
    const text = `[llm]\nprovider = "codex"\n\n${toml('frequency = "daily"\nhour = 7')}`
    const s = parseSchedule(text)
    expect(s.frequency).toBe('daily')
    expect(s.hour).toBe(7)
  })

  it('falls back to defaults when [schedule] is absent', () => {
    expect(parseSchedule('[llm]\nprovider = "api"\n')).toEqual(DEFAULT_SCHEDULE)
  })

  it('falls back per field, keeping the valid ones', () => {
    const s = parseSchedule(
      toml(
        [
          'frequency = "fortnightly"',
          'weekday = "notaday"',
          'hour = 99',
          'timezone = "Europe/Paris"',
        ].join('\n'),
      ),
    )
    expect(s.frequency).toBe(DEFAULT_SCHEDULE.frequency)
    expect(s.weekday).toBe(DEFAULT_SCHEDULE.weekday)
    expect(s.hour).toBe(DEFAULT_SCHEDULE.hour)
    // The one valid field survives the invalid neighbours.
    expect(s.timezone).toBe('Europe/Paris')
  })

  it('normalises weekday case and whitespace', () => {
    expect(parseSchedule(toml('weekday = "  FriDay "')).weekday).toBe('friday')
  })

  it('rejects a non-integer hour', () => {
    expect(parseSchedule(toml('hour = 9.5')).hour).toBe(DEFAULT_SCHEDULE.hour)
  })

  it('accepts hour 0', () => {
    expect(parseSchedule(toml('hour = 0')).hour).toBe(0)
  })

  it('throws on unparseable TOML', () => {
    expect(() => parseSchedule('[schedule\nhour =')).toThrow()
  })
})

describe('localParts', () => {
  it('resolves hour and weekday in the target zone', () => {
    expect(localParts('Asia/Tokyo', new Date('2026-07-29T00:00:00Z'))).toEqual({
      hour: 9,
      weekday: 'wednesday',
    })
  })

  it('reports midnight as hour 0, not 24', () => {
    expect(localParts('Asia/Tokyo', new Date('2026-07-28T15:00:00Z')).hour).toBe(
      0,
    )
  })

  it('throws on an unknown timezone', () => {
    expect(() => localParts('Mars/Olympus', new Date())).toThrow(RangeError)
  })
})

describe('shouldDispatch', () => {
  const daily: Schedule = {
    frequency: 'daily',
    weekday: 'monday',
    hour: 9,
    timezone: 'Asia/Tokyo',
  }

  it('fires at the configured hour', () => {
    // 00:00 UTC = 09:00 JST
    expect(shouldDispatch(daily, new Date('2026-07-29T00:00:00Z'))).toBe(true)
  })

  it('does not fire on other hours', () => {
    expect(shouldDispatch(daily, new Date('2026-07-29T01:00:00Z'))).toBe(false)
    expect(shouldDispatch(daily, new Date('2026-07-28T23:00:00Z'))).toBe(false)
  })

  it('ignores weekday when frequency is daily', () => {
    // 2026-07-29 JST is a Wednesday, but weekday says monday.
    expect(shouldDispatch(daily, new Date('2026-07-29T00:00:00Z'))).toBe(true)
  })

  const weekly: Schedule = {
    frequency: 'weekly',
    weekday: 'friday',
    hour: 18,
    timezone: 'Asia/Tokyo',
  }

  it('fires only on the configured weekday', () => {
    // 09:00 UTC = 18:00 JST Friday
    expect(shouldDispatch(weekly, new Date('2026-07-31T09:00:00Z'))).toBe(true)
    // Same local hour, one day earlier (Thursday).
    expect(shouldDispatch(weekly, new Date('2026-07-30T09:00:00Z'))).toBe(false)
  })

  it('fires at the same local hour across a DST boundary', () => {
    const ny: Schedule = {
      frequency: 'daily',
      weekday: 'monday',
      hour: 9,
      timezone: 'America/New_York',
    }
    // 09:00 EST (UTC-5) in January...
    expect(shouldDispatch(ny, new Date('2026-01-15T14:00:00Z'))).toBe(true)
    // ...and 09:00 EDT (UTC-4) in July. A cron frozen at save time would
    // have drifted by an hour here.
    expect(shouldDispatch(ny, new Date('2026-07-15T13:00:00Z'))).toBe(true)
    expect(shouldDispatch(ny, new Date('2026-07-15T14:00:00Z'))).toBe(false)
  })

  it('falls back to the default zone when the timezone is unknown', () => {
    const bad: Schedule = { ...daily, timezone: 'Mars/Olympus' }
    // Evaluated as Asia/Tokyo, so 00:00 UTC still matches hour 9.
    expect(shouldDispatch(bad, new Date('2026-07-29T00:00:00Z'))).toBe(true)
    expect(shouldDispatch(bad, new Date('2026-07-29T01:00:00Z'))).toBe(false)
  })

  it('matches the current production schedule exactly once a day', () => {
    const fires = Array.from({ length: 24 }, (_, h) =>
      shouldDispatch(
        daily,
        new Date(`2026-07-29T${String(h).padStart(2, '0')}:00:00Z`),
      ),
    ).filter(Boolean)
    expect(fires).toHaveLength(1)
  })
})
