import test from 'node:test';
import assert from 'node:assert/strict';
import { addToQueue, removeFromQueue, moveInQueue, visibleQueue, topOfQueue } from '../public/js/lib/queue.js';
import { createState, startDraft, makePick } from '../public/js/lib/draft.js';
import { etToUtc } from '../public/js/lib/clock.js';

test('add ignores duplicates, remove and reorder work', () => {
  let q = addToQueue([], 'a');
  q = addToQueue(q, 'b'); q = addToQueue(q, 'c'); q = addToQueue(q, 'a');
  assert.deepEqual(q, ['a', 'b', 'c']);
  assert.deepEqual(moveInQueue(q, 'c', 0), ['c', 'a', 'b']);
  assert.deepEqual(moveInQueue(q, 'a', 99), ['b', 'c', 'a']);
  assert.deepEqual(moveInQueue(q, 'zzz', 0), ['a', 'b', 'c']);
  assert.deepEqual(removeFromQueue(q, 'b'), ['a', 'c']);
});

test('drafted players are dropped when reading the queue', () => {
  const players = { a: { ownerTeam: 'X', drafted: 3 }, b: { ownerTeam: '', drafted: null }, c: { ownerTeam: '', drafted: null } };
  assert.deepEqual(visibleQueue(['a', 'b', 'c', 'gone'], players), ['b', 'c']);
  assert.equal(topOfQueue(['a', 'b'], players), 'b');
  assert.equal(topOfQueue(['a'], players), null);
});

test('queue never auto-drafts: a pick coming on the clock changes nothing', () => {
  const picks = [{ overall: 1, round: 1, slot: 1, origTeam: 'A', ownerTeam: 'A' }, { overall: 2, round: 1, slot: 2, origTeam: 'B', ownerTeam: 'B' }];
  const players = [{ id: 'p1', name: 'P1', ownerTeam: '' }, { id: 'p2', name: 'P2', ownerTeam: '' }];
  const admin = { email: 'c@example.com', isAdmin: true, teams: [] };
  const t = etToUtc(2027, 6, 7, 11);
  let s = createState({ picks, players });
  const queue = ['p2'];
  s = startDraft(s, admin, t).state;
  s = makePick(s, { email: 'a@example.com', teams: ['A'] }, 1, 'p1', t + 1000).state; // B now on the clock
  assert.equal(s.config.currentPick, 2);
  assert.equal(s.picks[2].status, 'open');
  assert.equal(s.players.p2.ownerTeam, '');
  assert.deepEqual(queue, ['p2']);
});
