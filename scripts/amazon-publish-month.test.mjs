// Offline coverage for the monthly publication date rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { previousMonth, monthBounds, monthSettled, PUBLISH_MARKETS, KNOWN_STEPS } from '../lib/amazon/sync-runner.ts';

test('previous month wraps the year', () => {
  assert.deepEqual(previousMonth(new Date('2026-11-15T08:20:00Z')), { year: 2026, month: 10 });
  assert.deepEqual(previousMonth(new Date('2027-01-15T08:20:00Z')), { year: 2026, month: 12 });
});

test('month bounds handle 30, 31 and February', () => {
  assert.deepEqual(monthBounds(2026, 10), { start: '2026-10-01', end: '2026-10-31', days: 31 });
  assert.deepEqual(monthBounds(2026, 9), { start: '2026-09-01', end: '2026-09-30', days: 30 });
  assert.equal(monthBounds(2028, 2).days, 29);
});

test('a month is settled 8 days after its last day', () => {
  assert.equal(monthSettled(2026, 10, new Date('2026-11-07T23:59:00Z')), false);
  assert.equal(monthSettled(2026, 10, new Date('2026-11-08T00:00:00Z')), true);
  assert.equal(monthSettled(2026, 10, new Date('2026-11-15T08:20:00Z')), true);
});

test('only qualified markets publish, and the step is routable', () => {
  assert.deepEqual([...PUBLISH_MARKETS], ['ES', 'US', 'MX']);
  assert.ok(KNOWN_STEPS.includes('publish-month'));
});
