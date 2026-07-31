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

// Aggregate to PK grain: (date, campaign_id, ad_group_id, asset_id, field_type)
// The view returns one row per ad; same asset in multiple RSAs in one ad group
// produces multiple source rows per PK. Sum metrics; keep first non-null asset_text.
const sourceRowCount = rows.length;
const aggMap = new Map();
for (const row of rows) {
  const date       = row.segments?.date;
  const campaignId = Number(row.campaign?.id);
  const adGroupId  = Number(row.ad_group?.id);
  const assetId    = Number(row.asset?.id);
  const fieldType  = en(enums.AssetFieldType, row.ad_group_ad_asset_view?.field_type);
  const key = `${date}|${campaignId}|${adGroupId}|${assetId}|${fieldType}`;

  if (!aggMap.has(key)) {
    aggMap.set(key, {
      date, campaignId, adGroupId, assetId, fieldType,
      assetTextVal: assetText(row),
      impressions:  Number(row.metrics?.impressions  ?? 0),
      clicks:       Number(row.metrics?.clicks       ?? 0),
      costMicros:   Number(row.metrics?.cost_micros  ?? 0),
      conversions:  Number(row.metrics?.conversions  ?? 0),
    });
  } else {
    const a = aggMap.get(key);
    if (a.assetTextVal == null) a.assetTextVal = assetText(row); // keep first non-null
    a.impressions += Number(row.metrics?.impressions  ?? 0);
    a.clicks      += Number(row.metrics?.clicks       ?? 0);
    a.costMicros  += Number(row.metrics?.cost_micros  ?? 0);
    a.conversions += Number(row.metrics?.conversions  ?? 0);
  }
}
const agg = [...aggMap.values()];

if (!execute) {
  const distinctDays   = new Set(agg.map(r => r.date)).size;
  const distinctAssets = new Set(agg.map(r => String(r.assetId))).size;
  const totalClicks      = agg.reduce((s, r) => s + r.clicks,      0);
  const totalCostMicros  = agg.reduce((s, r) => s + r.costMicros,  0);
  const totalConversions = agg.reduce((s, r) => s + r.conversions, 0);

  console.log(`DRY RUN ${fromArg} ${toArg}`);
  console.log(`ROWS ${agg.length}`);
  console.log(`SOURCE ROWS ${sourceRowCount} AGGREGATED ${agg.length}`);
  console.log(`DAYS ${distinctDays}`);
  console.log(`ASSETS ${distinctAssets}`);
  console.log(`TOTAL clicks=${totalClicks} cost_micros=${totalCostMicros} conversions=${totalConversions}`);

  for (const r of agg.slice(0, 10)) {
    console.log(
      `${r.date} | ${r.campaignId} | ${r.adGroupId} | ` +
      `${r.assetId} | ${r.fieldType} | ${r.assetTextVal ?? 'null'} | ` +
      `${r.impressions} | ${r.clicks} | ${r.costMicros} | ${r.conversions}`
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

const chunks = chunk(agg, 500);
let upserted = 0;
for (const batch of chunks) {
  const params = [];
  const valueClauses = batch.map((r, i) => {
    const base = i * 11;
    params.push(
      process.env.GOOGLE_ADS_CUSTOMER_ID, // $1 customer_id
      r.date,                              // $2 date
      r.campaignId,                        // $3 campaign_id
      r.adGroupId,                         // $4 ad_group_id
      r.assetId,                           // $5 asset_id
      r.fieldType,                         // $6 field_type
      r.assetTextVal,                      // $7 asset_text (null-safe)
      r.impressions,                       // $8
      r.clicks,                            // $9
      r.costMicros,                        // $10
      r.conversions,                       // $11
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
  console.log(`BATCH ${upserted}/${agg.length}`);
}

await pool.end();
console.log(`UPSERTED rows=${upserted}`);
