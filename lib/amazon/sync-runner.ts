// Server-side Amazon runner, copy-adapted from scripts/nightly-sync.mjs.
// The .mjs scripts remain the Mac/launchd path and are NOT modified.
// Google supplies the dispatcher/log shape only; never import its implementation.
// No Pool, token mint, or sync executes at module load/build time.
// Async handoff: request-reports -> amazon_report_requests -> ingest-reports.
// Soft wall cap: 240 s BETWEEN reports; PARTIAL n/total, continues next run.
// Finish a report atomically, or roll it back at the 270 s cleanup deadline.
// LOG CONTRACT: INSERT start -> UPDATE finish (ok, rows_reported, detail).

import { Pool, neonConfig, type PoolClient } from '@neondatabase/serverless'
import { gunzipSync } from 'node:zlib'

export const KNOWN_STEPS = [
  'request-reports', 'ingest-reports', 'structure', 'rollup', 'sweep', 'stamp',
] as const
export type KnownStep = (typeof KNOWN_STEPS)[number]
export const NOT_YET_IMPLEMENTED: readonly KnownStep[] = ['structure', 'rollup', 'sweep', 'stamp']
export const ACTIVE_PROFILE_IDS = [
  '2263723137827296', // ES
  '139446882235960',  // US
  '395707988492653',
  '350599867165328',
  '1711934819800765',
] as const // Constant allowlist, ALSO requiring amazon_profiles.is_active.

const WALL_CAP_MS = 240_000
const CLEANUP_DEADLINE_MS = 270_000
const BATCH_SIZE = 500
const REGION_HOST: Record<string, string> = {
  NA: 'https://advertising-api.amazon.com',
  EU: 'https://advertising-api-eu.amazon.com',
  FE: 'https://advertising-api-fe.amazon.com',
}
const REPORT_TYPES = ['spCampaigns', 'spSearchTerm', 'spAdvertisedProduct'] as const
type ReportType = (typeof REPORT_TYPES)[number]
type ReportRow = Record<string, unknown>
interface Profile { profile_id: string; region: string; env_var_name: string }
interface ReportRequest {
  report_id: string; profile_id: string; report_type: ReportType
  status: string; expired: boolean
}
interface Metadata { reportId?: string; status?: string; url?: string; detail?: string }
interface ApiResult { status: number; body: Metadata }
export interface StepResult { ok: boolean; rows: number | null; detail: string | null }

class SyncError extends Error {}
class DeadlineError extends SyncError {}
// Only our bounded messages reach logs/responses; never remote bodies, signed URLs,
// raw database exceptions, or credential values.
function errorDetail(err: unknown): string {
  return err instanceof SyncError ? err.message.slice(0, 500) : 'Sync operation failed'
}
export function isKnownStep(s: string): s is KnownStep {
  return (KNOWN_STEPS as readonly string[]).includes(s)
}
export function isAmazonDatabase(value: string | undefined): boolean {
  try {
    const url = new URL(value ?? '')
    return ['postgres:', 'postgresql:'].includes(url.protocol) &&
      /^ep-lucky-thunder-afwxriyy(-pooler)?\.[a-z0-9.-]+\.neon\.tech$/.test(url.hostname)
  } catch { return false }
}
function remaining(deadline: number): number {
  const ms = deadline - Date.now()
  if (ms <= 0) throw new DeadlineError('Cleanup deadline reached; report left for retry')
  return Math.min(ms, 30_000)
}
function reportWindow() {
  // Offset calendar days AFTER resolving Madrid today (DST-safe, including midnight).
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date())
  const midnight = Date.parse(`${today}T00:00:00Z`)
  return {
    startDate: new Date(midnight - 7 * 86_400_000).toISOString().slice(0, 10),
    endDate: new Date(midnight - 86_400_000).toISOString().slice(0, 10),
  }
}

// Copy-adapted 30 s AbortController helper. The timeout covers body consumption too.
async function fetchWithTimeout<T>(
  url: string, opts: RequestInit, label: string, deadline: number,
  consume: (res: Response) => Promise<T>,
): Promise<T> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), remaining(deadline))
  try {
    return await consume(await fetch(url, { ...opts, signal: ac.signal, cache: 'no-store' }))
  } catch (err) {
    if (ac.signal.aborted) throw new SyncError(`${label}: timed out`)
    throw err
  } finally { clearTimeout(timer) }
}

