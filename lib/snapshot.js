/**
 * Snapshot builder for the balance-float widget.
 *
 * Pure formatting over one ledger object: the Host half owns when the ledger is
 * updated, this module only turns it (plus the current peak window and the
 * price table) into the JSON the browser polls.
 */
import path from 'node:path'
import { PRICES, SCHEDULE, beijingDay, isPeak, nextPeakChange } from './pricing.js'
import { loadState } from './ledger.js'

/** Finite number or fallback. */
function numberOr(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** Rounded currency value. */
function money(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 1e6) / 1e6
}

/** Today's events folded per model and per peak/valley period. */
function todayBreakdown(events, today) {
  const models = {}
  let calls = 0
  let tokens = 0
  let input = 0
  let cacheRead = 0
  let output = 0
  let peakCost = 0
  let valleyCost = 0
  for (const event of events) {
    if (!event || event.day !== today) continue
    const cost = numberOr(event.cost, 0)
    const eventTokens = numberOr(event.tokens, 0)
    calls += 1
    tokens += eventTokens
    input += numberOr(event.input, 0)
    cacheRead += numberOr(event.cacheRead, 0)
    output += numberOr(event.output, 0)
    if (isPeak(numberOr(event.ts, 0) / 1000)) peakCost += cost
    else valleyCost += cost
    const key = String(event.model || 'unknown')
    const row =
      models[key] || (models[key] = { model: key, calls: 0, tokens: 0, input: 0, cacheRead: 0, output: 0, cost: 0 })
    row.calls += 1
    row.tokens += eventTokens
    row.input += numberOr(event.input, 0)
    row.cacheRead += numberOr(event.cacheRead, 0)
    row.output += numberOr(event.output, 0)
    row.cost += cost
  }
  const rows = Object.keys(models)
    .map((key) => ({ ...models[key], cost: money(models[key].cost) }))
    .sort((a, b) => b.cost - a.cost)
  return {
    calls,
    tokens,
    input,
    cacheRead,
    output,
    peakCost: money(peakCost),
    valleyCost: money(valleyCost),
    models: rows,
  }
}

/**
 * Cost of the most recently settled turn.
 *
 * One turn writes one event per model, all sharing the same `ts`, so the group
 * with the newest `ts` is exactly the last turn.
 */
function lastTurn(events) {
  let lastTs = 0
  for (const event of events) {
    const ts = numberOr(event && event.ts, 0)
    if (ts > lastTs) lastTs = ts
  }
  if (lastTs <= 0) return null
  let cost = 0
  let tokens = 0
  const byModel = {}
  for (const event of events) {
    if (numberOr(event && event.ts, 0) !== lastTs) continue
    const eventCost = numberOr(event.cost, 0)
    cost += eventCost
    tokens += numberOr(event.tokens, 0)
    const model = String((event && event.model) || 'unknown')
    byModel[model] = (byModel[model] || 0) + eventCost
  }
  return {
    cost: money(cost),
    tokens,
    at: lastTs,
    models: Object.keys(byModel)
      .map((model) => ({ model, cost: money(byModel[model]) }))
      .sort((a, b) => b.cost - a.cost),
  }
}

/**
 * Build one snapshot.
 *
 * @param options.ledger - the plugin's ledger object.
 * @param options.sourcePath - path the ledger is stored at (shown to the user).
 * @param options.mtimeMs - ledger file mtime, epoch milliseconds.
 * @param options.serverNow - epoch milliseconds, injectable for tests.
 * @returns JSON-serializable snapshot.
 */
export function buildSnapshot({ ledger, sourcePath, mtimeMs, serverNow = Date.now(), version = '', days = 31 } = {}) {
  const nowSec = Math.floor(serverNow / 1000)
  const peakActive = isPeak(nowSec)
  const nextChange = nextPeakChange(nowSec)
  const today = beijingDay(serverNow)
  const events = Array.isArray(ledger?.events) ? ledger.events : []
  const history = ledger?.history !== null && typeof ledger?.history === 'object' ? ledger.history : {}
  const breakdown = todayBreakdown(events, today)
  const balance = money(numberOr(ledger?.lastBalance, NaN))
  const dayStart = money(numberOr(ledger?.dayStart, NaN))
  const usedFromHistory = money(numberOr(history[today], NaN))
  const base = {
    ok: true,
    currency: 'CNY',
    serverNow,
    peak: {
      active: peakActive,
      label: peakActive ? 'peak' : 'valley',
      nextChangeAt: nextChange === null ? null : nextChange * 1000,
      schedule: SCHEDULE,
    },
    prices: PRICES,
    version,
    source: {
      exists: true,
      path: sourcePath ?? '',
      updatedAt: mtimeMs > 0 ? new Date(mtimeMs).toISOString() : null,
    },
  }

  // 31 keeps a whole calendar month (some months have 31 days); `days = 0`
  // asks for a light snapshot that carries no day rows at all.
  const dayKeys = Object.keys(history)
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day))
    .sort()
  const window = Number.isFinite(days) ? Math.max(0, Math.min(31, Math.floor(days))) : 31
  const kept = window === 0 ? [] : dayKeys.slice(-window)
  // Each bar carries its own breakdown (folded from the stored events); old
  // days whose events rolled out of MAX_EVENTS fall back to the stored total.
  const recent = kept.map((day) => {
    const detail = todayBreakdown(events, day)
    const fromEvents = money((detail.peakCost ?? 0) + (detail.valleyCost ?? 0)) ?? 0
    const stored = money(numberOr(history[day], 0)) ?? 0
    return {
      day,
      cost: money(Math.max(stored, fromEvents)),
      calls: detail.calls,
      tokens: detail.tokens,
      input: detail.input,
      cacheRead: detail.cacheRead,
      output: detail.output,
      peakCost: detail.peakCost,
      valleyCost: detail.valleyCost,
      models: detail.models,
    }
  })
  const turn = lastTurn(events)
  const todayUsed =
    money(numberOr(ledger?.todayUsage, NaN)) ?? usedFromHistory ?? money((breakdown.peakCost ?? 0) + (breakdown.valleyCost ?? 0))

  return {
    ...base,
    balance,
    dayStart,
    today,
    todayUsed,
    todayCalls: breakdown.calls,
    todayTokens: breakdown.tokens,
    todayInput: breakdown.input,
    todayCacheRead: breakdown.cacheRead,
    todayOutput: breakdown.output,
    todayPeakCost: breakdown.peakCost,
    todayValleyCost: breakdown.valleyCost,
    models: breakdown.models,
    turn,
    lastEventAt: turn === null ? 0 : turn.at,
    history: recent,
    historyMax: recent.reduce((max, row) => Math.max(max, row.cost ?? 0), 0),
    historyTotal: money(recent.reduce((sum, row) => sum + (row.cost ?? 0), 0)),
  }
}

/**
 * Convenience reader used by tests and by callers without in-memory state.
 *
 * @param options - raw row config (`storeFile` / `legacyFile`) plus `now`.
 */
export function readSnapshot(options = {}) {
  const now = options.now ?? Date.now()
  const loaded = loadState(options, now)
  return buildSnapshot({
    ledger: loaded.state,
    sourcePath: loaded.path,
    mtimeMs: loaded.mtimeMs,
    serverNow: now,
  })
}

/** File name of the store, for compact display. */
export function storeName(file) {
  return path.basename(file)
}
