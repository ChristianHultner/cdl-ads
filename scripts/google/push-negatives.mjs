/**
 * scripts/google/push-negatives.mjs
 *
 * Push APPROVED NEGATE_TERM / NEGATE_NGRAM recommendations to Google Ads.
 * NOTHING is pushed unless --execute is supplied.
 *
 * DEFAULT MODE (no flags):
 *   Prints MANIFEST + calls Google Ads API with validate_only=true.
 *   Prints "VALIDATE OK id=<id>" or full API error per rec.
 *   No DB state changes.
 *
 * --execute:
 *   Requires ALL validations to have passed (any failure → abort before
 *   any real mutate). Then mutates one rec at a time. Per success:
 *     - captures resource_name from API response
 *     - UPDATE rec: state='PUSHED', action jsonb spread with pushed_at + resource_name
 *     - prints "PUSHED id=<id> resource=<resource_name>"
 *   Per failure: prints full error, leaves rec APPROVED, continues.
 *   Exits 1 at end if any failed.
 *
 * RECONCILIATION (both modes, after the above):
 *   execute: query Google Ads API for each pushed resource_name → "CONFIRMED id=<id>"
 *   default: "RECONCILE: skipped (dry run)"
 *
 * Summary: PUSH SUMMARY approved=<n> validated=<n> pushed=<n> confirmed=<n> failed=<n>
 *
 * Rec types handled: NEGATE_TERM (ad-group or campaign level, EXACT)
 *                    NEGATE_NGRAM (campaign level, PHRASE)
 * action jsonb shape: { type, level, target, match_type }
 * campaign_id / ad_group_id come from the rec row columns.
 */

import { GoogleAdsApi, enums } from 'google-ads-api';
import { neon, Pool, neonConfig } from '@neondatabase/serverless';

// ── ENV guards ─────────────────────────────────────────────────────────────────

const ENV_REQUIRED = [
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_DEVELOPER_TOKEN',
  'GOOGLE_ADS_REFRESH_TOKEN',
  'GOOGLE_ADS_CUSTOMER_ID',
  'GOOGLE_DATABASE_URL',
];

for (const name of ENV_REQUIRED) {
  if (!process.env[name]) {
    console.error(`MISSING ${name}`);
    process.exit(1);
  }
}

// ── DB host guard ──────────────────────────────────────────────────────────────

const EXPECTED_HOST = 'ep-holy-star-afsf5u86';
const CUSTOMER_ID   = '2199803274';
const dbUrl = process.env.GOOGLE_DATABASE_URL;

if (!dbUrl.includes(EXPECTED_HOST)) {
  console.error(`WRONG DATABASE (expected host: ${EXPECTED_HOST})`);
  process.exit(1);
}

if (process.env.GOOGLE_ADS_CUSTOMER_ID !== CUSTOMER_ID) {
  console.error(
    `UNEXPECTED CUSTOMER ID (got ${process.env.GOOGLE_ADS_CUSTOMER_ID}, want ${CUSTOMER_ID})`
  );
  process.exit(1);
}

// ── Customer hard guard (vs google_accounts) ───────────────────────────────────

const sql = neon(dbUrl);

const acctRows = await sql`
  SELECT customer_id FROM google_accounts WHERE customer_id = ${CUSTOMER_ID} LIMIT 1
`;
if (acctRows.length === 0) {
  console.error(`FATAL: customer ${CUSTOMER_ID} not found in google_accounts — wrong database?`);
  process.exit(1);
}

// ── Flags ──────────────────────────────────────────────────────────────────────

const execute = process.argv.includes('--execute');

// ── Google Ads client ──────────────────────────────────────────────────────────

const api = new GoogleAdsApi({
  client_id:       process.env.GOOGLE_ADS_CLIENT_ID,
  client_secret:   process.env.GOOGLE_ADS_CLIENT_SECRET,
  developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
});

const customer = api.Customer({
  customer_id:   process.env.GOOGLE_ADS_CUSTOMER_ID,
  refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
});

// ── Read APPROVED NEGATE recs ──────────────────────────────────────────────────

const NEGATE_TYPES = ['NEGATE_TERM', 'NEGATE_NGRAM'];

const recs = await sql`
  SELECT
    id,
    rec_type,
    entity_key,
    action,
    campaign_id,
    ad_group_id
  FROM  google_recommendations
  WHERE state    = 'APPROVED'
    AND rec_type = ANY(${NEGATE_TYPES})
  ORDER BY id ASC
`;