async function createApi(profile: Profile, deadline: number) {
  const host = REGION_HOST[profile.region]
  const refreshToken = process.env[profile.env_var_name]
  const { LWA_CLIENT_ID, LWA_CLIENT_SECRET } = process.env
  if (!host) throw new SyncError('Unknown profile region')
  if (!refreshToken || !LWA_CLIENT_ID || !LWA_CLIENT_SECRET) {
    throw new SyncError('Missing Amazon credentials')
  }
  const mintToken = () => fetchWithTimeout(
    'https://api.amazon.com/auth/o2/token',
    {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: refreshToken,
        client_id: LWA_CLIENT_ID, client_secret: LWA_CLIENT_SECRET,
      }),
    }, 'LWA token mint', deadline,
    async res => {
      if (!res.ok) throw new SyncError(`LWA token HTTP ${res.status}`)
      const data = await res.json()
      if (typeof data.access_token !== 'string' || !data.access_token) {
        throw new SyncError('LWA response missing access token')
      }
      return data.access_token as string
    },
  )
  let accessToken = await mintToken()
  // Copied 401 re-mint + single retry; never print Authorization or response bodies.
  return async (path: string, opts: RequestInit = {}): Promise<ApiResult> => {
    const send = () => fetchWithTimeout(
      `${host}${path}`, {
        ...opts,
        headers: {
          ...opts.headers, Authorization: `Bearer ${accessToken}`,
          'Amazon-Advertising-API-ClientId': LWA_CLIENT_ID,
          'Amazon-Advertising-API-Scope': profile.profile_id,
        },
      }, 'Amazon Ads request', deadline,
      async res => ({
        status: res.status,
        body: res.ok || res.status === 425 ? await res.json() as Metadata : {},
      }),
    )
    let result = await send()
    if (result.status === 401) {
      accessToken = await mintToken()
      result = await send()
    }
    // Recover the existing report after POST succeeded but its DB INSERT was lost.
    // Amazon's duplicate-report response identifies the original request UUID.
    if (result.status === 425 && path === '/reporting/reports' && opts.method === 'POST') {
      const duplicateId = result.body.reportId ??
        result.body.detail?.match(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i)?.[0]
      if (duplicateId) return { status: 200, body: { reportId: duplicateId } }
    }
    if (result.status < 200 || result.status >= 300) {
      throw new SyncError(`Amazon Ads HTTP ${result.status}`)
    }
    return result
  }
}
type Api = Awaited<ReturnType<typeof createApi>>

