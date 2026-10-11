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
const REPORT_TYPES = ['spCampaigns', 'spSearchTerm', 'spAdvertisedProduct', 'sbCampaigns', 'sdCampaigns', 'sbLegacyCampaigns'] as const
type ReportType = (typeof REPORT_TYPES)[number]
type ReportRow = Record<string, unknown>
interface Profile { profile_id: string; region: string; env_var_name: string }
interface ReportRequest {
  report_id: string; profile_id: string; report_type: ReportType
  status: string; expired: boolean; start_date?: string; end_date?: string
}
interface Campaign {
  campaignId: string | number; name: string; state: string; campaignType?: string
  targetingType?: string; startDate?: string; endDate?: string
  budget?: { budget?: number; budgetType?: string }
}
interface Metadata { campaigns?: Campaign[]; nextToken?: string; reportId?: string; status?: string; url?: string; detail?: string }
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

export async function createApi(profile: Profile, deadline: number) {
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
  const request = async (path: string, opts: RequestInit = {}): Promise<ApiResult> => {
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
        body: res.ok || res.status === 425 || (res.status === 400 && path === '/reporting/reports') ? parseExactJson(await res.text()) as Metadata : {},
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
      if (result.status === 400 && path === '/reporting/reports') {
        // Keep report-schema/date validation findings visible. Never adapt the
        // requested columns or retry a different attribution basis automatically.
        throw new SyncError(`Amazon report HTTP 400: ${String(result.body.detail ?? 'invalid report request').replace(/https?:\/\/\S+/g, '[URL]')}`)
      }
      throw new SyncError(`Amazon Ads HTTP ${result.status}`)
    }
    return result
  }
  return Object.assign(request, {
    // Follow the authenticated API redirect manually; never send credentials to S3.
    downloadLegacy: async (reportId: string): Promise<Buffer> => {
      const download = () => fetchWithTimeout(`${host}/v2/reports/${encodeURIComponent(reportId)}/download`, {
        redirect: 'manual', headers: {
          Authorization: `Bearer ${accessToken}`, 'Amazon-Advertising-API-ClientId': LWA_CLIENT_ID,
          'Amazon-Advertising-API-Scope': profile.profile_id,
        },
      }, 'Legacy report download', deadline, async res => {
        if ([301,302,303,307,308].includes(res.status)) {
          const location = res.headers.get('location')
          if (!location || new URL(location).protocol !== 'https:') throw new SyncError('Invalid report download redirect')
          return fetchWithTimeout(location, {}, 'Legacy S3 download', deadline, async file => {
            if (!file.ok) throw new SyncError(`Report download HTTP ${file.status}`)
            return Buffer.from(await file.arrayBuffer())
          })
        }
        if (!res.ok) throw new SyncError(`Report download HTTP ${res.status}`)
        return Buffer.from(await res.arrayBuffer())
      })
      try { return await download() } catch (err) {
        if (!(err instanceof SyncError) || err.message !== 'Report download HTTP 401') throw err
        accessToken = await mintToken()
        return download()
      }
    },
  })
}
type Api = Awaited<ReturnType<typeof createApi>>

// Tokenize strings first so digit-like campaign names/escaped JSON remain intact.
// JSON.parse alone rounds the 18-digit legacy IDs before a reviver can save them.
export function parseExactJson(text: string): unknown {
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (token, number) => {
    if (number && /^-?\d+$/.test(number) && !Number.isSafeInteger(Number(number))) return `"${number}"`
    return token
  }))
}

function exactCampaignId(value: unknown): string {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  throw new SyncError('Missing or imprecise campaign ID')
}

export function reportJobs(startDate: string, endDate: string) {
  const jobs = REPORT_TYPES.filter(type => type !== 'sbLegacyCampaigns')
    .map(type => ({ type: type as ReportType, startDate, endDate }))
  for (let date = startDate; date <= endDate; date = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0,10)) {
    jobs.push({ type: 'sbLegacyCampaigns', startDate: date, endDate: date })
  }
  return jobs
}

export function requestCampaignReport(api: Api, type: ReportType, startDate: string, endDate: string) {
  if (type === 'sbLegacyCampaigns') {
    if (startDate !== endDate) throw new SyncError('Legacy report must cover exactly one day')
    return api('/v2/hsa/campaigns/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportDate: startDate.replaceAll('-', ''), creativeType: 'all',
        metrics: 'campaignId,campaignName,cost,attributedConversions14d,attributedSales14d' }),
    })
  }
  return api('/reporting/reports', {
    method: 'POST', headers: { 'Content-Type': 'application/vnd.createasyncreportrequest.v3+json' },
    body: JSON.stringify({ name: `cdl-ads ${type} ${startDate}_${endDate}`, startDate, endDate, configuration: REPORTS[type].configuration }),
  })
}

export async function v3SbPresence(client: PoolClient, profile: string, date: string) {
  const coverage = await client.query(
    `SELECT report_id FROM amazon_report_requests WHERE profile_id=$1 AND report_type='sbCampaigns'
      AND status='INGESTED' AND start_date <= $2::date AND end_date >= $2::date LIMIT 1`, [profile, date],
  )
  if (!coverage.rows.length) throw new SyncError('Legacy ingestion awaits ingested v3 SB report coverage for this day')
  const { rows } = await client.query(
    `SELECT campaign_id::text AS id, raw->>'campaignName' AS name FROM amazon_campaign_daily_other
      WHERE profile_id=$1 AND ad_product='SB' AND date=$2::date`, [profile, date],
  )
  if (rows.some(row => typeof row.name !== 'string')) throw new SyncError('Missing v3 SB campaign name')
  return { ids: new Set<string>(rows.map(row => exactCampaignId(row.id))), names: new Set<string>(rows.map(row => row.name)) }
}

export async function downloadLegacyReport(api: Api, reportId: string): Promise<ReportRow[]> {
  const buffer = await api.downloadLegacy(reportId)
  const rows = parseExactJson((buffer[0] === 31 && buffer[1] === 139 ? gunzipSync(buffer) : buffer).toString('utf8'))
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new SyncError('Invalid legacy report payload')
  return rows as ReportRow[]
}

export function legacyRows(rows: ReportRow[], present: { ids: Set<string>; names: Set<string> }, date: string): ReportRow[] {
  if (rows.some(row => typeof row.campaignName !== 'string')) throw new SyncError('Missing v2 SB campaign name')
  return rows.map(row => ({ ...row, campaignId: exactCampaignId(row.campaignId), campaignName: String(row.campaignName), date }))
    .filter(row => !present.ids.has(row.campaignId) && !present.names.has(String(row.campaignName)))
}

