// Christian's SEASONAL_STRUCTURE 2026 ruling. Dates are marketplace-local,
// never UTC instants; the API receives YYYYMMDD without timezone conversion.
export const SEASON_START = '2026-12-01';
export const SEASON_END = '2027-01-05';
export const MARKETS = { '2263723137827296': 'ES', '139446882235960': 'US' };
export const OPEN_STATUSES = ['DRAFT', 'APPROVED', 'HELD', 'PUSHED'];

export function assertSeason(profileId, start, end) {
  if (!MARKETS[String(profileId)]) throw new Error('Seasonal rules are limited to ES and US');
  if (start !== SEASON_START || end !== SEASON_END) {
    throw new Error(`Only the ruled season ${SEASON_START}..${SEASON_END} is allowed; no November changes`);
  }
}

export function isLiveExperimentCampaign(campaign, experiments) {
  return experiments.some(experiment => {
    if (experiment.status !== 'LIVE') return false;
    const ref = experiment.structure_ref ?? {};
    const entries = [ref, ...(Array.isArray(ref.selection) ? ref.selection : [])];
    return entries.some(entry => {
      const profileId = entry.profile_id ?? ref.profile_id;
      if (profileId != null ? String(profileId) !== String(campaign.profile_id) : experiment.market !== campaign.market) return false;
      const ids = [entry.campaign_id, ...(Array.isArray(entry.campaign_ids) ? entry.campaign_ids : [])].filter(id => id != null).map(String);
      if (ids.length) return ids.includes(String(campaign.campaign_id));
      const name = entry.campaign_name ?? (entry.cluster_name ? `CDL | SP | CLUSTER | ${entry.cluster_name} | AUTO` : null);
      return name != null && name === campaign.name;
    });
  });
}

export function seasonalEvidence(campaign, experiments, start, end) {
  assertSeason(campaign.profile_id, start, end);
  const spend = Number(campaign.spend_60d);
  const orders = Number(campaign.orders_60d);
  const current = Number(campaign.budget_amount);
  const gp = Number(campaign.gp_per_order);
  if (campaign.state !== 'ENABLED' || campaign.gp_per_order == null ||
      ![spend, orders, current, gp].every(Number.isFinite) || spend < 0 ||
      orders < 5 || current <= 0 || gp <= 0 || spend > gp * orders ||
      isLiveExperimentCampaign(campaign, experiments)) return null;
  const daily = spend / 60;
  const season = Math.max(current, Math.round((3 * daily + Number.EPSILON) * 100) / 100);
  const pct = Math.round((season / current - 1) * 100);
  if (pct <= 0) return null;
  return {
    kind: 'seasonal_2026', campaign_id: String(campaign.campaign_id), campaign_name: campaign.name,
    current_budget: current, avg_daily_spend_60d: daily, orders_60d: orders,
    cpo_60d: spend / orders, gp, season_budget: season, increase_pct: pct,
    start, end, pre_season_budget: current,
  };
}

export function rulePlan(rec, profileId) {
  const ev = rec.evidence;
  assertSeason(profileId, ev?.start, ev?.end);
  if (ev.kind !== 'seasonal_2026' || !/^\d+$/.test(ev.campaign_id) ||
      ev.campaign_id !== rec.campaign_id || ev.campaign_id !== rec.target_text ||
      !Number.isInteger(ev.increase_pct) || ev.increase_pct <= 0 ||
      !Number.isFinite(ev.current_budget) || ev.current_budget <= 0 ||
      ev.pre_season_budget !== ev.current_budget || !Number.isFinite(ev.season_budget) ||
      ev.season_budget <= ev.current_budget ||
      Math.round((ev.season_budget / ev.current_budget - 1) * 100) !== ev.increase_pct) {
    throw new Error(`Invalid seasonal evidence for rec ${rec.id}`);
  }
  return {
    name: `CDL seasonal ${ev.start} ${ev.end} campaign ${ev.campaign_id} rec ${rec.id}`,
    ruleType: 'SCHEDULE',
    duration: { dateRangeTypeRuleDuration: { startDate: ev.start.replaceAll('-', ''), endDate: ev.end.replaceAll('-', '') } },
    recurrence: { type: 'DAILY' },
    budgetIncreaseBy: { type: 'PERCENT', value: ev.increase_pct },
  };
}

// A 207 is not proof of success. Require the single-item receipt, its explicit
// Ok code, and the expected rule id before persisting success.
export function successfulRuleId(body, expectedRuleId) {
  const items = body?.responses;
  if (!Array.isArray(items) || items.length !== 1 ||
      String(items[0].code).toLowerCase() !== 'ok' ||
      typeof items[0].ruleId !== 'string' || !items[0].ruleId ||
      (expectedRuleId != null && items[0].ruleId !== expectedRuleId)) {
    throw new Error('Budget-rule response did not confirm the expected single-item success');
  }
  return items[0].ruleId;
}
