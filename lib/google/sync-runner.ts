// lib/google/sync-runner.ts
// ─────────────────────────────────────────────────────────────────────────────
// Server-side runner: reimplements each Google Ads sync step for Vercel cron
// invocation. The six .mjs scripts in scripts/google/ remain the Mac/launchd
// path and are NOT modified. Logic is copy-adapted from those proven scripts.
//
// TARGETING TIMEOUT SAFETY:
//   Keyword batches of 500 (proven). Wall-time capped at 240 s per invocation.
//   If exceeded: finish the current batch, set ok=true, detail=
//   "PARTIAL <n>/<total>, continues next run". Idempotent upserts make this safe.
//
// LOG CONTRACT: identical to nightly-sync.mjs —
//   INSERT start row → run → UPDATE finish (ok, rows_reported, detail).
// ─────────────────────────────────────────────────────────────────────────────

import { GoogleAdsApi, enums } from 'google-ads-api'
import { Pool, neonConfig } from '@neondatabase/serverless'

neonConfig.webSocketConstructor = WebSocket

// ── Constants ────────────────────────────────────────────────────────────────

const CUSTOMER_ID   = '2199803274'
const ASSET_FLOOR   = '2025-06-05'   // asset per-day data exists from this date
const WALL_CAP_MS   = 240_000        // targeting wall-time safety cap (240 s)

export const KNOWN_STEPS = [
  'structure',
  'targeting',
  'campaign-daily',
  'search-terms',
  'asset-daily',
  'recommendations',
] as const

export type KnownStep = (typeof KNOWN_STEPS)[number]

export function isKnownStep(s: string): s is KnownStep {
  return (KNOWN_STEPS as readonly string[]).includes(s)
}

