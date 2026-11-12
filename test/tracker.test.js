import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createTracker } from '../lib/tracker.js'

/** A ledger in its first-run shape. */
function freshState(day) {
  return { version: 1, date: day, dayStart: null, lastBalance: null, todayUsage: 0, history: {}, events: [] }
}

/** Drive one assistant message through the tracker. */
function message(tracker, session, turn) {
  tracker.handleEvent(
    { id: session },
    {
      type: 'assistant/message',
      time: Date.now(),
      data: {
        turn,
        usage: { inputTokens: 1e6, cacheReadTokens: 0, outputTokens: 0 },
        message: { source: { model: 'deepseek-flash' } },
      },
    },
  )
}

test('a settled turn is recorded and priced', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bf-'))
  try {
    const state = freshState(new Date().toISOString().slice(0, 10))
    const tracker = createTracker({ state, storePath: path.join(dir, 'usage.json') })
    message(tracker, 's1', 1)
    tracker.handleEvent({ id: 's1' }, { type: 'turn/end' })
    assert.equal(state.events.length, 1)
    const event = state.events[0]
    assert.ok(event.cost > 0)
    assert.equal(event.model, 'deepseek-flash')
    assert.equal(event.input, 1e6)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a turn that finishes after midnight is booked to its own day', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bf-'))
  try {
    const now = Date.now()
    const bjDay = (ms) => new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10)
    const today = bjDay(now)
    // One minute before Beijing midnight: yesterday, deterministically.
    const messageMs = Date.parse(today + 'T00:00:00Z') - 8 * 3600 * 1000 - 60000
    const yesterday = bjDay(messageMs)
    const state = freshState(today)
    state.history[yesterday] = 5
    const tracker = createTracker({ state, storePath: path.join(dir, 'usage.json') })
    // A message stamped yesterday, even though the turn ends "now".
    tracker.handleEvent(
      { id: 's1' },
      {
        type: 'assistant/message',
        time: messageMs,
        data: {
          turn: 1,
          usage: { inputTokens: 1e6, cacheReadTokens: 0, outputTokens: 0 },
          message: { createdAt: messageMs, source: { model: 'deepseek-flash' } },
        },
      },
    )
    tracker.handleEvent({ id: 's1' }, { type: 'turn/end' })
    const event = state.events.at(-1)
    assert.equal(event.day, yesterday)
    // Today's counter keeps only today's spend.
    assert.equal(state.todayUsage, 0)
    assert.ok(state.history[yesterday] >= 5)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a balance poll that changes nothing does not dirty the ledger', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bf-'))
  try {
    const state = freshState(new Date().toISOString().slice(0, 10))
    const tracker = createTracker({ state, storePath: path.join(dir, 'usage.json') })
    tracker.applyBalance(10)
    tracker.flushNow()
    const stamp = state.updatedAt
    // Same balance again: the ledger object must not be marked as changed.
    // (`updatedAt` is only stamped when something actually moved.)
    tracker.applyBalance(10)
    assert.equal(state.updatedAt, stamp)
    assert.equal(state.lastBalance, 10)
    assert.equal(state.todayUsage, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
