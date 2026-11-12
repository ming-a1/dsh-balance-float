import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSnapshot } from '../lib/snapshot.js'

/** Beijing day key for an offset in days from now. */
function dayKey(offset) {
  const ms = Date.now() - offset * 86400000
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function ledgerWithDays(count) {
  const history = {}
  for (let i = 0; i < count; i += 1) history[dayKey(i)] = i + 1
  return { lastBalance: 20, dayStart: 22, todayUsage: 3, history, events: [] }
}

test('history keeps a whole 31-day month', () => {
  const snapshot = buildSnapshot({ ledger: ledgerWithDays(40) })
  assert.equal(snapshot.history.length, 31)
})

test('light snapshots carry no day rows', () => {
  const snapshot = buildSnapshot({ ledger: ledgerWithDays(10), days: 0 })
  assert.deepEqual(snapshot.history, [])
  assert.equal(snapshot.historyTotal, 0)
})

test('a day row folds cost, peak/valley split and per-model cost', () => {
  const today = dayKey(0)
  const ts = Date.now() - 60_000
  const events = [
    { ts, day: today, model: 'deepseek-flash', cost: 0.5, tokens: 100, input: 10, cacheRead: 80, output: 10 },
    { ts, day: today, model: 'deepseek-v4-pro', cost: 1.5, tokens: 200, input: 20, cacheRead: 150, output: 30 },
  ]
  const snapshot = buildSnapshot({
    ledger: { lastBalance: 20, dayStart: 22, todayUsage: 2, history: { [today]: 2 }, events },
  })
  const row = snapshot.history.at(-1)
  assert.equal(row.day, today)
  assert.equal(Number(row.cost.toFixed(6)), 2)
  assert.equal(row.calls, 2)
  assert.equal(row.models.length, 2)
  assert.equal(Number((row.peakCost + row.valleyCost).toFixed(6)), 2)
})

test('the last turn is the newest ts group only', () => {
  const today = dayKey(0)
  const events = [
    { ts: 1000, day: today, model: 'a', cost: 1, tokens: 10 },
    { ts: 2000, day: today, model: 'a', cost: 2, tokens: 20 },
    { ts: 2000, day: today, model: 'b', cost: 3, tokens: 30 },
  ]
  const snapshot = buildSnapshot({ ledger: { events, history: { [today]: 6 }, lastBalance: 1, dayStart: 7 } })
  assert.equal(snapshot.turn.at, 2000)
  assert.equal(Number(snapshot.turn.cost.toFixed(6)), 5)
})
