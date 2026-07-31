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

// Parse --from=YYYY-MM-DD --to=YYYY-MM-DD (REQUIRED)
const dateRe  = /^\d{4}-\d{2}-\d{2}$/;
const fromArg = process.argv.find(a => a.startsWith('--from='))?.slice(7);
const toArg   = process.argv.find(a => a.startsWith('--to='))?.slice(5);

if (!fromArg || !toArg || !dateRe.test(fromArg) || !dateRe.test(toArg)) {
  console.error('MISSING DATE RANGE');
  process.exit(1);
}

// Floor guard: asset per-day stats exist from 2025-06-05 onward only
const ASSET_FLOOR = '2025-06-05';
if (fromArg < ASSET_FLOOR) {
  console.error('BEFORE ASSET DATA FLOOR');
  process.exit(1);
}

const fromMs   = Date.parse(fromArg);
const toMs     = Date.parse(toArg);
const diffDays = Math.round((toMs - fromMs) / 86400000);

if (diffDays < 0 || diffDays > 62) {
  console.error('RANGE TOO LARGE');
  process.exit(1);
}

const execute = process.argv.includes('--execute');

// en(): map enum integer to string name; pass strings through unchanged
const en = (table, v) => v == null ? null : (typeof v === 'number' ? table[v] : String(v));

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
  SELECT ad_group_ad_asset_view.asset,
         ad_group_ad_asset_view.field_type,
         asset.id,
         asset.text_asset.text,
         segments.date,
         campaign.id,
         ad_group.id,
         metrics.impressions,
         metrics.clicks,
         metrics.cost_micros,
         metrics.conversions
  FROM ad_group_ad_asset_view
  WHERE segments.date BETWEEN '${fromArg}' AND '${toArg}'
  ORDER BY segments.date, ad_group.id, asset.id
`);

// Validate enums before any output or DB write; abort on unmapped
for (const row of rows) {
  const val = row.ad_group_ad_asset_view?.field_type;
  if (val == null) {
    console.error(`MISSING FIELD TYPE date=${row.segments?.date} asset=${row.asset?.id}`);
    process.exit(1);
  }
  if (en(enums.AssetFieldType, val) === undefined) {
    console.error(`UNMAPPED ENUM AssetFieldType ${val}`);
    process.exit(1);
  }
}

// asset_text: null-safe — non-text assets stay null, never ''
const assetText = (row) => {
  const t = row.asset?.text_asset?.text;
  return (t == null || t === '') ? null : t;
};

if (!execute) {
  const distinctDays   = new Set(rows.map(r => r.segments?.date)).size;
  const distinctAssets = new Set(rows.map(r => String(r.asset?.id))).size;
  const totalClicks       = rows.reduce((s, r) => s + Number(r.metrics?.clicks     ?? 0), 0);
  const totalCostMicros   = rows.reduce((s, r) => s + Number(r.metrics?.cost_micros ?? 0), 0);
  const totalConversions  = rows.reduce((s, r) => s + Number(r.metrics?.conversions  ?? 0), 0);

  console.log(`DRY RUN ${fromArg} ${toArg}`);
  console.log(`ROWS ${rows.length}`);
  console.log(`DAYS ${distinctDays}`);
  console.log(`ASSETS ${distinctAssets}`);
  console.log(`TOTAL clicks=${totalClicks} cost_micros=${totalCostMicros} conversions=${totalConversions}`);

  for (const row of rows.slice(0, 10)) {
    const ft = en(enums.AssetFieldType, row.ad_group_ad_asset_view?.field_type);
    console.log(
      `${row.segments?.date} | ${row.campaign?.id} | ${row.ad_group?.id} | ` +
      `${row.asset?.id} | ${ft} | ${assetText(row) ?? 'null'} | ` +
      `${row.metrics?.impressions ?? 0} | ${row.metrics?.clicks ?? 0} | ` +
      `${row.metrics?.cost_micros ?? 0} | ${row.metrics?.conversions ?? 0}`
    );
  }

  process.exit(0);
}

// --execute: batched upsert on (customer_id, date, ad_group_id, asset_id, field_type)
neonConfig.webSocketConstructor = WebSocket;
const pool = new Pool({ connectionString: dbUrl });

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const chunks = chunk(rows, 500);
let upserted = 0;
for (const batch of chunks) {
  const params = [];
  const valueClauses = batch.map((row, i) => {
    const base = i * 11;
    params.push(
      process.env.GOOGLE_ADS_CUSTOMER_ID,                                    // $1 customer_id
      row.segments?.date,                                                      // $2 date
      Number(row.campaign?.id),                                                // $3 campaign_id
      Number(row.ad_group?.id),                                                // $4 ad_group_id
      Number(row.asset?.id),                                                   // $5 asset_id
      en(enums.AssetFieldType, row.ad_group_ad_asset_view?.field_type),        // $6 field_type
      assetText(row),                                                           // $7 asset_text (null-safe)
      Number(row.metrics?.impressions  ?? 0),                                  // $8
      Number(row.metrics?.clicks       ?? 0),                                  // $9
      Number(row.metrics?.cost_micros  ?? 0),                                  // $10
      Number(row.metrics?.conversions  ?? 0),                                  // $11
    );
    return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},now())`;
  });
  await pool.query(
    `INSERT INTO google_asset_daily
       (customer_id, date, campaign_id, ad_group_id, asset_id, field_type,
        asset_text, impressions, clicks, cost_micros, conversions, last_synced_at)
     VALUES ${valueClauses.join(',')}
     ON CONFLICT (customer_id, date, ad_group_id, asset_id, field_type) DO UPDATE SET
       campaign_id=EXCLUDED.campaign_id,
       asset_text=EXCLUDED.asset_text,
       impressions=EXCLUDED.impressions,
       clicks=EXCLUDED.clicks,
       cost_micros=EXCLUDED.cost_micros,
       conversions=EXCLUDED.conversions,
       last_synced_at=now()`,
    params
  );
  upserted += batch.length;
  console.log(`BATCH ${upserted}/${rows.length}`);
}

await pool.end();
console.log(`UPSERTED rows=${upserted}`);
