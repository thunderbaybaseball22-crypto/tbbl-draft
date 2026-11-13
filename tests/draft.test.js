import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../public/js/lib/draft.js';
import { etToUtc, addOpenTime } from '../public/js/lib/clock.js';

const H = 3600000, MIN = 60000;
const T0 = etToUtc(2027, 6, 7, 11); // Monday 11:00 ET
const admin = { email: 'comm@example.com', isAdmin: true, teams: [] };
const own = (t) => ({ email: `${t.toLowerCase()}@example.com`, isAdmin: false, teams: [t] });

function fresh() {
  const order = ['A', 'B', 'C', 'A', 'B', 'C'];
  const picks = order.map((t, i) => ({ overall: i + 1, round: Math.floor(i / 3) + 1, slot: (i % 3) + 1, origTeam: t, ownerTeam: t }));
  const players = Array.from({ length: 10 }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}`, ownerTeam: i === 0 ? 'C' : '' }));
  return D.createState({ picks, players, clockMinutes: 60 });
}
const live = () => D.startDraft(fresh(), admin, T0).state;
const types = (r) => r.audit.map((a) => a.type);

test('start puts pick 1 on the clock with a 1 hour deadline', () => {
  const s = live();
  assert.equal(s.config.status, 'live');
  assert.equal(s.config.currentPick, 1);
  assert.equal(s.config.deadline, T0 + H);
});

test('only the commissioner can start; cannot start twice', () => {
  assert.throws(() => D.startDraft(fresh(), own('A'), T0), /commissioner/);
  assert.throws(() => D.startDraft(live(), admin, T0), /already started/);
});

test('start time arrival starts the draft automatically (any client)', () => {
  const s = D.setStartAt(fresh(), admin, T0, T0 - H).state;
  assert.equal(D.startIfDue(s, T0 - 1).changed, false);
  const r = D.startIfDue(s, T0 + 5);
  assert.equal(r.state.config.status, 'live');
  assert.equal(r.state.config.currentPick, 1);
});

test('normal pick advances the clock to the next pick with a fresh deadline', () => {
  const r = D.makePick(live(), own('A'), 1, 'p2', T0 + 10 * MIN);
  assert.equal(r.state.picks[1].status, 'made');
  assert.equal(r.state.players.p2.ownerTeam, 'A');
  assert.equal(r.state.players.p2.drafted, 1);
  assert.equal(r.state.config.currentPick, 2);
  assert.equal(r.state.config.deadline, T0 + 10 * MIN + H);
  assert.equal(r.audit[0].type, 'pick');
});

test('input state is never mutated', () => {
  const s = live();
  const snap = JSON.stringify(s);
  D.makePick(s, own('A'), 1, 'p2', T0);
  assert.equal(JSON.stringify(s), snap);
});

test('owner cannot pick for a team they do not own, even if it is on the clock', () => {
  assert.throws(() => D.makePick(live(), own('B'), 1, 'p2', T0), /belongs to A/);
});

test('taken or keeper players are rejected', () => {
  let s = D.makePick(live(), own('A'), 1, 'p2', T0).state;
  assert.throws(() => D.makePick(s, own('B'), 2, 'p2', T0), /not available/);
  assert.throws(() => D.makePick(s, own('B'), 2, 'p1', T0), /not available/); // keeper of C
  assert.throws(() => D.makePick(s, own('B'), 2, 'nope', T0), /Unknown player/);
});

test('cannot pick before the draft starts or when paused (owners)', () => {
  assert.throws(() => D.makePick(fresh(), own('A'), 1, 'p2', T0), /not live/);
  const p = D.pause(live(), admin, T0 + MIN).state;
  assert.throws(() => D.makePick(p, own('A'), 1, 'p2', T0), /not live/);
  assert.equal(D.makePick(p, admin, 1, 'p2', T0 + 2 * MIN).state.picks[1].status, 'made');
});

test('expiry skips the pick and puts the next pick on the clock', () => {
  const s = live();
  assert.equal(D.expireIfDue(s, T0 + H - 1).changed, false);
  const r = D.expireIfDue(s, T0 + H);
  assert.equal(r.state.picks[1].status, 'skipped');
  assert.equal(r.state.config.currentPick, 2);
  assert.equal(r.state.config.deadline, T0 + 2 * H);
  assert.deepEqual(types(r), ['skip']);
});

test('expiry skips only one pick per call and nothing auto-drafts', () => {
  const r = D.expireIfDue(live(), T0 + 10 * H);
  assert.equal(r.state.picks[2].status, 'open');
  assert.equal(Object.values(r.state.picks).filter((p) => p.status === 'made').length, 0);
});

test('skipped owner can make a late pick; the clock stays on the current pick', () => {
  const s = D.expireIfDue(live(), T0 + H).state; // A skipped, B (pick 2) on the clock
  const deadline = s.config.deadline;
  const r = D.makePick(s, own('A'), 1, 'p3', T0 + H + 5 * MIN);
  assert.equal(r.state.picks[1].status, 'made');
  assert.equal(r.audit[0].late, true);
  assert.equal(r.state.config.currentPick, 2);
  assert.equal(r.state.config.deadline, deadline);
});

test('several skipped picks for one owner can be filled out of order', () => {
  let s = live();
  s = D.expireIfDue(s, T0 + H).state;       // pick 1 (A) skipped
  s = D.makePick(s, own('B'), 2, 'p2', T0 + H + MIN).state; // B picks, C (3) on clock
  s = D.makePick(s, own('C'), 3, 'p3', T0 + H + 2 * MIN).state; // A (pick 4) on clock
  const t4 = T0 + 3 * H;
  s = D.expireIfDue(s, s.config.deadline).state;   // pick 4 (A) skipped too
  assert.equal(s.picks[4].status, 'skipped');
  s = D.makePick(s, own('A'), 4, 'p4', t4).state;  // later pick first
  s = D.makePick(s, own('A'), 1, 'p5', t4 + MIN).state;
  assert.equal(s.picks[4].playerId, 'p4');
  assert.equal(s.picks[1].playerId, 'p5');
});

test('an owner cannot fill a future open pick early; the commissioner can', () => {
  const s = live();
  assert.throws(() => D.makePick(s, own('A'), 4, 'p2', T0), /not on the clock yet/);
  assert.throws(() => D.makeWriteIn(s, own('A'), 4, { name: 'Early Guy', note: 'x' }, T0), /not on the clock yet/);
  assert.equal(D.canPick(s, own('A'), 4), false);
  assert.equal(D.canPick(s, own('A'), 1), true);
  const r = D.makePick(s, admin, 4, 'p2', T0).state;
  assert.equal(r.picks[4].status, 'made');
  assert.equal(r.config.currentPick, 1);
});

test('completeIfDone closes a live draft only when every pick is made', () => {
  let s = live();
  for (let i = 0; i < 6; i++) s = D.expireIfDue(s, s.config.deadline ?? Infinity).state;
  assert.equal(D.completeIfDone(s, T0).changed, false); // skipped picks still open
  ['A', 'B', 'C', 'A', 'B', 'C'].forEach((t, i) => { s = D.makePick(s, own(t), i + 1, `p${i + 2}`, T0).state; });
  const live2 = { ...s, config: { ...s.config, status: 'live' } }; // as the live site stores an owner's last pick
  const r = D.completeIfDone(live2, T0);
  assert.equal(r.changed, true);
  assert.equal(r.state.config.status, 'complete');
  assert.equal(r.audit[0].type, 'complete');
});

test('when only skipped picks remain there is no clock; filling them completes the draft', () => {
  let s = live();
  for (let i = 0; i < 6; i++) s = D.expireIfDue(s, s.config.deadline ?? Infinity).state;
  assert.equal(s.config.currentPick, null);
  assert.equal(s.config.status, 'live');
  assert.equal(D.expireIfDue(s, T0 + 1000 * H).changed, false);
  const order = ['A', 'B', 'C', 'A', 'B', 'C'];
  order.forEach((t, i) => { s = D.makePick(s, own(t), i + 1, `p${i + 2}`, T0 + 50 * H).state; });
  assert.equal(s.config.status, 'complete');
});

test('commissioner can pick on behalf of any owner', () => {
  const r = D.makePick(live(), admin, 1, 'p2', T0);
  assert.equal(r.state.players.p2.ownerTeam, 'A');
  assert.equal(r.audit[0].onBehalf, true);
  assert.equal(r.audit[0].by, admin.email);
});

test('trade: new owner can pick, old owner rejected, original owner kept, audited', () => {
  const s = live();
  const r = D.tradePick(s, admin, 1, 'B', 'for cash', T0 + MIN);
  assert.equal(r.state.picks[1].ownerTeam, 'B');
  assert.equal(r.state.picks[1].origTeam, 'A');
  assert.equal(r.state.config.deadline, s.config.deadline); // clock untouched
  assert.deepEqual(r.audit[0], { type: 'trade', by: admin.email, at: T0 + MIN, overall: 1, from: 'A', to: 'B', orig: 'A', note: 'for cash' });
  assert.throws(() => D.makePick(r.state, own('A'), 1, 'p2', T0), /belongs to B/);
  assert.equal(D.makePick(r.state, own('B'), 1, 'p2', T0).state.players.p2.ownerTeam, 'B');
});

test('trade validation: admin only, known team, not to same owner, not a made pick', () => {
  const s = live();
  assert.throws(() => D.tradePick(s, own('A'), 1, 'B', '', T0), /commissioner/);
  assert.throws(() => D.tradePick(s, admin, 1, 'ZZZ', '', T0), /Unknown team/);
  assert.throws(() => D.tradePick(s, admin, 1, 'A', '', T0), /already owns/);
  const m = D.makePick(s, own('A'), 1, 'p2', T0).state;
  assert.throws(() => D.tradePick(m, admin, 1, 'B', '', T0), /Undo it first/);
});

test('undo the latest pick: player freed, pick back on the clock with a fresh deadline', () => {
  let s = D.makePick(live(), own('A'), 1, 'p2', T0 + 10 * MIN).state; // pick 2 on clock
  const r = D.undoPick(s, admin, 1, T0 + 20 * MIN);
  assert.equal(r.state.picks[1].status, 'open');
  assert.equal(r.state.players.p2.ownerTeam, '');
  assert.equal(r.state.players.p2.drafted, null);
  assert.equal(r.state.config.currentPick, 1);
  assert.equal(r.state.config.deadline, T0 + 20 * MIN + H);
  assert.equal(r.audit[0].type, 'undo');
});

test('undo a middle pick while a later pick is on the clock', () => {
  let s = live();
  s = D.makePick(s, own('A'), 1, 'p2', T0).state;
  s = D.makePick(s, own('B'), 2, 'p3', T0).state;  // C (3) on the clock
  const r = D.undoPick(s, admin, 2, T0 + MIN);
  assert.equal(r.state.picks[2].status, 'open');
  assert.equal(r.state.players.p3.ownerTeam, '');
  assert.equal(r.state.config.currentPick, 2); // earliest open pick takes the clock
});

test('undo of a previously skipped pick returns it to skipped and keeps the clock where it was', () => {
  let s = D.expireIfDue(live(), T0 + H).state;       // 1 skipped, 2 on clock
  s = D.makePick(s, own('A'), 1, 'p2', T0 + H + MIN).state;
  const deadline = s.config.deadline;
  const r = D.undoPick(s, admin, 1, T0 + H + 2 * MIN);
  assert.equal(r.state.picks[1].status, 'skipped');
  assert.equal(r.state.config.currentPick, 2);
  assert.equal(r.state.config.deadline, deadline);
});

test('undo is admin only, and only for made picks; undo reopens a completed draft', () => {
  const s = D.makePick(live(), own('A'), 1, 'p2', T0).state;
  assert.throws(() => D.undoPick(s, own('A'), 1, T0), /commissioner/);
  assert.throws(() => D.undoPick(s, admin, 2, T0), /not been made/);
  let c = live();
  ['A', 'B', 'C', 'A', 'B', 'C'].forEach((t, i) => { c = D.makePick(c, own(t), i + 1, `p${i + 2}`, T0).state; });
  assert.equal(c.config.status, 'complete');
  const u = D.undoPick(c, admin, 6, T0 + MIN).state;
  assert.equal(u.config.status, 'live');
  assert.equal(u.config.currentPick, 6);
});

test('edit pick swaps the player and audits', () => {
  const s = D.makePick(live(), own('A'), 1, 'p2', T0).state;
  const r = D.editPick(s, admin, 1, 'p3', T0 + MIN);
  assert.equal(r.state.players.p2.ownerTeam, '');
  assert.equal(r.state.players.p3.ownerTeam, 'A');
  assert.equal(r.state.picks[1].playerId, 'p3');
  assert.deepEqual(types(r), ['edit']);
});

test('clock length change keeps the same fraction remaining on the current pick', () => {
  const s = live();                                   // 60 min clock
  const r = D.setClockMinutes(s, admin, 120, T0 + 30 * MIN); // half used
  assert.equal(r.state.config.clockMinutes, 120);
  assert.equal(r.state.config.deadline, T0 + 30 * MIN + 60 * MIN); // half of 120
  const next = D.makePick(r.state, own('A'), 1, 'p2', T0 + 40 * MIN).state;
  assert.equal(next.config.deadline, T0 + 40 * MIN + 2 * H);   // later picks get the full new length
  assert.throws(() => D.setClockMinutes(s, admin, 0, T0), /positive/);
  assert.throws(() => D.setClockMinutes(s, own('A'), 30, T0), /commissioner/);
});

test('pause stores remaining time; resume restores it (outside hours does not burn clock)', () => {
  const s = live();
  const p = D.pause(s, admin, T0 + 20 * MIN);
  assert.equal(p.state.config.status, 'paused');
  assert.equal(p.state.config.deadline, null);
  assert.equal(p.state.config.remainingMs, 40 * MIN);
  const later = etToUtc(2027, 6, 9, 15); // two days later
  const r = D.resume(p.state, admin, later);
  assert.equal(r.state.config.deadline, later + 40 * MIN);
  assert.equal(D.expireIfDue(p.state, T0 + 100 * H).changed, false); // paused never expires
});

test('a pick that starts at 22:30 expires after 30 min tonight + 30 min tomorrow', () => {
  const s = D.startDraft(fresh(), admin, etToUtc(2027, 6, 7, 22, 30)).state;
  assert.equal(s.config.deadline, etToUtc(2027, 6, 8, 11, 30));
  assert.equal(D.expireIfDue(s, etToUtc(2027, 6, 8, 11, 29)).changed, false);
  assert.equal(D.expireIfDue(s, etToUtc(2027, 6, 8, 11, 30)).changed, true);
});

test('helpers: picksOwnedBy and roster', () => {
  let s = D.makePick(live(), own('A'), 1, 'p2', T0).state;
  assert.deepEqual(D.picksOwnedBy(s, 'A').map((p) => p.overall), [4]);
  assert.deepEqual(D.roster(s, 'A').map((r) => r.id), ['p2']);
  assert.equal(D.canPick(s, own('B'), 2), true);
  assert.equal(D.canPick(s, own('A'), 2), false);
});

test('addOpenTime import sanity (deadline equals clock.js)', () => {
  assert.equal(live().config.deadline, addOpenTime(T0, H));
});
