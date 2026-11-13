import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planRestart, runPlan, importedOwners, lockedReason, confirmOk, CHUNK } from '../public/js/lib/restart.js';
import { runGroupMail } from '../public/js/lib/groupmail.js';
import { needsFullRun } from '../public/js/lib/runner.js';

const T0 = 1_800_000_000_000;
const N = 312, TEAMS = 24;
const team = (i) => 'T' + String(i % TEAMS).padStart(2, '0');

/** A mid-draft database: 312 picks (some made, one write-in, skips, trades), taken markers, audit, notices, requests, owner lists. */
function world() {
  const db = {};
  const put = (path, data) => { db[path] = JSON.parse(JSON.stringify(data)); };
  put('config/draft', { status: 'live', startAt: T0, clockMinutes: 45, currentPick: 201, deadline: T0 + 99, remainingMs: null, allowPickWhenClockPaused: false });
  put('config/email', { groupEmails: true, enabledAt: T0 + 5, by: 'comm@x.com', at: T0 + 5 });
  put('groupMail/state', { enabledAt: T0 + 5, sent: [1, 2, 3, 4, 5], cursor: T0 + 9, batchNo: 1, pending: null });
  put('config/lock', { locked: false });
  for (let n = 1; n <= N; n++) {
    const orig = team(n - 1);
    const p = { overall: n, round: Math.ceil(n / TEAMS), slot: ((n - 1) % TEAMS) + 1, origTeam: orig, ownerTeam: orig, importedOwner: orig, status: 'open', playerId: null, wasSkipped: false, skippedAt: null, madeBy: null, madeAt: null, writeIn: null };
    if (n <= 150) Object.assign(p, { status: 'made', playerId: 'p' + n, madeBy: 'o@x.com', madeAt: T0 + n });
    if (n === 7) Object.assign(p, { status: 'skipped', playerId: null, madeBy: null, madeAt: null, wasSkipped: true, skippedAt: T0 });
    if (n === 8) Object.assign(p, { playerId: 'WI-8', writeIn: { name: 'Some Guy', url: 'http://x', note: '', status: 'pending' } });
    if (n === 20) p.ownerTeam = 'TRADED'; // traded on the site
    if (n === 250) { p.ownerTeam = 'T05'; p.importedOwner = 'T05'; } // already traded in the imported file: must stay
    put(`picks/${n}`, p);
    if (p.playerId) put(`taken/${p.playerId}`, { overall: n, team: p.ownerTeam });
  }
  put('taken/keeper1', { overall: 0, team: 'T01' });
  put('taken/keeper2', { overall: 0, team: 'T02' });
  put('pool/p1', {}); put('playerchunks/c000', { i: 0, players: [{ id: 'p1' }] });
  put('owners/a@x.com', { email: 'a@x.com', teams: ['T00'] }); put('logins/a@x.com', { at: 1 });
  put('queues/a@x.com', { items: ['p9', 'p10'], autoDraft: true });
  put('queues/b@x.com', { items: [], autoDraft: false });
  for (let k = 0; k < 700; k++) put(`audit/a${k}`, { type: k % 2 ? 'pick' : 'skip', by: 'x', at: T0 + k });
  put('audit/tr1', { type: 'trade', by: 'comm@x.com', at: T0 + 1, overall: 20, from: 'T19', to: 'TRADED', orig: 'T19', note: '' });
  put('notices/a@x.com', { overall: 3, sig: 'p9', type: 'exhausted' });
  put('pwRequests/a@x.com', { password: 'secret-pass-1', requestedAt: T0 });
  put('pwStatus/a@x.com', { state: 'pending', requestedAt: T0, at: T0 });
  return db;
}
const under = (db, prefix) => Object.keys(db).filter((k) => k.startsWith(prefix + '/'));

/** Read what store.restartDraft reads, then plan. */
function planFor(db, over = {}) {
  const picks = {}; under(db, 'picks').forEach((k) => { picks[k.split('/')[1]] = db[k]; });
  return planRestart({
    config: db['config/draft'], picks, emailCfg: db['config/email'],
    takenDocs: under(db, 'taken').map((k) => ({ id: k.split('/')[1], overall: db[k].overall })),
    auditDocs: under(db, 'audit').map((k) => ({ id: k.split('/')[1], ...db[k] })),
    noticeIds: under(db, 'notices').map((k) => k.split('/')[1]),
    pwRequestIds: under(db, 'pwRequests').map((k) => k.split('/')[1]),
    pwStatusIds: under(db, 'pwStatus').map((k) => k.split('/')[1]),
    by: 'comm@x.com', now: T0 + 10_000, ...over,
  });
}
/** Commit one batch to the fake db like Firestore: at most 500 writes; `failAt` makes the Nth batch fail first. */
function committer(db, { failAt = -1 } = {}) {
  const st = { batches: 0, sizes: [] };
  const fn = async (ops) => {
    st.batches++;
    assert.ok(ops.length <= 500, `batch of ${ops.length} exceeds 500`);
    if (st.batches - 1 === failAt) throw new Error('network dropped');
    st.sizes.push(ops.length);
    for (const o of ops) { if (o.op === 'set') db[o.path] = JSON.parse(JSON.stringify(o.data)); else delete db[o.path]; }
  };
  fn.st = st;
  return fn;
}

