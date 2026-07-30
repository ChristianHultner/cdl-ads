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

// Query 1: account
const [acctRow] = await customer.query(`
  SELECT customer.id, customer.descriptive_name, customer.currency_code,
         customer.time_zone, customer.manager
  FROM customer
`);

// Query 2: campaigns
const campaignRows = await customer.query(`
  SELECT campaign.id, campaign.name, campaign.status,
         campaign.advertising_channel_type, campaign.bidding_strategy_type,
         campaign_budget.amount_micros, campaign.start_date_time, campaign.end_date_time
  FROM campaign
  ORDER BY campaign.id
`);

const a = acctRow.customer;

if (!execute) {
  console.log('DRY RUN');
  console.log(
    `${a.id} | ${a.descriptive_name} | ${a.currency_code} | ` +
    `${a.time_zone} | manager=${a.manager}`
  );
  for (const row of campaignRows) {
    const c = row.campaign;
    const b = row.campaign_budget;
    console.log(
      `${c.id} | ${c.name} | ${en(enums.CampaignStatus, c.status)} | ${en(enums.AdvertisingChannelType, c.advertising_channel_type)} | ` +
      `${en(enums.BiddingStrategyType, c.bidding_strategy_type) ?? 'null'} | ${b?.amount_micros ?? 'null'}`
    );
  }
  console.log(`TOTAL ${campaignRows.length} campaigns`);
  process.exit(0);
}

// --execute: upsert to database

// Safety: validate enum mappings before any DB write
for (const row of campaignRows) {
  const c = row.campaign;
  const checks = [
    ['status', enums.CampaignStatus, c.status],
    ['advertising_channel_type', enums.AdvertisingChannelType, c.advertising_channel_type],
    ['bidding_strategy_type', enums.BiddingStrategyType, c.bidding_strategy_type],
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

await pool.query(
  `INSERT INTO google_accounts
     (customer_id, descriptive_name, currency_code, time_zone, is_manager, last_synced_at)
   VALUES ($1,$2,$3,$4,$5,now())
   ON CONFLICT (customer_id) DO UPDATE SET
     descriptive_name=EXCLUDED.descriptive_name, currency_code=EXCLUDED.currency_code,
     time_zone=EXCLUDED.time_zone, is_manager=EXCLUDED.is_manager, last_synced_at=now()`,
  [a.id, a.descriptive_name, a.currency_code, a.time_zone, a.manager ?? false]
);

let campsUpserted = 0;
for (const row of campaignRows) {
  const c = row.campaign;
  const b = row.campaign_budget;
  await pool.query(
    `INSERT INTO google_campaigns
       (campaign_id, customer_id, name, status, advertising_channel_type,
        bidding_strategy_type, budget_micros, start_date, end_date, last_synced_at, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10)
     ON CONFLICT (campaign_id) DO UPDATE SET
       customer_id=EXCLUDED.customer_id, name=EXCLUDED.name, status=EXCLUDED.status,
       advertising_channel_type=EXCLUDED.advertising_channel_type,
       bidding_strategy_type=EXCLUDED.bidding_strategy_type,
       budget_micros=EXCLUDED.budget_micros, start_date=EXCLUDED.start_date,
       end_date=EXCLUDED.end_date, last_synced_at=now(), raw=EXCLUDED.raw`,
    [
      c.id, a.id, c.name, en(enums.CampaignStatus, c.status), en(enums.AdvertisingChannelType, c.advertising_channel_type),
      en(enums.BiddingStrategyType, c.bidding_strategy_type), b?.amount_micros ?? null,
      (c.start_date_time ?? null) && String(c.start_date_time).slice(0, 10),
      (c.end_date_time ?? null) && String(c.end_date_time).slice(0, 10),
      JSON.stringify(row),
    ]
  );
  campsUpserted++;
}

await pool.end();
console.log(`UPSERTED accounts=1 campaigns=${campsUpserted}`);
