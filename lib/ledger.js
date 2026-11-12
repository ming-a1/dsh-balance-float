/**
 * Local usage ledger owned by this plugin.
 *
 * The widget used to read the ledger another balance widget maintained. It now
 * owns the file: the Host half appends one event per settled turn, refreshes
 * the balance from the configured DeepSeek credential, and persists atomically
 * under `$DSH_HOME/balance-float/usage.json`.
 *
 * On first run it seeds itself from a legacy ledger when one exists, so the
 * shown balance/today/history do not jump on the takeover.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LEGACY_UNIT, beijingDay } from './pricing.js'

/** Keep the ledger bounded; older events only feed the daily totals. */
export const MAX_EVENTS = 1200

/** DSH home, with the documented fallback when the env var is absent. */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * Resolve the store file and the legacy ledger path.
 *
 * @param config - raw row config (`storeFile` / `legacyFile` overrides).
 * @returns `{ store, legacy }` absolute paths.
 */
export function resolvePaths(config) {
  const configuredStore = typeof config?.storeFile === 'string' ? config.storeFile.trim() : ''
  const configuredLegacy = typeof config?.legacyFile === 'string' ? config.legacyFile.trim() : ''
  return {
    store: configuredStore !== '' ? path.resolve(configuredStore) : path.join(dshHome(), 'balance-float', 'usage.json'),
    legacy: configuredLegacy !== '' ? path.resolve(configuredLegacy) : path.join(dshHome(), '.dshw-usage.json'),
  }
}

/** Parse one JSON file; null when missing or unreadable. */
function readJson(file) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return null
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return data !== null && typeof data === 'object' ? { data, mtimeMs: stat.mtimeMs } : null
  } catch {
    return null
  }
}

/** A fresh ledger for one Beijing day. */
export function emptyState(day = beijingDay()) {
  return {
    version: 1,
    date: day,
    dayStart: null,
    lastBalance: null,
    todayUsage: 0,
    history: {},
    events: [],
    balanceSource: null,
    balanceAt: null,
    updatedAt: new Date().toISOString(),
  }
}

/** Finite number or null. */
function numOrNull(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Convert a legacy balance-widget ledger into this plugin's shape.
 *
 * @param legacy - parsed legacy ledger.
 * @param now - epoch milliseconds.
 */
export function seedFromLegacy(legacy, now = Date.now()) {
  const day = beijingDay(now)
  const state = emptyState(day)
  if (legacy === null || typeof legacy !== 'object') return state

  state.date = typeof legacy.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(legacy.date) ? legacy.date : day
  state.dayStart = numOrNull(legacy.dayStart)
  state.lastBalance = numOrNull(legacy.lastBalance)
  if (state.lastBalance === null) {
    // Legacy accounting stores 1e-8 units; the newest day's closing balance is
    // the last usable value when `lastBalance` is absent.
    const book = legacy.accounting?.books?.[legacy.accounting?.active]
    const days = book?.days && typeof book.days === 'object' ? Object.keys(book.days).sort() : []
    const last = days.length > 0 ? book.days[days[days.length - 1]] : null
    const units = numOrNull(last?.lastUnits)
    if (units !== null) state.lastBalance = units / LEGACY_UNIT
  }
  state.todayUsage = Math.max(0, numOrNull(legacy.todayUsage) ?? 0)
  if (legacy.history !== null && typeof legacy.history === 'object') {
    for (const key of Object.keys(legacy.history)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
      const value = numOrNull(legacy.history[key])
      if (value !== null) state.history[key] = value
    }
  }
  const events = Array.isArray(legacy.events) ? legacy.events : []
  state.events = events
    .filter((event) => event !== null && typeof event === 'object')
    .map((event) => ({
      ts: numOrNull(event.ts) ?? 0,
      day: typeof event.day === 'string' ? event.day : day,
      model: String(event.model || 'unknown'),
      cost: Math.max(0, numOrNull(event.cost) ?? 0),
      tokens: Math.max(0, numOrNull(event.tokens) ?? 0),
    }))
    .filter((event) => event.ts > 0)
    .sort((a, b) => a.ts - b.ts)
    .slice(-MAX_EVENTS)
  if (state.history[day] === undefined) state.history[day] = state.todayUsage
  state.balanceSource = 'ledger'
  state.balanceAt = now
  return state
}

/** Guard a stored ledger against partial/corrupt content. */
function normalize(state, now) {
  const base = emptyState(beijingDay(now))
  if (state === null || typeof state !== 'object') return base
  const merged = { ...base, ...state }
  merged.version = 1
  merged.date = typeof merged.date === 'string' ? merged.date : base.date
  merged.dayStart = numOrNull(merged.dayStart)
  merged.lastBalance = numOrNull(merged.lastBalance)
  merged.todayUsage = Math.max(0, numOrNull(merged.todayUsage) ?? 0)
  merged.history = merged.history !== null && typeof merged.history === 'object' ? merged.history : {}
  merged.events = Array.isArray(merged.events) ? merged.events.slice(-MAX_EVENTS) : []
  merged.balanceAt = numOrNull(merged.balanceAt)
  return merged
}

/**
 * Load the plugin's own ledger, or seed from the legacy one.
 *
 * @param config - raw row config.
 * @param now - epoch milliseconds.
 * @returns `{ state, path, mtimeMs, seeded }`.
 */
export function loadState(config, now = Date.now()) {
  const { store, legacy } = resolvePaths(config)
  const own = readJson(store)
  if (own !== null) {
    return { state: normalize(own.data, now), path: store, mtimeMs: own.mtimeMs, seeded: false }
  }
  const old = readJson(legacy)
  if (old !== null) {
    const seeded = seedFromLegacy(old.data, now)
    return { state: seeded, path: store, mtimeMs: old.mtimeMs, seeded: true }
  }
  return { state: emptyState(beijingDay(now)), path: store, mtimeMs: 0, seeded: false }
}

/**
 * Persist the ledger atomically (temp file + rename).
 *
 * @param file - store path.
 * @param state - ledger object.
 * @returns true on success.
 */
export function saveState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // Persist a shallow copy: saving must not mutate the caller's object, and
    // `updatedAt` belongs to the file, not to the in-memory ledger.
    const snapshot = { ...state, updatedAt: new Date().toISOString() }
    const text = JSON.stringify(snapshot)
    const temp = file + '.tmp-' + process.pid
    fs.writeFileSync(temp, text, 'utf8')
    fs.renameSync(temp, file)
    return true
  } catch {
    return false
  }
}
