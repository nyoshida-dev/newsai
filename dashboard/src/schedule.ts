/** Weekday name → cron DOW (Sunday = 0), matching JS getDay(). */
const WEEKDAY_TO_CRON: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
}

/**
 * UTC offset of `timezone` at `date`, in minutes east of UTC.
 * Uses Intl longOffset (e.g. "GMT+09:00"). Throws on unknown timezone.
 *
 * DST: pass the save-time `date` — the offset valid then is frozen into the cron.
 */
export function getOffsetMinutes(timezone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  })
  const parts = dtf.formatToParts(date)
  const tzName = parts.find((p) => p.type === 'timeZoneName')?.value
  if (!tzName) {
    throw new Error(`could not resolve offset for timezone: ${timezone}`)
  }
  if (tzName === 'GMT' || tzName === 'UTC') return 0
  const m = tzName.match(/^GMT([+-])(\d{2}):(\d{2})$/)
  if (!m) {
    throw new Error(`unexpected offset format: ${tzName}`)
  }
  const sign = m[1] === '+' ? 1 : -1
  return sign * (Number.parseInt(m[2]!, 10) * 60 + Number.parseInt(m[3]!, 10))
}

/**
 * Minutes past the requested hour at which the run actually fires.
 * GitHub delays or silently drops scheduled runs during high-load windows —
 * the start of every hour, and 00:00 UTC most of all. Offsetting off :00 lands
 * the job in a less congested minute and cuts the chance of a missed delivery.
 * https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
 */
export const SCHEDULE_JITTER_MINUTES = 13

/**
 * Compute a GitHub Actions cron expression from local schedule fields.
 * Offset is taken at `now` (default: current time) so DST zones freeze the
 * offset valid at save time.
 */
export function computeCron(
  frequency: 'daily' | 'weekly',
  weekday: string,
  hour: number,
  timezone: string,
  now: Date = new Date(),
): string {
  const offsetMinutes = getOffsetMinutes(timezone, now)
  let utcTotalMinutes = hour * 60 - offsetMinutes + SCHEDULE_JITTER_MINUTES
  let dayShift = 0
  while (utcTotalMinutes < 0) {
    utcTotalMinutes += 1440
    dayShift -= 1
  }
  while (utcTotalMinutes >= 1440) {
    utcTotalMinutes -= 1440
    dayShift += 1
  }
  const utcHour = Math.floor(utcTotalMinutes / 60)
  const utcMinute = utcTotalMinutes % 60

  if (frequency === 'daily') {
    return `${utcMinute} ${utcHour} * * *`
  }

  const base = WEEKDAY_TO_CRON[weekday]
  if (base === undefined) {
    throw new Error(`unknown weekday: ${weekday}`)
  }
  let dow = (base + dayShift) % 7
  if (dow < 0) dow += 7
  return `${utcMinute} ${utcHour} * * ${dow}`
}
