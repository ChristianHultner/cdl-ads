import { Pool, neonConfig } from '@neondatabase/serverless';

// ---- args ----
const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(name);
  if (i === -1 || !args[i + 1]) {
    console.error(`Missing required arg: ${name}`);
    process.exit(1);
  }
  return args[i + 1];
}
const profileIdStr = getArg('--profile');
const startArg = getArg('--start');
const endArg = getArg('--end');

// ---- optional --type ----
const VALID_TYPES = ['spCampaigns', 'spSearchTerm'];
const typeIdx = args.indexOf('--type');
const reportType = typeIdx !== -1 && args[typeIdx + 1] ? args[typeIdx + 1] : 'spCampaigns';
if (!VALID_TYPES.includes(reportType)) {
  console.error(`Invalid --type value: ${reportType}. Must be one of: ${VALID_TYPES.join(', ')}`);
  process.exit(1);
}

// ---- validate dates ----
function parseDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    console.error(`Invalid date: ${s}`);
    process.exit(1);
  }
  return new Date(s + 'T00:00:00Z');
}
const startDate = parseDate(startArg);
const endDate = parseDate(endArg);
if (endDate < startDate) {
  console.error('--end must be >= --start');
  process.exit(1);
}

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

// ---- look up profile ----
const { rows } = await pool.query(
  `SELECT ap.region, ac.env_var_name
   FROM amazon_profiles ap
   JOIN amazon_credentials ac ON ap.credential_id = ac.id
   WHERE ap.profile_id = $1`,
  [profileIdStr]
);
if (!rows.length) {
  console.error(`Unknown profile_id: ${profileIdStr}`);
  await pool.end();
  process.exit(1);
}
const { region, env_var_name } = rows[0];
const host = REGION_HOST[region];
if (!host) {
  console.error(`Unknown region: ${region}`);
  await pool.end();
  process.exit(1);
}

// ---- env checks ----
const refreshToken = process.env[env_var_name];
if (!refreshToken) {
  console.error(`env var ${env_var_name} is not set`);
  await pool.end();
  process.exit(1);
}
const { LWA_CLIENT_ID, LWA_CLIENT_SECRET } = process.env;
if (!LWA_CLIENT_ID || !LWA_CLIENT_SECRET) {
  console.error('LWA_CLIENT_ID / LWA_CLIENT_SECRET not set');
  await pool.end();
  process.exit(1);
}

// ---- mint token ----
console.log('minting token…');
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
  console.error('token error - response keys:', Object.keys(tokenData));
  await pool.end();
  process.exit(1);
}
const accessToken = tokenData.access_token;
console.log(`token ok (len ${accessToken.length})`);

// ---- chunk dates (max 31 days inclusive per chunk) ----
function toYMD(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(d, n) {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}
const chunks = [];
let cur = new Date(startDate);
while (cur <= endDate) {
  const chunkEnd = new Date(Math.min(addDays(cur, 30).getTime(), endDate.getTime()));
  chunks.push({ start: toYMD(cur), end: toYMD(chunkEnd) });
  cur = addDays(chunkEnd, 1);
}

// ---- request reports ----
let allOk = true;
for (const { start, end } of chunks) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res, body;
  try {
    res = await fetch(`https://${host}/reporting/reports`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId': LWA_CLIENT_ID,
        'Amazon-Advertising-API-Scope': profileIdStr,
        'Content-Type': 'application/vnd.createasyncreportrequest.v3+json',
      },
      body: JSON.stringify({
        name: `cdl-ads ${reportType} ${start}_${end}`,
        startDate: start,
        endDate: end,
        configuration: reportType === 'spSearchTerm' ? {
          adProduct: 'SPONSORED_PRODUCTS',
          groupBy: ['searchTerm'],
          columns: ['campaignId', 'adGroupId', 'keywordId', 'searchTerm', 'matchType',
                    'date', 'impressions', 'clicks', 'cost', 'purchases14d', 'sales14d'],
          reportTypeId: 'spSearchTerm',
          timeUnit: 'DAILY',
          format: 'GZIP_JSON',
        } : {
          adProduct: 'SPONSORED_PRODUCTS',
          groupBy: ['campaign'],
          columns: ['campaignId', 'date', 'impressions', 'clicks', 'cost',
                    'purchases14d', 'sales14d'],
          reportTypeId: 'spCampaigns',
          timeUnit: 'DAILY',
          format: 'GZIP_JSON',
        },
      }),
    });
    body = await res.json();
  } catch (err) {
    console.error(`${start}..${end} -> fetch error: ${err.message}`);
    allOk = false;
    clearTimeout(timer);
    continue;
  }
  clearTimeout(timer);

  if (res.ok) {
    const { reportId, status } = body;
    await pool.query(
      `INSERT INTO amazon_report_requests
         (report_id, profile_id, report_type, start_date, end_date, status)
       VALUES ($1, $2, $6, $3, $4, $5)
       ON CONFLICT (report_id) DO NOTHING`,
      [reportId, profileIdStr, start, end, status, reportType]
    );
    console.log(`${start}..${end} -> ${reportId} ${status}`);
  } else {
    console.error(`${start}..${end} -> HTTP ${res.status}:`, JSON.stringify(body));
    allOk = false;
  }
}

await pool.end();
process.exit(allOk ? 0 : 1);
