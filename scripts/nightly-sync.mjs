import { parseArgs } from 'node:util';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { gunzipSync } from 'node:zlib';

// Node 22+ native WebSocket
neonConfig.webSocketConstructor = WebSocket;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { profile: { type: 'string' } },
});
if (!values.profile) throw new Error('--profile <id> required');
const profileIdStr = values.profile;
const profileId    = BigInt(profileIdStr);

// ---------------------------------------------------------------------------
// DB — one short-lived pool for profile lookup only; closed immediately after.
// Each phase opens its own pool after COMPLETED + download, closes in finally.
// ---------------------------------------------------------------------------
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');

// ---------------------------------------------------------------------------
// Look up profile row → credential env_var_name + region
// ---------------------------------------------------------------------------
let region, env_var_name;
{
  const lookupPool = new Pool({ connectionString: DATABASE_URL });
  const { rows: profileRows } = await lookupPool.query(
    `SELECT p.profile_id, p.region, c.env_var_name
       FROM amazon_profiles p
       JOIN amazon_credentials c ON c.id = p.credential_id
      WHERE p.profile_id = $1`,
    [profileId],
  );
  await lookupPool.end();
  if (profileRows.length === 0) throw new Error(`Profile ${profileIdStr} not found in DB`);
  ({ region, env_var_name } = profileRows[0]);
}

// Region → API host (with protocol)
const REGION_HOST = {
  NA: 'https://advertising-api.amazon.com',
  EU: 'https://advertising-api-eu.amazon.com',
  FE: 'https://advertising-api-fe.amazon.com',
};
const host = REGION_HOST[region];
if (!host) throw new Error(`Unknown region: ${region}`);

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
const refreshToken = process.env[env_var_name];
if (!refreshToken) throw new Error(`Env var ${env_var_name} not set`);

const { LWA_CLIENT_ID, LWA_CLIENT_SECRET } = process.env;
if (!LWA_CLIENT_ID || !LWA_CLIENT_SECRET)
  throw new Error('LWA_CLIENT_ID / LWA_CLIENT_SECRET not set');

// ---------------------------------------------------------------------------
// Window: (today − 14 days) through yesterday (UTC), both as YYYY-MM-DD
// ---------------------------------------------------------------------------
const startDate = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
const endDate   = new Date(Date.now() -      86_400_000).toISOString().slice(0, 10);
console.log(`nightly-sync start: profile=${profileIdStr} window=${startDate}..${endDate}`);

// ---------------------------------------------------------------------------
// Helper: fetch with 30 s AbortController timeout
// ---------------------------------------------------------------------------
async function fetchWithTimeout(url, opts, label) {
  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      console.error(`ABORTED: ${label}`);
      process.exit(1);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Mint access token via LWA
// ---------------------------------------------------------------------------
async function mintToken() {
  console.log('minting token…');
  const tokenRes = await fetchWithTimeout(
    'https://api.amazon.com/auth/o2/token',
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
        client_id:     LWA_CLIENT_ID,
        client_secret: LWA_CLIENT_SECRET,
      }),
    },
    'LWA token mint',
  );
  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(`LWA token error ${tokenRes.status}: ${body}`);
  }
  const { access_token } = await tokenRes.json();
  console.log(`token ok (len ${access_token.length})`);
  return access_token;
}

// Mint once at start; mutate authHeaders['Authorization'] on re-mint
let accessToken = await mintToken();

const authHeaders = {
  'Authorization':                   `Bearer ${accessToken}`,
  'Amazon-Advertising-API-ClientId': LWA_CLIENT_ID,
  'Amazon-Advertising-API-Scope':    profileIdStr,
};

