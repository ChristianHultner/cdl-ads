import { Pool, neonConfig } from '@neondatabase/serverless';

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

// ---- fetch pending reports ----
const { rows } = await pool.query(
  `SELECT r.report_id, r.profile_id::text AS profile_id, r.status AS old_status,
          p.region, c.env_var_name
   FROM amazon_report_requests r
   JOIN amazon_profiles p USING (profile_id)
   JOIN amazon_credentials c ON p.credential_id = c.id
   WHERE r.status NOT IN ('COMPLETED', 'FAILED')`
);

if (!rows.length) {
  console.log('nothing pending');
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

// ---- mint one token per credential, poll all reports in that group ----
for (const [envVarName, reports] of byCredential) {
  const refreshToken = process.env[envVarName];
  if (!refreshToken) {
    console.error(`env var ${envVarName} is not set; skipping ${reports.length} report(s)`);
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
    continue;
  }
  const accessToken = tokenData.access_token;
  console.log(`token ok (len ${accessToken.length})`);

  // ---- poll each report in this credential group ----
  for (const { report_id, profile_id, old_status, region } of reports) {
    const host = REGION_HOST[region];
    if (!host) {
      console.error(`Unknown region ${region} for report ${report_id}, skipping`);
      continue;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let res, body;
    try {
      res = await fetch(`https://${host}/reporting/reports/${report_id}`, {
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Amazon-Advertising-API-ClientId': LWA_CLIENT_ID,
          'Amazon-Advertising-API-Scope': profile_id,
        },
      });
      body = await res.json();
    } catch (err) {
      console.error(`${report_id} fetch error: ${err.message}`);
      clearTimeout(timer);
      continue;
    }
    clearTimeout(timer);

    if (!res.ok) {
      console.error(`${report_id} HTTP ${res.status}:`, JSON.stringify(body));
      continue;
    }

    const newStatus = body.status;
    const urlExpiresAt = body.urlExpiresAt ?? null;
    const downloadUrl = body.url ?? null;

    if (downloadUrl) {
      console.log(`url received (len ${downloadUrl.length})`);
    }

    // Build UPDATE: always set status; set completed_at if newly COMPLETED;
    // set url_expiry if present; set error body if FAILED.
    const errorBody = newStatus === 'FAILED' ? JSON.stringify(body) : null;

    await pool.query(
      `UPDATE amazon_report_requests
       SET status      = $2,
           completed_at = CASE WHEN $2 = 'COMPLETED' THEN now() ELSE completed_at END,
           url_expiry  = COALESCE($3::timestamptz, url_expiry),
           error       = CASE WHEN $2 = 'FAILED' THEN $4 ELSE error END
       WHERE report_id = $1`,
      [report_id, newStatus, urlExpiresAt, errorBody]
    );

    console.log(`${report_id} ${old_status} -> ${newStatus}`);
  }
}

await pool.end();
process.exit(0);
