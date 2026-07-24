import { parseArgs } from 'node:util';
import { Pool, neonConfig } from '@neondatabase/serverless';

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
const profileId = BigInt(values.profile);

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
const pool = new Pool({ connectionString: DATABASE_URL });

// ---------------------------------------------------------------------------
// Look up profile row → credential env_var_name + region
// ---------------------------------------------------------------------------
const { rows: profileRows } = await pool.query(
  `SELECT p.profile_id, p.region, c.env_var_name
     FROM amazon_profiles p
     JOIN amazon_credentials c ON c.id = p.credential_id
    WHERE p.profile_id = $1`,
  [profileId],
);
if (profileRows.length === 0) throw new Error(`Profile ${profileId} not found in DB`);
const { region, env_var_name } = profileRows[0];

// Region → API host
const REGION_HOST = {
  NA: 'https://advertising-api.amazon.com',
  EU: 'https://advertising-api-eu.amazon.com',
  FE: 'https://advertising-api-fe.amazon.com',
};
const host = REGION_HOST[region];
if (!host) throw new Error(`Unknown region: ${region}`);

// ---------------------------------------------------------------------------
// Mint access token via LWA
// ---------------------------------------------------------------------------
const refreshToken = process.env[env_var_name];
if (!refreshToken) throw new Error(`Env var ${env_var_name} not set`);

const { LWA_CLIENT_ID, LWA_CLIENT_SECRET } = process.env;
if (!LWA_CLIENT_ID || !LWA_CLIENT_SECRET) throw new Error('LWA_CLIENT_ID / LWA_CLIENT_SECRET not set');

// ---------------------------------------------------------------------------
// Helper: fetch with 30 s AbortController timeout
// ---------------------------------------------------------------------------
async function fetchWithTimeout(url, opts, label) {
  const ac = new AbortController();
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

console.log('minting token…');
const tokenRes = await fetchWithTimeout(
  'https://api.amazon.com/auth/o2/token',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: LWA_CLIENT_ID,
      client_secret: LWA_CLIENT_SECRET,
    }),
  },
  'LWA token mint',
);
if (!tokenRes.ok) {
  const body = await tokenRes.text();
  throw new Error(`LWA token error ${tokenRes.status}: ${body}`);
}
const { access_token: accessToken } = await tokenRes.json();
console.log(`token ok (len ${accessToken.length})`);

// ---------------------------------------------------------------------------
// Paginate POST /sp/campaigns/list (read-only)
// ---------------------------------------------------------------------------
const MEDIA_TYPE = 'application/vnd.spCampaign.v3+json';
let nextToken = undefined;
let pagesFetched = 0;
const allCampaigns = [];

const PAGE_CAP = 50;

do {
  if (pagesFetched >= PAGE_CAP) {
    console.error('PAGE CAP HIT');
    process.exit(1);
  }

  const pageNum = pagesFetched + 1;
  console.log(`page ${pageNum}: requesting…`);

  const body = { maxResults: 100 };
  if (nextToken) body.nextToken = nextToken;

  const res = await fetchWithTimeout(
    `${host}/sp/campaigns/list`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId': LWA_CLIENT_ID,
        'Amazon-Advertising-API-Scope': String(profileId),
        'Content-Type': MEDIA_TYPE,
        'Accept': MEDIA_TYPE,
      },
      body: JSON.stringify(body),
    },
    `campaigns/list page ${pageNum}`,
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Campaigns list error ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  pagesFetched++;
  const campaigns = data.campaigns ?? [];
  allCampaigns.push(...campaigns);
  nextToken = data.nextToken ?? undefined;
  console.log(`page ${pageNum}: got ${campaigns.length} campaigns, nextToken: ${nextToken ? 'yes' : 'no'}`);
} while (nextToken);

// ---------------------------------------------------------------------------
// Upsert into amazon_campaigns
// ---------------------------------------------------------------------------
let upserted = 0;
for (const c of allCampaigns) {
  await pool.query(
    `INSERT INTO amazon_campaigns
       (campaign_id, profile_id, name, state, campaign_type,
        targeting_type, start_date, end_date, budget_amount, budget_type,
        raw, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
     ON CONFLICT (campaign_id, profile_id) DO UPDATE SET
       name            = EXCLUDED.name,
       state           = EXCLUDED.state,
       campaign_type   = EXCLUDED.campaign_type,
       targeting_type  = EXCLUDED.targeting_type,
       start_date      = EXCLUDED.start_date,
       end_date        = EXCLUDED.end_date,
       budget_amount   = EXCLUDED.budget_amount,
       budget_type     = EXCLUDED.budget_type,
       raw             = EXCLUDED.raw,
       synced_at       = EXCLUDED.synced_at`,
    [
      c.campaignId,
      profileId,
      c.name,
      c.state,
      c.campaignType ?? 'sponsoredProducts',
      c.targetingType ?? null,
      c.startDate ?? null,
      c.endDate ?? null,
      c.budget?.budget ?? null,
      c.budget?.budgetType ?? null,
      JSON.stringify(c),
    ],
  );
  upserted++;
}

await pool.end();
console.log(`pages fetched: ${pagesFetched}`);
console.log(`campaigns upserted: ${upserted}`);
