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

// GAQL A: ad groups
const adGroupRows = await customer.query(`
  SELECT ad_group.id, ad_group.name, ad_group.status,
         ad_group.type, campaign.id
  FROM ad_group
  ORDER BY ad_group.id
`);

// GAQL B: keywords
const keywordRows = await customer.query(`
  SELECT ad_group.id,
         ad_group_criterion.criterion_id,
         ad_group_criterion.keyword.text,
         ad_group_criterion.keyword.match_type,
         ad_group_criterion.status,
         ad_group_criterion.negative,
         ad_group_criterion.cpc_bid_micros
  FROM keyword_view
  ORDER BY ad_group.id, ad_group_criterion.criterion_id
`);

if (!execute) {
  console.log('DRY RUN');
  console.log(`AD GROUPS ${adGroupRows.length}`);
  console.log(`KEYWORDS ${keywordRows.length}`);

  // Per-status keyword breakdown
  const statusCounts = {};
  for (const row of keywordRows) {
    const st = en(enums.AdGroupCriterionStatus, row.ad_group_criterion.status) ?? String(row.ad_group_criterion.status);
    statusCounts[st] = (statusCounts[st] ?? 0) + 1;
  }
  for (const [st, count] of Object.entries(statusCounts)) {
    console.log(`KW ${st} ${count}`);
  }

  // First 20 keyword rows
  const first20 = keywordRows.slice(0, 20);
  for (const row of first20) {
    const ag = row.ad_group;
    const c  = row.ad_group_criterion;
    const st = en(enums.AdGroupCriterionStatus, c.status) ?? String(c.status);
    const mt = en(enums.KeywordMatchType, c.keyword?.match_type) ?? String(c.keyword?.match_type);
    console.log(`${ag.id} | ${c.keyword?.text ?? ''} | ${mt} | ${st}`);
  }

  process.exit(0);
}

// --execute: validate enums before any DB write
for (const row of adGroupRows) {
  const ag = row.ad_group;
  const checks = [
    ['ad_group.status', enums.AdGroupStatus,  ag.status],
    ['ad_group.type',   enums.AdGroupType,     ag.type],
  ];
  for (const [field, table, val] of checks) {
    if (val != null && en(table, val) === undefined) {
      console.error(`UNMAPPED ENUM ${field} ${val}`);
      process.exit(1);
    }
  }
}

for (const row of keywordRows) {
  const c = row.ad_group_criterion;
  if (!c.keyword?.text) { console.error(
    `MISSING KEYWORD TEXT ad_group=${row.ad_group.id} criterion=${c.criterion_id}`);
    process.exit(1); }
  const checks = [
    ['criterion.status',     enums.AdGroupCriterionStatus, c.status],
    ['keyword.match_type',   enums.KeywordMatchType,        c.keyword?.match_type],
  ];
  for (const [field, table, val] of checks) {
    if (val != null && en(table, val) === undefined) {
      console.error(`UNMAPPED ENUM ${field} ${val}`);
      process.exit(1);
    }
  }
}

neonConfig.webSocketConstructor = WebSocket;
const pool = new Pool({ connectionString: dbUrl });

// Upsert ad groups first (FK dependency for keywords)
let agUpserted = 0;
for (const row of adGroupRows) {
  const ag  = row.ad_group;
  const cam = row.campaign;
  await pool.query(
    `INSERT INTO google_ad_groups
       (ad_group_id, campaign_id, customer_id, name, status, type, last_synced_at, raw)
     VALUES ($1,$2,$3,$4,$5,$6,now(),$7)
     ON CONFLICT (ad_group_id) DO UPDATE SET
       campaign_id=EXCLUDED.campaign_id,
       customer_id=EXCLUDED.customer_id,
       name=EXCLUDED.name,
       status=EXCLUDED.status,
       type=EXCLUDED.type,
       last_synced_at=now(),
       raw=EXCLUDED.raw`,
    [
      ag.id,
      cam.id,
      process.env.GOOGLE_ADS_CUSTOMER_ID,
      ag.name,
      en(enums.AdGroupStatus, ag.status),
      en(enums.AdGroupType, ag.type),
      JSON.stringify(row),
    ]
  );
  agUpserted++;
}

// Upsert keywords second (depends on google_ad_groups)
let kwUpserted = 0;
for (const row of keywordRows) {
  const ag = row.ad_group;
  const c  = row.ad_group_criterion;
  await pool.query(
    `INSERT INTO google_keywords
       (ad_group_id, criterion_id, text, match_type, status, negative,
        cpc_bid_micros, last_synced_at, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8)
     ON CONFLICT (ad_group_id, criterion_id) DO UPDATE SET
       text=EXCLUDED.text,
       match_type=EXCLUDED.match_type,
       status=EXCLUDED.status,
       negative=EXCLUDED.negative,
       cpc_bid_micros=EXCLUDED.cpc_bid_micros,
       last_synced_at=now(),
       raw=EXCLUDED.raw`,
    [
      ag.id,
      c.criterion_id,
      c.keyword.text,
      en(enums.KeywordMatchType, c.keyword?.match_type),
      en(enums.AdGroupCriterionStatus, c.status),
      c.negative ?? false,
      c.cpc_bid_micros ?? null,
      JSON.stringify(row),
    ]
  );
  kwUpserted++;
}

await pool.end();
console.log(`UPSERTED ad_groups=${agUpserted} keywords=${kwUpserted}`);
