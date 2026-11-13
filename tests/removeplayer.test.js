import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as D from '../public/js/lib/draft.js';
import { tick } from '../public/js/lib/tick.js';
import { visibleQueue } from '../public/js/lib/queue.js';
import { derivePlayers } from '../public/js/lib/persist.js';
import { etToUtc } from '../public/js/lib/clock.js';

const MIN = 60000;
const T0 = etToUtc(2027, 6, 7, 11); // Monday 11:00 ET
const admin = { email: 'comm@example.com', isAdmin: true, teams: [] };
const own = (t) => ({ email: `${t.toLowerCase()}@example.com`, isAdmin: false, teams: [t] });

function fresh() {
  const order = ['A', 'B', 'C', 'A', 'B', 'C'];
  const picks = order.map((t, i) => ({ overall: i + 1, round: Math.floor(i / 3) + 1, slot: (i % 3) + 1, origTeam: t, ownerTeam: t }));
  const players = Array.from({ length: 8 }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}`, ownerTeam: i === 7 ? 'C' : '' }));
  return D.createState({ picks, players, clockMinutes: 60 });
}
const live = () => D.startDraft(fresh(), admin, T0).state;
const list = (team, items) => ({ email: `${team.toLowerCase()}@example.com`, teams: [team], autoDraft: true, items });
const ctx = (...queues) => ({ isAdmin: false, queues, verifiedKeys: new Set() });

test('commissioner removes a player after the draft is live; audited, input not mutated', () => {
  const s = live();
  const before = JSON.stringify(s);
  const r = D.removePlayer(s, admin, 'p3', 'Listed in error', T0 + MIN);
  assert.equal(r.state.players.p3.removed, true);
  assert.equal(r.state.players.p3.name, 'Player 3'); // data is kept
  assert.equal(JSON.stringify(s), before);
  assert.deepEqual(r.audit.map((a) => [a.type, a.by, a.playerId, a.player, a.reason]), [['player-remove', 'comm@example.com', 'p3', 'Player 3', 'Listed in error']]);
});

test('only the commissioner can remove or restore', () => {
  const s = live();
  assert.throws(() => D.removePlayer(s, own('A'), 'p3', '', T0), /Only the commissioner/);
  const r = D.removePlayer(s, admin, 'p3', '', T0).state;
  assert.throws(() => D.restorePlayer(r, own('A'), 'p3', T0), /Only the commissioner/);
});

test('a drafted player cannot be removed until the pick is undone', () => {
  let s = live();
  s = D.makePick(s, admin, 1, 'p1', T0).state;
  s = { ...s, players: { ...s.players } };
  assert.throws(() => D.removePlayer(s, admin, 'p1', '', T0), (e) => e.code === 'drafted' && /Undo that pick first/.test(e.message));
  s = D.undoPick(s, admin, 1, T0 + MIN).state;
  assert.equal(D.removePlayer(s, admin, 'p1', 'oops', T0 + MIN).state.players.p1.removed, true);
});

test('unknown, write-in and already-removed players are refused; restore needs a removed player', () => {
  const s = live();
  assert.throws(() => D.removePlayer(s, admin, 'nope', '', T0), /Unknown pool player/);
  const r = D.removePlayer(s, admin, 'p3', '', T0).state;
  assert.throws(() => D.removePlayer(r, admin, 'p3', '', T0), (e) => e.code === 'already-removed');
  assert.throws(() => D.restorePlayer(s, admin, 'p3', T0), (e) => e.code === 'not-removed');
});

test('a keeper (already owned by a team, not drafted) can be removed', () => {
  const s = live();
  assert.equal(s.players.p8.ownerTeam, 'C');
  const r = D.removePlayer(s, admin, 'p8', 'not a real keeper', T0);
  assert.equal(r.state.players.p8.removed, true);
  assert.equal(r.audit[0].team, 'C');
});

test('nobody can pick a removed player: owner pick, commissioner pick and edit are all refused', () => {
  let s = live();
  s = D.removePlayer(s, admin, 'p3', '', T0).state;
  assert.throws(() => D.makePick(s, own('A'), 1, 'p3', T0 + MIN), (e) => e.code === 'removed' && /removed from the draft list/.test(e.message));
  assert.throws(() => D.makePick(s, admin, 1, 'p3', T0 + MIN), (e) => e.code === 'removed');
  const picked = D.makePick(s, own('A'), 1, 'p2', T0 + MIN).state;
  assert.throws(() => D.editPick(picked, admin, 1, 'p3', T0 + 2 * MIN), (e) => e.code === 'removed');
});

test('restore puts him back: he can be drafted again', () => {
  let s = live();
  s = D.removePlayer(s, admin, 'p3', '', T0).state;
  const r = D.restorePlayer(s, admin, 'p3', T0 + MIN);
  assert.equal(r.state.players.p3.removed, undefined);
  assert.equal(r.audit[0].type, 'player-restore');
  assert.equal(D.makePick(r.state, own('A'), 1, 'p3', T0 + 2 * MIN).state.picks[1].playerId, 'p3');
});

test('auto-draft skips a removed player and takes the next entry; with only removed entries nothing is picked', () => {
  let s = live();
  s = D.removePlayer(s, admin, 'p2', '', T0).state;
  const r = tick(s, ctx(list('A', ['p2', 'p4'])), T0 + MIN);
  assert.equal(r.kind, 'autopick');
  assert.equal(r.state.picks[1].playerId, 'p4');
  const none = tick(s, ctx(list('A', ['p2'])), T0 + MIN);
  assert.equal(none.changed, false);
});

test('owners draft lists no longer show a removed player', () => {
  let s = live();
  s = D.removePlayer(s, admin, 'p2', '', T0).state;
  assert.deepEqual(visibleQueue(['p1', 'p2', 'p3'], s.players), ['p1', 'p3']);
});

test('derivePlayers flags removed ids (what the browser and the ticker load from removed/)', () => {
  const base = [{ id: 'p1', name: 'One', ownerTeam: '' }, { id: 'p2', name: 'Two', ownerTeam: '' }];
  const players = derivePlayers(base, {}, { p2: { name: 'Two' } });
  assert.equal(players.p1.removed, undefined);
  assert.equal(players.p2.removed, true);
  assert.equal(derivePlayers(base, {}).p2.removed, undefined); // no removed list = nothing flagged
});

test('ticker flow: a removed player on a list is skipped when state is derived with the removed list', () => {
  const base = Array.from({ length: 4 }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}`, ownerTeam: '' }));
  const s0 = D.startDraft(D.createState({ picks: [{ overall: 1, round: 1, slot: 1, origTeam: 'A', ownerTeam: 'A' }], players: base, clockMinutes: 60 }), admin, T0).state;
  const s = { ...s0, players: derivePlayers(base, s0.picks, { p1: true }) };
  const r = tick(s, ctx(list('A', ['p1', 'p2'])), T0 + MIN);
  assert.equal(r.state.picks[1].playerId, 'p2');
});

test('firestore.rules: removed players cannot be picked, and removed/ is commissioner-only even while locked', () => {
  const r = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  // owners' picks: the pool check also requires no removed/{id} document
  assert.match(r, /exists\(\/databases\/\$\(db\)\/documents\/pool\/\$\(n\.playerId\)\)\s*&& !exists\(\/databases\/\$\(db\)\/documents\/removed\/\$\(n\.playerId\)\)/);
  assert.match(r, /exists\(\/databases\/\$\(db\)\/documents\/pool\/\$\(pid\)\)\s*&& !exists\(\/databases\/\$\(db\)\/documents\/removed\/\$\(pid\)\)/);
  const block = r.slice(r.indexOf('match /removed/{pid}'), r.indexOf('match /playerchunks/{id}'));
  assert.ok(block.length > 50, 'removed rule block found');
  assert.match(block, /allow read: if signedIn\(\)/);
  assert.match(block, /allow create, update: if isAdmin\(\)/);
  assert.match(block, /allow delete: if isAdmin\(\)/);
  assert.doesNotMatch(block, /locked\(\)/); // works while the real-draft lock is ON
  assert.match(block, /hasOnly\(\['name', 'reason', 'by', 'at'\]\)/);
});
