import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as D from '../public/js/lib/draft.js';
import { tick, tickAll } from '../public/js/lib/tick.js';
import { planWrites, planStillValid } from '../public/js/lib/persist.js';
import { exportSchedule, exportResults, exportNewPlayers } from '../public/js/lib/csv.js';
import { planRestart } from '../public/js/lib/restart.js';
import { composeEmail, nextBatch, pickNo } from '../public/js/lib/groupmail.js';
import { pickLabel, overallLabel, orderKey } from '../public/js/lib/pickno.js';
import { etToUtc } from '../public/js/lib/clock.js';

const H = 3600000;
const T0 = etToUtc(2027, 6, 7, 11);
const admin = { email: 'comm@example.com', isAdmin: true, teams: [] };
const own = (t) => ({ email: `${t.toLowerCase()}@example.com`, isAdmin: false, teams: [t] });

function fresh() {
  const order = ['A', 'B', 'C', 'A', 'B', 'C'];
  const picks = order.map((t, i) => ({ overall: i + 1, round: Math.floor(i / 3) + 1, slot: (i % 3) + 1, origTeam: t, ownerTeam: t }));
  const players = Array.from({ length: 12 }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}`, ownerTeam: '' }));
  return D.createState({ picks, players, clockMinutes: 60 });
}
const live = () => D.startDraft(fresh(), admin, T0).state;
const order = (s) => Object.values(s.picks).sort((a, b) => a.overall - b.overall).map((p) => pickLabel(p));

test('void an open pick: stays on the board, audited, cannot be drafted, traded or skipped', () => {
  const r = D.voidPick(live(), admin, 3, 'dup', T0 + 1000);
  const s = r.state;
  assert.equal(s.picks[3].status, 'void');
  assert.equal(r.audit[0].type, 'void');
  assert.equal(r.audit[0].label, '1.3');
  assert.equal(Object.keys(s.picks).length, 6);
  assert.throws(() => D.makePick(s, admin, 3, 'p1', T0 + 2000), /voided/);
  assert.throws(() => D.makeWriteIn(s, admin, 3, { name: 'X Y', url: 'https://example.com', note: '' }, T0 + 2000), /voided/);
  assert.throws(() => D.tradePick(s, admin, 3, 'A', '', T0 + 2000), /voided/);
  assert.equal(D.canPick(s, admin, 3), false);
  assert.equal(D.canPick(s, own('C'), 3, T0), false);
  assert.throws(() => D.voidPick(s, admin, 3, '', T0), /already voided/);
});

test('only the commissioner can void, un-void or add', () => {
  assert.throws(() => D.voidPick(live(), own('A'), 1, '', T0), /commissioner/);
  assert.throws(() => D.addPick(live(), own('A'), 1, 'A', T0), /commissioner/);
  const v = D.voidPick(live(), admin, 2, '', T0).state;
  assert.throws(() => D.unvoidPick(v, own('B'), 2, T0), /commissioner/);
});

test('void is blocked on a filled pick with an undo-first message; undo then void works', () => {
  const s = D.makePick(live(), own('A'), 1, 'p1', T0 + 1000).state;
  assert.throws(() => D.voidPick(s, admin, 1, '', T0 + 2000), /Undo it first/);
  const u = D.undoPick(s, admin, 1, T0 + 3000).state;
  assert.equal(D.voidPick(u, admin, 1, '', T0 + 4000).state.picks[1].status, 'void');
});

test('void is not available before the start or after completion', () => {
  assert.throws(() => D.voidPick(fresh(), admin, 1, '', T0), /CSV/);
  assert.throws(() => D.addPick(fresh(), admin, 1, 'A', T0), /CSV/);
});

test('voiding the on-clock pick moves the clock to the next open pick with a full clock', () => {
  const s = live();
  const r = D.voidPick(s, admin, 1, '', T0 + 30 * 60000);
  assert.equal(r.state.config.currentPick, 2);
  assert.equal(r.state.config.deadline, T0 + 30 * 60000 + H);
  // voiding a later pick leaves the clock alone
  const r2 = D.voidPick(s, admin, 4, '', T0 + 1000);
  assert.equal(r2.state.config.currentPick, 1);
  assert.equal(r2.state.config.deadline, s.config.deadline);
});

test('void while paused gives the next pick a full paused clock', () => {
  const p = D.pause(live(), admin, T0 + 1000).state;
  const r = D.voidPick(p, admin, 1, '', T0 + 2000);
  assert.equal(r.state.config.currentPick, 2);
  assert.equal(r.state.config.remainingMs, H);
});

test('the clock skips over voided picks, in the skip chain and after a pick is made', () => {
  let s = D.voidPick(live(), admin, 2, '', T0 + 1000).state;
  s = D.makePick(s, own('A'), 1, 'p1', T0 + 2000).state;
  assert.equal(s.config.currentPick, 3);
  // expiry of 3 goes to 4 (never to a void)
  s = D.voidPick(s, admin, 4, '', T0 + 3000).state;
  const e = D.expireIfDue(s, s.config.deadline + 1);
  assert.equal(e.state.picks[3].status, 'skipped');
  assert.equal(e.state.config.currentPick, 5);
  assert.equal(e.state.picks[2].status, 'void');
});

test('voiding a skipped pick is allowed and removes the late-pick right; un-void restores it as skipped', () => {
  let s = D.expireIfDue(live(), T0 + H + 1).state;
  assert.equal(s.picks[1].status, 'skipped');
  assert.equal(D.canPick(s, own('A'), 1, T0 + H + 2), true);
  s = D.voidPick(s, admin, 1, '', T0 + H + 3).state;
  assert.equal(D.canPick(s, own('A'), 1, T0 + H + 4), false);
  assert.throws(() => D.makePick(s, own('A'), 1, 'p1', T0 + H + 4), /voided/);
  const u = D.unvoidPick(s, admin, 1, T0 + H + 5);
  assert.equal(u.state.picks[1].status, 'skipped');
  assert.equal(u.state.config.currentPick, 2); // skipped pick does not retake the clock
  assert.equal(u.audit[0].type, 'unvoid');
});

test('un-void returns the pick to its place; if earliest open it goes on the clock with a fresh clock', () => {
  let s = D.voidPick(live(), admin, 1, '', T0 + 1000).state;
  assert.equal(s.config.currentPick, 2);
  const u = D.unvoidPick(s, admin, 1, T0 + 10 * 60000);
  assert.equal(u.state.picks[1].status, 'open');
  assert.equal(u.state.config.currentPick, 1);
  assert.equal(u.state.config.deadline, T0 + 10 * 60000 + H);
  // a void later in the order does not steal the clock back
  s = D.voidPick(live(), admin, 5, '', T0 + 1000).state;
  assert.equal(D.unvoidPick(s, admin, 5, T0 + 2000).state.config.currentPick, 1);
  assert.throws(() => D.unvoidPick(live(), admin, 1, T0), /not voided/);
});

test('voiding every remaining pick completes the draft', () => {
  let s = live();
  for (let n = 1; n <= 6; n++) s = D.voidPick(s, admin, n, '', T0 + n * 1000).state;
  assert.equal(s.config.status, 'complete');
  assert.throws(() => D.addPick(s, admin, 1, 'A', T0 + H), /complete/);
  const u = D.unvoidPick(s, admin, 6, T0 + H).state;
  assert.equal(u.config.status, 'live');
  assert.equal(u.config.currentPick, 6);
});

test('add pick: letter suffix, ordering, numbering unchanged, commissioner picks the team', () => {
  let s = live();
  const r = D.addPick(s, admin, 2, 'C', T0 + 1000);
  s = r.state;
  assert.deepEqual(order(s), ['1.1', '1.2', '1.2a', '1.3', '2.1', '2.2', '2.3']);
  const a = s.picks[2.01];
  assert.equal(a.added, true); assert.equal(a.ownerTeam, 'C'); assert.equal(a.origTeam, 'C');
  assert.equal(overallLabel(a), '2a'); assert.equal(a.round, 1); assert.equal(a.slot, 2);
  assert.equal(r.audit[0].type, 'addpick'); assert.equal(r.audit[0].label, '1.2a');
  assert.equal(s.picks[3].overall, 3); // nothing renumbered
  // second add after the SAME pick, and after the first added one: both end up b, c in order
  s = D.addPick(s, admin, 2, 'A', T0 + 2000).state;
  s = D.addPick(s, admin, 2.01, 'B', T0 + 3000).state;
  assert.deepEqual(order(s), ['1.1', '1.2', '1.2a', '1.2b', '1.2c', '1.3', '2.1', '2.2', '2.3']);
  assert.equal(s.picks[2.02].ownerTeam, 'A');
  assert.equal(s.picks[2.03].ownerTeam, 'B');
  // pointers walk the order
  assert.equal(s.picks[2].next, 2.01); assert.equal(s.picks[2.01].next, 2.02); assert.equal(s.picks[2.03].next, 3);
  assert.throws(() => D.addPick(s, admin, 2, 'ZZ', T0), /Unknown team/);
  assert.equal(orderKey(60, 1), 60.01);
});

test('add at the very end keeps the order and a null pointer', () => {
  const s = D.addPick(live(), admin, 6, 'A', T0 + 1000).state;
  assert.deepEqual(order(s).slice(-2), ['2.3', '2.3a']);
  assert.equal(s.picks[6.01].next, null);
});

test('an added pick after the clock does not move the clock; it comes up in order', () => {
  let s = D.addPick(live(), admin, 1, 'C', T0 + 1000).state;
  assert.equal(s.config.currentPick, 1);
  s = D.makePick(s, own('A'), 1, 'p1', T0 + 2000).state;
  assert.equal(s.config.currentPick, 1.01);
  assert.equal(s.config.deadline, T0 + 2000 + H);
});

test('an added pick placed before the clock goes on the clock with a fresh full clock', () => {
  let s = D.makePick(live(), own('A'), 1, 'p1', T0 + 1000).state;
  s = D.addPick(s, admin, 1, 'B', T0 + 5000).state;
  assert.equal(s.config.currentPick, 1.01);
  assert.equal(s.config.deadline, T0 + 5000 + H);
});

test('added pick can be drafted by its owner, skipped, drafted late, traded and undone', () => {
  let s = D.addPick(live(), admin, 1, 'C', T0 + 1000).state; // 1.1a owned by C, comes after pick 1
  s = D.makePick(s, own('A'), 1, 'p1', T0 + 2000).state;
  assert.equal(s.config.currentPick, 1.01);
  assert.throws(() => D.makePick(s, own('A'), 1.01, 'p2', T0 + 3000), /belongs to C/);
  // trade it, then the new owner drafts it
  s = D.tradePick(s, admin, 1.01, 'B', 'swap', T0 + 3000).state;
  assert.equal(s.picks[1.01].origTeam, 'C');
  let m = D.makePick(s, own('B'), 1.01, 'p2', T0 + 4000);
  assert.equal(m.state.picks[1.01].status, 'made');
  assert.equal(m.state.players.p2.drafted, 1.01);
  assert.equal(m.state.config.currentPick, 2);
  // undo puts it back on the clock
  const u = D.undoPick(m.state, admin, 1.01, T0 + 5000).state;
  assert.equal(u.picks[1.01].status, 'open'); assert.equal(u.config.currentPick, 1.01);
  assert.equal(u.players.p2.drafted, null);
  // skip, then a late pick
  const e = D.expireIfDue(u, u.config.deadline + 1);
  assert.equal(e.state.picks[1.01].status, 'skipped');
  assert.equal(e.state.config.currentPick, 2);
  const late = D.makePick(e.state, own('B'), 1.01, 'p3', e.state.config.deadline - 10);
  assert.equal(late.state.picks[1.01].playerId, 'p3');
  assert.equal(late.audit[0].late, true);
  // write-in id for an added pick
  const w = D.makeWriteIn(e.state, own('B'), 1.01, { name: 'Zed Nobody', url: 'https://www.baseball-reference.com/register/player.fcgi?id=nobody01', note: '' }, e.state.config.deadline - 10);
  assert.equal(w.state.picks[1.01].playerId, 'WI-1.01');
});

test('auto-draft and tick honor voids and added picks', () => {
  let s = D.voidPick(live(), admin, 1, '', T0 + 100).state; // 2 on the clock (B)
  const q = { email: 'b@example.com', teams: ['B'], autoDraft: true, items: ['p5', 'p6'] };
  let r = tick(s, { isAdmin: false, queues: [q] }, T0 + 200);
  assert.equal(r.kind, 'autopick'); assert.equal(r.state.picks[2].playerId, 'p5');
  // owner A has auto-draft on but their pick 1 is void: nothing for A at 1; A's pick 4 later
  const qa = { email: 'a@example.com', teams: ['A'], autoDraft: true, items: ['p7'] };
  assert.equal(tick(s, { isAdmin: false, queues: [qa] }, T0 + 200).changed, false);
  // an added pick for A on the clock is auto-drafted for A
  s = D.addPick(s, admin, 2, 'A', T0 + 300).state;
  s = D.makePick(s, own('B'), 2, 'p1', T0 + 400).state;
  assert.equal(s.config.currentPick, 2.01);
  r = tick(s, { isAdmin: false, queues: [qa] }, T0 + 500);
  assert.equal(r.kind, 'autopick'); assert.equal(r.state.picks[2.01].playerId, 'p7');
  // the skip of an expired pick never lands on a void
  let t = D.voidPick(live(), admin, 2, '', T0 + 1).state;
  const all = tickAll(t, { isAdmin: true, queues: [] }, T0 + 2 * H, 20);
  assert.equal(all.state.picks[2].status, 'void');
  assert.equal(all.state.picks[1].status, 'skipped');
  assert.equal(all.state.config.currentPick, 3);
});

test('complete: the draft closes once every non-void pick is made', () => {
  let s = live();
  s = D.voidPick(s, admin, 6, '', T0 + 1).state;
  for (let n = 1; n <= 5; n++) {
    const team = s.picks[n].ownerTeam;
    s = D.makePick(s, own(team), n, `p${n}`, T0 + 1000 * (n + 1)).state;
  }
  s.config.status = 'live';
  const r = tickAll(s, { isAdmin: true, queues: [] }, T0 + 10000);
  assert.equal(r.state.config.status, 'complete');
});

test('persist: adding a pick writes the new pick and the pointer change; plan is valid against the stored data', () => {
  const before = live();
  const r = D.addPick(before, admin, 2, 'C', T0 + 1000);
  const plan = planWrites(before, r.state, r.audit);
  assert.deepEqual(plan.picks.map((p) => p.key).sort(), ['2', '2.01']);
  assert.equal(plan.expect.picks['2.01'], null);
  const stored = JSON.parse(JSON.stringify(before.picks));
  assert.equal(planStillValid(plan, before.config, stored), true);
  stored['2.01'] = { status: 'open' };
  assert.equal(planStillValid(plan, before.config, stored), false);
  const v = D.voidPick(before, admin, 3, '', T0 + 1000);
  const vp = planWrites(before, v.state, v.audit);
  assert.equal(vp.picks.find((p) => p.key === '3').data.status, 'void');
});

test('exports show VOID and lettered labels', () => {
  let s = D.voidPick(live(), admin, 3, 'dup', T0 + 1000).state;
  s = D.addPick(s, admin, 2, 'C', T0 + 2000).state;
  s = D.makePick(s, own('A'), 1, 'p1', T0 + 3000).state;
  s = D.makePick(s, own('B'), 2, 'p2', T0 + 4000).state;
  s = D.makePick(s, own('C'), 2.01, 'p3', T0 + 5000).state;
  const list = Object.values(s.picks);
  const sch = exportSchedule(list, s.players).trim().split('\r\n');
  assert.ok(sch.some((l) => l.startsWith('1,2,1.2a,C,,C,Player 3') && l.endsWith(',2a')), sch.join('\n'));
  assert.ok(sch.some((l) => l.startsWith('1,3,1.3,C,,C,VOID,3')));
  const res = exportResults(list, s.players).trim().split('\r\n');
  assert.ok(res[0].endsWith('pick_label,added_pick,void_note'));
  assert.ok(res.some((l) => l.startsWith('2a,1,2,C,C,made,') && l.includes(',1.2a,yes,')));
  assert.ok(res.some((l) => l.startsWith('3,1,3,C,C,VOID,') && l.endsWith(',1.3,,dup')));
  // write-in on an added pick appears in the new-players export with its label
  const w = D.makeWriteIn(D.addPick(live(), admin, 1, 'A', T0 + 1).state, admin, 1.01, { name: 'Zed Nobody', url: 'https://www.baseball-reference.com/register/player.fcgi?id=nobody01', note: '' }, T0 + 2);
  assert.ok(exportNewPlayers(Object.values(w.state.picks)).includes(',1,1,1a,'));
});

function restartInput(s) {
  return { config: s.config, picks: s.picks, emailCfg: null, takenDocs: [], auditDocs: [], noticeIds: [], pwRequestIds: [], pwStatusIds: [], by: 'c@x.com', now: T0 };
}
function withImported(s) {
  return { ...s, picks: Object.fromEntries(Object.entries(s.picks).map(([k, p]) => [k, { ...p, importedOwner: p.origTeam }])) };
}

test('Restart deletes added picks, clears voids and restores the imported order; trades revert too', () => {
  let s = live();
  s = D.voidPick(s, admin, 3, 'x', T0 + 1).state;
  s = D.addPick(s, admin, 2, 'C', T0 + 2).state;
  s = D.tradePick(s, admin, 4, 'C', '', T0 + 3).state;
  s = D.tradePick(s, admin, 2.01, 'A', '', T0 + 4).state;
  const plan = planRestart(restartInput(withImported(s)));
  const del = plan.body.filter((o) => o.op === 'delete' && o.path.startsWith('picks/')).map((o) => o.path);
  assert.deepEqual(del, ['picks/2.01']);
  const sets = Object.fromEntries(plan.body.filter((o) => o.op === 'set' && o.path.startsWith('picks/')).map((o) => [o.path, o.data]));
  assert.equal(Object.keys(sets).length, 6);
  assert.equal(sets['picks/3'].status, 'open');
  assert.equal(sets['picks/3'].voidedAt, undefined);
  assert.equal(sets['picks/2'].next, undefined);
  assert.equal(sets['picks/4'].ownerTeam, 'A');
  const audit = plan.footer.find((o) => o.path.startsWith('audit/restart-')).data;
  assert.equal(audit.addedRemoved, 1); assert.equal(audit.voidsCleared, 1); assert.equal(audit.tradesReverted, 1);
});

test('group email: void is listed once like a skip, does not count toward the 5; added pick uses its letter label', () => {
  const mk = (n, extra = {}) => ({ overall: n, round: 1, slot: n, origTeam: 'T', ownerTeam: 'T', status: 'made', playerId: 'p' + n, madeAt: 1000 * n, wasSkipped: false, ...extra });
  const picks = [mk(1), mk(2), mk(3), mk(4), { ...mk(4.01), added: true, base: 4, addSeq: 1, slot: 4 }];
  const voidP = { overall: 9, round: 1, slot: 9, origTeam: 'PAN', ownerTeam: 'PAN', status: 'void' };
  // a void is not a made pick: 4 made picks are not a batch yet
  assert.equal(nextBatch([...picks.slice(0, 4), voidP], [], false), null);
  const b = nextBatch(picks, [], false);
  assert.equal(b.overalls.length, 5);
  const names = Object.fromEntries(picks.map((p) => [p.playerId, 'N' + p.overall]));
  const msg = composeEmail({ batchPicks: picks, voided: [{ ...voidP, slot: 3, round: 5 }], upcoming: [], config: { status: 'live' }, names });
  assert.match(msg.text, /Pick 5\.3 \(PAN\): pick voided/);
  assert.match(msg.text, /1\.4a {2}T {2}N4\.01/);
  assert.equal(pickNo(picks[4]), '1.4a');
  assert.doesNotMatch(composeEmail({ batchPicks: picks, upcoming: [], config: { status: 'live' }, names }).text, /voided/);
});

test('group email runner reports a void once (voidReported) and never counts it', async () => {
  const { runGroupMail } = await import('../public/js/lib/groupmail.js');
  const mk = (n) => ({ overall: n, round: 1, slot: n, origTeam: 'T', ownerTeam: 'T', status: 'made', playerId: 'p' + n, madeAt: T0 + 1000 * n });
  const picks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(mk);
  const voidP = { overall: 20, round: 5, slot: 3, origTeam: 'PAN', ownerTeam: 'PAN', status: 'void' };
  let mail = { enabledAt: 1, sent: [], cursor: 0, batchNo: 0, skipReported: [], pending: null };
  const sent = [];
  const io = {
    getSwitch: async () => ({ groupEmails: true, enabledAt: 1 }), getMail: async () => structuredClone(mail), getConfig: async () => ({ status: 'live', currentPick: 11 }),
    getPicksSince: async () => structuredClone(picks),
    getSendContext: async (ov) => ({ config: { status: 'live' }, picks: ov.map((n) => picks.find((p) => p.overall === n)), upcoming: [], skipped: [], voided: [voidP], names: {} }),
    transact: async (fn) => { const o = fn(structuredClone(mail)); if (o.write) mail = structuredClone(o.write); return o.result; },
  };
  await runGroupMail(io, { sendMail: async (m) => sent.push(m) }, { from: 'a', to: 'b', now: () => T0 });
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /Pick 5\.3 \(PAN\): pick voided/);
  assert.doesNotMatch(sent[1].text, /voided/);
  assert.deepEqual(mail.voidReported, [20]);
});

test('rules: void/add are commissioner-only by shape and work while locked; owners cannot create or void', () => {
  const r = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const picks = r.slice(r.indexOf('match /picks/{n}'), r.indexOf('match /taken/{pid}'));
  assert.match(picks, /allow create: if isAdmin\(\) && \(!locked\(\) \|\| addedPickShape\(\)\)/);
  assert.match(picks, /allow delete: if isAdmin\(\) && !locked\(\)/);
  assert.match(picks, /function addedPickShape/);
  assert.match(picks, /n\.added == true && n\.status == 'open'/);
  assert.match(picks, /allow update: if isAdmin\(\) \|\| ownerMakesPick\(\) \|\| clockSkipsPick\(\)/);
  // the only owner update is status -> made; the clock-skip update is status -> skipped. Neither can write 'void'.
  assert.match(picks, /n\.status == 'made'/);
  assert.match(picks, /n\.status == 'skipped'/);
  assert.doesNotMatch(picks, /void'/);
  // voided/added picks and the clock walk
  assert.match(r, /function nx\(k\)/);
  assert.match(r, /get\('next', k \+ 1\)/);
  assert.match(r, /!openAfter\(a\)/);
  let depth = 0; for (const ch of r) { if (ch === '{') depth++; if (ch === '}') depth--; assert.ok(depth >= 0); }
  assert.equal(depth, 0);
});