/** Maps Vercel cron route param → google_sync_log.step value */
const LOG_STEP: Record<KnownStep, string> = {
  'structure':       'sync-structure',
  'targeting':       'sync-targeting',
  'campaign-daily':  'sync-campaign-daily',
  'search-terms':    'sync-search-terms',
  'asset-daily':     'sync-asset-daily',
  'recommendations': 'sync-recommendations',
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface StepResult {
  ok:   boolean
  rows: number | null
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Europe/Madrid date string with optional day offset (copy of nightly-sync helper) */
function madridDate(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(d)
}

/**
 * Map enum integer → string name; pass strings through unchanged.
 * Returns undefined when integer is not in table (used for validation).
 * Returns null when v is null/undefined.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function en(table: any, v: any): string | null | undefined {
  if (v == null) return null
  return typeof v === 'number' ? (table as Record<number, string>)[v] : String(v)
}

/** null-safe IS metric — absent/null stays NULL, NEVER coerces to 0 */
const isField = (v: unknown): number | null =>
  v == null ? null : Number(v)

/** Split array into fixed-size chunks */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Validate enum mapping; throws on unmapped value (same guard as scripts) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function assertEnum(
  table: any,
  val: unknown,
  field: string,
): void {
  if (val != null && en(table, val) === undefined) {
    throw new Error(`UNMAPPED ENUM ${field} ${val}`)
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Run one sync step end-to-end.
 *   1. Insert google_sync_log start row (ok=null)
 *   2. Execute step logic
 *   3. Update finish (ok, rows_reported, detail)
 *
 * Never throws — errors are caught and persisted as ok=false.
 */
export async function runStep(step: KnownStep): Promise<StepResult> {
  const dbUrl = process.env.GOOGLE_DATABASE_URL!
  neonConfig.webSocketConstructor = WebSocket
  const logPool = new Pool({ connectionString: dbUrl })

  const { rows: startRows } = await logPool.query<{ id: number }>(
    `INSERT INTO google_sync_log (run_started_at, step, ok)
     VALUES (now(), $1, null)
     RETURNING id`,
    [LOG_STEP[step]],
  )
  const logId = startRows[0].id

  let ok           = false
  let rowsReported: number | null = null
  let detail: string | null = null

  try {
    const result = await dispatchStep(step, dbUrl)
    ok           = result.ok
    rowsReported = result.rows
    detail       = result.detail ?? null
  } catch (err: unknown) {
    ok     = false
    detail = String(err instanceof Error ? err.message : err).slice(0, 500)
  }

  await logPool.query(
    `UPDATE google_sync_log
     SET run_finished_at = now(), ok = $1, detail = $2, rows_reported = $3
     WHERE id = $4`,
    [ok, detail, rowsReported, logId],
  )
  await logPool.end()

  return { ok, rows: rowsReported }
}

// ── Internal: dispatch ────────────────────────────────────────────────────────

interface InternalResult {
  ok:     boolean
  rows:   number | null
  detail: string | null
}

async function dispatchStep(step: KnownStep, dbUrl: string): Promise<InternalResult> {
  const api = new GoogleAdsApi({
    client_id:       process.env.GOOGLE_ADS_CLIENT_ID!,
    client_secret:   process.env.GOOGLE_ADS_CLIENT_SECRET!,
    developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN!,
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const customer: any = api.Customer({
    customer_id:   CUSTOMER_ID,
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN!,
  })

  // Each step owns its own data Pool, closed in finally
  const pool = new Pool({ connectionString: dbUrl })
  try {
    switch (step) {
      case 'structure':       return await stepStructure(customer, pool)
      case 'targeting':       return await stepTargeting(customer, pool)
      case 'campaign-daily':  return await stepCampaignDaily(customer, pool)
      case 'search-terms':    return await stepSearchTerms(customer, pool)
      case 'asset-daily':     return await stepAssetDaily(customer, pool)
      case 'recommendations': return await stepRecommendations(customer, pool)
    }
  } finally {
    await pool.end()
  }
}

// ── Step: structure ───────────────────────────────────────────────────────────
// Adapted from scripts/google/sync-structure.mjs
// Upserts google_accounts + google_campaigns.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function stepStructure(customer: any, pool: Pool): Promise<InternalResult> {
  // Query 1: account
  const [acctRow] = await customer.query(`
    SELECT customer.id, customer.descriptive_name, customer.currency_code,
           customer.time_zone, customer.manager
    FROM customer
  `) as [Record<string, Record<string, unknown>>]

  // Query 2: campaigns
  const campaignRows = await customer.query(`
    SELECT campaign.id, campaign.name, campaign.status,
           campaign.advertising_channel_type, campaign.bidding_strategy_type,
           campaign_budget.amount_micros, campaign.start_date_time, campaign.end_date_time
    FROM campaign
    ORDER BY campaign.id
  `) as Array<Record<string, Record<string, unknown>>>

  // Validate enums before any write (same guard as script)
  for (const row of campaignRows) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = row.campaign as any
    assertEnum(enums.CampaignStatus,           c.status,                    'status')
    assertEnum(enums.AdvertisingChannelType,    c.advertising_channel_type, 'advertising_channel_type')
    assertEnum(enums.BiddingStrategyType,       c.bidding_strategy_type,    'bidding_strategy_type')
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = acctRow.customer as any

  await pool.query(
    `INSERT INTO google_accounts
       (customer_id, descriptive_name, currency_code, time_zone, is_manager, last_synced_at)
     VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (customer_id) DO UPDATE SET
       descriptive_name=EXCLUDED.descriptive_name,
       currency_code=EXCLUDED.currency_code,
       time_zone=EXCLUDED.time_zone,
       is_manager=EXCLUDED.is_manager,
       last_synced_at=now()`,
    [a.id, a.descriptive_name, a.currency_code, a.time_zone, a.manager ?? false],
  )

  let campsUpserted = 0
  for (const row of campaignRows) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = row.campaign as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = row.campaign_budget as any
    await pool.query(
      `INSERT INTO google_campaigns
         (campaign_id, customer_id, name, status, advertising_channel_type,
          bidding_strategy_type, budget_micros, start_date, end_date, last_synced_at, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10)
       ON CONFLICT (campaign_id) DO UPDATE SET
         customer_id=EXCLUDED.customer_id,
         name=EXCLUDED.name,
         status=EXCLUDED.status,
         advertising_channel_type=EXCLUDED.advertising_channel_type,
         bidding_strategy_type=EXCLUDED.bidding_strategy_type,
         budget_micros=EXCLUDED.budget_micros,
         start_date=EXCLUDED.start_date,
         end_date=EXCLUDED.end_date,
         last_synced_at=now(),
         raw=EXCLUDED.raw`,
      [
        c.id,
        a.id,
        c.name,
        en(enums.CampaignStatus,          c.status),
        en(enums.AdvertisingChannelType,  c.advertising_channel_type),
        en(enums.BiddingStrategyType,     c.bidding_strategy_type),
        b?.amount_micros ?? null,
        c.start_date_time != null ? String(c.start_date_time).slice(0, 10) : null,
        c.end_date_time   != null ? String(c.end_date_time).slice(0, 10)   : null,
        JSON.stringify(row),
      ],
    )
    campsUpserted++
  }

  const detail = `UPSERTED accounts=1 campaigns=${campsUpserted}`
  return { ok: true, rows: campsUpserted, detail }
}

// ── Step: targeting ───────────────────────────────────────────────────────────
// Adapted from scripts/google/sync-targeting.mjs
// Upserts google_ad_groups (batches 100) + google_keywords (batches 500).
// WALL-TIME CAP: if elapsed > 240 s before a new keyword batch, return PARTIAL.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function stepTargeting(customer: any, pool: Pool): Promise<InternalResult> {
  const wallStart = Date.now()

  // GAQL A: ad groups
  const adGroupRows = await customer.query(`
    SELECT ad_group.id, ad_group.name, ad_group.status,
           ad_group.type, campaign.id
    FROM ad_group
    ORDER BY ad_group.id
  `) as Array<Record<string, Record<string, unknown>>>

  // GAQL B: all keywords (may be ~56 k rows)
  const keywordRows = await customer.query(`
    SELECT ad_group.id,
           ad_group_criterion.criterion_id,
           ad_group_criterion.keyword.text,
           ad_group_criterion.keyword.match_type,
           ad_group_criterion.status,
           ad_group_criterion.negative,
           ad_group_criterion.cpc_bid_micros
    FROM keyword_view
    ORDER BY ad_group.id, ad_group_criterion.criterion_id
  `) as Array<Record<string, Record<string, unknown>>>

  // Validate enums before any write
  for (const row of adGroupRows) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ag = row.ad_group as any
    assertEnum(enums.AdGroupStatus, ag.status, 'ad_group.status')
    assertEnum(enums.AdGroupType,   ag.type,   'ad_group.type')
  }
  for (const row of keywordRows) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = row.ad_group_criterion as any
    if (!c.keyword?.text) {
      throw new Error(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        `MISSING KEYWORD TEXT ad_group=${(row.ad_group as any)?.id} criterion=${c.criterion_id}`,
      )
    }
    assertEnum(enums.AdGroupCriterionStatus, c.status,             'criterion.status')
    assertEnum(enums.KeywordMatchType,        c.keyword?.match_type, 'keyword.match_type')
  }

  // ── Upsert ad groups first (FK dependency for keywords), batches of 100 ──
  const agChunks = chunk(adGroupRows, 100)
  let agUpserted = 0
  for (const batch of agChunks) {
    const params: unknown[] = []
    const valueClauses = batch.map((row, i) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ag  = row.ad_group  as any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cam = row.campaign  as any
      const base = i * 7
      params.push(
        ag.id, cam.id, CUSTOMER_ID,
        ag.name,
        en(enums.AdGroupStatus, ag.status),
        en(enums.AdGroupType,   ag.type),
        JSON.stringify(row),
      )
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},now(),$${base+7})`
    })
    await pool.query(
      `INSERT INTO google_ad_groups
         (ad_group_id, campaign_id, customer_id, name, status, type, last_synced_at, raw)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (ad_group_id) DO UPDATE SET
         campaign_id=EXCLUDED.campaign_id,
         customer_id=EXCLUDED.customer_id,
         name=EXCLUDED.name,
         status=EXCLUDED.status,
         type=EXCLUDED.type,
         last_synced_at=now(),
         raw=EXCLUDED.raw`,
      params,
    )
    agUpserted += batch.length
  }

  // ── Upsert keywords, batches of 500 — with wall-time cap ─────────────────
  const kwChunks  = chunk(keywordRows, 500)
  let kwUpserted  = 0
  let partial     = false

  for (const batch of kwChunks) {
    // Check wall-time BEFORE starting the next batch (finish current, don't start new)
    if (Date.now() - wallStart > WALL_CAP_MS) {
      partial = true
      break
    }

    const params: unknown[] = []
    const valueClauses = batch.map((row, i) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ag = row.ad_group           as any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c  = row.ad_group_criterion as any
      const base = i * 8
      params.push(
        ag.id,
        c.criterion_id,
        c.keyword.text,
        en(enums.KeywordMatchType,       c.keyword?.match_type),
        en(enums.AdGroupCriterionStatus, c.status),
        c.negative ?? false,
        c.cpc_bid_micros ?? null,
        JSON.stringify(row),
      )
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},now(),$${base+8})`
    })
    await pool.query(
      `INSERT INTO google_keywords
         (ad_group_id, criterion_id, text, match_type, status, negative,
          cpc_bid_micros, last_synced_at, raw)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (ad_group_id, criterion_id) DO UPDATE SET
         text=EXCLUDED.text,
         match_type=EXCLUDED.match_type,
         status=EXCLUDED.status,
         negative=EXCLUDED.negative,
         cpc_bid_micros=EXCLUDED.cpc_bid_micros,
         last_synced_at=now(),
         raw=EXCLUDED.raw`,
      params,
    )
    kwUpserted += batch.length
  }

  if (partial) {
    const detail = `PARTIAL ${kwUpserted}/${keywordRows.length}, continues next run`
    return { ok: true, rows: kwUpserted, detail }
  }

  const detail = `UPSERTED ad_groups=${agUpserted} keywords=${kwUpserted}`
  return { ok: true, rows: kwUpserted, detail }
}

