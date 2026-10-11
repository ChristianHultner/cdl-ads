// September qualification backfill, sharing the Vercel runner's exact v2 path.
// --phase request|ingest [--replay]; --replay re-downloads INGESTED v2 reports with the corrected filter; never publishes console_history.
import { parseArgs } from 'node:util';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { createApi, requestCampaignReport, downloadLegacyReport, ingestTransaction, isAmazonDatabase } from '../lib/amazon/sync-runner.ts';

const { values } = parseArgs({ options: { phase: { type: 'string' }, replay: { type: 'boolean', default: false } } });
if (!['request','ingest'].includes(values.phase)) throw new Error('--phase request|ingest required');
if (values.replay && values.phase !== 'ingest') throw new Error('--replay requires --phase ingest');
if (!isAmazonDatabase(process.env.DATABASE_URL)) throw new Error('WRONG DATABASE');
neonConfig.webSocketConstructor = WebSocket;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
const step = values.phase === 'request' ? 'request-reports' : 'ingest-reports';
let locked = false, errors = 0;
try {
  locked = (await client.query("SELECT pg_try_advisory_lock(hashtext('amazon-vercel-sync'),hashtext($1)) AS locked", [step])).rows[0].locked;
  if (!locked) throw new Error('Runner busy; retry later');
  const { rows: profiles } = await client.query(`SELECT p.profile_id::text,p.country_code AS market,p.region,c.env_var_name
    FROM amazon_profiles p JOIN amazon_credentials c ON c.id=p.credential_id
    WHERE p.profile_id IN (2263723137827296,139446882235960,395707988492653) ORDER BY p.country_code`);
  for (const profile of profiles) {
    const deadline = Date.now() + 270_000;
    const api = await createApi(profile, deadline);
    let requested = 0, landed = 0, pending = 0, skipped = 0;
    for (let day = 1; day <= 30; day++) {
      const date = `2026-09-${String(day).padStart(2,'0')}`;
      const { rows: existing } = await client.query(`SELECT report_id,profile_id::text,report_type,status,
        start_date::text,end_date::text,false AS expired FROM amazon_report_requests
        WHERE profile_id=$1 AND report_type='sbLegacyCampaigns' AND start_date=$2 AND end_date=$2
          AND status IN ('PENDING','COMPLETED','INGESTED') ORDER BY requested_at DESC LIMIT 1`, [profile.profile_id,date]);
      if (values.phase === 'request') {
        if (existing.length) { skipped++; continue; }
        const { body } = await requestCampaignReport(api,'sbLegacyCampaigns',date,date);
        if (!body.reportId) throw new Error('Missing report ID');
        await client.query(`INSERT INTO amazon_report_requests(report_id,profile_id,report_type,start_date,end_date,status)
          VALUES ($1,$2,'sbLegacyCampaigns',$3,$3,'PENDING') ON CONFLICT(report_id) DO NOTHING`, [body.reportId,profile.profile_id,date]);
        requested++;
      } else {
        const request = existing[0];
        if (!request) { errors++; continue; }
        if (request.status === 'INGESTED' && !values.replay) { skipped++; continue; }
        const { body } = await api(`/v2/reports/${encodeURIComponent(request.report_id)}`);
        if (body.status !== 'SUCCESS') { pending++; if (body.status === 'FAILURE') errors++; continue; }
        const rows = await downloadLegacyReport(api,request.report_id);
        landed += await ingestTransaction(client,request,rows,deadline,{ replayLegacy: values.replay });
      }
    }
    console.log(`${profile.market}|${values.phase}|requested=${requested}|landed=${landed}|pending=${pending}|skipped=${skipped}`);
  }
} catch (error) {
  errors++;
  console.error(error instanceof Error && error.message.startsWith('Amazon Ads HTTP') ? error.message : 'Legacy backfill failed; no monthly publication');
} finally {
  if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('amazon-vercel-sync'),hashtext($1))",[step]);
  client.release(); await pool.end();
}
console.log(`Legacy backfill: errors=${errors}; console_history unchanged.`);
process.exitCode = errors ? 1 : 0;
