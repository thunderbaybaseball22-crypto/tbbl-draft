import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monitorStatus } from '../public/js/lib/tick.js';

const base = { now: 10_000_000, deadline: 10_600_000, status: 'live', windowOpen: true };

test('monitor: recent tick is not stale and reports time to deadline', () => {
  const m = monitorStatus({ ...base, tickAt: base.now - 60_000 });
  assert.equal(m.stale, false);
  assert.equal(m.ageMs, 60_000);
  assert.equal(m.msToDeadline, 600_000);
});
test('monitor: no tick for over 6 minutes inside the window is stale', () => {
  assert.equal(monitorStatus({ ...base, tickAt: base.now - 7 * 60_000 }).stale, true);
  assert.equal(monitorStatus({ ...base, tickAt: null }).stale, true);
});
test('monitor: never stale outside the window, when paused, or before the start', () => {
  const old = base.now - 3_600_000;
  assert.equal(monitorStatus({ ...base, tickAt: old, windowOpen: false }).stale, false);
  assert.equal(monitorStatus({ ...base, tickAt: old, status: 'paused' }).stale, false);
  assert.equal(monitorStatus({ ...base, tickAt: old, status: 'pending' }).stale, false);
  assert.equal(monitorStatus({ ...base, tickAt: old, status: 'paused' }).msToDeadline, null);
});