// ── Step: campaign-daily ──────────────────────────────────────────────────────
// Adapted from scripts/google/sync-campaign-daily.mjs
// Trailing window: today-7 .. today-1 in Europe/Madrid.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function stepCampaignDaily(customer: any, pool: Pool): Promise<InternalResult> {
  const fromDate = madridDate(-7)
  const toDate   = madridDate(-1)

  const rows = await customer.query(`
    SELECT campaign.id,
           segments.date,
           metrics.impressions,
           metrics.clicks,
           metrics.cost_micros,
           metrics.conversions,
           metrics.conversions_value,
           metrics.search_impression_share,
           metrics.search_budget_lost_impression_share,
           metrics.search_rank_lost_impression_share
    FROM campaign
    WHERE segments.date BETWEEN '${fromDate}' AND '${toDate}'
    ORDER BY segments.date, campaign.id
  `) as Array<Record<string, Record<string, unknown>>>

  const chunks = chunk(rows, 500)
  let upserted = 0

  for (const batch of chunks) {
    const params: unknown[] = []
    const valueClauses = batch.map((row, i) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = row.metrics as any
      const base = i * 11
      params.push(
        CUSTOMER_ID,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (row.segments as any)?.date,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (row.campaign as any)?.id,
        Number(m?.impressions       ?? 0),
        Number(m?.clicks            ?? 0),
        Number(m?.cost_micros       ?? 0),
        Number(m?.conversions       ?? 0),
        Number(m?.conversions_value ?? 0),
        isField(m?.search_impression_share),
        isField(m?.search_budget_lost_impression_share),
        isField(m?.search_rank_lost_impression_share),
      )
      return (
        `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},` +
        `$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},now())`
      )
    })
    await pool.query(
      `INSERT INTO google_campaign_daily
         (customer_id, date, campaign_id, impressions, clicks, cost_micros,
          conversions, conversions_value,
          search_impression_share, search_budget_lost_impression_share,
          search_rank_lost_impression_share, last_synced_at)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (customer_id, date, campaign_id) DO UPDATE SET
         impressions=EXCLUDED.impressions,
         clicks=EXCLUDED.clicks,
         cost_micros=EXCLUDED.cost_micros,
         conversions=EXCLUDED.conversions,
         conversions_value=EXCLUDED.conversions_value,
         search_impression_share=EXCLUDED.search_impression_share,
         search_budget_lost_impression_share=EXCLUDED.search_budget_lost_impression_share,
         search_rank_lost_impression_share=EXCLUDED.search_rank_lost_impression_share,
         last_synced_at=now()`,
      params,
    )
    upserted += batch.length
  }

  return { ok: true, rows: upserted, detail: `UPSERTED rows=${upserted}` }
}