test('restart result: picks, skips, write-ins, taken markers, status, trades', async () => {
  const db = world();
  await runPlan(planFor(db), committer(db));
  for (let n = 1; n <= N; n++) {
    const p = db[`picks/${n}`];
    assert.equal(p.status, 'open'); assert.equal(p.playerId, null); assert.equal(p.writeIn, null);
    assert.equal(p.wasSkipped, false); assert.equal(p.skippedAt, null); assert.equal(p.madeBy, null); assert.equal(p.madeAt, null);
  }
  assert.equal(db['picks/20'].ownerTeam, 'T19', 'site trade reverted');
  assert.equal(db['picks/250'].ownerTeam, 'T05', 'trade that was in the imported file stays');
  assert.equal(db['picks/20'].origTeam, 'T19');
  assert.deepEqual(under(db, 'taken').sort(), ['taken/keeper1', 'taken/keeper2'], 'only keeper markers remain');
  assert.equal(db['taken/p1'], undefined); assert.equal(db['taken/WI-8'], undefined);
  assert.deepEqual(db['config/draft'], { status: 'pending', startAt: T0, clockMinutes: 45, currentPick: null, deadline: null, remainingMs: null, allowPickWhenClockPaused: false });
  assert.equal(db['config/restart'], undefined, 'marker removed when finished');
});

test('trade revert works on old data without importedOwner, using the earliest trade in the audit log', () => {
  const picks = { 1: { overall: 1, ownerTeam: 'B', origTeam: 'A' }, 2: { overall: 2, ownerTeam: 'C', origTeam: 'A' }, 3: { overall: 3, ownerTeam: 'A', origTeam: 'A' } };
  const audit = [{ type: 'trade', overall: 1, from: 'B', to: 'C', at: 5 }, { type: 'trade', overall: 1, from: 'A', to: 'B', at: 1 }, { type: 'trade', overall: 2, from: 'A', to: 'C', at: 2 }];
  assert.deepEqual(importedOwners(picks, audit), { 1: 'A', 2: 'A', 3: 'A' });
});

test('email off and batch reset, audit cleared plus one restart entry, requests and notices cleared, lists kept', async () => {
  const db = world();
  await runPlan(planFor(db), committer(db));
  assert.equal(db['config/email'].groupEmails, false);
  assert.equal(db['groupMail/state'], undefined);
  const audit = under(db, 'audit');
  assert.equal(audit.length, 1);
  assert.deepEqual(db[audit[0]], { type: 'restart', by: 'comm@x.com', at: T0 + 10_000, picksCleared: 150, tradesReverted: 1 });
  assert.equal(under(db, 'notices').length, 0); assert.equal(under(db, 'pwRequests').length, 0); assert.equal(under(db, 'pwStatus').length, 0);
  assert.deepEqual(db['queues/a@x.com'], { items: ['p9', 'p10'], autoDraft: true });
  assert.deepEqual(db['queues/b@x.com'], { items: [], autoDraft: false });
  for (const k of ['owners/a@x.com', 'logins/a@x.com', 'pool/p1', 'playerchunks/c000', 'config/lock']) assert.ok(db[k], `${k} kept`);
});

test('works within Firestore limits: batches of at most 400 writes', async () => {
  const db = world();
  const plan = planFor(db);
  const c = committer(db);
  await runPlan(plan, c);
  assert.ok(c.st.sizes.every((s) => s <= CHUNK), JSON.stringify(c.st.sizes));
  assert.ok(c.st.batches > 3, 'more than one body chunk was needed');
  assert.equal(plan.batches[0], plan.header); assert.equal(plan.batches.at(-1), plan.footer);
});

test('interrupted restart leaves a safe held state and can simply be run again', async () => {
  for (let failAt = 1; failAt <= 4; failAt++) {
    const db = world();
    await assert.rejects(runPlan(planFor(db), committer(db, { failAt })), /network dropped/);
    assert.ok(db['config/restart'], 'marker stays so the UI and ticker know');
    assert.equal(db['config/draft'].status, 'pending', 'draft is held not-started');
    assert.equal(db['config/email'].groupEmails, false, 'no email while half-done');
    // the ticker and the browsers leave the clock alone (tools/ticker.mjs returns no config while the marker exists)
    assert.equal(needsFullRun({ config: null }, T0 + 1e9), false);
    // run again from what is now stored
    await runPlan(planFor(db, { now: T0 + 20_000 }), committer(db));
    assert.equal(db['config/restart'], undefined);
    assert.equal(under(db, 'audit').length, 1);
    assert.equal(db[under(db, 'audit')[0]].at, T0 + 20_000);
    assert.equal(db['picks/20'].ownerTeam, 'T19');
    assert.equal(db['picks/250'].ownerTeam, 'T05');
    assert.ok(Object.keys(db).filter((k) => k.startsWith('picks/')).every((k) => db[k].status === 'open'));
    assert.deepEqual(under(db, 'taken').sort(), ['taken/keeper1', 'taken/keeper2']);
    assert.deepEqual(db['queues/a@x.com'], { items: ['p9', 'p10'], autoDraft: true });
  }
});

