// Usage: node --env-file=.env.local scripts/draft-seasonal-rules.mjs
//   --profile ID --start YYYY-MM-DD --end YYYY-MM-DD
// DB drafts only. No Amazon calls, approvals, or budget changes.
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { assertSeason, seasonalEvidence, MARKETS, OPEN_STATUSES } from './lib/seasonal-rules.mjs';

export async function draftSeasonalRules(pool, profileId, start, end, log = console.log) {
  assertSeason(profileId, start, end);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize concurrent drafts for this profile, including the existence check.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`seasonal-draft:${profileId}`]);
    const { rows: campaigns } = await client.query(`
      SELECT c.profile_id::text,c.campaign_id,c.name,c.state,c.budget_amount,
             p.country_code AS market,p.gp_per_order,
             COALESCE(SUM(d.cost),0) AS spend_60d,
             COALESCE(SUM(d.purchases_14d),0) AS orders_60d
      FROM amazon_campaigns c JOIN amazon_profiles p USING(profile_id)
      LEFT JOIN amazon_campaign_daily d ON d.profile_id=c.profile_id
        AND d.campaign_id=c.campaign_id AND d.date>=CURRENT_DATE-60 AND d.date<CURRENT_DATE
      WHERE c.profile_id=$1 AND c.state='ENABLED'
      GROUP BY c.profile_id,c.campaign_id,c.name,c.state,c.budget_amount,p.country_code,p.gp_per_order
      ORDER BY orders_60d DESC,c.name`, [profileId]);
    const { rows: experiments } = await client.query(`SELECT status,market,structure_ref FROM experiments WHERE status='LIVE'`);
    const { rows: existing } = await client.query(`
      SELECT campaign_id FROM recommendations WHERE profile_id=$1
        AND rec_type='SEASONAL_BUDGET_RULE' AND status=ANY($2::text[])
        AND evidence->>'start'=$3 AND evidence->>'end'=$4`, [profileId, OPEN_STATUSES, start, end]);
    const blocked = new Set(existing.map(row => row.campaign_id));
    const inserted = [];
    for (const campaign of campaigns) {
      if (blocked.has(campaign.campaign_id)) continue;
      const evidence = seasonalEvidence(campaign, experiments, start, end);
      if (!evidence) continue;
      const proposal = `Seasonal budget rule for '${campaign.name}': ${start}..${end} inclusive, marketplace-local; +${evidence.increase_pct}% (${evidence.current_budget.toFixed(2)} base, ${evidence.season_budget.toFixed(2)} target). Amazon schedules and reverts; reversal: disassociate rule. No November changes.`;
      const { rows } = await client.query(`
        INSERT INTO recommendations(rec_type,profile_id,campaign_id,target_text,proposal,evidence,status)
        VALUES ('SEASONAL_BUDGET_RULE',$1,$2,$2,$3,$4::jsonb,'DRAFT') RETURNING id`,
      [profileId, campaign.campaign_id, proposal, JSON.stringify(evidence)]);
      inserted.push({ id: rows[0].id, market: MARKETS[profileId], ...evidence });
      blocked.add(campaign.campaign_id);
    }
    await client.query('COMMIT');
    for (const row of inserted) log(`${row.id}|${row.market}|${row.campaign_name.slice(0,40)}|${row.current_budget.toFixed(2)}|${row.season_budget.toFixed(2)}|${row.increase_pct}`);
    log(`Draft complete: ${inserted.length} inserted for ${MARKETS[profileId]}; existing open/pushed season cards preserved.`);
    return inserted;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { profile: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' } } });
  assertSeason(values.profile, values.start, values.end);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  neonConfig.webSocketConstructor = WebSocket;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try { await draftSeasonalRules(pool, values.profile, values.start, values.end); }
  finally { await pool.end(); }
}
