// Usage: node --env-file=.env.local scripts/push-seasonal-rules.mjs --profile ID [--execute]
// Default: DB SELECTs and plan output only; no token mint or Amazon calls.
// API schema: https://d3a0d0y2hgofx6.cloudfront.net/ja-jp/guides/budgets/rules/schedule-based.html
// POST /sp/budgetRules -> persist rule id -> POST /sp/campaigns/{id}/budgetRules.
// All requests use application/json. No direct campaign-budget update or delete.
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { MARKETS, rulePlan, successfulRuleId } from './lib/seasonal-rules.mjs';

export async function pushSeasonalRules(pool, profileId, execute = false, { request = fetch, env = process.env, log = console.log } = {}) {
  const client = await pool.connect();
  let locked = false;
  let pushed = 0;
  try {
    // The shared route runs every script for every profile. Unruled markets are
    // a no-op here; the drafting CLI rejects them outright.
    if (!MARKETS[profileId]) {
      log(`Seasonal rules: profile ${profileId} outside ES/US scope; 0 to push.`);
      return;
    }
    if (execute) {
      const { rows } = await client.query(`SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked`, [`seasonal-push:${profileId}`]);
      if (!rows[0]?.locked) throw new Error('Another seasonal push is running for this profile');
      locked = true;
    }
    const { rows: recs } = await client.query(`
      SELECT id,campaign_id,target_text,evidence FROM recommendations
      WHERE profile_id=$1 AND rec_type='SEASONAL_BUDGET_RULE' AND status='APPROVED' ORDER BY id`, [profileId]);
    const plans = recs.map(rec => ({ rec, rule: rulePlan(rec, profileId) }));
    log(`${execute ? 'EXECUTE' : 'DRY RUN'} profile ${profileId}: ${plans.length} to push.`);
    for (const { rec, rule } of plans) {
      log(`PLAN rec=${rec.id} campaign=${rec.campaign_id}: ${rec.evidence.created_rule_id ? `reuse rule ${rec.evidence.created_rule_id}` : 'POST /sp/budgetRules'}; POST /sp/campaigns/${rec.campaign_id}/budgetRules; ${JSON.stringify(rule)}`);
    }
    log(`Totals: ${recs.length} fetched, 0 skipped, ${plans.length} planned rule association(s)`);
    if (!execute || !plans.length) {
      log(execute ? 'Execute complete: 0 pushed, 0 partial.' : 'DRY RUN complete — no writes, no Amazon calls.');
      return;
    }
    const { rows: profiles } = await client.query(`
      SELECT p.region,c.env_var_name FROM amazon_profiles p
      JOIN amazon_credentials c ON c.id=p.credential_id WHERE p.profile_id=$1`, [profileId]);
    const profile = profiles[0];
    const host = { EU: 'https://advertising-api-eu.amazon.com', NA: 'https://advertising-api.amazon.com' }[profile?.region];
    if (!host || !env[profile.env_var_name] || !env.LWA_CLIENT_ID || !env.LWA_CLIENT_SECRET) throw new Error('Missing profile or LWA credentials');
    const tokenResponse = await request('https://api.amazon.com/auth/o2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env[profile.env_var_name], client_id: env.LWA_CLIENT_ID, client_secret: env.LWA_CLIENT_SECRET }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!tokenResponse.ok) throw new Error(`LWA authentication HTTP ${tokenResponse.status}`);
    const { access_token: token } = await tokenResponse.json();
    if (!token) throw new Error('LWA authentication returned no access token');
    const post = async (path, body) => {
      const response = await request(host + path, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`,
          'Amazon-Advertising-API-ClientId': env.LWA_CLIENT_ID, 'Amazon-Advertising-API-Scope': profileId,
          'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`POST ${path}: HTTP ${response.status}; stop, no automatic retry`);
      return response.json();
    };
    const stamp = async (id, patch) => {
      const result = await client.query(`UPDATE recommendations SET evidence=evidence || $1::jsonb
        WHERE id=$2 AND profile_id=$3 AND rec_type='SEASONAL_BUDGET_RULE' AND status='APPROVED'`, [JSON.stringify(patch), id, profileId]);
      if (result.rowCount !== 1) throw new Error(`Rec ${id} no longer APPROVED; stopped`);
    };
    for (const { rec, rule } of plans) {
      // Re-read approvals and evidence immediately before each side effect.
      const { rows: current } = await client.query(`SELECT id,campaign_id,target_text,evidence FROM recommendations
        WHERE id=$1 AND profile_id=$2 AND rec_type='SEASONAL_BUDGET_RULE' AND status='APPROVED'`, [rec.id, profileId]);
      if (current.length !== 1 || JSON.stringify(current[0].evidence) !== JSON.stringify(rec.evidence)) throw new Error(`Rec ${rec.id} changed since planning; stopped`);
      let ruleId = rec.evidence.created_rule_id;
      const receipts = { ...(rec.evidence.push_result ?? {}) };
      if (!ruleId) {
        // A crash/timeout after POST may have created a rule. Persist intent
        // first; a retry without a known id requires read-only reconciliation,
        // never blindly creates a duplicate remote rule.
        if (rec.evidence.creation_attempted_at) throw new Error(`Rec ${rec.id}: unresolved creation attempt; reconcile before retry`);
        await stamp(rec.id, { creation_attempted_at: new Date().toISOString(), rule_name: rule.name });
        receipts.create = await post('/sp/budgetRules', { budgetRulesDetails: [rule] });
        ruleId = successfulRuleId(receipts.create);
        await stamp(rec.id, { created_rule_id: ruleId, push_result: receipts });
      }
      receipts.associate = await post(`/sp/campaigns/${rec.campaign_id}/budgetRules`, { budgetRuleIds: [ruleId] });
      successfulRuleId(receipts.associate, ruleId);
      const result = await client.query(`UPDATE recommendations SET status='PUSHED',pushed_at=now(),evidence=evidence || $1::jsonb
        WHERE id=$2 AND profile_id=$3 AND rec_type='SEASONAL_BUDGET_RULE' AND status='APPROVED'`,
      [JSON.stringify({ created_rule_id: ruleId, pushed_at: new Date().toISOString(), push_result: receipts }), rec.id, profileId]);
      if (result.rowCount !== 1) throw new Error(`Rec ${rec.id}: Amazon association succeeded but DB stamp failed; reconcile before retry`);
      pushed++;
      log(`PUSHED rec=${rec.id} campaign=${rec.campaign_id} rule=${ruleId}`);
    }
    log(`Execute complete: ${pushed} pushed, 0 partial.`);
  } finally {
    if (locked) await client.query(`SELECT pg_advisory_unlock(hashtextextended($1,0))`, [`seasonal-push:${profileId}`]);
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { profile: { type: 'string' }, execute: { type: 'boolean', default: false } } });
  if (!/^\d+$/.test(values.profile ?? '')) throw new Error('--profile ID required');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  neonConfig.webSocketConstructor = WebSocket;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try { await pushSeasonalRules(pool, values.profile, values.execute); }
  finally { await pool.end(); }
}
