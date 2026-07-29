import { GoogleAdsApi } from "google-ads-api";

const required = [
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_REFRESH_TOKEN",
];

for (const name of required) {
  if (!process.env[name]) {
    console.error(`MISSING ${name}`);
    process.exit(1);
  }
}

const client = new GoogleAdsApi({
  client_id:        process.env.GOOGLE_ADS_CLIENT_ID,
  client_secret:    process.env.GOOGLE_ADS_CLIENT_SECRET,
  developer_token:  process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
});

try {
  const res = await client.listAccessibleCustomers(
    process.env.GOOGLE_ADS_REFRESH_TOKEN
  );
  console.log(JSON.stringify(res, null, 2));
} catch (err) {
  console.error(err);
  process.exit(1);
}
