import test from 'node:test';
import assert from 'node:assert/strict';
import { runGroupMail, nextBatch, composeEmail } from '../public/js/lib/groupmail.js';

const T0 = 1_800_000_000_000;
// 24-slot-like fixture: 20 picks, slot = overall within round of 10.
function world({ on = true, made = 0 } = {}) {
  const w = {
    now: T0 + 1000, sw: on ? { groupEmails: true, enabledAt: T0 } : null, mail: null, version: 0,
    config: { status: 'live', currentPick: made + 1, deadline: T0 + 3600000, clockMinutes: 60 },
    picks: {}, sentMail: [], failNext: 0,
  };
  for (let n = 1; n <= 20; n++) {
    w.picks[n] = { overall: n, round: Math.ceil(n / 10), slot: ((n - 1) % 10) + 1, origTeam: 'T' + ((n - 1) % 10), ownerTeam: 'T' + ((n - 1) % 10), status: 'open', playerId: null, wasSkipped: false, madeAt: null, writeIn: null };
  }
  for (let n = 1; n <= made; n++) make(w, n);
  return w;
}
function make(w, n, extra = {}) { Object.assign(w.picks[n], { status: 'made', playerId: 'p' + n, madeAt: w.now += 1000 }, extra); }
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
function io(w) {
  return {
    getSwitch: async () => clone(w.sw), getMail: async () => clone(w.mail), getConfig: async () => clone(w.config),
    getPicksSince: async (ms) => Object.values(w.picks).filter((p) => p.status === 'made' && p.madeAt > ms).map(clone),
    getSendContext: async (ov) => {
      const names = {}; Object.values(w.picks).forEach((p) => { if (p.playerId) names[p.playerId] = 'Player ' + p.playerId; });
      return {
        config: clone(w.config), picks: ov.map((n) => clone(w.picks[n])), names,
        upcoming: Object.values(w.picks).filter((p) => p.overall >= (w.config.currentPick ?? 99)).map(clone),
        skipped: Object.values(w.picks).filter((p) => p.status === 'skipped').map(clone),
      };
    },
    // optimistic transaction with a yield between read and write, so concurrent runs really interleave
    async transact(fn) {
      for (;;) {
        const v = w.version, out = fn(clone(w.mail));
        await new Promise((r) => setImmediate(r));
        if (v !== w.version) continue;
        if (out.write) { w.mail = clone(out.write); w.version++; }
        return out.result;
      }
    },
  };
}
const transport = (w) => ({ sendMail: async (m) => { if (w.failNext > 0) { w.failNext--; throw new Error('smtp down'); } w.sentMail.push(m); } });
const run = (w) => runGroupMail(io(w), transport(w), { from: 'a@x.com', to: 'TBBL@groups.io', siteUrl: 'https://site.example', now: () => w.now });

test('nothing is sent while the switch is OFF', async () => {
  const w = world({ on: false, made: 12 });
  const r = await run(w);
  assert.equal(r.status, 'off'); assert.equal(w.sentMail.length, 0); assert.equal(w.mail, null);
});

test('turning ON starts counting from the current pick: earlier picks are never emailed', async () => {
  const w = world({ made: 7 });
  w.sw.enabledAt = w.now + 500; // switched ON after 7 picks were made
  assert.equal((await run(w)).status, 'baseline');
  assert.equal(w.sentMail.length, 0);
  for (let n = 8; n <= 11; n++) make(w, n);
  await run(w); assert.equal(w.sentMail.length, 0); // 4 new picks: not yet
  make(w, 12); w.config.currentPick = 13;
  await run(w);
  assert.equal(w.sentMail.length, 1);
  assert.match(w.sentMail[0].text, /1\.8 /); assert.doesNotMatch(w.sentMail[0].text, /1\.7 /);
});

test('an email goes out for every 5 made picks, with the next 5 teams and the deadline', async () => {
  const w = world(); await run(w);
  for (let n = 1; n <= 5; n++) make(w, n);
  w.config.currentPick = 6;
  await run(w);
  assert.equal(w.sentMail.length, 1);
  const m = w.sentMail[0];
  assert.equal(m.to, 'TBBL@groups.io'); assert.equal(m.from, 'a@x.com');
  for (let n = 1; n <= 5; n++) assert.match(m.text, new RegExp(`1\\.${n}  T${n - 1}  Player p${n}`));
  assert.match(m.text, /1\. T5 \(pick 1\.6\) - on the clock, deadline .* ET/);
  assert.match(m.text, /5\. T9 \(pick 1\.10\)/);
  assert.match(m.text, /https:\/\/site\.example/);
  make(w, 6); make(w, 7); w.config.currentPick = 8; // 2 more: no second email
  await run(w); assert.equal(w.sentMail.length, 1);
});