// ---------------------------------------------------------------------------
// Helper: fetch Amazon Ads API endpoint with 401 re-mint + single retry
// (pattern from sync-targeting fetchListPage)
// ---------------------------------------------------------------------------
async function fetchAPI(url, extraHeaders, fetchOpts, label) {
  const headers = { ...authHeaders, ...extraHeaders };
  let res = await fetchWithTimeout(url, { ...fetchOpts, headers }, label);

  if (res.status === 401) {
    console.log(`token expired — re-minting, retrying ${label}`);
    accessToken                  = await mintToken();
    authHeaders['Authorization'] = `Bearer ${accessToken}`;
    headers['Authorization']     = `Bearer ${accessToken}`;
    res = await fetchWithTimeout(url, { ...fetchOpts, headers }, label);
    if (res.status === 401) throw new Error(`401 after re-mint on ${label}`);
  }

  return res;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const POLL_INTERVAL_MS = 30_000;
const POLL_CAP         = 60;   // 60 × 30 s = 30 min

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// requestAndPoll: POST /reporting/reports → poll until COMPLETED
// Returns reportId on success; throws on failure / timeout.
// ---------------------------------------------------------------------------
async function requestAndPoll(phase, reportBody) {
  // 1. Request
  const reqRes = await fetchAPI(
    `${host}/reporting/reports`,
    { 'Content-Type': 'application/vnd.createasyncreportrequest.v3+json' },
    { method: 'POST', body: JSON.stringify(reportBody) },
    `${phase}/request`,
  );
  if (!reqRes.ok) {
    const errBody = await reqRes.text();
    throw new Error(`${phase}: report request HTTP ${reqRes.status}: ${errBody}`);
  }
  const reqData  = await reqRes.json();
  const reportId = reqData.reportId;
  if (!reportId) throw new Error(`${phase}: no reportId in response: ${JSON.stringify(reqData)}`);
  console.log(`${phase}: reportId=${reportId} status=${reqData.status}`);

  // 2. Poll every 30 s, cap 20 min
  let status    = reqData.status ?? 'PENDING';
  let pollCount = 0;

  while (status !== 'COMPLETED' && status !== 'FAILED') {
    if (pollCount >= POLL_CAP) {
      throw new Error(`${phase}: poll cap (${POLL_CAP} × 30 s) reached without COMPLETED`);
    }
    console.log(`${phase}: status=${status} — waiting ${POLL_INTERVAL_MS / 1000}s (poll ${pollCount + 1}/${POLL_CAP})`);
    await sleep(POLL_INTERVAL_MS);
    pollCount++;

    const pollRes = await fetchAPI(
      `${host}/reporting/reports/${reportId}`,
      {},
      { method: 'GET' },
      `${phase}/poll ${pollCount}`,
    );
    if (!pollRes.ok) {
      const errBody = await pollRes.text();
      throw new Error(`${phase}: poll HTTP ${pollRes.status}: ${errBody}`);
    }
    const pollData = await pollRes.json();
    status = pollData.status;
    console.log(`${phase}: poll ${pollCount} → status=${status}`);
  }

  if (status === 'FAILED') {
    throw new Error(`${phase}: report ended in FAILED status`);
  }

  return reportId;
}

// ---------------------------------------------------------------------------
// downloadReport: GET fresh signed URL → fetch S3 → gunzip → parse rows
// ---------------------------------------------------------------------------
async function downloadReport(phase, reportId) {
  // Get fresh signed URL
  const metaRes = await fetchAPI(
    `${host}/reporting/reports/${reportId}`,
    {},
    { method: 'GET' },
    `${phase}/meta`,
  );
  if (!metaRes.ok) {
    const errBody = await metaRes.text();
    throw new Error(`${phase}: meta HTTP ${metaRes.status}: ${errBody}`);
  }
  const meta = await metaRes.json();
  if (!meta.url) throw new Error(`${phase}: no download URL in meta: ${JSON.stringify(meta)}`);

  // Fetch signed S3 URL — NO auth headers on signed links (from download-reports.mjs)
  const s3Res = await fetch(meta.url);
  if (!s3Res.ok) throw new Error(`${phase}: S3 fetch HTTP ${s3Res.status}`);
  let gzBuf = Buffer.from(await s3Res.arrayBuffer());

  // Gunzip + parse
  const decompressed = gunzipSync(gzBuf);
  gzBuf = null;
  const reportRows = JSON.parse(decompressed.toString('utf8'));
  console.log(`${phase}: downloaded ${reportRows.length} rows`);
  return reportRows;
}

// ---------------------------------------------------------------------------
// Phase 1: Campaign Daily
// ---------------------------------------------------------------------------
let campaignOk = false;
{
  const phase = 'campaign-daily';
  console.log(`\n=== ${phase} phase start ===`);

  let phasePool;
  try {
    const reportId = await requestAndPoll(phase, {
      name:          `cdl-ads spCampaigns ${startDate}_${endDate}`,
      startDate:     startDate,
      endDate:       endDate,
      configuration: {
        adProduct:    'SPONSORED_PRODUCTS',
        groupBy:      ['campaign'],
        columns:      ['campaignId', 'date', 'impressions', 'clicks', 'cost',
                       'purchases14d', 'sales14d'],
        reportTypeId: 'spCampaigns',
        timeUnit:     'DAILY',
        format:       'GZIP_JSON',
      },
    });

    const reportRows = await downloadReport(phase, reportId);
    const fetched    = reportRows.length;

    // Pool created after COMPLETED + downloaded; closed in finally
    phasePool    = new Pool({ connectionString: DATABASE_URL });
    const client = await phasePool.connect();
    let landed   = 0;
    try {
      await client.query('BEGIN');
      for (const row of reportRows) {
        await client.query(
          `INSERT INTO amazon_campaign_daily
             (profile_id, campaign_id, date, impressions, clicks, cost,
              purchases_14d, sales_14d, raw)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (profile_id, campaign_id, date) DO UPDATE SET
             impressions   = EXCLUDED.impressions,
             clicks        = EXCLUDED.clicks,
             cost          = EXCLUDED.cost,
             purchases_14d = EXCLUDED.purchases_14d,
             sales_14d     = EXCLUDED.sales_14d,
             raw           = EXCLUDED.raw,
             landed_at     = now()`,
          [
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
        );
        landed++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // Count invariant
    const { rows: cntRows } = await phasePool.query(
      `SELECT COUNT(*) AS c FROM amazon_campaign_daily
        WHERE profile_id = $1 AND date BETWEEN $2 AND $3`,
      [profileIdStr, startDate, endDate],
    );
    const tableCount = Number(cntRows[0].c);
    console.log(`${phase}: fetched ${fetched}, landed ${landed}, table holds ${tableCount} rows for profile across window`);
    campaignOk = true;
  } catch (err) {
    console.error(`${phase}: FAILED — ${err.message}`);
  } finally {
    if (phasePool) await phasePool.end();
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Search Terms — guarded: v1 runs ONLY for profile 2263723137827296
// ---------------------------------------------------------------------------
const SEARCH_TERM_PROFILE = '2263723137827296';
let searchOk = true; // default true so non-guarded profiles exit 0 on campaign success

{
  const phase = 'search-terms';

  if (profileIdStr !== SEARCH_TERM_PROFILE) {
    console.log(`\n=== ${phase} phase skipped (v1: only profile ${SEARCH_TERM_PROFILE}) ===`);
  } else {
    searchOk = false; // will be set true on success
    console.log(`\n=== ${phase} phase start ===`);

    const BATCH_SIZE = 500;
    const NUM_COLS   = 13;

    let phasePool;
    try {
      const reportId = await requestAndPoll(phase, {
        name:          `cdl-ads spSearchTerm ${startDate}_${endDate}`,
        startDate:     startDate,
        endDate:       endDate,
        configuration: {
          adProduct:    'SPONSORED_PRODUCTS',
          groupBy:      ['searchTerm'],
          columns:      ['campaignId', 'adGroupId', 'keywordId', 'searchTerm', 'matchType',
                         'date', 'impressions', 'clicks', 'cost', 'purchases14d', 'sales14d'],
          reportTypeId: 'spSearchTerm',
          timeUnit:     'DAILY',
          format:       'GZIP_JSON',
        },
      });

      const reportRows = await downloadReport(phase, reportId);
      const fetched    = reportRows.length;

      // Pool created after COMPLETED + downloaded; closed in finally
      phasePool    = new Pool({ connectionString: DATABASE_URL });
      const client = await phasePool.connect();
      let landed   = 0;
      let batchN   = 0;
      try {
        await client.query('BEGIN');
        for (let i = 0; i < reportRows.length; i += BATCH_SIZE) {
          const batch  = reportRows.slice(i, i + BATCH_SIZE);
          const values = [];
          const placeholders = batch.map((row, idx) => {
            const b = idx * NUM_COLS;
            values.push(
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
            );
            return (
              `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},` +
              `$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13})`
            );
          }).join(',');
          await client.query(
            `INSERT INTO amazon_search_term_daily
               (profile_id, campaign_id, ad_group_id, keyword_id, search_term,
                match_type, date, impressions, clicks, cost, purchases_14d, sales_14d, raw)
             VALUES ${placeholders}
             ON CONFLICT (profile_id, campaign_id, ad_group_id, keyword_id, search_term, date)
             DO UPDATE SET
               impressions   = EXCLUDED.impressions,
               clicks        = EXCLUDED.clicks,
               cost          = EXCLUDED.cost,
               purchases_14d = EXCLUDED.purchases_14d,
               sales_14d     = EXCLUDED.sales_14d,
               raw           = EXCLUDED.raw,
               landed_at     = now()`,
            values,
          );
          landed += batch.length;
          batchN++;
        }
        await client.query('COMMIT');
        console.log(`${phase}: ${landed} rows landed (${batchN} batches)`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      // Count invariant
      const { rows: cntRows } = await phasePool.query(
        `SELECT COUNT(*) AS c FROM amazon_search_term_daily
          WHERE profile_id = $1 AND date BETWEEN $2 AND $3`,
        [profileIdStr, startDate, endDate],
      );
      const tableCount = Number(cntRows[0].c);
      console.log(`${phase}: fetched ${fetched}, landed ${landed}, table holds ${tableCount} rows for profile across window`);
      searchOk = true;
    } catch (err) {
      console.error(`${phase}: FAILED — ${err.message}`);
    } finally {
      if (phasePool) await phasePool.end();
    }
  }
}

// ---------------------------------------------------------------------------
// Finalize
// ---------------------------------------------------------------------------
if (!campaignOk || !searchOk) {
  console.error('nightly-sync: one or more phases FAILED');
  process.exit(1);
}
console.log('nightly-sync: all phases complete');
