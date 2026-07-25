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
  'Authorization':                   `Bearer ${accessToken}`,
  'Amazon-Advertising-API-ClientId': LWA_CLIENT_ID,
  'Amazon-Advertising-API-Scope':    String(profileId),
};

const PAGE_CAP = 200;

// ---------------------------------------------------------------------------
// Phase 1: Targets  —  POST /sp/targets/list
// ---------------------------------------------------------------------------
{
  const MEDIA   = 'application/vnd.spTargetingClause.v3+json';
  let nextToken = undefined;
  let page      = 0;
  let total     = 0;

  do {
    if (page >= PAGE_CAP) {
      console.error('targets: PAGE CAP HIT');
      process.exit(1);
    }
    page++;
    const reqBody = { maxResults: 100 };
    if (nextToken) reqBody.nextToken = nextToken;

    const res = await fetchWithTimeout(
      `${host}/sp/targets/list`,
      {
        method:  'POST',
        headers: { ...authHeaders, 'Content-Type': MEDIA, 'Accept': MEDIA },
        body:    JSON.stringify(reqBody),
      },
      `targets/list page ${page}`,
    );
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`targets/list ${res.status}: ${errBody}`);
    }

    const data  = await res.json();
    const items = data.targetingClauses ?? [];
    nextToken   = data.nextToken ?? undefined;
    console.log(`targets: page ${page} got ${items.length}`);

    for (const t of items) {
      // Extract resolved_asin: first expression entry of type ASIN_SAME_AS, uppercased
      const expressionArr = Array.isArray(t.expression) ? t.expression : [];
      const asinEntry     = expressionArr.find(e => e.type === 'ASIN_SAME_AS');
      const resolvedAsin  = asinEntry ? String(asinEntry.value).toUpperCase() : null;

      await pool.query(
        `INSERT INTO amazon_targets
           (target_id, profile_id, campaign_id, ad_group_id, state,
            expression_type, expression, resolved_asin, bid, raw, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
         ON CONFLICT (target_id, profile_id) DO UPDATE SET
           campaign_id     = EXCLUDED.campaign_id,
           ad_group_id     = EXCLUDED.ad_group_id,
           state           = EXCLUDED.state,
           expression_type = EXCLUDED.expression_type,
           expression      = EXCLUDED.expression,
           resolved_asin   = EXCLUDED.resolved_asin,
           bid             = EXCLUDED.bid,
           raw             = EXCLUDED.raw,
           synced_at       = EXCLUDED.synced_at`,
        [
          String(t.targetId),
          profileId,
          String(t.campaignId),
          String(t.adGroupId),
          t.state,
          t.expressionType ?? null,
          JSON.stringify(expressionArr),
          resolvedAsin,
          t.bid ?? null,
          JSON.stringify(t),
        ],
      );
      total++;
    }
  } while (nextToken);

  console.log(`targets: total ${total} upserted`);
}

// ---------------------------------------------------------------------------
// Phase 2: Keywords  —  POST /sp/keywords/list
// ---------------------------------------------------------------------------
{
  const MEDIA   = 'application/vnd.spKeyword.v3+json';
  let nextToken = undefined;
  let page      = 0;
  let total     = 0;

  do {
    if (page >= PAGE_CAP) {
      console.error('keywords: PAGE CAP HIT');
      process.exit(1);
    }
    page++;
    const reqBody = { maxResults: 100 };
    if (nextToken) reqBody.nextToken = nextToken;

    const res = await fetchWithTimeout(
      `${host}/sp/keywords/list`,
      {
        method:  'POST',
        headers: { ...authHeaders, 'Content-Type': MEDIA, 'Accept': MEDIA },
        body:    JSON.stringify(reqBody),
      },
      `keywords/list page ${page}`,
    );
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`keywords/list ${res.status}: ${errBody}`);
    }

    const data  = await res.json();
    const items = data.keywords ?? [];
    nextToken   = data.nextToken ?? undefined;
    console.log(`keywords: page ${page} got ${items.length}`);

    for (const kw of items) {
      await pool.query(
        `INSERT INTO amazon_keywords
           (keyword_id, profile_id, campaign_id, ad_group_id,
            keyword_text, match_type, state, bid, raw, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
         ON CONFLICT (keyword_id, profile_id) DO UPDATE SET
           campaign_id  = EXCLUDED.campaign_id,
           ad_group_id  = EXCLUDED.ad_group_id,
           keyword_text = EXCLUDED.keyword_text,
           match_type   = EXCLUDED.match_type,
           state        = EXCLUDED.state,
           bid          = EXCLUDED.bid,
           raw          = EXCLUDED.raw,
           synced_at    = EXCLUDED.synced_at`,
        [
          String(kw.keywordId),
          profileId,
          String(kw.campaignId),
          String(kw.adGroupId),
          kw.keywordText,
          kw.matchType,
          kw.state,
          kw.bid ?? null,
          JSON.stringify(kw),
        ],
      );
      total++;
    }
  } while (nextToken);

  console.log(`keywords: total ${total} upserted`);
}

await pool.end();