async function downloadReport(api: Api, reportId: string, deadline: number): Promise<ReportRow[]> {
  // Fresh signed URL, never stored. No auth headers on the signed S3 download.
  const { body: meta } = await api(`/reporting/reports/${encodeURIComponent(reportId)}`)
  if (!meta.url || meta.status !== 'COMPLETED') throw new SyncError('Report not ready for download')
  let gzBuf: Buffer | null = await fetchWithTimeout(
    meta.url, {}, 'Report download', deadline,
    async res => {
      if (!res.ok) throw new SyncError(`Report download HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    },
  )
  remaining(deadline)
  let decompressed: Buffer | null = gunzipSync(gzBuf)
  gzBuf = null
  const rows: unknown = JSON.parse(decompressed.toString('utf8'))
  decompressed = null
  remaining(deadline)
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new SyncError('Report payload is not an array of rows')
  }
  return rows as ReportRow[]
}

async function activeProfiles(client: PoolClient): Promise<Profile[]> {
  const { rows } = await client.query<Profile>(
    `SELECT p.profile_id::text, p.region, c.env_var_name
     FROM amazon_profiles p JOIN amazon_credentials c ON c.id = p.credential_id
     WHERE p.is_active AND p.profile_id = ANY($1::bigint[]) ORDER BY p.profile_id`,
    [ACTIVE_PROFILE_IDS],
  )
  return rows
}

async function requestReports(client: PoolClient, started: number): Promise<StepResult> {
  const profiles = await activeProfiles(client)
  const { startDate, endDate } = reportWindow()
  const total = profiles.length * REPORT_TYPES.length
  let done = 0, requested = 0, failures = 0
  const deadline = started + CLEANUP_DEADLINE_MS
  for (const profile of profiles) {
    let api: Api | undefined
    for (const type of REPORT_TYPES) {
      if (Date.now() - started >= WALL_CAP_MS) {
        return { ok: failures === 0, rows: requested, detail: `PARTIAL ${done}/${total}, continues next run` }
      }
      try {
        // With the step advisory lock, dashboard retries do not re-request known windows.
        const existing = await client.query(
          `SELECT report_id FROM amazon_report_requests
           WHERE profile_id = $1 AND report_type = $2 AND start_date = $3 AND end_date = $4
             AND status IN ('PENDING', 'COMPLETED', 'INGESTED') LIMIT 1`,
          [profile.profile_id, type, startDate, endDate],
        )
        if (!existing.rowCount) {
          api ??= await createApi(profile, deadline)
          const { body } = await api('/reporting/reports', {
            method: 'POST',
            headers: { 'Content-Type': 'application/vnd.createasyncreportrequest.v3+json' },
            body: JSON.stringify({
              name: `cdl-ads ${type} ${startDate}_${endDate}`,
              startDate, endDate, configuration: REPORTS[type].configuration,
            }),
          })
          if (typeof body.reportId !== 'string' || !body.reportId) throw new SyncError('Missing reportId')
          await client.query(
            `INSERT INTO amazon_report_requests
             (report_id, profile_id, report_type, start_date, end_date, status)
             VALUES ($1,$2,$3,$4,$5,'PENDING') ON CONFLICT (report_id) DO NOTHING`,
            [body.reportId, profile.profile_id, type, startDate, endDate],
          )
          requested++
        }
      } catch { failures++ }
      done++
    }
  }
  return { ok: failures === 0, rows: requested, detail: `REQUESTED ${requested}; checked ${done}/${total}; errors=${failures}` }
}

async function ingestReports(client: PoolClient, started: number): Promise<StepResult> {
  const profiles = new Map((await activeProfiles(client)).map(p => [p.profile_id, p]))
  const { rows: requests } = await client.query<ReportRequest>(
    `SELECT report_id, profile_id::text, report_type, status,
            requested_at < now() - interval '3 days' AS expired
     FROM amazon_report_requests
     WHERE status IN ('PENDING', 'COMPLETED') AND profile_id = ANY($1::bigint[])
       AND report_type = ANY($2::text[]) ORDER BY requested_at, report_id`,
    [[...profiles.keys()], REPORT_TYPES],
  )
  const apis = new Map<string, Api>()
  const deadline = started + CLEANUP_DEADLINE_MS
  let done = 0, landed = 0, failures = 0
  for (const request of requests) {
    if (Date.now() - started >= WALL_CAP_MS) {
      return { ok: failures === 0, rows: landed, detail: `PARTIAL ${done}/${requests.length}, continues next run` }
    }
    try {
      if (request.status === 'PENDING' && request.expired) {
        await client.query(
          `UPDATE amazon_report_requests SET status = 'EXPIRED', error = 'Pending for more than 3 days'
           WHERE report_id = $1 AND status = 'PENDING'`, [request.report_id],
        )
      } else {
        let api = apis.get(request.profile_id)
        if (!api) {
          api = await createApi(profiles.get(request.profile_id)!, deadline)
          apis.set(request.profile_id, api)
        }
        const { body: meta } = await api(`/reporting/reports/${encodeURIComponent(request.report_id)}`)
        if (meta.status === 'FAILED') {
          await client.query(
            `UPDATE amazon_report_requests SET status = 'FAILED', error = 'Amazon report FAILED'
             WHERE report_id = $1 AND status IN ('PENDING', 'COMPLETED')`, [request.report_id],
          )
          failures++
        } else if (meta.status === 'COMPLETED') {
          await client.query(
            `UPDATE amazon_report_requests SET status = 'COMPLETED', error = NULL
             WHERE report_id = $1 AND status IN ('PENDING', 'COMPLETED')`, [request.report_id],
          )
          const rows = await downloadReport(api, request.report_id, deadline)
          landed += await ingestTransaction(client, request, rows, deadline)
        } else if (!['PENDING', 'PROCESSING', 'IN_PROGRESS'].includes(meta.status ?? '')) {
          throw new SyncError('Unknown Amazon report status')
        }
      }
    } catch (err) {
      failures++
      await client.query(
        `UPDATE amazon_report_requests SET error = $2
         WHERE report_id = $1 AND status IN ('PENDING', 'COMPLETED')`,
        [request.report_id, errorDetail(err)],
      )
      if (err instanceof DeadlineError) {
        return { ok: false, rows: landed, detail: `PARTIAL ${done}/${requests.length}, continues next run` }
      }
    }
    done++
  }
  return { ok: failures === 0, rows: landed, detail: `INGESTED rows=${landed}; checked ${done}/${requests.length}; errors=${failures}` }
}

async function ingestTransaction(
  client: PoolClient, request: ReportRequest, rows: ReportRow[], deadline: number,
): Promise<number> {
  remaining(deadline)
  await client.query('BEGIN')
  try {
    // Atomic claim + landing: a concurrent old downloader cannot race the final status.
    const locked = await client.query(
      `SELECT status FROM amazon_report_requests WHERE report_id = $1 FOR UPDATE`, [request.report_id],
    )
    if (!['PENDING', 'COMPLETED'].includes(locked.rows[0]?.status)) {
      await client.query('ROLLBACK')
      return 0
    }
    const spec = REPORTS[request.report_type]
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(remaining(deadline))])
      const values: unknown[] = []
      const placeholders = rows.slice(i, i + BATCH_SIZE).map(row => {
        const data = spec.values(request.profile_id, row)
        const base = values.length
        values.push(...data)
        return `(${data.map((_, j) => `$${base + j + 1}`).join(',')})`
      }).join(',')
      await client.query(`${spec.insert} VALUES ${placeholders} ${spec.conflict}`, values)
    }
    remaining(deadline)
    await client.query(
      `UPDATE amazon_report_requests SET status = 'INGESTED', completed_at = now(), error = NULL
       WHERE report_id = $1`, [request.report_id],
    )
    await client.query('COMMIT')
    return rows.length
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

// Entire lifecycle guarded, including log INSERT/UPDATE and cleanup: never throws.
export async function runStep(step: KnownStep): Promise<StepResult> {
  let pool: Pool | undefined, client: PoolClient | undefined, logId: string | undefined
  let locked = false
  const started = Date.now()
  let result: StepResult = { ok: false, rows: null, detail: null }
  try {
    if (!isAmazonDatabase(process.env.DATABASE_URL)) throw new SyncError('WRONG DATABASE')
    neonConfig.webSocketConstructor = WebSocket
    pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000, statement_timeout: 30_000 })
    // Attach an idle-error listener so the Pool cannot emit an unhandled error.
    pool.on('error', () => { result = { ...result, ok: false, detail: 'Database connection failed' } })
    client = await pool.connect()
    const start = await client.query(
      'INSERT INTO amazon_sync_log (run_started_at, step, ok) VALUES (now(), $1, null) RETURNING id', [step],
    )
    logId = start.rows[0].id
    if (NOT_YET_IMPLEMENTED.includes(step)) {
      result = { ok: false, rows: null, detail: 'not implemented' }
    } else {
      const lock = await client.query(
        "SELECT pg_try_advisory_lock(hashtext('amazon-vercel-sync'), hashtext($1)) AS locked", [step],
      )
      locked = lock.rows[0].locked
      result = !locked ? { ok: true, rows: 0, detail: 'Already running' }
        : step === 'request-reports' ? await requestReports(client, started)
        : await ingestReports(client, started)
    }
  } catch (err) {
    result = { ...result, ok: false, detail: errorDetail(err) }
  } finally {
    try {
      if (client && logId) await client.query(
        `UPDATE amazon_sync_log SET run_finished_at = now(), ok = $1, rows_reported = $2, detail = $3 WHERE id = $4`,
        [result.ok, result.rows, result.detail, logId],
      )
    } catch { result = { ...result, ok: false, detail: 'Sync log finish failed' } }
    try {
      if (client && locked) await client.query(
        "SELECT pg_advisory_unlock(hashtext('amazon-vercel-sync'), hashtext($1))", [step],
      )
    } catch { result = { ...result, ok: false, detail: 'Sync lock cleanup failed' } }
    try { client?.release(true) } catch { result.ok = false }
    try { await pool?.end() } catch { result.ok = false }
  }
  return result
}

interface ReportSpec {
  configuration: {
    adProduct: string; groupBy: string[]; columns: string[]
    reportTypeId: string; timeUnit: string; format: string
  }
  insert: string
  conflict: string
  values: (profileIdStr: string, row: ReportRow) => unknown[]
}

// Exact configuration bodies, column mapping and ON CONFLICT clauses from the
// three nightly phases. Only campaign-daily's row-by-row INSERT becomes batches.
const REPORTS: Record<ReportType, ReportSpec> = {
  spCampaigns: {
    configuration: {
        adProduct:    'SPONSORED_PRODUCTS',
        groupBy:      ['campaign'],
        columns:      ['campaignId', 'date', 'impressions', 'clicks', 'cost',
                       'purchases14d', 'sales14d'],
        reportTypeId: 'spCampaigns',
        timeUnit:     'DAILY',
        format:       'GZIP_JSON',
      },
    insert: `INSERT INTO amazon_campaign_daily
             (profile_id, campaign_id, date, impressions, clicks, cost,
              purchases_14d, sales_14d, raw)`,
    conflict: `ON CONFLICT (profile_id, campaign_id, date) DO UPDATE SET
             impressions   = EXCLUDED.impressions,
             clicks        = EXCLUDED.clicks,
             cost          = EXCLUDED.cost,
             purchases_14d = EXCLUDED.purchases_14d,
             sales_14d     = EXCLUDED.sales_14d,
             raw           = EXCLUDED.raw,
             landed_at     = now()`,
    values: (profileIdStr, row) => [
      profileIdStr,
            row.campaignId != null ? String(row.campaignId) : null,
            row.date          ?? null,
            row.impressions   ?? null,
            row.clicks        ?? null,
            row.cost          ?? null,
            row.purchases14d  ?? null,
            row.sales14d      ?? null,
            row,
    ],
  },
  spSearchTerm: {
    configuration: {
        adProduct:    'SPONSORED_PRODUCTS',
        groupBy:      ['searchTerm'],
        columns:      ['campaignId', 'adGroupId', 'keywordId', 'searchTerm', 'matchType',
                       'date', 'impressions', 'clicks', 'cost', 'purchases14d', 'sales14d'],
        reportTypeId: 'spSearchTerm',
        timeUnit:     'DAILY',
        format:       'GZIP_JSON',
      },
    insert: `INSERT INTO amazon_search_term_daily
             (profile_id, campaign_id, ad_group_id, keyword_id, search_term,
              match_type, date, impressions, clicks, cost, purchases_14d, sales_14d, raw)`,
    conflict: `ON CONFLICT (profile_id, campaign_id, ad_group_id, keyword_id, search_term, date)
           DO UPDATE SET
             impressions   = EXCLUDED.impressions,
             clicks        = EXCLUDED.clicks,
             cost          = EXCLUDED.cost,
             purchases_14d = EXCLUDED.purchases_14d,
             sales_14d     = EXCLUDED.sales_14d,
             raw           = EXCLUDED.raw,
             landed_at     = now()`,
    values: (profileIdStr, row) => [
      profileIdStr,
            row.campaignId  != null ? String(row.campaignId)  : null,
            row.adGroupId   != null ? String(row.adGroupId)   : null,
            row.keywordId   != null ? String(row.keywordId)   : '-',
            row.searchTerm,
            row.matchType,
            row.date,
            row.impressions,
            row.clicks,
            row.cost,
            row.purchases14d,
            row.sales14d,
            row,
    ],
  },
  spAdvertisedProduct: {
    configuration: {
        adProduct:    'SPONSORED_PRODUCTS',
        groupBy:      ['advertiser'],
        columns:      ['adId', 'adGroupId', 'campaignId', 'advertisedAsin',
                       'date', 'impressions', 'clicks', 'cost',
                       'purchases14d', 'sales14d'],
        reportTypeId: 'spAdvertisedProduct',
        timeUnit:     'DAILY',
        format:       'GZIP_JSON',
      },
    insert: `INSERT INTO amazon_advertised_product_daily
             (profile_id, ad_id, ad_group_id, campaign_id, asin, date,
              impressions, clicks, cost, purchases_14d, sales_14d, raw)`,
    conflict: `ON CONFLICT (profile_id, ad_id, date) DO UPDATE SET
             ad_group_id   = EXCLUDED.ad_group_id,
             campaign_id   = EXCLUDED.campaign_id,
             asin          = EXCLUDED.asin,
             impressions   = EXCLUDED.impressions,
             clicks        = EXCLUDED.clicks,
             cost          = EXCLUDED.cost,
             purchases_14d = EXCLUDED.purchases_14d,
             sales_14d     = EXCLUDED.sales_14d,
             raw           = EXCLUDED.raw,
             landed_at     = now()`,
    values: (profileIdStr, row) => [
      profileIdStr,
            row.adId          != null ? String(row.adId)          : null,
            row.adGroupId     != null ? String(row.adGroupId)     : null,
            row.campaignId    != null ? String(row.campaignId)    : null,
            row.advertisedAsin ?? null,
            row.date           ?? null,
            row.impressions    ?? null,
            row.clicks         ?? null,
            row.cost           ?? null,
            row.purchases14d   ?? null,
            row.sales14d       ?? null,
            row,
    ],
  },
}
