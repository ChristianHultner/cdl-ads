// Offline-only tests: fake DB and fake HTTP; never load credentials or contact Amazon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSeason, seasonalEvidence, isLiveExperimentCampaign, rulePlan, successfulRuleId, SEASON_START, SEASON_END } from './lib/seasonal-rules.mjs';
import { pushSeasonalRules } from './push-seasonal-rules.mjs';

const profileId = '2263723137827296';
const campaign = { profile_id: profileId, campaign_id: '123', market: 'ES', name: 'Example', state: 'ENABLED', budget_amount: '4', spend_60d: '187.40', orders_60d: '52', gp_per_order: '5.00' };
const evidence = (overrides = {}, experiments = []) => seasonalEvidence({ ...campaign, ...overrides }, experiments, SEASON_START, SEASON_END);
const rec = () => ({ id: '1', campaign_id: '123', target_text: '123', evidence: evidence() });

test('D-tier arithmetic uses all 60 days and rounds money before the percent', () => {
  const ev = evidence();
  assert.equal(ev.avg_daily_spend_60d, 187.4 / 60);
  assert.equal(ev.season_budget, 9.37);
  assert.equal(ev.increase_pct, 134);
  assert.equal(ev.pre_season_budget, 4);
  assert.equal(evidence({ spend_60d: '100', orders_60d: '20' }).cpo_60d, 5);
  assert.equal(evidence({ spend_60d: '100.01', orders_60d: '20' }), null);
});

test('no cards for zero rounded increases, weak samples, paused campaigns or unknown GP', () => {
  for (const overrides of [{ spend_60d: '40' }, { spend_60d: '80.20' }, { orders_60d: '4' }, { state: 'PAUSED' }, { gp_per_order: null }]) {
    assert.equal(evidence(overrides), null);
  }
  assert.throws(() => assertSeason(profileId, '2026-11-01', SEASON_END));
  assert.throws(() => assertSeason('1711934819800765', SEASON_START, SEASON_END));
});

test('LIVE scope handles IDs, arrays, selection and name fallback, not released/not_selected', () => {
  const live = structure_ref => ({ status: 'LIVE', market: 'ES', structure_ref });
  for (const ref of [{ campaign_id: '123' }, { campaign_ids: ['123'] }, { selection: [{ campaign_id: '123' }] }, { campaign_name: 'Example' }]) {
    assert.equal(evidence({}, [live(ref)]), null);
  }
  assert.equal(isLiveExperimentCampaign(campaign, [live({ not_selected: [{ campaign_id: '123' }] })]), false);
  assert.equal(isLiveExperimentCampaign(campaign, [live({ profile_id: '139446882235960', campaign_id: '123' })]), false);
  assert.equal(isLiveExperimentCampaign(campaign, [{ ...live({ campaign_id: '123' }), status: 'RELEASED' }]), false);
  assert.equal(isLiveExperimentCampaign({ ...campaign, name: 'CDL | SP | CLUSTER | Test | AUTO' }, [live({ cluster_name: 'Test' })]), true);
});

test('Amazon payload preserves local inclusive dates and percentage; receipts fail closed', () => {
  const rule = rulePlan(rec(), profileId);
  assert.deepEqual(rule.duration, { dateRangeTypeRuleDuration: { startDate: '20261201', endDate: '20270105' } });
  assert.deepEqual(rule.recurrence, { type: 'DAILY' });
  assert.deepEqual(rule.budgetIncreaseBy, { type: 'PERCENT', value: 134 });
  assert.throws(() => rulePlan({ ...rec(), target_text: 'wrong' }, profileId));
  assert.throws(() => successfulRuleId({ responses: [] }));
  assert.throws(() => successfulRuleId({ responses: [{ code: 'ERROR', ruleId: 'r' }] }));
  assert.throws(() => successfulRuleId({ responses: [{ code: 'Ok', ruleId: 'wrong' }] }, 'expected'));
  assert.equal(successfulRuleId({ responses: [{ code: 'Ok', ruleId: 'r' }] }), 'r');
});

