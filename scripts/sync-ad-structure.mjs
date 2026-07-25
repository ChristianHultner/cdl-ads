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
if (!LWA_CLIENT_ID || !LWA_CLIENT_SECRET)
  throw new Error('LWA_CLIENT_ID / LWA_CLIENT_SECRET not set');

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

console.log('minting token…');
const tokenRes = await fetchWithTimeout(
  'https://api.amazon.com/auth/o2/token',
  {
    method: 'POST',
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
const { access_token: accessToken } = await tokenRes.json();
console.log(`token ok (len ${accessToken.length})`);

// Shared auth headers (Content-Type/Accept set per phase)
const authHeaders = {
  'Authorization':                      `Bearer ${accessToken}`,
  'Amazon-Advertising-API-ClientId':    LWA_CLIENT_ID,
  'Amazon-Advertising-API-Scope':       String(profileId),
};

const PAGE_CAP = 50;

// ---------------------------------------------------------------------------
// Phase 1: Ad Groups  —  POST /sp/adGroups/list
// ---------------------------------------------------------------------------
{
  const MEDIA     = 'application/vnd.spAdGroup.v3+json';
  let nextToken   = undefined;
  let page        = 0;
  let total       = 0;

  do {
    if (page >= PAGE_CAP) {
      console.error('adGroups: PAGE CAP HIT');
      process.exit(1);
    }
    page++;
    const reqBody = { maxResults: 100 };
    if (nextToken) reqBody.nextToken = nextToken;

    const res = await fetchWithTimeout(
      `${host}/sp/adGroups/list`,
      {
        method:  'POST',
        headers: { ...authHeaders, 'Content-Type': MEDIA, 'Accept': MEDIA },
        body:    JSON.stringify(reqBody),
      },
      `adGroups/list page ${page}`,
    );
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`adGroups/list ${res.status}: ${errBody}`);
    }

    const data  = await res.json();
    const items = data.adGroups ?? [];
    nextToken   = data.nextToken ?? undefined;
    console.log(`adGroups: page ${page} got ${items.length}`);

    for (const ag of items) {
      await pool.query(
        `INSERT INTO amazon_ad_groups
           (ad_group_id, profile_id, campaign_id, name, state, default_bid, raw, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT (ad_group_id, profile_id) DO UPDATE SET
           campaign_id = EXCLUDED.campaign_id,
           name        = EXCLUDED.name,
           state       = EXCLUDED.state,
           default_bid = EXCLUDED.default_bid,
           raw         = EXCLUDED.raw,
           synced_at   = EXCLUDED.synced_at`,
        [
          ag.adGroupId,
          profileId,
          String(ag.campaignId),
          ag.name,
          ag.state,
          ag.defaultBid ?? null,
          JSON.stringify(ag),
        ],
      );
      total++;
    }
  } while (nextToken);

  console.log(`adGroups: total ${total} upserted`);
}

// ---------------------------------------------------------------------------
// Phase 2: Product Ads  —  POST /sp/productAds/list
// ---------------------------------------------------------------------------
{
  const MEDIA     = 'application/vnd.spProductAd.v3+json';
  let nextToken   = undefined;
  let page        = 0;
  let total       = 0;

  do {
    if (page >= PAGE_CAP) {
      console.error('productAds: PAGE CAP HIT');
      process.exit(1);
    }
    page++;
    const reqBody = { maxResults: 100 };
    if (nextToken) reqBody.nextToken = nextToken;

    const res = await fetchWithTimeout(
      `${host}/sp/productAds/list`,
      {
        method:  'POST',
        headers: { ...authHeaders, 'Content-Type': MEDIA, 'Accept': MEDIA },
        body:    JSON.stringify(reqBody),
      },
      `productAds/list page ${page}`,
    );
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`productAds/list ${res.status}: ${errBody}`);
    }

    const data  = await res.json();
    const items = data.productAds ?? [];
    nextToken   = data.nextToken ?? undefined;
    console.log(`productAds: page ${page} got ${items.length}`);

    for (const pa of items) {
      await pool.query(
        `INSERT INTO amazon_product_ads
           (ad_id, profile_id, campaign_id, ad_group_id, asin, sku, state, raw, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
         ON CONFLICT (ad_id, profile_id) DO UPDATE SET
           campaign_id = EXCLUDED.campaign_id,
           ad_group_id = EXCLUDED.ad_group_id,
           asin        = EXCLUDED.asin,
           sku         = EXCLUDED.sku,
           state       = EXCLUDED.state,
           raw         = EXCLUDED.raw,
           synced_at   = EXCLUDED.synced_at`,
        [
          pa.adId,
          profileId,
          String(pa.campaignId),
          String(pa.adGroupId),
          pa.asin ?? null,
          pa.sku ?? null,
          pa.state,
          JSON.stringify(pa),
        ],
      );
      total++;
    }
  } while (nextToken);

  console.log(`productAds: total ${total} upserted`);
}

await pool.end();
