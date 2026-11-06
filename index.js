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
import { execFile } from 'node:child_process'
import { appendFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadState, resolvePaths, saveState } from './lib/ledger.js'
import { buildSnapshot } from './lib/snapshot.js'
import { createTracker } from './lib/tracker.js'

/**
 * This package's own version, shown in the widget footer.
 *
 * Read lazily and cached by mtime: a host that is only reloaded rarely (or a
 * hot-linked workspace) must not keep serving the version it saw at boot.
 */
let versionCache = { mtimeMs: -1, value: '' }
function packageVersion() {
  try {
    const file = new URL('./package.json', import.meta.url)
    const stat = statSync(file)
    if (stat.mtimeMs !== versionCache.mtimeMs) {
      const pkg = JSON.parse(readFileSync(file, 'utf8'))
      versionCache = { mtimeMs: stat.mtimeMs, value: typeof pkg.version === 'string' ? pkg.version : '' }
    }
    return versionCache.value
  } catch {
    return ''
  }
}

/**
 * Compare two dotted versions: true when `a` is newer than `b`.
 * Non-numeric parts are ignored so a pre-release tag never beats a release.
 */
function isNewer(a, b) {
  const parse = (value) => String(value).replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? 0
    const y = right[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/** Cached check against the published package.json on the default branch. */
const UPDATE_TTL_MS = 5 * 60 * 1000
// Only the *published* version is cached; `current` is re-read every call so a
// locally bumped version never reports the value cached minutes ago.
let updateCache = { at: 0, latest: null }

async function checkUpdate({ fresh = false } = {}) {
  const now = Date.now()
  const current = packageVersion()
  // A manual click must never be answered from the cache: the published version
  // can change right after a silent check.
  if (!fresh && updateCache.latest !== null && now - updateCache.at < UPDATE_TTL_MS) {
    return { ok: true, current, latest: updateCache.latest, hasUpdate: isNewer(updateCache.latest, current) }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    // api.github.com is reachable on hosts where raw.githubusercontent.com is
    // not (and it needs no token for a public repo).
    const response = await fetch(
      'https://api.github.com/repos/ming-a1/dsh-balance-float/contents/package.json?ref=main',
      {
        signal: controller.signal,
        headers: { accept: 'application/vnd.github.raw', 'user-agent': 'dsh-balance-float' },
      },
    )
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const pkg = JSON.parse(await response.text())
    const latest = typeof pkg?.version === 'string' ? pkg.version : ''
    if (latest !== '') updateCache = { at: now, latest }
    return { ok: true, current, latest, hasUpdate: latest !== '' && isNewer(latest, current) }
  } catch (error) {
    // Do not cache failures: the next click retries.
    return { ok: false, current, latest: '', hasUpdate: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * In-place self-update: download the default branch tarball, unpack it and copy
 * every file except `.git` over this package. The running Host keeps executing
 * the old module until it is reloaded, so the browser half is told to reload.
 */
let updateJob = { phase: 'idle', percent: 0, message: '', version: '', at: 0 }

function setJob(patch) {
  updateJob = { ...updateJob, ...patch, at: Date.now() }
}

async function downloadTarball(dest) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60000)
  try {
    const response = await fetch(TARBALL_URL, { signal: controller.signal, headers: { 'user-agent': 'dsh-balance-float' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length') || 0)
    const chunks = []
    let received = 0
    for await (const chunk of response.body) {
      chunks.push(chunk)
      received += chunk.length
      // Keep 100% for the copy phase, the download itself stops at 90%.
      if (total > 0) setJob({ phase: 'download', percent: Math.min(90, Math.round((received / total) * 90)) })
    }
    writeFileSync(dest, Buffer.concat(chunks))
  } finally {
    clearTimeout(timer)
  }
}

function unpack(tarball, dir) {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xzf', tarball, '-C', dir], (error) => (error ? reject(error) : resolve()))
  })
}

async function runUpdate() {
  setJob({ phase: 'download', percent: 0, message: '', version: '', at: Date.now() })
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-balance-float-'))
  try {
    const tarball = path.join(dir, 'src.tar.gz')
    await downloadTarball(tarball)
    setJob({ phase: 'unpack', percent: 92 })
    await unpack(tarball, dir)
    const extracted = readdirSync(dir).find((name) => name.startsWith('dsh-balance-float-'))
    if (extracted === undefined) throw new Error('archive layout unexpected')
    const source = path.join(dir, extracted)
    setJob({ phase: 'apply', percent: 96 })
    for (const name of readdirSync(source)) {
      if (name === '.git') continue
      cpSync(path.join(source, name), path.join(PACKAGE_DIR, name), { recursive: true, force: true })
    }
    setJob({ phase: 'done', percent: 100, version: packageVersion() })
  } catch (error) {
    setJob({ phase: 'error', percent: 0, message: error instanceof Error ? error.message : String(error) })
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // temp cleanup is best effort
    }
  }
}

/** Version of the code loaded into this process (differs from disk after an in-place update). */
const BOOT_VERSION = packageVersion()

export const name = 'balance-float'

/** Services this plugin cannot work without (`credentials` is read optionally). */
export const inject = ['webServer', 'timer']

const ROUTE = '/balance-float/snapshot'
const ROUTE_UPDATE = '/balance-float/update'
const ROUTE_UPDATE_RUN = '/balance-float/update/run'
const ROUTE_UPDATE_STATUS = '/balance-float/update/status'
const ROUTE_RELOAD = '/balance-float/reload'
const ENTRY_ID = 'balance-float'
const TARBALL_URL = 'https://codeload.github.com/ming-a1/dsh-balance-float/tar.gz/refs/heads/main'
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url))
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
  const reloadLog = path.join(path.dirname(paths.store), 'reload.log')
  const noteReload = (line) => {
    try {
      appendFileSync(reloadLog, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // diagnostics only
    }
  }
  noteReload(`module v${packageVersion()}`)
  // Which client-graph id does this bundle get? Needed to republish it after a
  // self-reload (rebuilt(id) is a no-op for an unknown id).
  try {
    const modules = ctx.get('modules')
    const entries = modules?.graph?.()?.entries ?? []
    const ids = entries.map((entry) => entry?.id).filter((id) => String(id).includes('float'))
    noteReload(`graph=[${ids.join(',')}]`)
  } catch (error) {
    noteReload(`graph error ${error instanceof Error ? error.message : String(error)}`)
  }
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
              version: packageVersion(),
              hostVersion: BOOT_VERSION,
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

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_UPDATE,
        handler: async (req, res) => {
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
            const fresh = new URL(req.url ?? '/', 'http://localhost').searchParams.get('fresh') === '1'
            respondJson(res, 200, await checkUpdate({ fresh }))
          } catch (error) {
            ctx.logger?.warn?.(`balance-float: update check failed: ${error instanceof Error ? error.message : String(error)}`)
            respondJson(res, 500, { ok: false, error: 'update check failed' })
          }
        },
      }),
    'balance-float: update route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_UPDATE_STATUS,
        handler: (req, res) => {
          const rejection = ctx.get('connection')?.requestRejection?.({ headers: req.headers })
          if (rejection !== undefined) {
            respondJson(res, rejection === 401 ? 401 : 403, { ok: false, error: 'forbidden' })
            return
          }
          respondJson(res, 200, { ok: true, job: updateJob })
        },
      }),
    'balance-float: update status route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_UPDATE_RUN,
        handler: (req, res) => {
          if (req.method !== 'POST') {
            respondJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const rejection = ctx.get('connection')?.requestRejection?.({ headers: req.headers })
          if (rejection !== undefined) {
            respondJson(res, rejection === 401 ? 401 : 403, { ok: false, error: 'forbidden' })
            return
          }
          if (updateJob.phase === 'download' || updateJob.phase === 'unpack' || updateJob.phase === 'apply') {
            respondJson(res, 200, { ok: true, job: updateJob })
            return
          }
          respondJson(res, 202, { ok: true, job: updateJob })
          void runUpdate()
        },
      }),
    'balance-float: update run route',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_RELOAD,
        handler: (req, res) => {
          if (req.method !== 'POST') {
            respondJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const rejection = ctx.get('connection')?.requestRejection?.({ headers: req.headers })
          if (rejection !== undefined) {
            respondJson(res, rejection === 401 ? 401 : 403, { ok: false, error: 'forbidden' })
            return
          }
          // Answer first, then dispose/re-init this very row: the response must
          // be flushed before the fiber that owns this handler goes away.
          respondJson(res, 202, { ok: true })
          noteReload(`start host=${BOOT_VERSION} disk=${packageVersion()}`)
          setTimeout(() => {
            void (async () => {
              try {
                const loader = ctx.get('loader')
                const entries = loader === undefined || typeof loader.entries !== 'function' ? [] : [...loader.entries()]
                const ids = entries.map((row) => row.id ?? row.options?.id ?? '?')
                noteReload(`entries=${ids.length} ids=${ids.join(',')}`)
                const entry = entries.find(
                  (row) =>
                    (row.id ?? row.options?.id) === ENTRY_ID ||
                    row.options?.id === ENTRY_ID ||
                    row.options?.name === 'dsh-balance-float',
                )
                if (entry === undefined) {
                  noteReload('row not found')
                  ctx.logger?.warn?.('balance-float: reload requested but the row was not found')
                  return
                }
                // Node caches ES modules by URL: drop our entries so refresh()
                // re-evaluates the files the updater just wrote. The cache is a
                // Map subclass whose own methods are patched, so go through
                // Map.prototype exactly like the HMR service does.
                const hmr = ctx.get('hmr')
                const urls = typeof hmr?.esmUrls === 'function' ? hmr.esmUrls() : []
                const cache = loader?.internal?.loadCache
                let busted = 0
                if (cache !== undefined && cache !== null) {
                  for (const url of urls) {
                    if (typeof url !== 'string' || !url.includes('/balance-float/')) continue
                    Map.prototype.delete.call(cache, url)
                    busted += 1
                  }
                }
                const sample = urls.filter((url) => typeof url === 'string' && url.includes('balance-float')).slice(0, 2).join(' ')
                noteReload(`bust=${busted}/${urls.length} ${sample}`)
                // Re-publish the client bundle: the browser bundle URL carries a
                // rev derived from the file, and without this the boot graph keeps
                // the old rev (the pill silently disappears after the update).
                let rebuiltRev = 'none'
                try {
                  const modules = ctx.get('modules')
                  if (typeof modules?.rebuilt === 'function') {
                    for (const id of ['dsh-balance-float', 'balance-float', 'include:balance-float']) {
                      const rev = modules.rebuilt(id)
                      if (rev !== undefined) {
                        rebuiltRev = `${id}:${rev}`
                        break
                      }
                    }
                  }
                } catch (error) {
                  rebuiltRev = `error:${error instanceof Error ? error.message : String(error)}`
                }
                noteReload(`rebuilt=${rebuiltRev}`)
                await entry.fiber?.dispose?.()
                // Entry.refresh() returns early while `fiber` still points at the
                // disposed instance, so clear it and re-init explicitly.
                try {
                  entry.fiber = undefined
                } catch {
                  // frozen entry: fall through to refresh
                }
                if (typeof entry.init === 'function') await entry.init()
                else await entry.refresh?.()
                noteReload('done')
              } catch (error) {
                noteReload(`failed ${error instanceof Error ? error.message : String(error)}`)
                ctx.logger?.warn?.(`balance-float: self reload failed: ${error instanceof Error ? error.message : String(error)}`)
              }
            })()
          }, 400)
        },
      }),
    'balance-float: reload route',
  )

  // First reading right after activation; the interval below covers the rest.
  schedulePoll(1200)
}