function harness({ savedRule = false, creationAttempt = false, failAssociation = false, failCreation = false, empty = false } = {}) {
  const record = rec();
  if (savedRule) record.evidence.created_rule_id = 'rule-1';
  if (creationAttempt) record.evidence.creation_attempted_at = '2026-10-11T00:00:00Z';
  const events = [];
  let state = 'APPROVED';
  const client = {
    release() {},
    async query(sql, params) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [] };
      if (sql.includes('JOIN amazon_credentials')) return { rows: [{ region: 'EU', env_var_name: 'TEST_REFRESH' }] };
      if (sql.includes('SELECT id,campaign_id')) return { rows: empty ? [] : [structuredClone(record)] };
      if (sql.startsWith('UPDATE recommendations')) {
        events.push(sql.includes("status='PUSHED'") ? 'db:pushed' : 'db:stamp');
        Object.assign(record.evidence, JSON.parse(params[0]));
        if (sql.includes("status='PUSHED'")) state = 'PUSHED';
        return { rowCount: 1 };
      }
      throw new Error(`Unexpected test query: ${sql}`);
    },
  };
  const request = async (url, options) => {
    if (url.includes('/auth/o2/token')) { events.push('token'); return { ok: true, json: async () => ({ access_token: 'test-only' }) }; }
    const creating = url.endsWith('/sp/budgetRules');
    events.push(creating ? 'create' : 'associate');
    if (creating && failCreation) throw new Error('test timeout');
    if (creating) assert.equal(JSON.parse(options.body).budgetRulesDetails[0].ruleType, 'SCHEDULE');
    else assert.deepEqual(JSON.parse(options.body), { budgetRuleIds: ['rule-1'] });
    return { ok: true, json: async () => ({ responses: [{ code: !creating && failAssociation ? 'ERROR' : 'Ok', ruleId: 'rule-1' }] }) };
  };
  return { pool: { connect: async () => client }, events, record, state: () => state,
    options: { request, env: { TEST_REFRESH: 'test', LWA_CLIENT_ID: 'test', LWA_CLIENT_SECRET: 'test' }, log() {} } };
}

test('dry run with an approved card makes no HTTP calls or DB writes', async () => {
  const h = harness();
  await pushSeasonalRules(h.pool, profileId, false, h.options);
  assert.deepEqual(h.events, []);
  assert.equal(h.state(), 'APPROVED');
});

test('no approved cards means no token mint even in execute mode', async () => {
  const h = harness({ empty: true });
  await pushSeasonalRules(h.pool, profileId, true, h.options);
  assert.deepEqual(h.events, []);
});

test('push journals creation intent and rule id before association, then marks pushed', async () => {
  const h = harness();
  await pushSeasonalRules(h.pool, profileId, true, h.options);
  assert.deepEqual(h.events, ['token', 'db:stamp', 'create', 'db:stamp', 'associate', 'db:pushed']);
  assert.equal(h.state(), 'PUSHED');
  assert.equal(h.record.evidence.created_rule_id, 'rule-1');
});

test('failed association stays approved and retry reuses the created rule', async () => {
  const h = harness({ failAssociation: true });
  await assert.rejects(pushSeasonalRules(h.pool, profileId, true, h.options));
  assert.equal(h.state(), 'APPROVED');
  assert.equal(h.record.evidence.created_rule_id, 'rule-1');
  const retry = harness({ savedRule: true });
  await pushSeasonalRules(retry.pool, profileId, true, retry.options);
  assert.deepEqual(retry.events, ['token', 'associate', 'db:pushed']);
});

test('ambiguous creation fails closed and cannot create another rule on retry', async () => {
  const h = harness({ failCreation: true });
  await assert.rejects(pushSeasonalRules(h.pool, profileId, true, h.options));
  assert.ok(h.record.evidence.creation_attempted_at);
  assert.equal(h.state(), 'APPROVED');
  const retry = harness({ creationAttempt: true });
  await assert.rejects(pushSeasonalRules(retry.pool, profileId, true, retry.options), /reconcile/);
  assert.ok(!retry.events.includes('create'));
});
