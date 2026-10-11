// One-off 2026 Aug/Sep reporting backfill, using the Vercel runner's exact
// report configurations and atomic ingestion. No campaign API or monthly writes.
// Node 22.18+ native TypeScript loading; runner import has no startup side effects.
// node --env-file=.env.local scripts/backfill-amazon-monthly.mjs --phase request|ingest
import { parseArgs } from 'node:util';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { REPORTS, createApi, downloadReport, ingestTransaction, isAmazonDatabase } from '../lib/amazon/sync-runner.ts';

const { values } = parseArgs({ options: { phase: { type: 'string' }, profile: { type: 'string' } } });
if (!['request', 'ingest'].includes(values.phase ?? '')) throw new Error('--phase request|ingest required');
if (values.profile && !['2263723137827296','139446882235960','395707988492653'].includes(values.profile)) throw new Error('Profile outside ES/US/MX backfill scope');
if (!isAmazonDatabase(process.env.DATABASE_URL)) throw new Error('WRONG DATABASE');
neonConfig.webSocketConstructor = WebSocket;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
const windows = [['2026-08-01', '2026-08-31'], ['2026-09-01', '2026-09-30']];
let errors = 0;
try {
  const { rows: profiles } = await client.query(`SELECT p.profile_id::text,p.country_code AS market,p.region,c.env_var_name
    FROM amazon_profiles p JOIN amazon_credentials c ON c.id=p.credential_id
    WHERE p.profile_id IN (2263723137827296,139446882235960,395707988492653) ORDER BY p.country_code`);
  for (const profile of profiles) {
    if (values.profile && profile.profile_id !== values.profile) continue;
    const deadline = Date.now() + 240_000;
    const api = await createApi(profile, deadline);
    for (const [start, end] of windows) {
      for (const type of ['spCampaigns', 'sbCampaigns', 'sdCampaigns']) {
        try {
          if (values.phase === 'request') {
            if (type === 'spCampaigns') {
              const { rows } = await client.query(`SELECT COUNT(*)::int AS missing FROM generate_series($2::date,$3::date,'1 day') day
                WHERE NOT EXISTS (SELECT 1 FROM amazon_campaign_daily d WHERE d.profile_id=$1 AND d.date=day::date)`, [profile.profile_id, start, end]);
              if (!rows[0].missing) { console.log(`${profile.market}|${start.slice(0,7)}|SP|existing daily coverage complete; untouched`); continue; }
            }
            const requestWindow = async (windowStart, windowEnd) => {
            const { rows: existing } = await client.query(`SELECT report_id FROM amazon_report_requests
              WHERE profile_id=$1 AND report_type=$2 AND start_date=$3 AND end_date=$4
                AND status IN ('PENDING','COMPLETED','INGESTED') LIMIT 1`, [profile.profile_id, type, windowStart, windowEnd]);
            if (existing.length) { console.log(`${profile.market}|${windowStart}..${windowEnd}|${type}|already requested`); return; }
            let result;
            for (let attempt = 0; ; attempt++) {
              try {
                result = await api('/reporting/reports', { method: 'POST',
              headers: { 'Content-Type': 'application/vnd.createasyncreportrequest.v3+json' },
              body: JSON.stringify({ name: `cdl-monthly ${type} ${windowStart}_${windowEnd}`, startDate: windowStart, endDate: windowEnd, configuration: REPORTS[type].configuration }),
            });
                break;
              } catch (error) {
                const message = error instanceof Error ? error.message : '';
                if (message === 'Amazon Ads HTTP 429' && attempt < 2) {
                  await new Promise(resolve => setTimeout(resolve, 5_000 * (attempt + 1)));
                  continue;
                }
                const retainedFrom = message.match(/data retention start date \((\d{4}-\d{2}-\d{2})\)/)?.[1];
                if (retainedFrom && retainedFrom > windowStart && retainedFrom <= windowEnd) {
                  console.log(`${profile.market}|${type}|RETENTION GAP ${windowStart}..before ${retainedFrom}|${message}`);
                  errors++; // Partial recovery never establishes a complete month.
                  await requestWindow(retainedFrom, windowEnd);
                  return;
                }
                throw error; // In particular, never alter columns after a schema 400.
              }
            }
            const { body } = result;
            if (!body.reportId) throw new Error('Missing report ID');
            await client.query(`INSERT INTO amazon_report_requests(report_id,profile_id,report_type,start_date,end_date,status)
              VALUES ($1,$2,$3,$4,$5,'PENDING') ON CONFLICT (report_id) DO NOTHING`, [body.reportId, profile.profile_id, type, windowStart, windowEnd]);
            console.log(`${profile.market}|${windowStart}..${windowEnd}|${type}|REQUESTED|${body.reportId}`);
            };
            await requestWindow(start, end);
          } else {
            const { rows: requests } = await client.query(`SELECT report_id,profile_id::text,report_type,status,false AS expired FROM amazon_report_requests
              WHERE profile_id=$1 AND report_type=$2 AND start_date>=$3 AND end_date<=$4
                AND status IN ('PENDING','COMPLETED') ORDER BY requested_at`, [profile.profile_id, type, start, end]);
            for (const request of requests) {
              const { body } = await api(`/reporting/reports/${encodeURIComponent(request.report_id)}`);
              if (body.status !== 'COMPLETED') {
                console.log(`${profile.market}|${start.slice(0,7)}|${type}|${body.status}`);
                if (body.status === 'FAILED') errors++;
                continue;
              }
              const data = await downloadReport(api, request.report_id, deadline);
              if (data.some(row => typeof row.date !== 'string' || row.date < start || row.date > end)) throw new Error('Report contains out-of-window dates');
              const count = await ingestTransaction(client, request, data, deadline);
              console.log(`${profile.market}|${start.slice(0,7)}|${type}|LANDED|${count}`);
            }
          }
        } catch (error) {
          errors++;
          // API schema/date errors are findings; never change columns or metrics
          // on a 400. SDK/DB errors can contain URLs, so print only safe API messages.
          const message = error instanceof Error && error.message.startsWith('Amazon ') ? error.message : 'Backfill operation failed';
          console.log(`${profile.market}|${start.slice(0,7)}|${type}|ERROR|${message}`);
        }
      }
    }
  }
} finally { client.release(); await pool.end(); }
console.log(`Backfill ${values.phase} complete; errors=${errors}; console_history unchanged.`);
process.exitCode = errors ? 1 : 0;
