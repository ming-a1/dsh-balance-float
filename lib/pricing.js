/**
 * Peak/valley calendar and the official CNY price table.
 *
 * Shared by the tracker (which prices each settled turn) and the snapshot
 * (which shows the current window), so both always agree on what "peak" means.
 */

/** Ledger amounts are stored as plain CNY numbers; the legacy ledger uses 1e-8 units. */
export const LEGACY_UNIT = 1e8

/** Peak windows in Beijing local hours: [startHour, endHour). */
const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]

/**
 * Weekend valley pricing was introduced on Beijing 2026-08-23 00:00; earlier
 * buckets in a legacy ledger were charged by the old all-week rule.
 */
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)

/** Statutory holidays are valley-priced all day since Beijing 2026-09-19 00:00. */
const HOLIDAY_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 8, 18, 16, 0, 0) / 1000)

/**
 * Days that are holidays for billing (only days off need listing: make-up
 * working weekends are already valley under the weekend rule).
 * Extend this table when the 2027 schedule is published.
 */
const HOLIDAY_VALLEY = {
  '2026-01-01': 1, '2026-01-02': 1, '2026-01-03': 1,
  '2026-02-15': 1, '2026-02-16': 1, '2026-02-17': 1, '2026-02-18': 1, '2026-02-19': 1,
  '2026-02-20': 1, '2026-02-21': 1, '2026-02-22': 1, '2026-02-23': 1,
  '2026-04-04': 1, '2026-04-05': 1, '2026-04-06': 1,
  '2026-05-01': 1, '2026-05-02': 1, '2026-05-03': 1, '2026-05-04': 1, '2026-05-05': 1,
  '2026-06-19': 1, '2026-06-20': 1, '2026-06-21': 1,
  '2026-09-25': 1, '2026-09-26': 1, '2026-09-27': 1,
  '2026-10-01': 1, '2026-10-02': 1, '2026-10-03': 1, '2026-10-04': 1,
  '2026-10-05': 1, '2026-10-06': 1, '2026-10-07': 1,
}

/** The schedule sentence shown in the widget. */
export const SCHEDULE = '峰：周一至周五 09:00–12:00、14:00–18:00；其余（含周末与法定节假日全天）谷价'

/**
 * Official CNY price per million tokens: [off-peak, peak]. Peak is 2x off-peak.
 * Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 */
export const PRICES = [
  { key: 'flash', model: 'deepseek-flash', hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  { key: 'pro', model: 'deepseek-v4-pro', hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] },
]

const FLASH = PRICES[0]
const PRO = PRICES[1]

/** Beijing local hour/weekday/date for an epoch-second instant, read through UTC. */
function beijingParts(sec) {
  const bj = new Date(sec * 1000 + 8 * 3600 * 1000)
  return { hour: bj.getUTCHours(), dow: bj.getUTCDay(), day: bj.toISOString().slice(0, 10) }
}

/**
 * True when the instant is billed at peak price.
 *
 * @param sec - epoch seconds.
 */
export function isPeak(sec) {
  if (!Number.isFinite(sec)) return false
  const { hour, dow, day } = beijingParts(sec)
  if (sec >= WEEKEND_VALLEY_FROM_SEC && (dow === 0 || dow === 6)) return false
  if (sec >= HOLIDAY_VALLEY_FROM_SEC && HOLIDAY_VALLEY[day] === 1) return false
  return PEAK_HOURS.some(([start, end]) => hour >= start && hour < end)
}

/**
 * Next instant whose peak/valley classification differs from `sec`.
 * Scans Beijing hour edges (00/09/12/14/18) day by day; 12 days covers the
 * longest statutory break.
 *
 * @param sec - epoch seconds.
 * @returns epoch seconds, or null when no edge flips within 12 days.
 */
export function nextPeakChange(sec) {
  if (!Number.isFinite(sec)) return null
  const current = isPeak(sec)
  const midnight = Math.floor((sec + 8 * 3600) / 86400) * 86400
  for (let day = 0; day <= 12; day++) {
    for (const edge of [0, 9, 12, 14, 18]) {
      const candidate = midnight + day * 86400 + edge * 3600 - 8 * 3600
      if (candidate <= sec + 1) continue
      if (isPeak(candidate) !== current) return candidate
    }
  }
  return null
}

/** Beijing calendar date (`YYYY-MM-DD`) for an epoch-millisecond instant. */
export function beijingDay(ms = Date.now()) {
  return beijingParts(Math.floor(ms / 1000)).day
}

/**
 * Price row for a model name: Pro tiers cost 3x Flash, everything else is Flash.
 *
 * @param model - model id from the assistant message source.
 */
export function priceFor(model) {
  return String(model || '').toLowerCase().indexOf('pro') !== -1 ? PRO : FLASH
}

/** Finite non-negative number or 0. */
function count(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Cost of one assistant message in CNY at the instant it completed.
 *
 * DSH guarantees `reasoningTokens ⊆ outputTokens`, so reasoning is not billed
 * again on top of the output tokens.
 *
 * @param model - model id.
 * @param usage - TokenUsage from the `assistant/message` event.
 * @param sec - epoch seconds used to pick the peak/valley price.
 * @returns CNY amount.
 */
export function costOf(model, usage, sec) {
  if (usage === null || typeof usage !== 'object') return 0
  const price = priceFor(model)
  const tier = isPeak(sec) ? 1 : 0
  const hit = count(usage.cacheReadTokens)
  const miss = count(usage.inputTokens)
  const out = count(usage.outputTokens)
  return (hit / 1e6) * price.hit[tier] + (miss / 1e6) * price.miss[tier] + (out / 1e6) * price.out[tier]
}