export async function downloadReport(api: Api, reportId: string, deadline: number): Promise<ReportRow[]> {
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
  const rows: unknown = parseExactJson(decompressed.toString('utf8'))
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
  const jobs = reportJobs(startDate, endDate)
  const total = profiles.length * jobs.length
  let done = 0, requested = 0, failures = 0
  const findings: string[] = []
  const deadline = started + CLEANUP_DEADLINE_MS
  for (const profile of profiles) {
    let api: Api | undefined
    for (const { type, startDate, endDate } of jobs) {
      if (Date.now() - started >= WALL_CAP_MS) {
        return { ok: failures === 0, rows: requested, detail: `PARTIAL ${done}/${total}, continues next run` }
      }
      try {
        // Retries skip known windows; legacy days refresh each Madrid day for attribution updates.
        const existing = await client.query(
          `SELECT report_id FROM amazon_report_requests
           WHERE profile_id = $1 AND report_type = $2 AND start_date = $3 AND end_date = $4
             AND status IN ('PENDING', 'COMPLETED', 'INGESTED')
             AND ($2 <> 'sbLegacyCampaigns' OR status <> 'INGESTED'
               OR requested_at >= (date_trunc('day', now() AT TIME ZONE 'Europe/Madrid') AT TIME ZONE 'Europe/Madrid'))
           LIMIT 1`,
          [profile.profile_id, type, startDate, endDate],
        )
        if (!existing.rowCount) {
          api ??= await createApi(profile, deadline)
          const { body } = await requestCampaignReport(api, type, startDate, endDate)
          if (typeof body.reportId !== 'string' || !body.reportId) throw new SyncError('Missing reportId')
          await client.query(
            `INSERT INTO amazon_report_requests
             (report_id, profile_id, report_type, start_date, end_date, status)
             VALUES ($1,$2,$3,$4,$5,'PENDING') ON CONFLICT (report_id) DO NOTHING`,
            [body.reportId, profile.profile_id, type, startDate, endDate],
          )
          requested++
        }
      } catch (err) { failures++; findings.push(`${profile.profile_id}/${type}: ${errorDetail(err)}`) }
      done++
    }
  }
  return { ok: failures === 0, rows: requested, detail: `REQUESTED ${requested}; checked ${done}/${total}; errors=${failures}${findings.length ? '; ' + findings.join('; ') : ''}` }
}