// ── Step: search-terms ────────────────────────────────────────────────────────
// Adapted from scripts/google/sync-search-terms.mjs
// Trailing window: today-7 .. today-1 in Europe/Madrid.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function stepSearchTerms(customer: any, pool: Pool): Promise<InternalResult> {
  const fromDate = madridDate(-7)
  const toDate   = madridDate(-1)

  const rows = await customer.query(`
    SELECT search_term_view.search_term,
           search_term_view.status,
           segments.date,
           segments.search_term_match_type,
           campaign.id,
           ad_group.id,
           metrics.impressions,
           metrics.clicks,
           metrics.cost_micros,
           metrics.conversions,
           metrics.conversions_value
    FROM search_term_view
    WHERE segments.date BETWEEN '${fromDate}' AND '${toDate}'
    ORDER BY segments.date
  `) as Array<Record<string, Record<string, unknown>>>

  // Validate enums + required fields before any write
  for (const row of rows) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const val = (row.segments as any)?.search_term_match_type
    if (val == null) {
      throw new Error(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        `MISSING MATCH TYPE date=${(row.segments as any)?.date} term=${(row.search_term_view as any)?.search_term}`,
      )
    }
    assertEnum(enums.SearchTermMatchType, val, 'search_term_match_type')
  }

  const chunks = chunk(rows, 500)
  let upserted = 0

  for (const batch of chunks) {
    const params: unknown[] = []
    const valueClauses = batch.map((row, i) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = row.metrics as any
      const base = i * 11
      params.push(
        CUSTOMER_ID,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (row.segments as any)?.date,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (row.campaign as any)?.id,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (row.ad_group as any)?.id,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (row.search_term_view as any)?.search_term,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        en(enums.SearchTermMatchType, (row.segments as any)?.search_term_match_type),
        Number(m?.impressions       ?? 0),
        Number(m?.clicks            ?? 0),
        Number(m?.cost_micros       ?? 0),
        Number(m?.conversions       ?? 0),
        Number(m?.conversions_value ?? 0),
      )
      return (
        `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},` +
        `$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},now())`
      )
    })
    await pool.query(
      `INSERT INTO google_search_term_daily
         (customer_id, date, campaign_id, ad_group_id, search_term, match_type,
          impressions, clicks, cost_micros, conversions, conversions_value, last_synced_at)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (customer_id, date, campaign_id, ad_group_id, search_term, match_type) DO UPDATE SET
         impressions=EXCLUDED.impressions,
         clicks=EXCLUDED.clicks,
         cost_micros=EXCLUDED.cost_micros,
         conversions=EXCLUDED.conversions,
         conversions_value=EXCLUDED.conversions_value,
         last_synced_at=now()`,
      params,
    )
    upserted += batch.length
  }

  return { ok: true, rows: upserted, detail: `UPSERTED rows=${upserted}` }
}

