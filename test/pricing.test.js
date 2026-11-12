import assert from 'node:assert/strict'
import test from 'node:test'
import { beijingDay, costOf, isPeak, nextPeakChange } from '../lib/pricing.js'

/** Epoch seconds for a Beijing wall-clock instant. */
function bj(y, m, d, hh, mm = 0) {
  return Math.floor(Date.UTC(y, m - 1, d, hh, mm) / 1000) - 8 * 3600
}

test('peak windows are 09-12 and 14-18 on a weekday', () => {
  // 2026-11-12 is a Thursday.
  assert.equal(isPeak(bj(2026, 11, 12, 9, 30)), true)
  assert.equal(isPeak(bj(2026, 11, 12, 12, 30)), false)
  assert.equal(isPeak(bj(2026, 11, 12, 14, 30)), true)
  assert.equal(isPeak(bj(2026, 11, 12, 18, 30)), false)
})

test('weekends and listed holidays are valley all day', () => {
  assert.equal(isPeak(bj(2026, 11, 14, 10, 0)), false) // Saturday
  assert.equal(isPeak(bj(2026, 10, 2, 10, 0)), false) // National Day
})

test('nextPeakChange returns the next hour edge', () => {
  const at = bj(2026, 11, 12, 11, 30)
  assert.equal(nextPeakChange(at), bj(2026, 11, 12, 12, 0))
})

test('beijingDay shifts to the Beijing calendar', () => {
  assert.equal(beijingDay(Date.UTC(2026, 10, 12, 15, 30)), '2026-11-12')
  assert.equal(beijingDay(Date.UTC(2026, 10, 12, 16, 30)), '2026-11-13')
})

test('costOf bills cached, uncached and output tokens separately', () => {
  const usage = { cacheReadTokens: 1e6, inputTokens: 1e6, outputTokens: 1e6 }
  const valley = costOf('deepseek-flash', usage, bj(2026, 11, 12, 22, 0))
  const peak = costOf('deepseek-flash', usage, bj(2026, 11, 12, 10, 0))
  assert.equal(Number(valley.toFixed(6)), 5.02)
  assert.equal(Number(peak.toFixed(6)), 10.04)
})

test('costOf treats pro ids as the pro tier', () => {
  const usage = { cacheReadTokens: 0, inputTokens: 1e6, outputTokens: 0 }
  assert.equal(costOf('deepseek-v4-pro', usage, bj(2026, 11, 12, 22, 0)), 4.5)
})
