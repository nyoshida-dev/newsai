/**
 * Delivery schedule, read from config.toml `[schedule]` at dispatch time.
 *
 * The Worker wakes every hour and asks `shouldDispatch` whether *this* hour is
 * the configured delivery time. Evaluating at fire time (rather than baking a
 * UTC cron at save time) means DST transitions are handled automatically and
 * the dashboard only has to write config.toml for a change to take effect.
 */

import { parse as parseToml } from 'smol-toml'

export type Frequency = 'daily' | 'weekly'

export type Schedule = {
  frequency: Frequency
  weekday: string
  hour: number
  timezone: string
}

/**
 * Used when config.toml cannot be read or parsed. Deliberately equal to the
 * schedule the dispatcher hardcoded before it read config.toml: a transient
 * GitHub failure degrades to the previous behaviour instead of silently
 * stopping delivery.
 */
export const DEFAULT_SCHEDULE: Schedule = {
  frequency: 'daily',
  weekday: 'monday',
  hour: 9,
  timezone: 'Asia/Tokyo',
}

/** Lowercase English weekday names, as emitted by Intl `weekday: 'long'`. */
const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]

/**
 * Read `[schedule]` out of config.toml text. Every field falls back to
 * DEFAULT_SCHEDULE independently, so a single bad value does not discard the
 * rest of the user's settings. Throws only if the TOML itself is unparseable.
 */
export function parseSchedule(tomlText: string): Schedule {
  const cfg = parseToml(tomlText) as Record<string, unknown>
  const raw = cfg?.schedule
  const s: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}

  const frequency: Frequency =
    s.frequency === 'daily' || s.frequency === 'weekly'
      ? s.frequency
      : DEFAULT_SCHEDULE.frequency

  const weekdayRaw =
    typeof s.weekday === 'string' ? s.weekday.trim().toLowerCase() : ''
  const weekday = WEEKDAYS.includes(weekdayRaw)
    ? weekdayRaw
    : DEFAULT_SCHEDULE.weekday

  const hour =
    typeof s.hour === 'number' &&
    Number.isInteger(s.hour) &&
    s.hour >= 0 &&
    s.hour <= 23
      ? s.hour
      : DEFAULT_SCHEDULE.hour

  const timezone =
    typeof s.timezone === 'string' && s.timezone.trim().length > 0
      ? s.timezone.trim()
      : DEFAULT_SCHEDULE.timezone

  return { frequency, weekday, hour, timezone }
}

/**
 * Local hour (0-23) and lowercase weekday name in `timezone` at `now`.
 * Throws RangeError if the timezone is not recognised.
 */
export function localParts(
  timezone: string,
  now: Date,
): { hour: number; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    hour: '2-digit',
    weekday: 'long',
  }).formatToParts(now)

  const hourRaw = parts.find((p) => p.type === 'hour')?.value
  const weekdayRaw = parts.find((p) => p.type === 'weekday')?.value
  if (hourRaw === undefined || weekdayRaw === undefined) {
    throw new RangeError(`could not resolve local time for: ${timezone}`)
  }
  // h23 should never yield 24, but normalise defensively — an off-by-one here
  // would silently skip a whole day's delivery.
  const hour = Number.parseInt(hourRaw, 10) % 24
  return { hour, weekday: weekdayRaw.toLowerCase() }
}

/**
 * Is `now` the configured delivery time?
 *
 * The Worker wakes at :00 UTC each hour, so for whole-hour offsets this fires
 * at exactly HH:00 local. Zones offset by :30/:45 (e.g. Asia/Kolkata) deliver
 * at HH:30/HH:45 local — the configured hour is still correct, only the minute
 * differs.
 */
export function shouldDispatch(schedule: Schedule, now: Date): boolean {
  let parts: { hour: number; weekday: string }
  try {
    parts = localParts(schedule.timezone, now)
  } catch {
    console.error(
      `不明なタイムゾーン: ${schedule.timezone} — ${DEFAULT_SCHEDULE.timezone} で判定します`,
    )
    parts = localParts(DEFAULT_SCHEDULE.timezone, now)
  }

  if (parts.hour !== schedule.hour) return false
  if (schedule.frequency === 'daily') return true
  return parts.weekday === schedule.weekday
}