if (recs.length === 0) {
  console.log('No APPROVED NEGATE recs. Exiting.');
  console.log('PUSH SUMMARY approved=0 validated=0 pushed=0 confirmed=0 failed=0');
  process.exit(0);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildOperation(rec) {
  const action       = rec.action;
  const matchTypeVal = enums.KeywordMatchType[action.match_type];
  if (matchTypeVal === undefined) {
    throw new Error(`Unknown match_type "${action.match_type}" for id=${rec.id}`);
  }

  if (action.level === 'campaign') {
    return {
      _resource: 'CampaignCriterion',
      campaign:  `customers/${CUSTOMER_ID}/campaigns/${rec.campaign_id}`,
      negative:  true,
      keyword: {
        text:       action.target,
        match_type: matchTypeVal,
      },
    };
  } else {
    // ad_group level
    return {
      _resource: 'AdGroupCriterion',
      ad_group:  `customers/${CUSTOMER_ID}/ad_groups/${rec.ad_group_id}`,
      negative:  true,
      keyword: {
        text:       action.target,
        match_type: matchTypeVal,
      },
    };
  }
}

function levelId(rec) {
  return rec.action.level === 'campaign' ? rec.campaign_id : rec.ad_group_id;
}

function fmtError(err) {
  const lines = [];
  lines.push(String(err?.message ?? err));
  if (Array.isArray(err?.errors)) {
    for (const e of err.errors) {
      lines.push('  ' + JSON.stringify(e));
    }
  }
  return lines.join('\n');
}

// ── MANIFEST ───────────────────────────────────────────────────────────────────

console.log(`--- MANIFEST (${recs.length} rec${recs.length === 1 ? '' : 's'}) ---`);
for (const rec of recs) {
  console.log(
    `MANIFEST id=${rec.id} ${rec.rec_type} ${rec.action.match_type}` +
    ` '${rec.entity_key}' -> ${rec.action.level} ${levelId(rec)}`
  );
}
console.log('');

// ── VALIDATION (validate_only=true for ALL recs) ───────────────────────────────

console.log('--- VALIDATION ---');
const validationStatus = new Map(); // id -> boolean

for (const rec of recs) {
  try {
    const op = buildOperation(rec);
    await customer.mutateResources([op], { validate_only: true });
    console.log(`VALIDATE OK id=${rec.id}`);
    validationStatus.set(rec.id, true);
  } catch (err) {
    console.log(`VALIDATE FAIL id=${rec.id}`);
    console.log(fmtError(err));
    validationStatus.set(rec.id, false);
  }
}
console.log('');

const validatedCount  = [...validationStatus.values()].filter(Boolean).length;
const validationFailed = validatedCount < recs.length;

// ── Abort if any validation failed (both modes) ────────────────────────────────

if (validationFailed) {
  const nFailed = recs.length - validatedCount;
  console.error(
    `ABORTING: ${nFailed} validation failure${nFailed === 1 ? '' : 's'} —` +
    ` no real mutate performed`
  );
  process.exit(1);
}

// ── Dry-run gate — nothing below is reachable without --execute ────────────────

if (!execute) {
  console.log('--- RECONCILIATION ---');
  console.log('RECONCILE: skipped (dry run)');
  console.log(`PUSH SUMMARY approved=${recs.length} validated=${validatedCount} pushed=0 confirmed=0 failed=0`);
  process.exit(0);
}

neonConfig.webSocketConstructor = WebSocket;
const pool = new Pool({ connectionString: dbUrl });

console.log('--- EXECUTE ---');
let pushed      = 0;
let failed      = 0;
const pushedLog = []; // { rec, resourceName } for reconciliation

for (const rec of recs) {
  try {
    const op     = buildOperation(rec);
    const result = await customer.mutateResources([op]);
    const resourceName = result?.results?.[0]?.resource_name ?? null;
    const pushedAt     = new Date().toISOString();

    await pool.query(
      `UPDATE google_recommendations
          SET state  = 'PUSHED',
              action = action || $1::jsonb
        WHERE id    = $2
          AND state = 'APPROVED'`,
      [
        JSON.stringify({ pushed_at: pushedAt, resource_name: resourceName }),
        rec.id,
      ]
    );

    console.log(`PUSHED id=${rec.id} resource=${resourceName}`);
    pushedLog.push({ rec, resourceName });
    pushed++;
  } catch (err) {
    console.error(`FAIL id=${rec.id}`);
    console.error(fmtError(err));
    // rec remains APPROVED; continue with rest
    failed++;
  }
}
console.log('');

await pool.end();

// ── RECONCILIATION ─────────────────────────────────────────────────────────────

console.log('--- RECONCILIATION ---');
let confirmed = 0;

for (const { rec, resourceName } of pushedLog) {
  if (!resourceName) {
    console.log(`RECONCILE SKIP id=${rec.id} (no resource_name returned)`);
    continue;
  }

  const isAdGroup   = rec.action.level !== 'campaign';
  const gaqlTable   = isAdGroup ? 'ad_group_criterion'   : 'campaign_criterion';
  const gaqlField   = isAdGroup
    ? 'ad_group_criterion.resource_name'
    : 'campaign_criterion.resource_name';
  const safeRN      = resourceName.replace(/'/g, "''");

  try {
    const rows = await customer.query(
      `SELECT ${gaqlField} FROM ${gaqlTable} WHERE ${gaqlField} = '${safeRN}'`
    );
    if (rows.length > 0) {
      console.log(`CONFIRMED id=${rec.id}`);
      confirmed++;
    } else {
      console.log(`NOT FOUND id=${rec.id} resource=${resourceName}`);
    }
  } catch (err) {
    console.log(`RECONCILE ERROR id=${rec.id}: ${String(err?.message ?? err)}`);
  }
}
console.log('');

// ── Summary ────────────────────────────────────────────────────────────────────

console.log(
  `PUSH SUMMARY approved=${recs.length} validated=${validatedCount}` +
  ` pushed=${pushed} confirmed=${confirmed} failed=${failed}`
);

process.exit(failed > 0 ? 1 : 0);
