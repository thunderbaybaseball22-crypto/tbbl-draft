import test from 'node:test';
import assert from 'node:assert/strict';
import { isOpen, nextOpen, addOpenTime, remainingOpenMs, etToUtc, etParts } from '../public/js/lib/clock.js';

const H = 3600000, M = 60000;
const et = (y, m, d, h, mi = 0) => etToUtc(y, m, d, h, mi);

test('window boundaries 11:00-23:00 ET', () => {
  assert.equal(isOpen(et(2027, 6, 7, 10, 59)), false);
  assert.equal(isOpen(et(2027, 6, 7, 11, 0)), true);
  assert.equal(isOpen(et(2027, 6, 7, 22, 59)), true);
  assert.equal(isOpen(et(2027, 6, 7, 23, 0)), false);
});

test('nextOpen waits for 11:00, or tomorrow 11:00 after close', () => {
  assert.equal(nextOpen(et(2027, 6, 7, 10, 30)), et(2027, 6, 7, 11));
  assert.equal(nextOpen(et(2027, 6, 7, 23, 30)), et(2027, 6, 8, 11));
  assert.equal(nextOpen(et(2027, 6, 7, 15)), et(2027, 6, 7, 15));
});

test('pick starting 10:30 waits for 11:00', () => {
  assert.equal(addOpenTime(et(2027, 6, 7, 10, 30), H), et(2027, 6, 7, 12));
});

test('1 hour pick starting 22:30 uses 30 min tonight and 30 min tomorrow', () => {
  assert.equal(addOpenTime(et(2027, 6, 7, 22, 30), H), et(2027, 6, 8, 11, 30));
});

test('pick starting at 23:00 sharp starts tomorrow 11:00', () => {
  assert.equal(addOpenTime(et(2027, 6, 7, 23, 0), H), et(2027, 6, 8, 12));
});

test('deadline may land exactly on 23:00', () => {
  assert.equal(addOpenTime(et(2027, 6, 7, 22, 0), H), et(2027, 6, 7, 23));
});

test('30 hour clock spans days (12h + 12h + 6h)', () => {
  assert.equal(addOpenTime(et(2027, 6, 7, 11), 30 * H), et(2027, 6, 9, 17));
});

test('spring-forward weekend (2027-03-14) stays on Eastern wall-clock hours', () => {
  const d = addOpenTime(et(2027, 3, 13, 22), 3 * H);
  assert.deepEqual([etParts(d).d, etParts(d).h, etParts(d).mi], [14, 13, 0]);
  const full = addOpenTime(et(2027, 3, 14, 11), 12 * H);
  assert.deepEqual([etParts(full).d, etParts(full).h], [14, 23]);
});

test('fall-back weekend (2027-11-07) stays on Eastern wall-clock hours', () => {
  const d = addOpenTime(et(2027, 11, 6, 22), 3 * H);
  assert.deepEqual([etParts(d).d, etParts(d).h, etParts(d).mi], [7, 13, 0]);
  assert.equal(addOpenTime(et(2027, 11, 7, 11), 12 * H), et(2027, 11, 7, 23));
});

test('remainingOpenMs counts only open time; pause/resume preserves it', () => {
  const start = et(2027, 6, 7, 22);
  const deadline = addOpenTime(start, 2 * H); // Tue 12:00
  assert.equal(deadline, et(2027, 6, 8, 12));
  assert.equal(remainingOpenMs(et(2027, 6, 7, 22, 30), deadline), 90 * M);
  assert.equal(remainingOpenMs(et(2027, 6, 7, 23, 30), deadline), 60 * M);
  assert.equal(remainingOpenMs(et(2027, 6, 8, 13), deadline), 0);
  // pause at Mon 22:30 (90 min left), resume Wed 15:00 -> deadline Wed 16:30
  const rem = remainingOpenMs(et(2027, 6, 7, 22, 30), deadline);
  assert.equal(addOpenTime(et(2027, 6, 9, 15), rem), et(2027, 6, 9, 16, 30));
});
