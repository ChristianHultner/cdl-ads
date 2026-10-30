// Offline-only tests for the display yardstick shared by the Amazon pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, money, moneyK, pct, monthLabel, dayLabel, adTypeName, marketName } from '../lib/amazon/yardstick.ts';

const ES = { gpPerOrder: 5, targetAcos: null };
const MX = { gpPerOrder: null, targetAcos: 0.35 };

test('unit basis: profit after ads is orders × margin − spend', () => {
  const j = judge({ spend: 2890, sales: 9000, orders: 601, ...ES });
  assert.equal(j.basis, 'unit');
  assert.equal(Math.round(j.profitAfterAds), 115);
  assert.equal(j.costPerOrder.toFixed(2), '4.81');
});

test('unit basis: paying, break-even within ±5%, losing', () => {
  assert.equal(judge({ spend: 412, sales: 1749, orders: 96, ...ES }).label, 'Paying');      // 4,29
  assert.equal(judge({ spend: 2890, sales: 9000, orders: 601, ...ES }).label, 'Break-even'); // 4,81
  assert.equal(judge({ spend: 515, sales: 1000, orders: 100, ...ES }).label, 'Break-even');  // 5,15
  assert.equal(judge({ spend: 365, sales: 900, orders: 61, ...ES }).label, 'Losing');        // 5,98
});

test('unit basis: no orders with real spend loses; tiny spend is too little data', () => {
  assert.deepEqual([judge({ spend: 16, sales: 0, orders: 0, ...ES }).tone, judge({ spend: 16, sales: 0, orders: 0, ...ES }).label], ['lose', 'No orders']);
  assert.equal(judge({ spend: 4, sales: 0, orders: 0, ...ES }).label, 'Too little data');
  assert.equal(judge({ spend: 6, sales: 30, orders: 2, ...ES }).label, 'Too little data');
  assert.equal(judge({ spend: 0, sales: 0, orders: 0, ...ES }).label, 'No spend');
});

test('revenue basis: ACoS against target, no profit figure', () => {
  const over = judge({ spend: 1840, sales: 4420, orders: 21, ...MX });
  assert.equal(over.basis, 'revenue');
  assert.equal(over.profitAfterAds, null);
  assert.equal(over.label, 'Over target');
  assert.equal(judge({ spend: 96, sales: 310, orders: 9, ...MX }).label, 'On target');
  assert.equal(judge({ spend: 96, sales: 310, orders: 9, gpPerOrder: null, targetAcos: null }).label, 'No target set');
});

test('money: European format, one currency at a time, signed when asked', () => {
  assert.equal(money(2890, 'EUR'), '2.890 €');
  assert.equal(money(6.52, 'USD'), '6,52 US$');
  assert.equal(money(-356.4, 'USD', { sign: true }), '−356 US$');
  assert.equal(money(114.2, 'EUR', { sign: true }), '+114 €');
  assert.equal(money(87.6, 'MXN'), '87,60 MX$');
  assert.equal(money(4, 'GBP', { decimals: 2 }), '4,00 £');
  assert.equal(moneyK(95000, 'EUR'), '95k €');
  assert.equal(moneyK(-10934, 'EUR'), '−10,9k €');
  assert.equal(moneyK(820, 'EUR'), '820 €');
  assert.equal(pct(0.416), '41,6%');
});

test('labels', () => {
  assert.equal(monthLabel(2026, 9), 'Sep 26');
  assert.equal(dayLabel('2026-10-29'), '29 Oct');
  assert.equal(adTypeName('SBV'), 'Brand video');
  assert.equal(marketName('ES'), 'Spain');
});
