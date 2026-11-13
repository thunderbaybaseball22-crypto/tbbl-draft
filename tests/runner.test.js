import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../public/js/lib/draft.js';
import { runTicker, needsFullRun, ConflictError, listSig } from '../public/js/lib/runner.js';
import { planStillValid } from '../public/js/lib/persist.js';
import { etToUtc } from '../public/js/lib/clock.js';

const H = 3600000;
const T0 = etToUtc(2027, 6, 7, 11);
const admin = { email: 'comm@example.com', isAdmin: true, teams: [] };
const mk = (t) => ({ email: `${t.toLowerCase()}@example.com`, teams: [t] });

function fresh({ live = true } = {}) {
  const order = ['A', 'B', 'C', 'A', 'B', 'C'];
  const picks = order.map((t, i) => ({ overall: i + 1, round: Math.floor(i / 3) + 1, slot: (i % 3) + 1, origTeam: t, ownerTeam: t }));
  const players = Array.from({ length: 10 }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}`, ownerTeam: '' }));
  const s = D.createState({ picks, players, clockMinutes: 60 });
  return live ? D.startDraft(s, admin, T0).state : s;
}

/** In-memory database + io that behaves like the Firestore transaction in tools/ticker.mjs. */
function memDb(state, queues = []) {
  const db = {
    config: structuredClone(state.config), picks: structuredClone(state.picks),
    basePlayers: Object.values(state.players).map(({ drafted, ...p }) => p),
    queues: structuredClone(queues), taken: new Set(), audit: [], ticks: null, notices: {}, fullLoads: 0, commits: 0, hook: null,
  };
  db.io = {
    async loadLight() {
      const pick = db.config.currentPick != null ? structuredClone(db.picks[db.config.currentPick]) : null;
      const qs = structuredClone(db.queues.filter((q) => !pick || q.teams.includes(pick.ownerTeam)));
      return { config: structuredClone(db.config), tickAt: db.ticks, pick, unfilled: Object.values(db.picks).filter((p) => p.status !== 'made').length, queues: qs, notices: structuredClone(db.notices) };
    },
    async loadFull() {
      db.fullLoads++;
      return { config: structuredClone(db.config), picks: structuredClone(db.picks), basePlayers: structuredClone(db.basePlayers), queues: structuredClone(db.queues), verifiedKeys: [] };
    },
    async commit(plan) {
      if (db.hook) { const h = db.hook; db.hook = null; await h(); }
      if (!planStillValid(plan, db.config, db.picks)) throw new ConflictError();
      for (const t of plan.takenSet) if (db.taken.has(t.id)) throw new ConflictError('taken');
      db.commits++;
      for (const id of plan.takenDelete) db.taken.delete(id);
      for (const t of plan.takenSet) db.taken.add(t.id);
      for (const p of plan.picks) db.picks[p.key] = structuredClone(p.data);
      if (plan.config) db.config = structuredClone(plan.config);
      db.audit.push(...plan.audit);
    },
    async heartbeat(at) { db.ticks = at; },
    async putNotice(email, n) { const o = db.notices[email]; if (!o || o.overall !== n.overall || o.sig !== n.sig) db.notices[email] = n; },
  };
  return db;
}
const q = (team, items, autoDraft = true) => ({ ...mk(team), autoDraft, items });
const clock = (t) => () => t.v;

test('ticker starts a pending draft only once the start time arrives', async () => {
  const s = fresh({ live: false }); s.config.startAt = T0;
  const db = memDb(s);
  const t = { v: T0 - 1000 };
  assert.equal((await runTicker(db.io, clock(t))).ran, false);
  assert.equal(db.config.status, 'pending');
  t.v = T0 + 1000;
  const r = await runTicker(db.io, clock(t));
  assert.deepEqual(r.steps, ['start']);
  assert.equal(db.config.status, 'live');
  assert.equal(db.config.currentPick, 1);
  assert.deepEqual((await runTicker(db.io, clock(t))).steps, []);
});

test('auto-draft with nobody online: first still-available list entry, owner offline', async () => {
  const db = memDb(fresh(), [q('A', ['p1', 'p2', 'p3'])]);
  db.taken.add('p1'); db.picks[1].status = 'open';
  // p1 was taken by someone else (a keeper marker on the player)
  db.basePlayers.find((p) => p.id === 'p1').ownerTeam = 'Z';
  const r = await runTicker(db.io, clock({ v: T0 + 60000 }));
  assert.deepEqual(r.steps, ['autopick']);
  assert.equal(db.picks[1].status, 'made');
  assert.equal(db.picks[1].playerId, 'p2');
  assert.equal(db.config.currentPick, 2);
  assert.ok(db.taken.has('p2'));
  assert.equal(db.audit.find((a) => a.type === 'pick').auto, true);
});

test('auto-draft Off, wrong team, or paused draft: ticker does nothing', async () => {
  let db = memDb(fresh(), [q('A', ['p1'], false)]);
  assert.equal((await runTicker(db.io, clock({ v: T0 + 1000 }))).ran, false);
  assert.equal(db.picks[1].status, 'open');
  db = memDb(fresh(), [q('B', ['p1'])]); // B's list, A's pick
  assert.equal((await runTicker(db.io, clock({ v: T0 + 1000 }))).ran, false);
  const paused = D.pause(fresh(), admin, T0 + 1000).state;
  db = memDb(paused, [q('A', ['p1'])]);
  assert.equal((await runTicker(db.io, clock({ v: T0 + 2000 }))).ran, false);
  assert.equal(db.picks[1].status, 'open');
});

test('exhausted list: no pick, clock keeps running, notice written once; then normal skip; late pick works', async () => {
  const db = memDb(fresh(), [q('A', ['p1'])]);
  db.basePlayers.find((p) => p.id === 'p1').ownerTeam = 'Z'; // only list entry is gone
  const t = { v: T0 + 60000 };
  let r = await runTicker(db.io, clock(t));
  assert.deepEqual(r.steps, []);
  assert.equal(db.picks[1].status, 'open');
  assert.equal(db.config.deadline, fresh().config.deadline, 'clock untouched');
  assert.equal(r.notices.length, 1);
  assert.equal(db.notices['a@example.com'].overall, 1);
  // next run: known exhausted for this pick and list -> cheap path, no full load
  const loads = db.fullLoads;
  t.v += 60000;
  r = await runTicker(db.io, clock(t));
  assert.equal(r.ran, false);
  assert.equal(db.fullLoads, loads);
  // deadline passes: normal skip, next pick on the clock
  t.v = T0 + H + 1000;
  r = await runTicker(db.io, clock(t));
  assert.deepEqual(r.steps, ['skip']);
  assert.equal(db.picks[1].status, 'skipped');
  assert.equal(db.config.currentPick, 2);
  // the skipped owner can still pick late (state machine, same data)
  const st = { config: db.config, picks: db.picks, players: Object.fromEntries(db.basePlayers.map((p) => [p.id, { ...p, drafted: null }])) };
  const late = D.makePick(st, { ...mk('A'), isAdmin: false }, 1, 'p5', t.v);
  assert.equal(late.state.picks[1].status, 'made');
});

test('repeated runs are idempotent: one skip, one audit entry', async () => {
  const db = memDb(fresh());
  const t = { v: T0 + H + 5000 };
  const a = await runTicker(db.io, clock(t));
  const b = await runTicker(db.io, clock(t));
  assert.deepEqual(a.steps, ['skip']);
  assert.deepEqual(b.steps, []);
  assert.equal(db.audit.filter((e) => e.type === 'skip').length, 1);
  assert.equal(db.config.currentPick, 2);
});

test('two tickers at the same moment: the loser conflicts, reloads and does nothing (no double skip)', async () => {
  const db = memDb(fresh());
  const t = { v: T0 + H + 5000 };
  db.hook = async () => { await runTicker(db.io, clock(t)); }; // rival commits first, inside our commit
  const r = await runTicker(db.io, clock(t));
  assert.equal(r.conflicts, 1);
  assert.deepEqual(r.steps, []);
  assert.equal(db.audit.filter((e) => e.type === 'skip').length, 1);
  assert.equal(db.picks[1].status, 'skipped');
  assert.equal(db.picks[2].status, 'open');
  assert.equal(db.config.currentPick, 2);
});

test('rival auto-pick of the same pick: ticker does not double-draft', async () => {
  const db = memDb(fresh(), [q('A', ['p1', 'p2'])]);
  const t = { v: T0 + 1000 };
  db.hook = async () => { // the owner's own browser makes a different pick for A first
    const st = { config: db.config, picks: db.picks, players: Object.fromEntries(db.basePlayers.map((p) => [p.id, { ...p, drafted: null }])) };
    const res = D.makePick(st, { ...mk('A'), isAdmin: false }, 1, 'p9', t.v);
    await db.io.commit(await import('../public/js/lib/persist.js').then((m) => m.planWrites(st, res.state, res.audit)));
  };
  const r = await runTicker(db.io, clock(t));
  assert.equal(r.conflicts, 1);
  assert.equal(db.picks[1].playerId, 'p9');
  assert.equal(db.picks[2].status, 'open');
  assert.equal([...db.taken].filter((x) => x === 'p9').length, 1);
});

test('a taken marker written by someone else blocks the same player (no double-draft), nothing is written', async () => {
  const db = memDb(fresh(), [q('A', ['p1'])]);
  db.hook = async () => { db.taken.add('p1'); };
  await runTicker(db.io, clock({ v: T0 + 1000 }));
  assert.equal(db.picks[1].status, 'open');
  assert.equal(db.commits, 0);
});

test('write-in entry auto-picks as pending; duplicate write-in is skipped for the next entry', async () => {
  const ok = { writeIn: { name: 'Zed Nobody', url: 'https://www.baseball-reference.com/register/player.fcgi?id=nobody01', note: '' } };
  let db = memDb(fresh(), [q('A', [ok, 'p4'])]);
  await runTicker(db.io, clock({ v: T0 + 1000 }));
  assert.equal(db.picks[1].status, 'made');
  assert.equal(db.picks[1].playerId, 'WI-1');
  assert.equal(db.picks[1].writeIn.status, 'pending');
  const dup = { writeIn: { name: 'Player 3', url: 'https://example.com/x', note: '' } }; // same name as a pool player
  db = memDb(fresh(), [q('A', [dup, 'p4'])]);
  await runTicker(db.io, clock({ v: T0 + 1000 }));
  assert.equal(db.picks[1].playerId, 'p4');
});

test('a long outage produces one skip per run, never a cascade: the next clock starts at the catch-up moment', async () => {
  const db = memDb(fresh());
  const t = { v: T0 + 40 * H };
  const r = await runTicker(db.io, clock(t));
  assert.deepEqual(r.steps, ['skip']);
  assert.equal(db.config.currentPick, 2);
  assert.ok(db.config.deadline > t.v);
  assert.deepEqual((await runTicker(db.io, clock(t))).steps, []);
  assert.equal(db.audit.filter((e) => e.type === 'skip').length, 1);
});
test('draft closes when every pick is made and nothing is on the clock', async () => {
  let s = fresh(); let now = T0;
  for (let i = 1; i <= 6; i++) { s = D.makePick(s, admin, i, `p${i}`, now += 1000).state; }
  s.config.status = 'live'; // an owner's last pick leaves the draft live (rules do not let owners close it)
  const db = memDb(s);
  const r = await runTicker(db.io, clock({ v: now + 5000 }));
  assert.deepEqual(r.steps, ['complete']);
  assert.equal(db.config.status, 'complete');
});

test('needsFullRun is cheap-path only when nothing is due; listSig changes with the list', () => {
  const live = { config: { status: 'live', currentPick: 1, deadline: T0 + H }, pick: { overall: 1, status: 'open', ownerTeam: 'A' }, queues: [], unfilled: 6 };
  assert.equal(needsFullRun(live, T0 + 1000), false);
  assert.equal(needsFullRun(live, T0 + H), true);
  assert.notEqual(listSig(['p1']), listSig(['p1', 'p2']));
});
