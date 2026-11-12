/**
 * Runtime accounting for the balance-float widget.
 *
 * - folds `assistant/message` usage into a per-(session, turn) aggregate and
 *   appends one ledger event per model when the turn ends;
 * - applies each balance poll to the ledger: the day's opening balance sets the
 *   baseline, and `openingBalance - currentBalance` is today's spend (so usage
 *   from outside this Harness also counts);
 * - persists on a short debounce so a busy turn does not rewrite per message.
 */
import { beijingDay, costOf } from './pricing.js'
import { MAX_EVENTS, saveState } from './ledger.js'

/** Round to the ledger's 1e-6 CNY resolution. */
function round(value) {
  return Math.round(Number(value) * 1e6) / 1e6
}

/**
 * Create the tracker over one mutable ledger object.
 *
 * @param options.state - the ledger (mutated in place).
 * @param options.storePath - where to persist it.
 * @param options.onTurn - called after a turn is settled (trigger a balance poll).
 * @param options.logger - optional logger.
 */
export function createTracker({ state, storePath, onTurn, logger } = {}) {
  const turns = new Map()
  let saveTimer = null
  let dirty = false
  let lastSavedAt = 0

  function flush() {
    saveTimer = null
    if (!dirty) return
    dirty = false
    if (saveState(storePath, state)) lastSavedAt = Date.now()
  }

  function scheduleSave() {
    dirty = true
    if (saveTimer !== null) return
    saveTimer = setTimeout(flush, 1200)
    if (typeof saveTimer.unref === 'function') saveTimer.unref()
  }

  /** Start a new Beijing day, carrying yesterday's total into `history`. */
  function rollover(now = Date.now()) {
    const today = beijingDay(now)
    if (state.date === today) return
    state.history[state.date] = round(state.todayUsage)
    state.date = today
    state.dayStart = state.lastBalance
    state.todayUsage = 0
    state.history[today] = 0
  }

  /** Sum of the appended events that belong to one day. */
  function eventsDaySum(day) {
    let sum = 0
    for (const event of state.events) {
      if (event && event.day === day) sum += Number(event.cost) || 0
    }
    return sum
  }

  /** Append one settled turn as one event per model. */
  function settle(agg, now = Date.now()) {
    const ts = agg.lastTs || now
    const day = beijingDay(ts)
    let total = 0
    let tokens = 0
    for (const model of Object.keys(agg.byModel)) {
      const cost = round(agg.byModel[model])
      if (!(cost > 0)) continue
      const modelTokens = Math.max(0, Math.round(agg.byModelTokens[model] || 0))
      const usage = agg.byModelUsage[model] || { input: 0, cacheRead: 0, output: 0 }
      // Keep the per-bucket split: the card shows cached vs uncached input later.
      state.events.push({
        ts,
        day,
        model,
        cost,
        tokens: modelTokens,
        input: Math.max(0, Math.round(usage.input)),
        cacheRead: Math.max(0, Math.round(usage.cacheRead)),
        output: Math.max(0, Math.round(usage.output)),
      })
      total += cost
      tokens += modelTokens
    }
    if (total <= 0) return
    if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS)
    // A turn that settles after midnight belongs to its own day: never mix in
    // the current day's running total.
    const dayTotal = eventsDaySum(day)
    state.history[day] = round(Math.max(Number(state.history[day]) || 0, dayTotal))
    if (day === state.date) state.todayUsage = round(Math.max(state.todayUsage, dayTotal))
    state.updatedAt = new Date(now).toISOString()
    scheduleSave()
    onTurn?.(total, tokens)
  }

  function finalize(sessionId, now = Date.now()) {
    const agg = turns.get(sessionId)
    if (!agg) return
    turns.delete(sessionId)
    settle(agg, now)
  }

  /**
   * Epoch seconds of one event: the message's own clock when present, so a
   * reply that streams across a peak/valley edge is still priced correctly.
   *
   * @param event - session event (`time` is epoch ms per the session format).
   */
  function messageSec(event) {
    const candidates = [event?.data?.message?.createdAt, event?.time]
    for (const value of candidates) {
      const n = Number(value)
      if (Number.isFinite(n) && n > 0) return Math.floor(n > 1e12 ? n / 1000 : n)
    }
    return Math.floor(Date.now() / 1000)
  }

  /**
   * Fold one session event.
   *
   * @param session - the session the event belongs to.
   * @param event - the appended SessionEvent.
   */
  function handleEvent(session, event) {
    const type = event && event.type
    const data = event && event.data
    if (type !== 'assistant/message' && type !== 'turn/end') return
    const sessionId = session && session.id ? String(session.id) : 'default'
    if (type === 'turn/end') {
      finalize(sessionId)
      return
    }
    if (!data || !Number.isFinite(Number(data.turn)) || data.usage === null || typeof data.usage !== 'object') return
    const turn = Number(data.turn)
    let agg = turns.get(sessionId)
    if (!agg || agg.turn !== turn) {
      if (agg) finalize(sessionId)
      agg = { turn, byModel: {}, byModelTokens: {}, byModelUsage: {}, lastTs: 0 }
      turns.set(sessionId, agg)
    }
    const model = String(data.message?.source?.model || 'unknown')
    const usage = data.usage
    const cost = costOf(model, usage, messageSec(event))
    agg.byModel[model] = (agg.byModel[model] || 0) + cost
    agg.byModelTokens[model] =
      (agg.byModelTokens[model] || 0) +
      (Number(usage.inputTokens) || 0) +
      (Number(usage.cacheReadTokens) || 0) +
      (Number(usage.outputTokens) || 0)
    const buckets = agg.byModelUsage[model] || (agg.byModelUsage[model] = { input: 0, cacheRead: 0, output: 0 })
    buckets.input += Number(usage.inputTokens) || 0
    buckets.cacheRead += Number(usage.cacheReadTokens) || 0
    buckets.output += Number(usage.outputTokens) || 0
    // The turn belongs to the day of its last message: a request that finishes
    // after midnight must not be booked into the new day.
    agg.lastTs = messageSec(event) * 1000
  }

  /**
   * Apply one balance reading.
   *
   * @param balance - total balance in CNY.
   * @param source - where the reading came from (`apikey`).
   * @param now - epoch milliseconds.
   */
  function applyBalance(balance, source = 'apikey', now = Date.now()) {
    const value = Number(balance)
    if (!Number.isFinite(value)) return false
    const before = { date: state.date, dayStart: state.dayStart, last: state.lastBalance, usage: state.todayUsage }
    rollover(now)
    if (state.dayStart === null) state.dayStart = value
    state.lastBalance = round(value)
    state.balanceSource = source
    state.balanceAt = now
    const delta = state.dayStart === null ? null : state.dayStart - value
    if (delta === null) {
      // First reading of the day doubles as the baseline.
    } else if (delta >= -0.005) {
      state.todayUsage = round(Math.max(state.todayUsage, delta))
    } else {
      // Balance went up: a top-up, so re-anchor the baseline instead of
      // reporting negative spend.
      state.dayStart = value
    }
    state.history[state.date] = round(state.todayUsage)
    // A poll that changed nothing must not rewrite the whole ledger file.
    const changed =
      before.date !== state.date ||
      before.dayStart !== state.dayStart ||
      before.last !== state.lastBalance ||
      before.usage !== state.todayUsage
    if (changed) {
      state.updatedAt = new Date(now).toISOString()
      scheduleSave()
    }
    return true
  }

  /** Persist synchronously (startup seed, disposal). */
  function flushNow() {
    dirty = true
    flush()
  }

  return {
    handleEvent,
    applyBalance,
    flushNow,
    get state() {
      return state
    },
    get lastSavedAt() {
      return lastSavedAt
    },
    dispose() {
      if (saveTimer !== null) clearTimeout(saveTimer)
      saveTimer = null
      flushNow()
    },
  }
}
