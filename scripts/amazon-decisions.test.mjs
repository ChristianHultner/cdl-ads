// Offline-only tests for the plain-language wording on the Decisions page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describe, KIND_ORDER } from '../lib/amazon/decisions.ts';
import { money, count } from '../lib/amazon/yardstick.ts';

const eur = (v) => money(v, 'EUR', { decimals: 2 });
const base = { money: eur, count, campaignName: 'ES · Mamá · Broad' };

test('bid cut reads as a sentence with both bids', () => {
  const v = describe({ ...base, recType: 'BID_ADJUST', targetText: 'cuentos para dormir niños',
    proposal: "Lower bid on keyword from €0.62 to €0.48: 9 orders at €8.10 in 30d.",
    evidence: { current_bid: 0.62, proposed_bid: 0.48, spend: 72.9, clicks: 118, orders: 9, window_start: '2026-09-30', window_end: '2026-10-29',
      rule_track_record: { win_rate: 0.64, n: 53 } } });
  assert.equal(v.kind, 'Change a bid');
  assert.equal(v.title, 'Lower the bid on “cuentos para dormir niños” from 0,62 € to 0,48 €');
  assert.equal(v.why, '9 orders at €8.10 in 30d.');
  assert.deepEqual(v.stats.map(s => s.v), ['72,90 €', '118', '9', '8,10 €']);
  assert.equal(v.stats[0].k, 'Spend · 30 days');
  assert.equal(v.track, 'Changes like this worked 64% of the time (53 judged)');
  assert.equal(v.takesBid, true);
});

test('negation, pause and budget titles', () => {
  assert.equal(describe({ ...base, recType: 'NEGATE_TERM', targetText: '[REVIEW] libro colorear', proposal: "Negate 'libro colorear': 22 € spend, 41 clicks, 0 orders in 30d.", evidence: { spend: 22.14, clicks: 41, orders: 0 } }).title,
    'Stop showing ads for “libro colorear” in ES · Mamá · Broad');
  assert.equal(describe({ ...base, recType: 'PAUSE_CAMPAIGN', targetText: '123', proposal: "Pause 'x': zero orders in 90 days.", evidence: {} }).title, 'Pause ES · Mamá · Broad');
  assert.equal(describe({ ...base, recType: 'BUDGET_ADJUST', targetText: '123', proposal: 'Raise budget', evidence: { budget_amount: 15, proposed_budget: 20 } }).title,
    'Raise the daily budget in ES · Mamá · Broad from 15,00 € to 20,00 €');
  const neg = describe({ ...base, recType: 'NEGATE_TERM', targetText: 'x', proposal: 'p', evidence: { spend: 5, orders: 0 } });
  assert.equal(neg.stats[3].v, '—');
});

test('track record needs ten judged; unknown types fall back to the proposal', () => {
  assert.equal(describe({ ...base, recType: 'PROMOTE_TERM', targetText: 't', proposal: 'p', evidence: { rule_track_record: { win_rate: 0.5, n: 4 } } }).track, 'Too few judged to say (4 so far)');
  assert.equal(describe({ ...base, recType: 'PROMOTE_TERM', targetText: 't', proposal: 'p', evidence: {} }).track, 'No track record for this kind of change yet');
  const o = describe({ ...base, recType: 'SOMETHING_NEW', targetText: 't', proposal: 'Do the thing', evidence: {} });
  assert.equal(o.kind, 'Other');
  assert.equal(o.title, 'Do the thing');
  assert.ok(KIND_ORDER.includes('Other'));
  assert.equal(describe({ ...base, recType: 'CREATIVE_TARGET', targetText: 't', proposal: 'p', evidence: {} }).needsAsin, true);
});