test('10 picks at once make two separate emails of 5', async () => {
  const w = world(); await run(w);
  for (let n = 1; n <= 10; n++) make(w, n);
  w.config.currentPick = 11;
  await run(w);
  assert.equal(w.sentMail.length, 2);
});

test('final partial batch goes out when the draft completes', async () => {
  const w = world(); await run(w);
  for (let n = 1; n <= 7; n++) make(w, n);
  await run(w); assert.equal(w.sentMail.length, 1);
  w.config = { status: 'complete', currentPick: null, deadline: null };
  await run(w);
  assert.equal(w.sentMail.length, 2);
  assert.match(w.sentMail[1].subject, /FINAL/); assert.match(w.sentMail[1].text, /1\.6 /); assert.match(w.sentMail[1].text, /1\.7 /);
  await run(w); assert.equal(w.sentMail.length, 2);
});

test('skipped picks are listed but not counted; late picks count and are marked', async () => {
  const w = world(); await run(w);
  w.picks[3].status = 'skipped'; w.picks[3].wasSkipped = true;
  for (const n of [1, 2, 4, 5]) make(w, n);
  w.config.currentPick = 6;
  await run(w); assert.equal(w.sentMail.length, 0); // only 4 made picks; the skip does not count
  make(w, 6); w.config.currentPick = 7;
  await run(w);
  assert.equal(w.sentMail.length, 1);
  assert.match(w.sentMail[0].text, /Skipped: T2 \(pick 1\.3\)/);
  assert.doesNotMatch(w.sentMail[0].text, /^\s+1\.3 /m);
  for (const n of [7, 8, 9, 10]) make(w, n);
  make(w, 3, { wasSkipped: true }); // the late pick fills the skipped slot: counts as the 5th
  w.config.currentPick = 11;
  await run(w);
  assert.equal(w.sentMail.length, 2);
  assert.match(w.sentMail[1].text, /1\.3  T2  Player p3 \(late pick\)/);
  assert.doesNotMatch(w.sentMail[1].text, /Skipped:/);
});

test('write-in picks are labelled pending verification', () => {
  const p = { overall: 1, round: 1, slot: 1, origTeam: 'A', ownerTeam: 'B', status: 'made', playerId: 'WI-1', madeAt: 1, writeIn: { name: 'Kid Hopeful', status: 'pending' } };
  const m = composeEmail({ batchPicks: [p], upcoming: [], config: {}, names: {}, siteUrl: '' });
  assert.match(m.text, /1\.1  B \(via A\)  Kid Hopeful \(write-in, pending verification\)/);
});

test('repeated runs never send the same batch twice', async () => {
  const w = world(); await run(w);
  for (let n = 1; n <= 5; n++) make(w, n);
  await run(w); await run(w); await run(w);
  assert.equal(w.sentMail.length, 1);
});

test('concurrent runs (ticker + another ticker) send the batch once', async () => {
  const w = world(); await run(w);
  for (let n = 1; n <= 5; n++) make(w, n);
  await Promise.all([run(w), run(w), run(w)]);
  assert.equal(w.sentMail.length, 1);
  assert.deepEqual(w.mail.sent.sort((a, b) => a - b), [1, 2, 3, 4, 5]); assert.equal(w.mail.pending, null);
});

test('a send failure is retried on a later run with the same picks, nothing lost or doubled', async () => {
  const w = world(); await run(w);
  for (let n = 1; n <= 5; n++) make(w, n);
  w.failNext = 1;
  const r = await run(w);
  assert.equal(r.status, 'failed'); assert.equal(w.sentMail.length, 0);
  assert.equal(w.mail.pending.status, 'failed'); assert.match(w.mail.lastError, /smtp down/);
  make(w, 6); // more picks arrive meanwhile
  assert.equal((await run(w)).status, 'waiting'); // backoff
  w.now += 5 * 60000;
  await run(w);
  assert.equal(w.sentMail.length, 1);
  assert.match(w.sentMail[0].text, /1\.1 /); assert.match(w.sentMail[0].text, /1\.5 /); assert.doesNotMatch(w.sentMail[0].text, /1\.6  /);
  assert.equal(w.mail.pending, null); assert.equal(w.mail.lastError, null);
  await run(w); assert.equal(w.sentMail.length, 1); // pick 6 alone: not yet
});

test('nextBatch: only made picks count', () => {
  const picks = [1, 2, 3, 4, 5].map((n) => ({ overall: n, status: n === 3 ? 'skipped' : 'made', madeAt: n }));
  assert.equal(nextBatch(picks, [], false), null);
  assert.deepEqual(nextBatch(picks, [], true).overalls, [1, 2, 4, 5]);
});
