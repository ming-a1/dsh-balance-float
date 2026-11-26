/**
 * 火山方舟额度：Host 半区路由，并入 @lls-a1/dsh-balance-float。
 *
 * 从 @local/ark-quota 插件搬过来，路径不变：
 * - GET  /ark-quota/summary      汇总余额 + Agent Plan + Coding Plan（60 秒缓存，?fresh=1 绕过）
 * - GET  /ark-quota/credentials  返回是否已配置与 AK 掩码
 * - POST /ark-quota/credentials  保存 AK/SK（失败回滚）
 * - DELETE /ark-quota/credentials 清除 AK/SK
 *
 * AK/SK 存在 DSH 凭据库（ARK_QUOTA_ACCESS_KEY / ARK_QUOTA_SECRET_KEY），不出 Host 进程。
 */
import { createHash, createHmac } from 'node:crypto'

const AK_REF = 'ARK_QUOTA_ACCESS_KEY'
const SK_REF = 'ARK_QUOTA_SECRET_KEY'
const CACHE_MS = 60_000
const TIMEOUT_MS = 12_000

/** V4 签名：与火山官方 SDK 的 Authorization 逐字节一致。`date` 仅用于测试注入。 */
function signRequest({ accessKeyId, secretAccessKey, host, region, service, action, version, body = '{}', date = new Date() }) {
  const xDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const shortDate = xDate.slice(0, 8)
  const query = `Action=${action}&Version=${version}`
  const payloadHash = createHash('sha256').update(body).digest('hex')
  const signedHeaders = 'host;x-content-sha256;x-date'
  const canonicalHeaders = `host:${host}\nx-content-sha256:${payloadHash}\nx-date:${xDate}\n`
  const canonicalRequest = ['POST', '/', query, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${shortDate}/${region}/${service}/request`
  const stringToSign = ['HMAC-SHA256', xDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n')
  const hmac = (key, value) => createHmac('sha256', key).update(value).digest()
  const signingKey = hmac(hmac(hmac(hmac(secretAccessKey, shortDate), region), service), 'request')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  return {
    url: `https://${host}/?${query}`,
    headers: {
      'Content-Type': 'application/json',
      Host: host,
      'X-Date': xDate,
      'X-Content-Sha256': payloadHash,
      Authorization: `HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  }
}

const num = (value) => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : null
}

function toBar({ label, used, total, percent, resetAt }) {
  const u = num(used)
  const t = num(total)
  let p = num(percent)
  if (p === null && u !== null && t !== null && t > 0) p = (u / t) * 100
  if (p !== null) p = Math.max(0, Math.min(100, p))
  return {
    label,
    used: u,
    total: t,
    percent: p === null ? null : Math.round(p * 10) / 10,
    resetAt: typeof resetAt === 'number' && resetAt > 0 ? resetAt : null,
  }
}

async function callOpenApi({ accessKeyId, secretAccessKey, host, region, service, action, version, body: payload = {} }) {
  const body = JSON.stringify(payload ?? {})
  const signed = signRequest({ accessKeyId, secretAccessKey, host, region, service, action, version, body })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let response
  try {
    response = await fetch(signed.url, { method: 'POST', headers: signed.headers, body, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
  const text = await response.text()
  let json
  try {
    json = text === '' ? {} : JSON.parse(text)
  } catch {
    throw new Error(`返回不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
  const meta = json?.ResponseMetadata
  if (meta?.Error) throw new Error(`${meta.Error.Code ?? 'OpenApiError'}: ${meta.Error.Message ?? '请求失败'}`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return json?.Result ?? json
}

function readAfpUsage(result) {
  const buckets = [
    ['AFPFiveHour', '近 5 小时用量'],
    ['AFPWeekly', '近一周用量'],
    ['AFPMonthly', '近一月用量'],
  ]
  const bars = []
  for (const [key, label] of buckets) {
    const bucket = result?.[key]
    if (!bucket) continue
    const used = num(bucket.Used)
    const total = num(bucket.Quota) ?? num(bucket.Total)
    const percent = num(bucket.Percent)
    if (used === null && total === null && percent === null) continue
    let reset = num(bucket.ResetTime) ?? num(bucket.ResetTimestamp)
    if (reset !== null && reset < 1e12) reset *= 1000
    bars.push(toBar({ label, used, total, percent, resetAt: reset }))
  }
  const rawTier = [result?.PlanType, result?.Tier].find((value) => typeof value === 'string' && value.trim() !== '')
  const tier = rawTier ? rawTier.trim().replace(/^./, (c) => c.toUpperCase()) : null
  return { bars, tier }
}

function readCodingUsage(result) {
  const labels = { session: '会话', weekly: '本周', monthly: '本月' }
  const list = Array.isArray(result?.QuotaUsage) ? result.QuotaUsage : []
  return list.map((item) => {
    const level = String(item?.Level ?? '')
    const reset = num(item?.ResetTimestamp)
    return toBar({
      label: labels[level] ?? (level || '额度'),
      percent: item?.Percent,
      resetAt: reset !== null && reset < 1e12 ? reset * 1000 : reset,
    })
  })
}

const PLAN_CACHE_MS = 10 * 60 * 1000
let planCache = { at: 0, ak: '', value: null }

/**
 * 个人版套餐信息：档位 / 生效状态 / 起止时间 / 自动续费。
 * 未订阅时接口报 ResourceNotFound.Plan，按「未订阅」处理而不是错误。
 */
async function fetchPlans({ accessKeyId, secretAccessKey }) {
  if (planCache.ak === accessKeyId && planCache.value !== null && Date.now() - planCache.at < PLAN_CACHE_MS) {
    return planCache.value
  }
  const read = async (plan) => {
    try {
      const result = await callOpenApi({
        accessKeyId,
        secretAccessKey,
        host: 'ark.cn-beijing.volcengineapi.com',
        region: 'cn-beijing',
        service: 'ark',
        action: 'GetPersonalPlan',
        version: '2024-01-01',
        body: { Plan: plan },
      })
      return {
        plan,
        subscribed: true,
        planType: typeof result?.PlanType === 'string' ? result.PlanType : null,
        status: typeof result?.Status === 'string' ? result.Status : null,
        startTime: typeof result?.StartTime === 'string' ? result.StartTime : null,
        endTime: typeof result?.EndTime === 'string' ? result.EndTime : null,
        autoRenew: result?.AutoRenew === true,
        error: null,
      }
    } catch (error) {
      const message = String(error?.message ?? error)
      const missing = /ResourceNotFound|not found|未订阅|不存在/i.test(message)
      return { plan, subscribed: missing ? false : null, planType: null, status: null, startTime: null, endTime: null, autoRenew: false, error: missing ? null : message }
    }
  }
  const [agent, coding] = await Promise.all([read('AgentPlan'), read('CodingPlan')])
  const value = { agent, coding }
  planCache = { at: Date.now(), ak: accessKeyId, value }
  return value
}

async function fetchSummary({ accessKeyId, secretAccessKey }) {
  const summary = { at: Date.now(), balance: null, agentPlan: null, codingPlan: null, plans: null, errors: [] }
  await Promise.all([
    callOpenApi({
      accessKeyId,
      secretAccessKey,
      host: 'billing.volcengineapi.com',
      region: 'cn-north-1',
      service: 'billing',
      action: 'QueryBalanceAcct',
      version: '2022-01-01',
    })
      .then((result) => {
        summary.balance = {
          available: num(result?.AvailableBalance),
          cash: num(result?.CashBalance),
          arrears: num(result?.ArrearsBalance),
          credit: num(result?.CreditLimit),
          freeze: num(result?.FreezeAmount),
          accountId: result?.AccountID ?? null,
        }
      })
      .catch((error) => summary.errors.push({ part: '余额', message: String(error?.message ?? error) })),
    callOpenApi({
      accessKeyId,
      secretAccessKey,
      host: 'ark.cn-beijing.volcengineapi.com',
      region: 'cn-beijing',
      service: 'ark',
      action: 'GetAFPUsage',
      version: '2024-01-01',
    })
      .then((result) => {
        const { bars, tier } = readAfpUsage(result)
        summary.agentPlan = { subscribed: true, tier, bars }
      })
      .catch((error) => {
        const message = String(error?.message ?? error)
        const unsubscribed = /not\s*subscri|no\s*subscri|未订阅|订阅不存在/i.test(message)
        summary.agentPlan = unsubscribed ? { subscribed: false, bars: [] } : { subscribed: null, bars: [], error: message }
      }),
    callOpenApi({
      accessKeyId,
      secretAccessKey,
      host: 'ark.cn-beijing.volcengineapi.com',
      region: 'cn-beijing',
      service: 'ark',
      action: 'GetCodingPlanUsage',
      version: '2024-01-01',
    })
      .then((result) => {
        const bars = readCodingUsage(result)
        summary.codingPlan = { subscribed: bars.length > 0, bars }
      })
      .catch((error) => {
        summary.codingPlan = { subscribed: null, bars: [], error: String(error?.message ?? error) }
      }),
    fetchPlans({ accessKeyId, secretAccessKey })
      .then((plans) => {
        summary.plans = plans
      })
      .catch((error) => summary.errors.push({ part: '套餐', message: String(error?.message ?? error) })),
  ])
  return summary
}

/** JSON 响应。 */
function respondJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('请求体不是 JSON'), { status: 400 })
  }
}

