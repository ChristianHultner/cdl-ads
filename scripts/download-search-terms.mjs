import { Pool, neonConfig } from '@neondatabase/serverless';
import { gunzipSync } from 'node:zlib';

// ---- region → host ----
const REGION_HOST = {
  NA: 'advertising-api.amazon.com',
  EU: 'advertising-api-eu.amazon.com',
  FE: 'advertising-api-fe.amazon.com',
};

// ---- DB ----
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
neonConfig.webSocketConstructor = WebSocket;
const pool = new Pool({ connectionString: DATABASE_URL });

// ---- fetch completed spSearchTerm reports with no landed rows ----
const { rows } = await pool.query(
  `SELECT r.report_id, r.profile_id::text AS profile_id, p.region,
          c.env_var_name
   FROM amazon_report_requests r
   JOIN amazon_profiles p USING (profile_id)
   JOIN amazon_credentials c ON p.credential_id = c.id
   WHERE r.status = 'COMPLETED'
     AND r.report_type = 'spSearchTerm'
     AND NOT EXISTS (SELECT 1 FROM amazon_search_term_daily d
                     WHERE d.profile_id = r.profile_id
                       AND d.date BETWEEN r.start_date AND r.end_date
                     LIMIT 1)`
);

if (!rows.length) {
  console.log('nothing to download');
  await pool.end();
  process.exit(0);
}

// ---- check env ----
const { LWA_CLIENT_ID, LWA_CLIENT_SECRET } = process.env;
if (!LWA_CLIENT_ID || !LWA_CLIENT_SECRET) {
  console.error('LWA_CLIENT_ID / LWA_CLIENT_SECRET not set');
  await pool.end();
  process.exit(1);
}

// ---- group by env_var_name ----
const byCredential = new Map();
for (const row of rows) {
  if (!byCredential.has(row.env_var_name)) {
    byCredential.set(row.env_var_name, []);
  }
  byCredential.get(row.env_var_name).push(row);
}

let anyFailed = false;

const BATCH_SIZE = 500;
const NUM_COLS  = 13;
const MB_200    = 200 * 1024 * 1024;

// ---- mint one token per credential, download all reports in that group ----
for (const [envVarName, reports] of byCredential) {
  const refreshToken = process.env[envVarName];
  if (!refreshToken) {
    console.error(`env var ${envVarName} is not set; skipping ${reports.length} report(s)`);
    anyFailed = true;
    continue;
  }

  console.log(`minting token for ${envVarName}…`);
  const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     LWA_CLIENT_ID,
      client_secret: LWA_CLIENT_SECRET,
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) {
    console.error(`token error for ${envVarName} - response keys:`, Object.keys(tokenData));
    anyFailed = true;
    continue;
  }
  const accessToken = tokenData.access_token;
  console.log(`token ok (len ${accessToken.length})`);

  for (const { report_id, profile_id, region } of reports) {
    const host = REGION_HOST[region];
    if (!host) {
      console.error(`Unknown region ${region} for report ${report_id}, skipping`);
      anyFailed = true;
      continue;
    }

    // Step 1: GET fresh signed URL from Amazon
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let metaRes, meta;
    try {
      metaRes = await fetch(`https://${host}/reporting/reports/${report_id}`, {
        signal: controller.signal,
        headers: {
          'Authorization':                    `Bearer ${accessToken}`,
          'Amazon-Advertising-API-ClientId':  LWA_CLIENT_ID,
          'Amazon-Advertising-API-Scope':     profile_id,
        },
      });
      meta = await metaRes.json();
    } catch (err) {
      console.error(`${report_id} meta fetch error: ${err.message}`);
      clearTimeout(timer);
      anyFailed = true;
      continue;
    }
    clearTimeout(timer);

    if (!metaRes.ok) {
      console.error(`${report_id} meta HTTP ${metaRes.status}:`, JSON.stringify(meta));
      anyFailed = true;
      continue;
    }

    if (meta.status !== 'COMPLETED' || !meta.url) {
      console.log(`${report_id}: status=${meta.status} url=${meta.url ? 'present' : 'absent'}, skipping`);
      anyFailed = true;
      continue;
    }

    // Step 2: Fetch the signed S3 URL — NO auth headers on signed links
    let gzBuf;
    try {
      const s3Res = await fetch(meta.url);
      if (!s3Res.ok) {
        console.error(`${report_id} S3 fetch HTTP ${s3Res.status}`);
        anyFailed = true;
        continue;
      }
      gzBuf = Buffer.from(await s3Res.arrayBuffer());
    } catch (err) {
      console.error(`${report_id} S3 fetch error: ${err.message}`);
      anyFailed = true;
      continue;
    }

    // Step 3: gunzip once, size-guard, parse once — do NOT hold both gz and
    // decompressed buffers simultaneously longer than necessary.
    let decompressed;
    try {
      decompressed = gunzipSync(gzBuf);
    } catch (err) {
      console.error(`${report_id} gunzip error: ${err.message}`);
      anyFailed = true;
      continue;
    }
    gzBuf = null; // release compressed buffer immediately

    if (decompressed.length > MB_200) {
      console.log(
        `${report_id}: decompressed size ${(decompressed.length / 1024 / 1024).toFixed(1)} MB` +
        ` exceeds 200 MB limit — skipping without landing (finding, not failure)`
      );
      anyFailed = true;
      continue;
    }

    let reportRows;
    try {
      reportRows = JSON.parse(decompressed.toString('utf8'));
    } catch (err) {
      console.error(`${report_id} JSON parse error: ${err.message}`);
      anyFailed = true;
      continue;
    }
    decompressed = null; // release decompressed buffer before DB work

    // Step 4: land rows in ONE transaction per report, 500-row multi-VALUES batches.
    // Each batch's values array is released when it goes out of scope at the end
    // of the iteration; reportRows is nulled in finally before the next report loads.
    const client = await pool.connect();
    let totalLanded = 0;
    let batchCount  = 0;
    try {
      await client.query('BEGIN');

      for (let i = 0; i < reportRows.length; i += BATCH_SIZE) {
        const batch = reportRows.slice(i, i + BATCH_SIZE);
        const values = [];
        const placeholders = batch.map((row, idx) => {
          const b = idx * NUM_COLS;
          values.push(
            profile_id,
            row.campaignId  != null ? String(row.campaignId)  : null,
            row.adGroupId   != null ? String(row.adGroupId)   : null,
            row.keywordId   != null ? String(row.keywordId)   : '-',
            row.searchTerm,       // explicit — missing value must FAIL loudly
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

        try {
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
            values
          );
        } catch (err) {
          console.error(`${report_id} batch ${batchCount} insert failed: ${err.message}`);
          for (const row of batch) {
            console.error('failing batch row:', JSON.stringify(row));
          }
          throw err; // roll back the whole transaction
        }

        totalLanded += batch.length;
        batchCount++;
        // batch and values go out of scope here — eligible for GC before next batch
      }

      await client.query('COMMIT');
      console.log(`${report_id}: ${totalLanded} rows landed (${batchCount} batches)`);
    } catch (_err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`${report_id}: transaction rolled back`);
      anyFailed = true;
    } finally {
      client.release();
      reportRows = null; // release before next report's decompression
    }
  }
}

await pool.end();
process.exit(anyFailed ? 1 : 0);
