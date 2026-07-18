import { describe, expect, it } from 'vitest'
import { computeCron, getOffsetMinutes } from './schedule'

describe('getOffsetMinutes', () => {
  it('returns +540 for Asia/Tokyo', () => {
    expect(getOffsetMinutes('Asia/Tokyo', new Date('2024-07-01T00:00:00Z'))).toBe(
      540,
    )
  })

  it('throws on unknown timezone', () => {
    expect(() =>
      getOffsetMinutes('Not/AZone', new Date('2024-07-01T00:00:00Z')),
    ).toThrow()
  })
})

describe('computeCron', () => {
  // Runs fire SCHEDULE_JITTER_MINUTES (13) past the hour to dodge GitHub's
  // top-of-hour scheduler congestion, so every minute field below is 13.

  it('weekly friday 18 Asia/Tokyo → 13 9 * * 5', () => {
    expect(
      computeCron('weekly', 'friday', 18, 'Asia/Tokyo', new Date('2024-07-01')),
    ).toBe('13 9 * * 5')
  })

  it('daily 9 Asia/Tokyo → 13 0 * * *', () => {
    expect(
      computeCron('daily', 'friday', 9, 'Asia/Tokyo', new Date('2024-07-01')),
    ).toBe('13 0 * * *')
  })

  it('weekly monday 8 Asia/Tokyo → 13 23 * * 0 (day shift back)', () => {
    expect(
      computeCron('weekly', 'monday', 8, 'Asia/Tokyo', new Date('2024-07-01')),
    ).toBe('13 23 * * 0')
  })

  it('weekly sunday 23 America/Los_Angeles in July (PDT) → 13 6 * * 1', () => {
    // July → PDT UTC-7 (−420)
    expect(
      computeCron(
        'weekly',
        'sunday',
        23,
        'America/Los_Angeles',
        new Date('2024-07-15T12:00:00Z'),
      ),
    ).toBe('13 6 * * 1')
  })

  it('daily 9 Asia/Kolkata (+05:30) → 43 3 * * * (jitter adds to :30)', () => {
    expect(
      computeCron(
        'daily',
        'friday',
        9,
        'Asia/Kolkata',
        new Date('2024-07-01'),
      ),
    ).toBe('43 3 * * *')
  })

  it('daily 9 Asia/Kathmandu (+05:45) → 28 3 * * * (jitter adds to :15)', () => {
    // 9*60 − 345 + 13 = 208 min → 03:28 UTC.
    expect(
      computeCron(
        'daily',
        'friday',
        9,
        'Asia/Kathmandu',
        new Date('2024-07-01'),
      ),
    ).toBe('28 3 * * *')
  })

  it('unknown timezone throws', () => {
    expect(() =>
      computeCron('daily', 'friday', 9, 'Fake/Zone', new Date('2024-07-01')),
    ).toThrow()
  })
})
