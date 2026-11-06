/**
 * Host half of the balance-float bundle.
 *
 * Owns the local usage ledger this widget shows:
 *
 * - folds every session's settled turns into per-model cost events (official
 *   CNY prices, peak/valley aware) and appends them to the ledger;
 * - polls the balance endpoint of the configured DeepSeek credential and
 *   derives today's spend from the day's opening balance;
 * - serves one read-only JSON snapshot on `/balance-float/snapshot` with the
 *   ledger, the current peak/valley window and the price table, so the pill and
 *   card agree with the Host clock.
 *
 * The route sits behind the Host's browser trust fence like every other
 * browser-facing endpoint. No credential value ever leaves the Host process and
 * nothing is logged about it.
 */
import { readFileSync } from 'node:fs'
import { loadState, resolvePaths, saveState } from './lib/ledger.js'
import { buildSnapshot } from './lib/snapshot.js'
import { createTracker } from './lib/tracker.js'

/** This package's own version, shown in the widget footer. */
const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
})()

export const name = 'balance-float'

/** Services this plugin cannot work without (`credentials` is read optionally). */
export const inject = ['webServer', 'timer']

const ROUTE = '/balance-float/snapshot'
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const BALANCE_TIMEOUT_MS = 8000

/** JSON response with the headers a same-origin poll expects. */
function respondJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

/** One usable number from a response field. */
function numeric(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Mount the ledger, the accounting listener, the balance poll and the route.
 *
 * @param ctx - plugin context.
 * @param config - row config: `storeFile`, `legacyFile`, `refreshSeconds`, `apiKeyRef`.
 */
export function apply(ctx, config) {
  const paths = resolvePaths(config)
  const loaded = loadState(config)
  const refreshSeconds = Number.isFinite(config?.refreshSeconds) ? Math.max(5, Math.floor(config.refreshSeconds)) : 20
  const apiKeyRef =
    typeof config?.apiKeyRef === 'string' && config.apiKeyRef.trim() !== '' ? config.apiKeyRef.trim() : 'DEEPSEEK_API_KEY'

  let pollTimer = null
  let polling = false

  const tracker = createTracker({
    state: loaded.state,
    storePath: paths.store,
    logger: ctx.logger,
    onTurn: () => schedulePoll(1500),
  })

  // Materialize the ledger right away: on a first run this persists the seed
  // copied from the legacy ledger, so the widget starts from known values.
  saveState(paths.store, tracker.state)
  const seededAt = Date.now()

  /** Read the configured credential and refresh the balance. */
  async function pollBalance() {
    if (polling) return
    polling = true
    try {
      const credentials = ctx.get('credentials')
      if (!credentials || typeof credentials.resolve !== 'function') return
      let credential
      try {
        credential = await credentials.resolve(apiKeyRef)
      } catch {
        return
      }
      const token = credential && typeof credential.value === 'string' ? credential.value : ''
      if (token === '') return
      const response = await fetch(BALANCE_URL, {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
        signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
      })
      if (!response.ok) return
      const payload = await response.json()
      const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : []
      const info = infos.find((entry) => String(entry?.currency || '').toUpperCase() === 'CNY') || infos[0]
      const total = numeric(info?.total_balance)
      if (total === null) return
      tracker.applyBalance(total, 'apikey')
    } catch (error) {
      ctx.logger?.debug?.(`balance-float: balance poll failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      polling = false
    }
  }

  /** Poll again soon, collapsing several turns into one request. */
  function schedulePoll(delay) {
    if (pollTimer !== null) return
    pollTimer = setTimeout(() => {
      pollTimer = null
      void pollBalance()
    }, delay)
    if (typeof pollTimer.unref === 'function') pollTimer.unref()
  }

  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        try {
          tracker.handleEvent(session, event)
        } catch (error) {
          ctx.logger?.warn?.(`balance-float: turn accounting failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }),
    'balance-float: turn accounting',
  )

  ctx.effect(() => ctx.timer.interval(() => void pollBalance(), refreshSeconds * 1000), 'balance-float: balance poll')

  ctx.effect(
    () => () => {
      if (pollTimer !== null) {
        clearTimeout(pollTimer)
        pollTimer = null
      }
      tracker.dispose()
    },
    'balance-float: ledger flush',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            respondJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const rejection = ctx.get('connection')?.requestRejection?.({ headers: req.headers })
          if (rejection !== undefined) {
            respondJson(res, rejection === 401 ? 401 : 403, { ok: false, error: 'forbidden' })
            return
          }
          try {
            const snapshot = buildSnapshot({
              ledger: tracker.state,
              sourcePath: paths.store,
              mtimeMs: tracker.lastSavedAt > 0 ? tracker.lastSavedAt : seededAt,
              serverNow: Date.now(),
              version: VERSION,
            })
            respondJson(res, 200, snapshot)
          } catch (error) {
            ctx.logger?.warn?.(`balance-float: snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
            respondJson(res, 500, { ok: false, error: 'snapshot failed' })
          }
        },
      }),
    'balance-float: snapshot route',
  )

  // First reading right after activation; the interval below covers the rest.
  schedulePoll(1200)
}