test('running restart twice gives the same result (idempotent)', async () => {
  const db = world();
  await runPlan(planFor(db), committer(db));
  const once = JSON.stringify(db);
  await runPlan(planFor(db), committer(db));
  const twice = JSON.parse(JSON.stringify(db));
  delete twice[under(twice, 'audit')[0]];
  const first = JSON.parse(once); delete first[under(first, 'audit')[0]];
  assert.deepEqual(twice, first);
});

test('the lock blocks restart, typed word is required', () => {
  assert.equal(lockedReason(null), null);
  assert.equal(lockedReason({ locked: false }), null);
  assert.match(lockedReason({ locked: true }), /lock is ON/);
  assert.equal(confirmOk('RESTART'), true); assert.equal(confirmOk('  RESTART '), true);
  for (const bad of ['restart', 'Restart', 'RESTAR', '', null, undefined, 'RESTART now']) assert.equal(confirmOk(bad), false);
});

test('firestore.rules enforce the lock server-side and keep Pause/Resume open', () => {
  const r = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const block = (head) => { const i = r.indexOf(head); assert.ok(i >= 0, head); return r.slice(i, i + 900); };
  assert.match(r, /function locked\(\) \{ return exists\(lockDoc\(\)\) && get\(lockDoc\(\)\)\.data\.locked == true; \}/);
  assert.match(block('match /config/lock'), /allow read: if isAdmin\(\)[\s\S]*hasOnly\(\['locked', 'by', 'at'\]\)/);
  // moving the draft back to not-started is refused while locked (Pause/Resume/Start change to other statuses)
  assert.match(r, /isAdmin\(\) && !\(locked\(\) && request\.resource\.data\.status == 'pending' && resource\.data\.status != 'pending'\)/);
  assert.match(block('match /picks/{n}'), /allow delete: if isAdmin\(\) && !locked\(\)/);
  assert.match(block('match /picks/{n}'), /allow create: if isAdmin\(\) && \(!locked\(\) \|\| addedPickShape\(\)\)/);
  assert.match(block('match /playerchunks'), /allow write: if isAdmin\(\) && !locked\(\)/);
  assert.match(block('match /pool/'), /allow write: if isAdmin\(\) && !locked\(\)/);
  assert.match(block('match /groupMail/'), /allow delete: if isAdmin\(\) && !locked\(\)/);
  assert.match(block('match /notices/'), /allow delete: if isAdmin\(\) && !locked\(\)/);
  assert.match(block('match /audit/'), /allow delete: if isAdmin\(\) && !locked\(\) && cfg\(\)\.status == 'pending'/);
  assert.match(block('match /audit/'), /allow update: if false/);
  assert.match(block('match /config/draft'), /allow create, delete: if isAdmin\(\) && !locked\(\)/);
  assert.doesNotMatch(r, /locked\(\)[^\n]*'paused'/, 'pause is not tied to the lock');
  // an auto-start cannot happen while a restart is running
  assert.match(r, /!exists\(restartDoc\(\)\)/);
  // balanced braces and parentheses (cheap compile sanity check)
  const strip = r.replace(/\/\/[^\n]*/g, '');
  for (const [a, b] of [['{', '}'], ['(', ')'], ['[', ']']]) assert.equal(strip.split(a).length, strip.split(b).length, a + b);
});

test('re-run after interruption keeps the original picksCleared count', async () => {
  const db = world();
  const first = planFor(db);
  const cleared = first.footer[0].data.picksCleared;
  assert.ok(cleared > 0);
  assert.equal(first.header[0].data.picksCleared, cleared);
  await assert.rejects(runPlan(first, committer(db, { failAt: 2 })));
  const again = planFor(db, { prevPicksCleared: db['config/restart'].picksCleared });
  await runPlan(again, committer(db));
  const audit = under(db, 'audit');
  assert.equal(db[audit[0]].picksCleared, cleared);
});

test('a restart never sends email: switch is OFF afterwards and the mailer does nothing', async () => {
  const db = world();
  await runPlan(planFor(db), committer(db));
  const sent = [];
  const io = {
    getSwitch: async () => db['config/email'], getMail: async () => db['groupMail/state'] || null, getConfig: async () => db['config/draft'],
    getPicksSince: async () => { throw new Error('should not read picks while OFF'); },
    getSendContext: async () => { throw new Error('should not build an email'); },
    transact: async () => { throw new Error('should not write while OFF'); },
  };
  const r = await runGroupMail(io, { sendMail: async (m) => sent.push(m) }, { from: 'a', to: 'b' });
  assert.equal(r.status, 'off'); assert.equal(sent.length, 0);
  // no op of the plan turns the switch on or writes mail state
  const plan = planFor(world());
  const mailOps = plan.batches.flat().filter((o) => /^(config\/email|groupMail)/.test(o.path));
  assert.ok(mailOps.every((o) => (o.path === 'config/email' ? o.op === 'set' && o.data.groupEmails === false : o.op === 'delete')));
});
