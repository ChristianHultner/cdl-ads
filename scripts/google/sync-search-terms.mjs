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

// Parse --from=YYYY-MM-DD --to=YYYY-MM-DD
const dateRe  = /^\d{4}-\d{2}-\d{2}$/;
const fromArg = process.argv.find(a => a.startsWith('--from='))?.slice(7);
const toArg   = process.argv.find(a => a.startsWith('--to='))?.slice(5);

if (!fromArg || !toArg || !dateRe.test(fromArg) || !dateRe.test(toArg)) {
  console.error('MISSING DATE RANGE');
  process.exit(1);
}

const fromMs  = Date.parse(fromArg);
const toMs    = Date.parse(toArg);
const diffDays = Math.round((toMs - fromMs) / 86400000);

if (diffDays < 0 || diffDays > 62) {
  console.error('RANGE TOO LARGE');
  process.exit(1);
}

const execute = process.argv.includes('--execute');

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
  SELECT search_term_view.search_term,
         search_term_view.status,
         segments.date,
         segments.search_term_match_type,
         campaign.id,
         ad_group.id,
         metrics.impressions,
         metrics.clicks,
         metrics.cost_micros,
         metrics.conversions,
         metrics.conversions_value
  FROM search_term_view
  WHERE segments.date BETWEEN '${fromArg}' AND '${toArg}'
  ORDER BY segments.date
`);

// Validate enums before any output or DB write
for (const row of rows) {
  const val = row.segments?.search_term_match_type;
  if (val != null && en(enums.SearchTermMatchType, val) === undefined) {
    console.error(`UNMAPPED ENUM search_term_match_type ${val}`);
    process.exit(1);
  }
}

if (!execute) {
  const distinctDates   = new Set(rows.map(r => r.segments?.date)).size;
  const totalClicks     = rows.reduce((s, r) => s + Number(r.metrics?.clicks     ?? 0), 0);
  const totalCostMicros = rows.reduce((s, r) => s + Number(r.metrics?.cost_micros ?? 0), 0);

  console.log(`DRY RUN ${fromArg} ${toArg}`);
  console.log(`ROWS ${rows.length}`);
  console.log(`DAYS ${distinctDates}`);
  console.log(`TOTAL clicks=${totalClicks} cost_micros=${totalCostMicros}`);

  for (const row of rows.slice(0, 15)) {
    const mt = en(enums.SearchTermMatchType, row.segments?.search_term_match_type) ?? String(row.segments?.search_term_match_type);
    console.log(
      `${row.segments?.date} | ${row.campaign?.id} | ${row.search_term_view?.search_term} | ` +
      `${mt} | ${row.metrics?.impressions ?? 0} | ${row.metrics?.clicks ?? 0} | ${row.metrics?.cost_micros ?? 0}`
    );
  }

  process.exit(0);
}

// --execute: batched upsert
neonConfig.webSocketConstructor = WebSocket;
const pool = new Pool({ connectionString: dbUrl });

// Helper: split array into fixed-size chunks
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
      process.env.GOOGLE_ADS_CUSTOMER_ID,
      row.segments?.date,
      row.campaign?.id,
      row.ad_group?.id,
      row.search_term_view?.search_term,
      en(enums.SearchTermMatchType, row.segments?.search_term_match_type),
      Number(row.metrics?.impressions   ?? 0),
      Number(row.metrics?.clicks        ?? 0),
      Number(row.metrics?.cost_micros   ?? 0),
      Number(row.metrics?.conversions   ?? 0),
      Number(row.metrics?.conversions_value ?? 0),
    );
    return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},now())`;
  });
  await pool.query(
    `INSERT INTO google_search_term_daily
       (customer_id, date, campaign_id, ad_group_id, search_term, match_type,
        impressions, clicks, cost_micros, conversions, conversions_value, last_synced_at)
     VALUES ${valueClauses.join(',')}
     ON CONFLICT (customer_id, date, campaign_id, ad_group_id, search_term) DO UPDATE SET
       match_type=EXCLUDED.match_type,
       impressions=EXCLUDED.impressions,
       clicks=EXCLUDED.clicks,
       cost_micros=EXCLUDED.cost_micros,
       conversions=EXCLUDED.conversions,
       conversions_value=EXCLUDED.conversions_value,
       last_synced_at=now()`,
    params
  );
  upserted += batch.length;
  console.log(`BATCH ${upserted}/${rows.length}`);
}

await pool.end();
console.log(`UPSERTED rows=${upserted}`);