const mask = (value) => (value.length <= 8 ? `${value.slice(0, 2)}***` : `${value.slice(0, 4)}***${value.slice(-4)}`)

/**
 * 注册火山额度路由；返回一次性 disposer。
 * @param ctx 需要 webServer 与 credentials 服务。
 */
export function registerArkQuota(ctx) {
  let cache = { at: 0, ak: '', value: null }

  const credentialState = async () => {
    const ak = await ctx.credentials.resolve(AK_REF)
    const sk = await ctx.credentials.resolve(SK_REF)
    return { ak: ak?.value ?? '', sk: sk?.value ?? '', akMasked: ak?.value ? mask(ak.value) : null }
  }

  const guard = (res, req) => {
    const rejection = ctx.get('connection')?.requestRejection?.({ headers: req.headers })
    if (rejection === undefined) return false
    respondJson(res, rejection === 401 ? 401 : 403, { ok: false, code: 'forbidden' })
    return true
  }

  const disposeSummary = ctx.webServer.register({
    kind: 'exact',
    path: '/ark-quota/summary',
    handler: async (req, res) => {
      if (req.method !== 'GET') return respondJson(res, 405, { ok: false, code: 'method-not-allowed' })
      if (guard(res, req)) return
      const fresh = new URL(req.url ?? '/', 'http://localhost').searchParams.get('fresh') === '1'
      const state = await credentialState()
      if (!state.ak || !state.sk) {
        return respondJson(res, 200, { ok: false, code: 'missing-credential', configured: false, summary: null })
      }
      if (!fresh && cache.value !== null && cache.ak === state.ak && Date.now() - cache.at < CACHE_MS) {
        return respondJson(res, 200, { ok: true, configured: true, akMasked: state.akMasked, cached: true, summary: cache.value })
      }
      try {
        const summary = await fetchSummary({ accessKeyId: state.ak, secretAccessKey: state.sk })
        cache = { at: Date.now(), ak: state.ak, value: summary }
        return respondJson(res, 200, { ok: true, configured: true, akMasked: state.akMasked, cached: false, summary })
      } catch (error) {
        return respondJson(res, 200, {
          ok: false,
          configured: true,
          akMasked: state.akMasked,
          code: 'query-failed',
          message: String(error?.message ?? error),
        })
      }
    },
  })

  const disposeCredential = ctx.webServer.register({
    kind: 'exact',
    path: '/ark-quota/credentials',
    handler: async (req, res) => {
      if (guard(res, req)) return
      if (req.method === 'GET') {
        const state = await credentialState()
        return respondJson(res, 200, { ok: true, configured: Boolean(state.ak && state.sk), akMasked: state.akMasked })
      }
      if (req.method === 'DELETE') {
        await ctx.credentials.unset(AK_REF)
        await ctx.credentials.unset(SK_REF)
        cache = { at: 0, ak: '', value: null }
        planCache = { at: 0, ak: '', value: null }
        return respondJson(res, 200, { ok: true, configured: false })
      }
      if (req.method !== 'POST') return respondJson(res, 405, { ok: false, code: 'method-not-allowed' })
      try {
        const body = await readJsonBody(req)
        const accessKeyId = String(body?.accessKeyId ?? '').trim()
        const secretAccessKey = String(body?.secretAccessKey ?? '').trim()
        if (!accessKeyId || !secretAccessKey) {
          return respondJson(res, 400, { ok: false, code: 'invalid', message: 'AK 和 SK 都不能为空' })
        }
        if (accessKeyId.length > 512 || secretAccessKey.length > 512) {
          return respondJson(res, 400, { ok: false, code: 'invalid', message: 'AK/SK 长度异常' })
        }
        const previousAk = (await ctx.credentials.resolve(AK_REF))?.value ?? ''
        const previousSk = (await ctx.credentials.resolve(SK_REF))?.value ?? ''
        await ctx.credentials.set(AK_REF, accessKeyId)
        try {
          await ctx.credentials.set(SK_REF, secretAccessKey)
        } catch (error) {
          if (previousAk === '') await ctx.credentials.unset(AK_REF).catch(() => {})
          else await ctx.credentials.set(AK_REF, previousAk).catch(() => {})
          if (previousSk === '') await ctx.credentials.unset(SK_REF).catch(() => {})
          throw error
        }
        const state = await credentialState()
        cache = { at: 0, ak: '', value: null }
        planCache = { at: 0, ak: '', value: null }
        return respondJson(res, 200, { ok: true, configured: true, akMasked: state.akMasked })
      } catch (error) {
        return respondJson(res, error?.status ?? 500, { ok: false, code: 'save-failed', message: String(error?.message ?? error) })
      }
    },
  })

  return () => {
    disposeSummary()
    disposeCredential()
  }
}

// 供测试直接引用的内部实现（生产路径只走 registerArkQuota）。
export { signRequest, fetchSummary }
