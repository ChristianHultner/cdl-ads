import { GoogleAdsApi, enums } from 'google-ads-api';
import { Pool, neonConfig } from '@neondatabase/serverless';

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

const dbUrl = process.env.GOOGLE_DATABASE_URL;
if (!dbUrl.includes('ep-holy-star-afsf5u86')) {
  console.error('WRONG DATABASE');
  process.exit(1);
}

if (process.env.GOOGLE_ADS_CUSTOMER_ID !== '2199803274') {
  console.error('UNEXPECTED CUSTOMER ID');
  process.exit(1);
}

const execute = process.argv.includes('--execute');

// en(): map enum integer to string name; pass strings through unchanged
const en = (table, v) => v == null ? null : (typeof v === 'number' ? table[v] : String(v));

// Parse campaign_id from a campaign resource name (null-safe)
// e.g. "customers/2199803274/campaigns/987654321" → 987654321
const parseCampaignId = (rn) => {
  if (!rn) return null;
  const m = String(rn).match(/\/campaigns\/(\d+)/);
  return m ? Number(m[1]) : null;
};

const api = new GoogleAdsApi({
  client_id:       process.env.GOOGLE_ADS_CLIENT_ID,
  client_secret:   process.env.GOOGLE_ADS_CLIENT_SECRET,
  developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
});

const customer = api.Customer({
  customer_id:   process.env.GOOGLE_ADS_CUSTOMER_ID,
  refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
});

const rows = await customer.query(`
  SELECT recommendation.resource_name,
         recommendation.type,
         recommendation.dismissed,
         recommendation.campaign
  FROM recommendation
`);

// Validate enums before any output or DB write; abort on unmapped
for (const row of rows) {
  const val = row.recommendation?.type;
  if (val == null) {
    console.error(`MISSING TYPE resource_name=${row.recommendation?.resource_name}`);
    process.exit(1);
  }
  if (en(enums.RecommendationType, val) === undefined) {
    console.error(`UNMAPPED ENUM RecommendationType ${val}`);
    process.exit(1);
  }
}

if (!execute) {
  // Per-type counts
  const typeCounts = {};
  for (const row of rows) {
    const t = en(enums.RecommendationType, row.recommendation?.type);
    typeCounts[t] = (typeCounts[t] ?? 0) + 1;
  }

  console.log(`RECS ${rows.length}`);
  for (const [type, count] of Object.entries(typeCounts).sort()) {
    console.log(`${type} ${count}`);
  }

  for (const row of rows.slice(0, 10)) {
    const type       = en(enums.RecommendationType, row.recommendation?.type);
    const campaign   = row.recommendation?.campaign ?? 'null';
    const dismissed  = row.recommendation?.dismissed ?? 'null';
    console.log(`${type} | ${campaign} | ${dismissed}`);
  }

  process.exit(0);
}

// --execute: INSERT all rows as one snapshot (point-in-time, no upsert)
neonConfig.webSocketConstructor = WebSocket;
const pool = new Pool({ connectionString: dbUrl });

// Capture a single snapshot timestamp for the whole run
const snapAt = new Date().toISOString();

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const chunks = chunk(rows, 500);
let inserted = 0;
for (const batch of chunks) {
  const params = [];
  const valueClauses = batch.map((row, i) => {
    const base = i * 7;
    params.push(
      snapAt,                                                                     // $1 snapshot_at
      process.env.GOOGLE_ADS_CUSTOMER_ID,                                         // $2 customer_id
      row.recommendation?.resource_name,                                           // $3 resource_name
      en(enums.RecommendationType, row.recommendation?.type),                      // $4 type
      parseCampaignId(row.recommendation?.campaign),                               // $5 campaign_id (null-safe)
      row.recommendation?.dismissed ?? null,                                        // $6 dismissed
      JSON.stringify(row.recommendation ?? row),                                    // $7 raw
    );
    return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7})`;
  });
  await pool.query(
    `INSERT INTO google_recommendation_snapshots
       (snapshot_at, customer_id, resource_name, type, campaign_id, dismissed, raw)
     VALUES ${valueClauses.join(',')}`,
    params
  );
  inserted += batch.length;
}

await pool.end();
console.log(`SNAPSHOT inserted=${inserted}`);
