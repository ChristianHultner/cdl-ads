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

// ---- fetch completed reports with no landed rows ----
const { rows } = await pool.query(
  `SELECT r.report_id, r.profile_id::text AS profile_id, p.region,
          c.env_var_name
   FROM amazon_report_requests r
   JOIN amazon_profiles p USING (profile_id)
   JOIN amazon_credentials c ON p.credential_id = c.id
   WHERE r.status = 'COMPLETED'
     AND r.report_type = 'spCampaigns'
     AND NOT EXISTS (SELECT 1 FROM amazon_campaign_daily d
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
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: LWA_CLIENT_ID,
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

  // ---- download each report in this credential group ----
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
          'Authorization': `Bearer ${accessToken}`,
          'Amazon-Advertising-API-ClientId': LWA_CLIENT_ID,
          'Amazon-Advertising-API-Scope': profile_id,
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

    // Step 3: gunzip + parse
    let reportRows;
    try {
      const decompressed = gunzipSync(gzBuf);
      reportRows = JSON.parse(decompressed.toString('utf8'));
    } catch (err) {
      console.error(`${report_id} decompress/parse error: ${err.message}`);
      anyFailed = true;
      continue;
    }

    // Step 4: land rows in ONE transaction per report
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of reportRows) {
        try {
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
              profile_id,
              row.campaignId != null ? String(row.campaignId) : null,
              row.date          ?? null,
              row.impressions   ?? null,
              row.clicks        ?? null,
              row.cost          ?? null,
              row.purchases14d  ?? null,
              row.sales14d      ?? null,
              row,
            ]
          );
        } catch (err) {
          console.error(`${report_id} row insert failed: ${err.message}`);
          console.error('failing row:', JSON.stringify(row));
          throw err; // roll back the whole transaction
        }
      }
      await client.query('COMMIT');
      console.log(`${report_id}: ${reportRows.length} rows landed`);
    } catch (_err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`${report_id}: transaction rolled back`);
      anyFailed = true;
    } finally {
      client.release();
    }
  }
}

await pool.end();
process.exit(anyFailed ? 1 : 0);