// ── Step: asset-daily ─────────────────────────────────────────────────────────
// Adapted from scripts/google/sync-asset-daily.mjs
// Trailing window: today-7 .. today-1 in Europe/Madrid.
// Aggregates source rows to PK grain before upsert (same as script).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function stepAssetDaily(customer: any, pool: Pool): Promise<InternalResult> {
  const fromDate = madridDate(-7)
  const toDate   = madridDate(-1)

  // Floor guard: asset per-day stats exist from ASSET_FLOOR onward
  if (fromDate < ASSET_FLOOR) {
    throw new Error(`BEFORE ASSET DATA FLOOR: fromDate ${fromDate} < ${ASSET_FLOOR}`)
  }

  const rows = await customer.query(`
    SELECT ad_group_ad_asset_view.asset,
           ad_group_ad_asset_view.field_type,
           asset.id,
           asset.text_asset.text,
           segments.date,
           campaign.id,
           ad_group.id,
           metrics.impressions,
           metrics.clicks,
           metrics.cost_micros,
           metrics.conversions
    FROM ad_group_ad_asset_view
    WHERE segments.date BETWEEN '${fromDate}' AND '${toDate}'
    ORDER BY segments.date, ad_group.id, asset.id
  `) as Array<Record<string, Record<string, unknown>>>

  // Validate enums before any write
  for (const row of rows) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const val = (row.ad_group_ad_asset_view as any)?.field_type
    if (val == null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      throw new Error(`MISSING FIELD TYPE date=${(row.segments as any)?.date} asset=${(row.asset as any)?.id}`)
    }
    assertEnum(enums.AssetFieldType, val, 'AssetFieldType')
  }

  // asset_text: null-safe — non-text assets stay null, never ''
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const assetText = (row: Record<string, Record<string, unknown>>): string | null => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (row.asset as any)?.text_asset?.text
    return (t == null || t === '') ? null : t
  }

  // Aggregate to PK grain: (date, campaign_id, ad_group_id, asset_id, field_type)
  // Same asset in multiple RSAs in one ad group → multiple source rows per PK.
  // Sum metrics; keep first non-null asset_text.
  interface AggRow {
    date:         string
    campaignId:   number
    adGroupId:    number
    assetId:      number
    fieldType:    string
    assetTextVal: string | null
    impressions:  number
    clicks:       number
    costMicros:   number
    conversions:  number
  }

  const aggMap = new Map<string, AggRow>()
  for (const row of rows) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const date       = (row.segments as any)?.date          as string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const campaignId = Number((row.campaign as any)?.id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adGroupId  = Number((row.ad_group as any)?.id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const assetId    = Number((row.asset as any)?.id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fieldType  = en(enums.AssetFieldType, (row.ad_group_ad_asset_view as any)?.field_type) as string
    const key = `${date}|${campaignId}|${adGroupId}|${assetId}|${fieldType}`

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = row.metrics as any
    if (!aggMap.has(key)) {
      aggMap.set(key, {
        date, campaignId, adGroupId, assetId, fieldType,
        assetTextVal: assetText(row),
        impressions:  Number(m?.impressions ?? 0),
        clicks:       Number(m?.clicks      ?? 0),
        costMicros:   Number(m?.cost_micros ?? 0),
        conversions:  Number(m?.conversions ?? 0),
      })
    } else {
      const a = aggMap.get(key)!
      if (a.assetTextVal == null) a.assetTextVal = assetText(row) // keep first non-null
      a.impressions += Number(m?.impressions ?? 0)
      a.clicks      += Number(m?.clicks      ?? 0)
      a.costMicros  += Number(m?.cost_micros ?? 0)
      a.conversions += Number(m?.conversions ?? 0)
    }
  }

  const agg    = [...aggMap.values()]
  const chunks = chunk(agg, 500)
  let upserted = 0

  for (const batch of chunks) {
    const params: unknown[] = []
    const valueClauses = batch.map((r, i) => {
      const base = i * 11
      params.push(
        CUSTOMER_ID,   // $1
        r.date,        // $2
        r.campaignId,  // $3
        r.adGroupId,   // $4
        r.assetId,     // $5
        r.fieldType,   // $6
        r.assetTextVal, // $7 — null-safe
        r.impressions, // $8
        r.clicks,      // $9
        r.costMicros,  // $10
        r.conversions, // $11
      )
      return (
        `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},` +
        `$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},now())`
      )
    })
    await pool.query(
      `INSERT INTO google_asset_daily
         (customer_id, date, campaign_id, ad_group_id, asset_id, field_type,
          asset_text, impressions, clicks, cost_micros, conversions, last_synced_at)
       VALUES ${valueClauses.join(',')}
       ON CONFLICT (customer_id, date, ad_group_id, asset_id, field_type) DO UPDATE SET
         campaign_id=EXCLUDED.campaign_id,
         asset_text=EXCLUDED.asset_text,
         impressions=EXCLUDED.impressions,
         clicks=EXCLUDED.clicks,
         cost_micros=EXCLUDED.cost_micros,
         conversions=EXCLUDED.conversions,
         last_synced_at=now()`,
      params,
    )
    upserted += batch.length
  }

  return { ok: true, rows: upserted, detail: `UPSERTED rows=${upserted}` }
}

// ── Step: recommendations ─────────────────────────────────────────────────────
// Adapted from scripts/google/sync-recommendations.mjs
// Point-in-time snapshot: INSERT only (no upsert), entire current rec list.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function stepRecommendations(customer: any, pool: Pool): Promise<InternalResult> {
  const rows = await customer.query(`
    SELECT recommendation.resource_name,
           recommendation.type,
           recommendation.dismissed,
           recommendation.campaign
    FROM recommendation
  `) as Array<Record<string, Record<string, unknown>>>

  // Parse campaign_id from resource name (null-safe)
  // e.g. "customers/2199803274/campaigns/987654321" → 987654321
  const parseCampaignId = (rn: unknown): number | null => {
    if (!rn) return null
    const m = String(rn).match(/\/campaigns\/(\d+)/)
    return m ? Number(m[1]) : null
  }

  // Validate enums before any write
  for (const row of rows) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const val = (row.recommendation as any)?.type
    if (val == null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      throw new Error(`MISSING TYPE resource_name=${(row.recommendation as any)?.resource_name}`)
    }
    assertEnum(enums.RecommendationType, val, 'RecommendationType')
  }

  // Capture single snapshot timestamp for the whole run
  const snapAt = new Date().toISOString()
  const chunks = chunk(rows, 500)
  let inserted = 0

  for (const batch of chunks) {
    const params: unknown[] = []
    const valueClauses = batch.map((row, i) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rec  = row.recommendation as any
      const base = i * 7
      params.push(
        snapAt,
        CUSTOMER_ID,
        rec?.resource_name,
        en(enums.RecommendationType, rec?.type),
        parseCampaignId(rec?.campaign),
        rec?.dismissed ?? null,
        JSON.stringify(rec ?? row),
      )
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7})`
    })
    await pool.query(
      `INSERT INTO google_recommendation_snapshots
         (snapshot_at, customer_id, resource_name, type, campaign_id, dismissed, raw)
       VALUES ${valueClauses.join(',')}`,
      params,
    )
    inserted += batch.length
  }

  return { ok: true, rows: inserted, detail: `SNAPSHOT inserted=${inserted}` }
}