async function ingestReports(client: PoolClient, started: number): Promise<StepResult> {
  const profiles = new Map((await activeProfiles(client)).map(p => [p.profile_id, p]))
  const { rows: requests } = await client.query<ReportRequest>(
    `SELECT report_id, profile_id::text, report_type, status, start_date::text, end_date::text,
            requested_at < now() - interval '3 days' AS expired
     FROM amazon_report_requests
     WHERE status IN ('PENDING', 'COMPLETED') AND profile_id = ANY($1::bigint[])
       AND report_type = ANY($2::text[]) ORDER BY (report_type='sbLegacyCampaigns'), requested_at, report_id`,
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
        const legacy = request.report_type === 'sbLegacyCampaigns'
        const { body: meta } = await api(`${legacy ? '/v2/reports/' : '/reporting/reports/'}${encodeURIComponent(request.report_id)}`)
        if (['FAILED', 'FAILURE'].includes(meta.status ?? '')) {
          await client.query(
            `UPDATE amazon_report_requests SET status = 'FAILED', error = 'Amazon report FAILED'
             WHERE report_id = $1 AND status IN ('PENDING', 'COMPLETED')`, [request.report_id],
          )
          failures++
        } else if (meta.status === 'COMPLETED' || (legacy && meta.status === 'SUCCESS')) {
          await client.query(
            `UPDATE amazon_report_requests SET status = 'COMPLETED', error = NULL
             WHERE report_id = $1 AND status IN ('PENDING', 'COMPLETED')`, [request.report_id],
          )
          const rows = legacy
            ? await downloadLegacyReport(api, request.report_id)
            : await downloadReport(api, request.report_id, deadline)
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

export async function ingestTransaction(
  client: PoolClient, request: ReportRequest, rows: ReportRow[], deadline: number, options: { replayLegacy?: boolean } = {},
): Promise<number> {
  if (request.report_type === 'sbLegacyCampaigns') {
    if (!request.start_date || request.start_date !== request.end_date) throw new SyncError('Legacy report must cover exactly one day')
  }
  remaining(deadline)
  await client.query('BEGIN')
  try {
    // Atomic claim + landing: a concurrent old downloader cannot race the final status.
    const locked = await client.query(
      `SELECT status FROM amazon_report_requests WHERE report_id = $1 FOR UPDATE`, [request.report_id],
    )
    const replay = options.replayLegacy && request.report_type === 'sbLegacyCampaigns' && locked.rows[0]?.status === 'INGESTED'
    if (!replay && !['PENDING', 'COMPLETED'].includes(locked.rows[0]?.status)) {
      await client.query('ROLLBACK')
      return 0
    }
    if (request.report_type === 'sbLegacyCampaigns') {
      const present = await v3SbPresence(client, request.profile_id, request.start_date!)
      rows = legacyRows(rows, present, request.start_date!)
      // Replay/refresh replaces this day's filtered slice, removing any newly overlapping rows.
      await client.query(`DELETE FROM amazon_campaign_daily_other
        WHERE profile_id=$1 AND ad_product='SB_LEGACY' AND date=$2::date`, [request.profile_id, request.start_date])
    }
    const spec = request.report_type === 'sbLegacyCampaigns' ? LEGACY_REPORT : REPORTS[request.report_type]
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
    if (request.report_type === 'sbCampaigns' && rows.length) {
      // A later v3 arrival must also remove overlaps left by an earlier legacy ingestion.
      await client.query(`DELETE FROM amazon_campaign_daily_other l USING amazon_campaign_daily_other s
        WHERE l.profile_id=$1 AND l.ad_product='SB_LEGACY' AND s.profile_id=l.profile_id
          AND s.ad_product='SB' AND s.date=l.date AND s.date=ANY($2::date[])
          AND (s.campaign_id=l.campaign_id OR s.raw->>'campaignName'=l.raw->>'campaignName')`,
        [request.profile_id, [...new Set(rows.map(row => row.date))]])
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

// These four steps copy the mini's SQL/mappings; no script is imported/executed.
// Every unit is bounded, with a soft stop before the next page/row/horizon/profile.
async function stepQuery(client: PoolClient, deadline: number, sql: string, values: unknown[] = []) {
  await client.query("SELECT set_config('statement_timeout', $1, false)", [String(remaining(deadline))])
  return client.query(sql, values)
}

type MaintenanceStep = Exclude<KnownStep, 'request-reports' | 'ingest-reports'>
async function maintenanceStep(client: PoolClient, step: MaintenanceStep, started: number): Promise<StepResult> {
  const deadline = started + CLEANUP_DEADLINE_MS
  const profiles = await activeProfiles(client)
  let done = 0, rows = 0, failures = 0
  const partial = (): StepResult => ({
    ok: failures === 0, rows, detail: `PARTIAL ${done}/${profiles.length}, continues next run`,
  })
  for (const profile of profiles) {
    if (Date.now() - started >= WALL_CAP_MS) return partial()
    try {
      if (step === 'structure' || step === 'stamp') {
        const result = step === 'structure'
          ? await syncStructure(client, profile, started)
          : await stampProfile(client, profile, started)
        rows += result.rows ?? 0
        if (!result.ok) failures++
        if (result.detail?.startsWith('PARTIAL')) return partial()
      } else {
        const result = await stepQuery(client, deadline,
          step === 'sweep' ? SWEEP_SQL : ROLLUP_SQL,
          step === 'sweep' ? [profile.profile_id] : [3, profile.profile_id],
        )
        rows += result.rowCount ?? 0
      }
    } catch (err) {
      failures++
      if (err instanceof DeadlineError) return partial()
    }
    done++
  }
  return { ok: failures === 0, rows, detail: `${step.toUpperCase()} rows=${rows}; checked ${done}/${profiles.length}; errors=${failures}` }
}

// Display-only structure. These list calls never create/update Amazon entities.
export async function otherCampaignStructure(api: Api) {
  type Entity = Record<string, unknown>
  async function sbList(path: string, media: string, key: string): Promise<Entity[]> {
    const rows: Entity[] = [], tokens = new Set<string>()
    let nextToken: string | undefined
    do {
      const { body } = await api(path, { method: 'POST', headers: { 'Content-Type': media, Accept: media },
        body: JSON.stringify({ maxResults: 100, stateFilter: { include: ['ENABLED','PAUSED','ARCHIVED'] }, ...(nextToken ? { nextToken } : {}) }) })
      const payload = body as unknown as Record<string, unknown>
      if (!Array.isArray(payload[key])) throw new SyncError('Invalid SB structure list')
      rows.push(...payload[key] as Entity[])
      nextToken = typeof payload.nextToken === 'string' ? payload.nextToken : undefined
      if (nextToken && (tokens.has(nextToken) || tokens.size >= 50)) throw new SyncError('SB structure pagination failed')
      if (nextToken) tokens.add(nextToken)
    } while (nextToken)
    return rows
  }
  const sb = await sbList('/sb/v4/campaigns/list', 'application/vnd.sbcampaignresource.v4+json', 'campaigns')
  const formats = new Map<string, Set<string>>()
  // Campaign responses omit format; ads expose creative.type (e.g. BRAND_VIDEO).
  for (const ad of await sbList('/sb/v4/ads/list', 'application/vnd.sbadresource.v4+json', 'ads')) {
    const id = exactCampaignId(ad.campaignId)
    const creative = ad.creative as Record<string, unknown> | undefined
    const format = ad.adFormat ?? creative?.type
    if (typeof format === 'string') {
      if (!formats.has(id)) formats.set(id, new Set())
      formats.get(id)!.add(format)
    }
  }
  const sd: Entity[] = [], seen = new Set<string>()
  for (let start = 0; ; start += 100) {
    if (start >= 5000) throw new SyncError('SD structure page cap reached')
    const { body } = await api(`/sd/campaigns?startIndex=${start}&count=100&stateFilter=enabled,paused,archived`)
    if (!Array.isArray(body)) throw new SyncError('Invalid SD structure list')
    for (const c of body) {
      const id = exactCampaignId(c.campaignId)
      if (seen.has(id)) throw new SyncError('Repeated SD structure campaign')
      seen.add(id); sd.push(c)
    }
    if (body.length < 100) break
  }
  return [
    ...sb.map(c => normalizeOtherCampaign(c, 'sponsoredBrands', [...(formats.get(exactCampaignId(c.campaignId)) ?? [])])),
    ...sd.map(c => normalizeOtherCampaign(c, 'sponsoredDisplay', [])),
  ]
}

export function normalizeOtherCampaign(c: Record<string, unknown>, type: 'sponsoredBrands' | 'sponsoredDisplay', adFormats: string[]) {
  const date = (v: unknown) => typeof v === 'string' && /^\d{8}$/.test(v)
    ? `${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}` : v ?? null
  if (typeof c.name !== 'string' || typeof c.state !== 'string') throw new SyncError('Invalid campaign identity')
  const budget = typeof c.budget === 'object' && c.budget !== null ? (c.budget as Record<string, unknown>).budget : c.budget
  if (budget != null && !Number.isFinite(Number(budget))) throw new SyncError('Invalid campaign budget')
  return { campaignId: exactCampaignId(c.campaignId), name: c.name, state: c.state.toUpperCase(), type,
    startDate: date(c.startDate), endDate: date(c.endDate), budget: budget ?? null,
    budgetType: typeof c.budgetType === 'string' ? c.budgetType.toUpperCase() : null,
    raw: { ...c, displayAdFormats: adFormats } }
}

async function syncStructure(client: PoolClient, profile: Profile, started: number): Promise<StepResult> {
  const deadline = started + CLEANUP_DEADLINE_MS
  const media = 'application/vnd.spCampaign.v3+json'
  let nextToken: string | undefined, pages = 0, rows = 0
  const partial = (): StepResult => ({ ok: true, rows, detail: 'PARTIAL campaign list, continues next run' })
  try {
    const api = await createApi(profile, deadline)
    do {
      if (Date.now() - started >= WALL_CAP_MS) return partial()
      if (pages >= 50) throw new SyncError('Campaign list page cap reached')
      const { body } = await api('/sp/campaigns/list', {
        method: 'POST', headers: { 'Content-Type': media, Accept: media },
        body: JSON.stringify({ maxResults: 100, ...(nextToken ? { nextToken } : {}) }),
      })
      const campaigns = body.campaigns ?? []
      if (!Array.isArray(campaigns)) throw new SyncError('Invalid campaign list')
      if (campaigns.length) {
        const data = campaigns.map(c => [c.campaignId, profile.profile_id, c.name, c.state,
          c.campaignType ?? 'sponsoredProducts', c.targetingType ?? null, c.startDate ?? null,
          c.endDate ?? null, c.budget?.budget ?? null, c.budget?.budgetType ?? null, JSON.stringify(c)])
        const placeholders = data.map((row, i) => `(${row.map((_, j) => `$${i * 11 + j + 1}`).join(',')},now())`).join(',')
        await stepQuery(client, deadline, `INSERT INTO amazon_campaigns
          (campaign_id,profile_id,name,state,campaign_type,targeting_type,start_date,end_date,budget_amount,budget_type,raw,synced_at)
          VALUES ${placeholders}
          ON CONFLICT (campaign_id,profile_id) DO UPDATE SET name=EXCLUDED.name,state=EXCLUDED.state,
            campaign_type=EXCLUDED.campaign_type,targeting_type=EXCLUDED.targeting_type,
            start_date=EXCLUDED.start_date,end_date=EXCLUDED.end_date,budget_amount=EXCLUDED.budget_amount,
            budget_type=EXCLUDED.budget_type,raw=EXCLUDED.raw,synced_at=EXCLUDED.synced_at`, data.flat())
        rows += campaigns.length
      }
      pages++
      nextToken = body.nextToken ?? undefined
    } while (nextToken)
    const other = await otherCampaignStructure(api)
    for (let i = 0; i < other.length; i += 100) {
      if (Date.now() - started >= WALL_CAP_MS) return partial()
      const batch = other.slice(i, i + 100)
      const data = batch.map(c => [c.campaignId,profile.profile_id,c.name,c.state,c.type,
        c.startDate,c.endDate,c.budget,c.budgetType,JSON.stringify(c.raw)])
      const placeholders = data.map((row, n) => `(${row.map((_, j) => `$${n * 10 + j + 1}`).join(',')},now())`).join(',')
      await stepQuery(client, deadline, `INSERT INTO amazon_campaigns
        (campaign_id,profile_id,name,state,campaign_type,start_date,end_date,budget_amount,budget_type,raw,synced_at)
        VALUES ${placeholders}
        ON CONFLICT (campaign_id,profile_id) DO UPDATE SET name=EXCLUDED.name,state=EXCLUDED.state,
          campaign_type=EXCLUDED.campaign_type,start_date=EXCLUDED.start_date,end_date=EXCLUDED.end_date,
          budget_amount=EXCLUDED.budget_amount,budget_type=EXCLUDED.budget_type,raw=EXCLUDED.raw,synced_at=now()`, data.flat())
      rows += batch.length
    }
    return { ok: true, rows, detail: null }
  } catch (err) {
    return { ok: false, rows, detail: err instanceof DeadlineError ? 'PARTIAL campaign list, continues next run' : errorDetail(err) }
  }
}

const SWEEP_SQL = `
  WITH destinations AS (
    SELECT
      r.id,
      r.rec_type,
      r.target_text,
      r.profile_id,
      COALESCE(
        r.campaign_id,
        r.evidence #>> '{resolved_destination,campaign_id}',
        r.evidence ->> 'campaign_id',
        r.evidence #>> '{primary_placement,campaign_id}'
      ) AS destination_campaign_id,
      COALESCE(
        r.evidence #>> '{resolved_destination,ad_group_id}',
        r.evidence ->> 'ad_group_id',
        r.evidence #>> '{primary_placement,ad_group_id}'
      ) AS destination_ad_group_id
    FROM recommendations r
    WHERE r.status IN ('DRAFT', 'APPROVED')
      AND r.rec_type <> 'CREATE_STRUCTURE'
      AND r.profile_id = $1
  ),
  stale AS (
    SELECT
      d.id,
      d.rec_type,
      d.target_text,
      c.name AS campaign_name,
      COALESCE(c.state, 'MISSING') AS campaign_state,
      CASE
        WHEN d.destination_ad_group_id IS NULL THEN NULL
        ELSE COALESCE(ag.state, 'MISSING')
      END AS ad_group_state
    FROM destinations d
    LEFT JOIN amazon_campaigns c
      ON c.campaign_type = 'sponsoredProducts' AND c.profile_id = d.profile_id
     AND c.campaign_id = d.destination_campaign_id
    LEFT JOIN amazon_ad_groups ag
      ON ag.profile_id = d.profile_id
     AND ag.ad_group_id = d.destination_ad_group_id
     AND ag.campaign_id = d.destination_campaign_id
    WHERE c.state IS DISTINCT FROM 'ENABLED'
       OR (d.destination_ad_group_id IS NOT NULL AND ag.state IS DISTINCT FROM 'ENABLED')
  ),
     rejected AS (
       UPDATE recommendations r
          SET status   = 'REJECTED',
              ruled_at = now(),
              evidence = r.evidence || jsonb_build_object(
                'reject_reason', 'destination_not_enabled'
              )
         FROM stale s
        WHERE r.id = s.id
          AND r.status IN ('DRAFT', 'APPROVED')
       RETURNING r.id, r.ruled_at
     )
     SELECT
       s.id,
       s.rec_type,
       s.target_text,
       s.campaign_name,
       s.campaign_state,
       s.ad_group_state,
       rejected.ruled_at
     FROM stale s
     JOIN rejected USING (id)
     ORDER BY s.id`

const ROLLUP_SQL = `INSERT INTO daily_rollup
       (profile_id, date, currency, spend, sales, orders, clicks, impressions, acos, computed_at)
     SELECT
       d.profile_id,
       d.date,
       p.currency_code                       AS currency,
       SUM(d.cost)                           AS spend,
       SUM(d.sales_14d)                      AS sales,
       SUM(d.purchases_14d)::int             AS orders,
       SUM(d.clicks)::int                    AS clicks,
       SUM(d.impressions)                    AS impressions,
       CASE WHEN SUM(d.sales_14d) > 0
            THEN ROUND(SUM(d.cost) / SUM(d.sales_14d), 4)
            ELSE NULL
       END                                   AS acos,
       now()                                 AS computed_at
     FROM amazon_campaign_daily d
     JOIN amazon_profiles p ON p.profile_id = d.profile_id
     WHERE d.date >= CURRENT_DATE - ($1::int - 1)
       AND d.date <= CURRENT_DATE
       AND p.is_active AND d.profile_id = $2
     GROUP BY d.profile_id, d.date, p.currency_code
     ON CONFLICT (profile_id, date) DO UPDATE SET
       currency    = EXCLUDED.currency,
       spend       = EXCLUDED.spend,
       sales       = EXCLUDED.sales,
       orders      = EXCLUDED.orders,
       clicks      = EXCLUDED.clicks,
       impressions = EXCLUDED.impressions,
       acos        = EXCLUDED.acos,
       computed_at = EXCLUDED.computed_at`

interface StampRec {
  id: string; rec_type: string; campaign_id: string | null; target_text: string
  evidence: string | Record<string, string>; pushed_at_resolved: string
}
const HORIZONS = [{ key: 't7', days: 7 }, { key: 't14', days: 14 }, { key: 't30', days: 30 }] as const
const MS_PER_DAY = 86_400_000

async function stampProfile(client: PoolClient, profile: Profile, started: number): Promise<StepResult> {
  const deadline = started + CLEANUP_DEADLINE_MS
  let rows = 0, failures = 0
  const partial = (): StepResult => ({ ok: failures === 0, rows, detail: 'PARTIAL due horizons, continues next run' })
  try {
    const { rows: profRows } = await stepQuery(client, deadline,
      `SELECT gp_per_order::float AS gp_per_order FROM amazon_profiles WHERE profile_id = $1`,
      [profile.profile_id],
    )
    const gpPerOrder = profRows[0]?.gp_per_order != null ? Number(profRows[0].gp_per_order) : null
    const { rows: recs } = await stepQuery(client, deadline,
      `SELECT id, rec_type, profile_id, campaign_id, target_text, evidence,
              COALESCE(pushed_at, (evidence->>'pushed_at')::timestamptz) AS pushed_at_resolved
       FROM recommendations WHERE status = 'PUSHED' AND profile_id = $1
         AND COALESCE(pushed_at, (evidence->>'pushed_at')::timestamptz) IS NOT NULL
       ORDER BY id`, [profile.profile_id],
    )
    const stampedSet = new Set<string>()
    if (recs.length) {
      const { rows: existing } = await stepQuery(client, deadline,
        `SELECT rec_id::text, horizon FROM rec_outcomes WHERE rec_id = ANY($1::bigint[])`,
        [recs.map(r => r.id)],
      )
      for (const row of existing) stampedSet.add(`${row.rec_id}:${row.horizon}`)
    }
    const now = Date.now()
    for (const rec of recs as StampRec[]) {
      if (Date.now() - started >= WALL_CAP_MS) return partial()
      const pushedMs = new Date(rec.pushed_at_resolved).getTime()
      for (const horizon of HORIZONS) {
        if (Date.now() - started >= WALL_CAP_MS) return partial()
        if (pushedMs + horizon.days * MS_PER_DAY > now || stampedSet.has(`${rec.id}:${horizon.key}`)) continue
        const metrics = await captureOutcome(client, deadline, profile.profile_id, rec, horizon.days, gpPerOrder)
        if (metrics.capture_error) failures++
        // Unique primary key shared with the mini: the pre-read alone is NOT a lock.
        const written = await stepQuery(client, deadline,
          `INSERT INTO rec_outcomes (rec_id, horizon, metrics)
           VALUES ($1, $2, $3)
           ON CONFLICT (rec_id, horizon) DO NOTHING`,
          [rec.id, horizon.key, JSON.stringify(metrics)],
        )
        rows += written.rowCount ?? 0
        stampedSet.add(`${rec.id}:${horizon.key}`)
      }
    }
    return { ok: failures === 0, rows, detail: null }
  } catch (err) {
    return { ok: false, rows, detail: err instanceof DeadlineError ? 'PARTIAL due horizons, continues next run' : errorDetail(err) }
  }
}

// All handler queries, metric fields and before/after windows from stamp-outcomes.mjs.
async function captureOutcome(
  client: PoolClient, deadline: number, profileIdStr: string,
  rec: StampRec, days: number, gpPerOrder: number | null,
): Promise<Record<string, unknown>> {
  const gpBasis = gpPerOrder != null ? 'unit' : 'revenue'
  const ev = typeof rec.evidence === 'string' ? JSON.parse(rec.evidence) : rec.evidence
  const pushedAt = new Date(rec.pushed_at_resolved ?? ev.pushed_at)
  const pushedMs = pushedAt.getTime()
  const windowStart = pushedAt.toISOString().slice(0, 10)
  const windowEnd = new Date(pushedMs + days * MS_PER_DAY).toISOString().slice(0, 10)
  const beforeEnd = windowStart
  const beforeStart = new Date(pushedMs - days * MS_PER_DAY).toISOString().slice(0, 10)
  let metrics: Record<string, unknown> = { window_days: days, rows_found: 0 }
  try {
    // ── NEGATE_TERM ──────────────────────────────────────────────────────
    // Layer 3.1: sales_14d (after); before-window (cost, sales_14d,
    //   clicks, rows_found).
    // Layer 3.2: + purchases_14d (after); + before_purchases_14d;
    //             + gp_basis, gp_per_order
    if (rec.rec_type === 'NEGATE_TERM') {
      const { rows } = await stepQuery(client, deadline,
        `SELECT COALESCE(SUM(clicks),        0)::bigint AS clicks,
                COALESCE(SUM(cost),          0)         AS cost,
                COALESCE(SUM(purchases_14d), 0)::bigint AS purchases_14d,
                COALESCE(SUM(sales_14d),     0)         AS sales_14d,
                COUNT(*)::int                           AS rows_found
           FROM amazon_search_term_daily
          WHERE profile_id  = $1 AND search_term = $2
            AND date >= $3::date AND date < $4::date`,
        [profileIdStr, rec.target_text, windowStart, windowEnd],
      );
      const { rows: bRows } = await stepQuery(client, deadline,
        `SELECT COALESCE(SUM(clicks),        0)::bigint AS before_clicks,
                COALESCE(SUM(cost),          0)         AS before_cost,
                COALESCE(SUM(purchases_14d), 0)::bigint AS before_purchases_14d,
                COALESCE(SUM(sales_14d),     0)         AS before_sales_14d,
                COUNT(*)::int                           AS before_rows_found
           FROM amazon_search_term_daily
          WHERE profile_id  = $1 AND search_term = $2
            AND date >= $3::date AND date < $4::date`,
        [profileIdStr, rec.target_text, beforeStart, beforeEnd],
      );
      const r = rows[0]; const b = bRows[0];
      metrics = {
        ...metrics,
        clicks:               Number(r.clicks),
        cost:                 Number(r.cost),
        purchases_14d:        Number(r.purchases_14d),
        sales_14d:            Number(r.sales_14d),
        rows_found:           Number(r.rows_found),
        before_clicks:        Number(b.before_clicks),
        before_cost:          Number(b.before_cost),
        before_purchases_14d: Number(b.before_purchases_14d),
        before_sales_14d:     Number(b.before_sales_14d),
        before_rows_found:    Number(b.before_rows_found),
        gp_basis: gpBasis,
        gp_per_order:         gpPerOrder,
      };

    // ── NEGATE_TARGET ────────────────────────────────────────────────────
    // Layer 3.1: sales_14d (after); before-window (cost, sales_14d,
    //   clicks, rows_found).
    // Layer 3.2: + purchases_14d (after); + before_purchases_14d;
    //             + gp_basis, gp_per_order
    } else if (rec.rec_type === 'NEGATE_TARGET') {
      const targetAsin = (rec.target_text || '').toLowerCase();
      const { rows: ntRows } = await stepQuery(client, deadline,
        `SELECT COALESCE(SUM(clicks),        0)::bigint AS clicks,
                COALESCE(SUM(cost),          0)         AS cost,
                COALESCE(SUM(purchases_14d), 0)::bigint AS purchases_14d,
                COALESCE(SUM(sales_14d),     0)         AS sales_14d,
                COUNT(*)::int                           AS rows_found
           FROM amazon_search_term_daily
          WHERE profile_id = $1 AND LOWER(search_term) = $2
            AND date >= $3::date AND date < $4::date`,
        [profileIdStr, targetAsin, windowStart, windowEnd],
      );
      const { rows: nbRows } = await stepQuery(client, deadline,
        `SELECT COALESCE(SUM(clicks),        0)::bigint AS before_clicks,
                COALESCE(SUM(cost),          0)         AS before_cost,
                COALESCE(SUM(purchases_14d), 0)::bigint AS before_purchases_14d,
                COALESCE(SUM(sales_14d),     0)         AS before_sales_14d,
                COUNT(*)::int                           AS before_rows_found
           FROM amazon_search_term_daily
          WHERE profile_id = $1 AND LOWER(search_term) = $2
            AND date >= $3::date AND date < $4::date`,
        [profileIdStr, targetAsin, beforeStart, beforeEnd],
      );
      const ntr = ntRows[0]; const nb = nbRows[0];
      metrics = {
        ...metrics,
        clicks:               Number(ntr.clicks),
        cost:                 Number(ntr.cost),
        purchases_14d:        Number(ntr.purchases_14d),
        sales_14d:            Number(ntr.sales_14d),
        rows_found:           Number(ntr.rows_found),
        before_clicks:        Number(nb.before_clicks),
        before_cost:          Number(nb.before_cost),
        before_purchases_14d: Number(nb.before_purchases_14d),
        before_sales_14d:     Number(nb.before_sales_14d),
        before_rows_found:    Number(nb.before_rows_found),
        gp_basis: gpBasis,
        gp_per_order:         gpPerOrder,
      };

    // ── PROMOTE_TERM / CREATIVE_KEYWORD ──────────────────────────────────
    // Layer 3.1: before-window (cost, sales_14d, clicks,
    //   purchases_14d, rows_found).
    // Layer 3.2: + gp_basis, gp_per_order (purchases already present)
    } else if (rec.rec_type === 'PROMOTE_TERM' || rec.rec_type === 'CREATIVE_KEYWORD') {
      const { rows } = await stepQuery(client, deadline,
        `SELECT COALESCE(SUM(clicks),        0)::bigint AS clicks,
                COALESCE(SUM(cost),          0)         AS cost,
                COALESCE(SUM(purchases_14d), 0)::bigint AS purchases_14d,
                COALESCE(SUM(sales_14d),     0)         AS sales_14d,
                COUNT(*)::int                           AS rows_found
           FROM amazon_search_term_daily
          WHERE profile_id  = $1 AND search_term = $2
            AND date >= $3::date AND date < $4::date`,
        [profileIdStr, rec.target_text, windowStart, windowEnd],
      );
      const { rows: bRows } = await stepQuery(client, deadline,
        `SELECT COALESCE(SUM(clicks),        0)::bigint AS before_clicks,
                COALESCE(SUM(cost),          0)         AS before_cost,
                COALESCE(SUM(purchases_14d), 0)::bigint AS before_purchases_14d,
                COALESCE(SUM(sales_14d),     0)         AS before_sales_14d,
                COUNT(*)::int                           AS before_rows_found
           FROM amazon_search_term_daily
          WHERE profile_id  = $1 AND search_term = $2
            AND date >= $3::date AND date < $4::date`,
        [profileIdStr, rec.target_text, beforeStart, beforeEnd],
      );
      const r = rows[0]; const b = bRows[0];
      metrics = {
        ...metrics,
        clicks:               Number(r.clicks),
        cost:                 Number(r.cost),
        purchases_14d:        Number(r.purchases_14d),
        sales_14d:            Number(r.sales_14d),
        rows_found:           Number(r.rows_found),
        before_clicks:        Number(b.before_clicks),
        before_cost:          Number(b.before_cost),
        before_purchases_14d: Number(b.before_purchases_14d),
        before_sales_14d:     Number(b.before_sales_14d),
        before_rows_found:    Number(b.before_rows_found),
        gp_basis: gpBasis,
        gp_per_order:         gpPerOrder,
      };

    // ── PROMOTE_ASIN / CREATIVE_TARGET ───────────────────────────────────
    // Layer 3.1: before-window (cost, sales (sales_14d), clicks,
    //   purchases, rows_found).
    // Layer 3.2: + gp_basis, gp_per_order (purchases already present)
    } else if (rec.rec_type === 'PROMOTE_ASIN' || rec.rec_type === 'CREATIVE_TARGET') {
      const asin = rec.target_text.toLowerCase();
      const { rows } = await stepQuery(client, deadline,
        `SELECT COALESCE(SUM(clicks),        0)::bigint AS clicks,
                COALESCE(SUM(cost),          0)         AS cost,
                COALESCE(SUM(purchases_14d), 0)::bigint AS purchases,
                COALESCE(SUM(sales_14d),     0)         AS sales,
                COUNT(*)::int                           AS rows_found
           FROM amazon_search_term_daily
          WHERE profile_id = $1 AND LOWER(search_term) = $2
            AND date >= $3::date AND date < $4::date`,
        [profileIdStr, asin, windowStart, windowEnd],
      );
      const { rows: bRows } = await stepQuery(client, deadline,
        `SELECT COALESCE(SUM(clicks),        0)::bigint AS before_clicks,
                COALESCE(SUM(cost),          0)         AS before_cost,
                COALESCE(SUM(purchases_14d), 0)::bigint AS before_purchases,
                COALESCE(SUM(sales_14d),     0)         AS before_sales,
                COUNT(*)::int                           AS before_rows_found
           FROM amazon_search_term_daily
          WHERE profile_id = $1 AND LOWER(search_term) = $2
            AND date >= $3::date AND date < $4::date`,
        [profileIdStr, asin, beforeStart, beforeEnd],
      );
      const r = rows[0]; const b = bRows[0];
      metrics = {
        ...metrics,
        clicks:            Number(r.clicks),
        cost:              Number(r.cost),
        purchases:         Number(r.purchases),
        sales:             Number(r.sales),
        rows_found:        Number(r.rows_found),
        before_clicks:     Number(b.before_clicks),
        before_cost:       Number(b.before_cost),
        before_purchases:  Number(b.before_purchases),
        before_sales:      Number(b.before_sales),
        before_rows_found: Number(b.before_rows_found),
        gp_basis: gpBasis,
        gp_per_order:      gpPerOrder,
      };

    // ── REPLACE_PRODUCT_AD ───────────────────────────────────────────────
    // Layer 3.1: b0_sales, hc_sales (after-window); before-window for
    //   both B0 and HC.
    // Layer 3.2: + b0_orders (after); + before_b0_orders, before_hc_orders;
    //             + gp_basis, gp_per_order
    } else if (rec.rec_type === 'REPLACE_PRODUCT_AD') {
      const b0Asin = (ev.b0_asin   || '').toLowerCase();
      const hcAsin = (ev.hc_isbn10 || '').toLowerCase();
      const campId = String(ev.campaign_id ?? rec.campaign_id ?? '');

      // B0 after
      const { rows: b0Rows } = await stepQuery(client, deadline,
        `SELECT COALESCE(SUM(cost),          0)         AS b0_spend,
                COALESCE(SUM(clicks),        0)::bigint AS b0_clicks,
                COALESCE(SUM(impressions),   0)::bigint AS b0_impressions,
                COALESCE(SUM(purchases_14d), 0)::bigint AS b0_orders,
                COALESCE(SUM(sales_14d),     0)         AS b0_sales,
                COUNT(*)::int                           AS b0_rows_found
           FROM amazon_advertised_product_daily
          WHERE profile_id = $1 AND LOWER(asin) = $2 AND campaign_id = $3
            AND date >= $4::date AND date < $5::date`,
        [profileIdStr, b0Asin, campId, windowStart, windowEnd],
      );
      // HC after
      const { rows: hcRows } = await stepQuery(client, deadline,
        `SELECT COALESCE(SUM(cost),          0)         AS hc_spend,
                COALESCE(SUM(clicks),        0)::bigint AS hc_clicks,
                COALESCE(SUM(impressions),   0)::bigint AS hc_impressions,
                COALESCE(SUM(purchases_14d), 0)::bigint AS hc_orders,
                COALESCE(SUM(sales_14d),     0)         AS hc_sales,
                COUNT(*)::int                           AS hc_rows_found
           FROM amazon_advertised_product_daily
          WHERE profile_id = $1 AND LOWER(asin) = $2 AND campaign_id = $3
            AND date >= $4::date AND date < $5::date`,
        [profileIdStr, hcAsin, campId, windowStart, windowEnd],
      );
      // B0 before
      const { rows: b0bRows } = await stepQuery(client, deadline,
        `SELECT COALESCE(SUM(cost),          0)         AS before_b0_spend,
                COALESCE(SUM(purchases_14d), 0)::bigint AS before_b0_orders,
                COALESCE(SUM(sales_14d),     0)         AS before_b0_sales,
                COUNT(*)::int                           AS before_b0_rows_found
           FROM amazon_advertised_product_daily
          WHERE profile_id = $1 AND LOWER(asin) = $2 AND campaign_id = $3
            AND date >= $4::date AND date < $5::date`,
        [profileIdStr, b0Asin, campId, beforeStart, beforeEnd],
      );
      // HC before
      const { rows: hcbRows } = await stepQuery(client, deadline,
        `SELECT COALESCE(SUM(cost),          0)         AS before_hc_spend,
                COALESCE(SUM(purchases_14d), 0)::bigint AS before_hc_orders,
                COALESCE(SUM(sales_14d),     0)         AS before_hc_sales,
                COUNT(*)::int                           AS before_hc_rows_found
           FROM amazon_advertised_product_daily
          WHERE profile_id = $1 AND LOWER(asin) = $2 AND campaign_id = $3
            AND date >= $4::date AND date < $5::date`,
        [profileIdStr, hcAsin, campId, beforeStart, beforeEnd],
      );

      const b0 = b0Rows[0]; const hc = hcRows[0];
      const b0b = b0bRows[0]; const hcb = hcbRows[0];
      metrics = {
        ...metrics,
        grain:                'asin+campaign_id',
        b0_asin:              ev.b0_asin,
        hc_asin:              ev.hc_isbn10,
        b0_spend:             Number(b0.b0_spend),
        b0_clicks:            Number(b0.b0_clicks),
        b0_impressions:       Number(b0.b0_impressions),
        b0_orders:            Number(b0.b0_orders),
        b0_sales:             Number(b0.b0_sales),
        hc_spend:             Number(hc.hc_spend),
        hc_clicks:            Number(hc.hc_clicks),
        hc_impressions:       Number(hc.hc_impressions),
        hc_orders:            Number(hc.hc_orders),
        hc_sales:             Number(hc.hc_sales),
        before_b0_spend:      Number(b0b.before_b0_spend),
        before_b0_orders:     Number(b0b.before_b0_orders),
        before_b0_sales:      Number(b0b.before_b0_sales),
        before_b0_rows_found: Number(b0b.before_b0_rows_found),
        before_hc_spend:      Number(hcb.before_hc_spend),
        before_hc_orders:     Number(hcb.before_hc_orders),
        before_hc_sales:      Number(hcb.before_hc_sales),
        before_hc_rows_found: Number(hcb.before_hc_rows_found),
        rows_found:           Number(b0.b0_rows_found) + Number(hc.hc_rows_found),
        b0_rows_found:        Number(b0.b0_rows_found),
        hc_rows_found:        Number(hc.hc_rows_found),
        gp_basis: gpBasis,
        gp_per_order:         gpPerOrder,
      };

    // ── BID_ADJUST (incl. REVIVE) / BUDGET_ADJUST / PAUSE_CAMPAIGN / CREATE_STRUCTURE
    // Layer 3.1: before/after cost + sales already present.
    // Layer 3.2: + purchases_14d (after); + before_purchases_14d;
    //             + gp_basis, gp_per_order
    } else if (
      rec.rec_type === 'BID_ADJUST'       ||
      rec.rec_type === 'BUDGET_ADJUST'    ||
      rec.rec_type === 'PAUSE_CAMPAIGN'   ||
      rec.rec_type === 'CREATE_STRUCTURE'
    ) {
      const campId = String(ev.campaign_id ?? rec.campaign_id ?? rec.target_text);
      const { rows: curr } = await stepQuery(client, deadline,
        `SELECT COALESCE(SUM(cost),          0)         AS cost,
                COALESCE(SUM(purchases_14d), 0)::bigint AS purchases_14d,
                COALESCE(SUM(sales_14d),     0)         AS sales_14d,
                COALESCE(SUM(clicks),        0)::bigint AS clicks,
                COALESCE(SUM(impressions),   0)::bigint AS impressions,
                COUNT(*)::int                           AS rows_found
           FROM amazon_campaign_daily
          WHERE profile_id = $1 AND campaign_id = $2
            AND date >= $3::date AND date < $4::date`,
        [profileIdStr, campId, windowStart, windowEnd],
      );
      const { rows: before } = await stepQuery(client, deadline,
        `SELECT COALESCE(SUM(cost),          0)         AS before_cost,
                COALESCE(SUM(purchases_14d), 0)::bigint AS before_purchases_14d,
                COALESCE(SUM(sales_14d),     0)         AS before_sales_14d,
                COALESCE(SUM(clicks),        0)::bigint AS before_clicks,
                COALESCE(SUM(impressions),   0)::bigint AS before_impressions,
                COUNT(*)::int                           AS before_rows_found
           FROM amazon_campaign_daily
          WHERE profile_id = $1 AND campaign_id = $2
            AND date >= $3::date AND date < $4::date`,
        [profileIdStr, campId, beforeStart, beforeEnd],
      );
      const c = curr[0]; const b = before[0];
      metrics = {
        ...metrics,
        cost:                 Number(c.cost),
        purchases_14d:        Number(c.purchases_14d),
        sales_14d:            Number(c.sales_14d),
        clicks:               Number(c.clicks),
        impressions:          Number(c.impressions),
        rows_found:           Number(c.rows_found),
        before_cost:          Number(b.before_cost),
        before_purchases_14d: Number(b.before_purchases_14d),
        before_sales_14d:     Number(b.before_sales_14d),
        before_clicks:        Number(b.before_clicks),
        before_impressions:   Number(b.before_impressions),
        before_rows_found:    Number(b.before_rows_found),
        gp_basis: gpBasis,
        gp_per_order:         gpPerOrder,
      };
    }
  } catch (err) {
    if (err instanceof DeadlineError) throw err;
    metrics = { ...metrics, rows_found: 0, capture_error: errorDetail(err) };
  }
  return metrics
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
    const lock = await client.query(
      "SELECT pg_try_advisory_lock(hashtext('amazon-vercel-sync'), hashtext($1)) AS locked", [step],
    )
    locked = lock.rows[0].locked
    result = !locked ? { ok: true, rows: 0, detail: 'Already running' }
      : step === 'request-reports' ? await requestReports(client, started)
      : step === 'ingest-reports' ? await ingestReports(client, started)
      : await maintenanceStep(client, step, started)
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

const LEGACY_REPORT: Omit<ReportSpec, 'configuration'> = {
  insert: `INSERT INTO amazon_campaign_daily_other
    (profile_id, ad_product, campaign_id, date, impressions, clicks, cost, purchases, sales, raw)`,
  conflict: `ON CONFLICT (profile_id, ad_product, campaign_id, date) DO UPDATE SET
    impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks, cost=EXCLUDED.cost,
    purchases=EXCLUDED.purchases, sales=EXCLUDED.sales, raw=EXCLUDED.raw, landed_at=now()`,
  values: (profile, row) => {
    if (['cost','attributedConversions14d','attributedSales14d'].some(key => row[key] == null || !Number.isFinite(Number(row[key])))) {
      throw new SyncError('Legacy report required metrics missing')
    }
    return [profile, 'SB_LEGACY', exactCampaignId(row.campaignId), row.date, null, null,
      row.cost, row.attributedConversions14d, row.attributedSales14d, row]
  },
}

function otherCampaignReport(product: 'SB' | 'SD'): ReportSpec {
  return {
    configuration: {
      adProduct: product === 'SB' ? 'SPONSORED_BRANDS' : 'SPONSORED_DISPLAY',
      reportTypeId: product === 'SB' ? 'sbCampaigns' : 'sdCampaigns',
      groupBy: ['campaign'],
      columns: ['campaignId', 'campaignName', 'date', 'impressions', 'clicks', 'cost', 'purchases', 'sales'],
      timeUnit: 'DAILY', format: 'GZIP_JSON',
    },
    insert: `INSERT INTO amazon_campaign_daily_other
      (profile_id, ad_product, campaign_id, date, impressions, clicks, cost, purchases, sales, raw)`,
    conflict: `ON CONFLICT (profile_id, ad_product, campaign_id, date) DO UPDATE SET
      impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks, cost=EXCLUDED.cost,
      purchases=EXCLUDED.purchases, sales=EXCLUDED.sales, raw=EXCLUDED.raw, landed_at=now()`,
    values: (profileId, row) => {
      if (row.campaignId == null || typeof row.date !== 'string' ||
          ['impressions','clicks','cost','purchases','sales'].some(key => row[key] == null || !Number.isFinite(Number(row[key])))) {
        throw new SyncError(`Invalid ${product} campaign row; required metrics missing`)
      }
      return [profileId, product, String(row.campaignId), row.date, row.impressions, row.clicks, row.cost, row.purchases, row.sales, row]
    },
  }
}

// Exact configuration bodies, column mapping and ON CONFLICT clauses from the
// three nightly phases. Only campaign-daily's row-by-row INSERT becomes batches.
export const REPORTS: Record<Exclude<ReportType, 'sbLegacyCampaigns'>, ReportSpec> = {
  sbCampaigns: otherCampaignReport('SB'),
  sdCampaigns: otherCampaignReport('SD'),
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
