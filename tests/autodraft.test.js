import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as D from '../public/js/lib/draft.js';
import { tick, tickAll, autoDraftStatus } from '../public/js/lib/tick.js';
import { addToQueue, moveInQueue, visibleQueue, checkQueueWriteIn, itemKey } from '../public/js/lib/queue.js';
import { etToUtc, addOpenTime, deadlineFloor, deadlineCeiling } from '../public/js/lib/clock.js';

const H = 3600000, MIN = 60000;
const T0 = etToUtc(2027, 6, 7, 11); // Monday 11:00 ET
const admin = { email: 'comm@example.com', isAdmin: true, teams: [] };
const own = (t) => ({ email: `${t.toLowerCase()}@example.com`, isAdmin: false, teams: [t] });

function fresh(extra = {}) {
  const order = ['A', 'B', 'C', 'A', 'B', 'C'];
  const picks = order.map((t, i) => ({ overall: i + 1, round: Math.floor(i / 3) + 1, slot: (i % 3) + 1, origTeam: t, ownerTeam: t }));
  const players = Array.from({ length: 10 }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}`, ownerTeam: '' }));
  const s = D.createState({ picks, players, clockMinutes: 60 });
  Object.assign(s.config, extra);
  return s;
}
const live = (extra) => D.startDraft(fresh(extra), admin, T0).state;
const list = (team, items, autoDraft = true) => ({ email: `${team.toLowerCase()}@example.com`, teams: [team], autoDraft, items });
const ctx = (...queues) => ({ isAdmin: false, queues, verifiedKeys: new Set() });

// ---- A: lower bound on a client-supplied deadline ----
test('deadline floor/ceiling bracket every real deadline (incl. DST days, long clocks) and reject now+1s', () => {
  const starts = [etToUtc(2027, 6, 7, 11), etToUtc(2027, 6, 7, 22, 59), etToUtc(2027, 6, 8, 3), etToUtc(2027, 3, 13, 22), etToUtc(2027, 3, 14, 10, 30),
    etToUtc(2027, 11, 6, 22, 30), etToUtc(2027, 11, 7, 1, 30), etToUtc(2027, 11, 7, 12)];
  for (const now of starts) {
    for (const minutes of [1, 15, 60, 90, 600, 1800, 4000]) {
      const dl = addOpenTime(now, minutes * MIN);
      assert.ok(dl >= deadlineFloor(now, minutes), `floor ${new Date(now).toISOString()} ${minutes}`);
      assert.ok(dl <= deadlineCeiling(now, minutes), `ceiling ${new Date(now).toISOString()} ${minutes}`);
      assert.ok(now + 1000 < deadlineFloor(now, minutes) || minutes * MIN - 120000 <= 1000, 'a 1 second deadline is below the floor');
    }
  }
});

test('firestore.rules enforces the same floor and ceiling in deadlineOk', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  assert.ok(rules.includes('n.deadline >= now() + o.clockMinutes * 60000 - 120000'), 'floor missing from deadlineOk');
  assert.ok(rules.includes('n.deadline <= now() + 2 * o.clockMinutes * 60000 + 86400000'), 'ceiling missing from deadlineOk');
});

// ---- B: early picks when the countdown is paused ----
test('owner may pick at 11:30 PM ET as soon as the pick before theirs is made; not ahead of the clock', () => {
  const late = etToUtc(2027, 6, 7, 23, 30);
  let s = live();
  s = D.makePick(s, own('A'), 1, 'p1', late).state; // pick 2 is now on the clock, outside the window
  assert.equal(s.config.currentPick, 2);
  assert.ok(s.config.deadline > etToUtc(2027, 6, 8, 11), 'countdown waits for 11:00 AM ET');
  assert.equal(D.canPick(s, own('B'), 2, late + MIN), true);
  assert.equal(D.canPick(s, own('C'), 3, late + MIN), false);
  assert.throws(() => D.makePick(s, own('C'), 3, 'p2', late + MIN), /not on the clock/);
  s = D.makePick(s, own('B'), 2, 'p2', late + MIN).state;
  assert.equal(s.config.currentPick, 3);
});

test('commissioner flag allowPickWhenClockPaused=false limits owners to the clock window', () => {
  const late = etToUtc(2027, 6, 7, 23, 30);
  let s = live();
  s = D.setAllowPickWhenClockPaused(s, admin, false, T0).state;
  assert.throws(() => D.setAllowPickWhenClockPaused(s, own('A'), true, T0), /commissioner/);
  s = D.makePick(s, admin, 1, 'p1', late).state;
  assert.equal(D.canPick(s, own('B'), 2, late + MIN), false);
  assert.throws(() => D.makePick(s, own('B'), 2, 'p2', late + MIN), /11:00 AM/);
  assert.equal(D.canPick(s, own('B'), 2, etToUtc(2027, 6, 8, 11, 5)), true); // window open again
  assert.doesNotThrow(() => D.makePick(s, admin, 2, 'p2', late + MIN)); // commissioner unaffected
});

// ---- C: auto-draft ----
test('auto-draft ON takes the first still-available player on the list, right away, at any hour', () => {
  const late = etToUtc(2027, 6, 7, 23, 30);
  let s = live();
  s = D.makePick(s, own('A'), 1, 'p1', late).state; // B on the clock at 11:30 PM
  const lst = list('B', ['p1', 'p3', 'p2']); // p1 already taken, so p3
  const r = tick(s, ctx(lst), late + 1000);
  assert.equal(r.kind, 'autopick');
  assert.equal(r.state.picks[2].playerId, 'p3');
  assert.equal(r.state.picks[2].madeBy, 'b@example.com');
  assert.equal(r.state.config.currentPick, 3);
  assert.equal(r.audit[0].auto, true);
  assert.equal(r.audit[0].type, 'pick');
});

test('auto-draft OFF does nothing, and the list never drafts by itself', () => {
  const s = live();
  const r = tick(s, ctx(list('A', ['p2'], false)), T0 + MIN);
  assert.equal(r.changed, false);
  assert.equal(s.picks[1].status, 'open');
  assert.equal(autoDraftStatus(s, ctx(list('A', ['p2'], false)), T0).kind, 'none');
});

test('auto-draft only acts for the owner of the pick on the clock', () => {
  const s = live(); // A is on the clock
  assert.equal(tick(s, ctx(list('B', ['p2'])), T0 + MIN).changed, false);
});

test('exhausted list: nothing is picked, the clock keeps running, then the normal skip applies and a late pick works', () => {
  let s = live();
  const taken = D.makePick(s, admin, 1, 'p1', T0).state; // A's pick; B now on the clock with a fresh hour
  const exhausted = list('B', ['p1']); // only entry is gone
  const dl = taken.config.deadline;
  assert.equal(autoDraftStatus(taken, ctx(exhausted), T0 + MIN).kind, 'exhausted');
  const r = tick(taken, ctx(exhausted), T0 + 30 * MIN);
  assert.equal(r.changed, false);
  assert.equal(taken.config.deadline, dl, 'deadline untouched');
  // time runs out: normal skip
  const sk = tick(taken, ctx(exhausted), dl);
  assert.equal(sk.kind, 'skip');
  assert.equal(sk.state.picks[2].status, 'skipped');
  assert.equal(sk.state.config.currentPick, 3);
  // owner picks later as a skipped pick (and the list still does not best-available for them)
  const late = D.makePick(sk.state, own('B'), 2, 'p5', dl + 5 * MIN).state;
  assert.equal(late.picks[2].playerId, 'p5');
  assert.equal(late.config.currentPick, 3);
});

test('auto-draft runs before the skip, so a pick whose list can fill it is not skipped', () => {
  const taken = D.makePick(live(), admin, 1, 'p1', T0).state;
  const r = tick(taken, ctx(list('B', ['p4'])), taken.config.deadline + 5 * MIN);
  assert.equal(r.kind, 'autopick');
  assert.equal(r.state.picks[2].playerId, 'p4');
});

test('write-in entry auto-picks as a write-in flagged pending verification', () => {
  const s = live();
  const item = { writeIn: { name: 'Pat Prospect', url: 'https://www.baseball-reference.com/register/player.fcgi?id=prospe001pat', note: '' } };
  const r = tick(s, ctx(list('A', ['nope', item])), T0 + MIN); // unknown id first is skipped
  assert.equal(r.kind, 'autopick');
  const p = r.state.picks[1];
  assert.equal(p.playerId, 'WI-1');
  assert.equal(p.writeIn.status, 'pending');
  assert.equal(p.writeIn.name, 'Pat Prospect');
  assert.equal(r.audit[0].type, 'writein');
  assert.equal(r.audit[0].auto, true);
});

test('duplicate write-in (already written in by id, URL or name; or now in the pool) is skipped at pick time', () => {
  let s = live();
  s = D.makeWriteIn(s, own('A'), 1, { name: 'Pat Prospect', url: 'https://www.baseball-reference.com/register/player.fcgi?id=prospe001pat' }, T0 + MIN).state;
  const dupByName = { writeIn: { name: 'pat prospect', url: '', note: 'same guy' } };
  const dupById = { writeIn: { name: 'P. Prospect', url: 'https://baseball-reference.com/register/player.fcgi?id=prospe001pat', note: '' } };
  const inPool = { writeIn: { name: 'Player 7', url: '', note: 'x' } };
  const ok = { writeIn: { name: 'Quinn Other', url: '', note: 'HS SS' } };
  const r = tick(s, ctx(list('B', [dupByName, dupById, inPool, ok])), T0 + 2 * MIN);
  assert.equal(r.kind, 'autopick');
  assert.equal(r.state.picks[2].writeIn.name, 'Quinn Other');
  // only duplicates left -> exhausted, nothing picked
  const none = tick(s, ctx(list('B', [dupByName, dupById, inPool])), T0 + 2 * MIN);
  assert.equal(none.changed, false);
  assert.equal(autoDraftStatus(s, ctx(list('B', [dupByName, dupById, inPool])), T0 + 2 * MIN).kind, 'exhausted');
});

test('consecutive auto-draft owners chain; the chain stops at an owner with auto-draft off', () => {
  const s = live();
  const out = tickAll(s, ctx(list('A', ['p1']), list('B', ['p2']), list('C', ['p3'], false)), T0 + MIN);
  assert.equal(out.state.picks[1].playerId, 'p1');
  assert.equal(out.state.picks[2].playerId, 'p2');
  assert.equal(out.state.picks[3].status, 'open');
  assert.equal(out.state.config.currentPick, 3);
  assert.equal(out.audit.filter((a) => a.auto).length, 2);
});

test('auto-draft respects the commissioner window flag (waits until the window opens)', () => {
  const late = etToUtc(2027, 6, 7, 23, 30);
  let s = live({ allowPickWhenClockPaused: false });
  s = D.makePick(s, admin, 1, 'p1', late).state;
  assert.equal(tick(s, ctx(list('B', ['p2'])), late + MIN).changed, false);
  assert.equal(tick(s, ctx(list('B', ['p2'])), etToUtc(2027, 6, 8, 11, 1)).kind, 'autopick');
});

test('no auto-draft while paused', () => {
  const s = D.pause(live(), admin, T0 + MIN).state;
  assert.equal(tick(s, ctx(list('A', ['p2'])), T0 + 2 * MIN).changed, false);
});

// ---- commissioner pre-verification of queued write-ins ----
test('a write-in the commissioner verified ahead of time is confirmed by the commissioner tick', () => {
  const item = { writeIn: { name: 'Pat Prospect', url: '', note: 'HS SS' } };
  const s = tick(live(), ctx(list('A', [item])), T0 + MIN).state;
  assert.equal(s.picks[1].writeIn.status, 'pending');
  const key = s.picks[1].writeIn.nameKey;
  assert.equal(tick(s, ctx(), T0 + 2 * MIN).changed, false); // owner tabs never confirm
  const r = tick(s, { isAdmin: true, queues: [], verifiedKeys: new Set([key]) }, T0 + 2 * MIN);
  assert.equal(r.kind, 'confirm');
  assert.equal(r.state.picks[1].writeIn.status, 'confirmed');
});

// ---- draft list helpers ----
test('draft list holds pool players and write-ins in one ordered list; duplicates are ignored', () => {
  const w = { writeIn: { name: 'Pat Prospect', url: '', note: 'x' } };
  let q = addToQueue([], 'p1');
  q = addToQueue(q, w); q = addToQueue(q, { writeIn: { name: 'PAT  prospect', url: '', note: 'y' } }); q = addToQueue(q, 'p2');
  assert.equal(q.length, 3);
  assert.deepEqual(moveInQueue(q, w, 0).map(itemKey), ['wi:pat prospect', 'p1', 'p2']);
});

test('write-in list entries get the same validation as write-in picks', () => {
  const s = live();
  assert.match(checkQueueWriteIn({ name: '', note: 'x' }, s).error, /name/i);
  assert.match(checkQueueWriteIn({ name: 'Zed', url: '', note: '' }, s).error, /link/i);
  assert.match(checkQueueWriteIn({ name: 'Zed', url: 'not a url' }, s).error, /web address/);
  assert.match(checkQueueWriteIn({ name: 'Player 3', note: 'x' }, s).error, /already in the player pool/);
  const ok = checkQueueWriteIn({ name: 'Zed Zero', url: 'https://example.com/zed' }, s);
  assert.equal(ok.item.writeIn.name, 'Zed Zero');
  const taken = D.makeWriteIn(s, own('A'), 1, { name: 'Zed Zero', url: 'https://example.com/zed' }, T0 + MIN).state;
  assert.match(checkQueueWriteIn({ name: 'Zed Zero', url: 'https://example.com/other' }, taken).error, /already written in/);
  assert.deepEqual(visibleQueue(['p1', ok.item], taken.players, taken), ['p1']);
});
