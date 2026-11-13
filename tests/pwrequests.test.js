import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { processPasswordRequests, rejectReason, EXPIRY_MS, LEASE_MS } from '../tools/pwrequests.mjs';

const T0 = 1_800_000_000_000;
const PW = 'Sunrise-Pelican-42';
const E = 'owner@example.com';

// Fake Firestore + Auth: optimistic transactions with a yield between read and write so concurrent runs interleave.
function world(requests = {}) {
  const w = { now: T0, reqs: {}, statuses: {}, version: 0, audit: [], calls: [], users: { [E]: 'uid-1', 'b@example.com': 'uid-2' }, failSet: null, failRevoke: null, logs: [] };
  for (const [k, v] of Object.entries(requests)) w.reqs[k] = JSON.parse(JSON.stringify(v));
  w.io = {
    async listIds() { return Object.keys(w.reqs); },
    async txRequest(id, fn) {
      for (;;) {
        const v = w.version, cur = w.reqs[id] ? JSON.parse(JSON.stringify(w.reqs[id])) : null;
        const out = fn(cur);
        await new Promise((r) => setImmediate(r));
        if (v !== w.version) continue;
        if (out.write) w.reqs[id] = JSON.parse(JSON.stringify(out.write));
        if (out.del) delete w.reqs[id];
        if (out.status) w.statuses[id] = JSON.parse(JSON.stringify(out.status));
        if (out.write || out.del || out.status) w.version++;
        return out.result;
      }
    },
    async setPassword(email, password) {
      w.calls.push({ op: 'set', email, password });
      await new Promise((r) => setImmediate(r));
      if (w.failSet) throw Object.assign(new Error('boom ' + password), { code: w.failSet });
      if (!w.users[email]) throw Object.assign(new Error('no user'), { code: 'auth/user-not-found' });
      return { uid: w.users[email] };
    },
    async revoke(uid) { w.calls.push({ op: 'revoke', uid }); if (w.failRevoke) throw Object.assign(new Error('x ' + PW), { code: w.failRevoke }); },
  };
  w.run = () => processPasswordRequests(w.io, { now: () => w.now, log: (m) => w.logs.push(m) });
  return w;
}
const req = (extra = {}) => ({ password: PW, requestedAt: T0 - 1000, ...extra });
const sets = (w) => w.calls.filter((c) => c.op === 'set');

test('request validation: good request passes; bad shapes, weak and future-dated ones are rejected', () => {
  assert.equal(rejectReason(E, req(), T0), null);
  assert.match(rejectReason('Owner@Example.com', req(), T0), /invalid request/);
  assert.match(rejectReason(E, { requestedAt: T0 }, T0), /invalid request/);
  assert.match(rejectReason(E, { password: 5, requestedAt: T0 }, T0), /invalid request/);
  assert.match(rejectReason(E, req({ requestedAt: 'now' }), T0), /invalid request/);
  assert.match(rejectReason(E, req({ requestedAt: T0 + 10 * 60000 }), T0), /future/);
  assert.match(rejectReason(E, req({ password: 'short' }), T0), /^weak password: Too short/);
  assert.match(rejectReason(E, req({ password: 'password123' }), T0), /weak password/);
  assert.match(rejectReason(E, req({ password: 'x'.repeat(129) }), T0), /weak password/);
  assert.equal(rejectReason(E, req({ requestedAt: T0 - EXPIRY_MS }), T0), null);
  assert.equal(rejectReason(E, req({ requestedAt: T0 - EXPIRY_MS - 1 }), T0), 'expired');
  assert.equal(EXPIRY_MS, 15 * 60 * 1000);
});

test('apply then delete: password set, old sessions revoked, request gone, status done', async () => {
  const w = world({ [E]: req() });
  const r = await w.run();
  assert.equal(r.done, 1);
  assert.deepEqual(sets(w), [{ op: 'set', email: E, password: PW }]);
  assert.ok(w.calls.some((c) => c.op === 'revoke' && c.uid === 'uid-1'));
  assert.deepEqual(w.reqs, {});
  assert.equal(w.statuses[E].state, 'done');
  assert.equal(w.statuses[E].requestedAt, T0 - 1000);
  assert.equal(w.statuses[E].at, T0);
});

test('the password never appears in a status record, a log line, or the audit log', async () => {
  const cases = [
    { [E]: req() },                                   // success
    { [E]: req({ password: 'password123' }) },        // weak
    { [E]: req({ requestedAt: T0 - EXPIRY_MS - 5 }) },// expired
    { 'nobody@example.com': req() },                  // no login
  ];
  for (const c of cases) {
    const w = world(c);
    await w.run();
    const dump = JSON.stringify({ s: w.statuses, a: w.audit, l: w.logs, r: w.reqs });
    assert.ok(!dump.includes(PW), 'password leaked');
    assert.ok(!dump.includes('password123'), 'password leaked');
    assert.deepEqual(w.audit, []); // the step never writes audit entries
    assert.deepEqual(Object.keys(w.statuses[Object.keys(c)[0]]).filter((k) => /pass|pw/i.test(k)), []);
  }
  // an error whose own message contains the password does not leak it either
  const w = world({ [E]: req() }); w.failRevoke = 'auth/internal-error';
  await w.run();
  assert.ok(!JSON.stringify({ s: w.statuses, l: w.logs }).includes(PW));
  const w2 = world({ [E]: req() }); w2.failSet = 'auth/network-request-failed';
  await w2.run();
  assert.ok(!JSON.stringify({ s: w2.statuses, l: w2.logs, r: w2.reqs }).includes('boom'));
});

test('expiry: an old request is not applied, is deleted and reported as expired', async () => {
  const w = world({ [E]: req({ requestedAt: T0 - EXPIRY_MS - 1000 }) });
  const r = await w.run();
  assert.equal(r.expired, 1);
  assert.equal(sets(w).length, 0);
  assert.deepEqual(w.reqs, {});
  assert.deepEqual([w.statuses[E].state, w.statuses[E].reason], ['failed', 'expired']);
  // just inside the limit is still applied
  const ok = world({ [E]: req({ requestedAt: T0 - EXPIRY_MS + 1000 }) });
  assert.equal((await ok.run()).done, 1);
});

test('repeated runs: the second run finds nothing and never applies again', async () => {
  const w = world({ [E]: req() });
  await w.run();
  const again = await w.run();
  assert.deepEqual(again, { done: 0, failed: 0, expired: 0, busy: 0, retry: 0, gone: 0 });
  assert.equal(sets(w).length, 1);
  assert.equal(w.statuses[E].state, 'done');
});

test('concurrent runners: the password is applied exactly once', async () => {
  const w = world({ [E]: req(), 'b@example.com': req() });
  const rs = await Promise.all([w.run(), w.run(), w.run()]);
  assert.equal(sets(w).filter((c) => c.email === E).length, 1);
  assert.equal(sets(w).filter((c) => c.email === 'b@example.com').length, 1);
  assert.equal(rs.reduce((n, r) => n + r.done, 0), 2);
  assert.deepEqual(w.reqs, {});
  assert.equal(w.statuses[E].state, 'done');
});

test('a crashed run that already set the password is cleaned up without applying again', async () => {
  const w = world({ [E]: req({ applied: true, lease: { token: 'dead', until: T0 - 1 } }) });
  const r = await w.run();
  assert.equal(r.done, 1);
  assert.equal(sets(w).length, 0);
  assert.deepEqual(w.reqs, {});
  assert.equal(w.statuses[E].state, 'done');
});

test('a request leased by another live runner is left alone; after the lease runs out it is taken', async () => {
  const w = world({ [E]: req({ lease: { token: 'other', until: T0 + LEASE_MS } }) });
  assert.equal((await w.run()).busy, 1);
  assert.equal(sets(w).length, 0);
  assert.ok(w.reqs[E]);
  w.now = T0 + LEASE_MS + 1;
  assert.equal((await w.run()).done, 1);
  assert.equal(sets(w).length, 1);
});

test('failures are reported with a clear reason and the request is deleted', async () => {
  const none = world({ 'nobody@example.com': req() });
  assert.equal((await none.run()).failed, 1);
  assert.equal(none.statuses['nobody@example.com'].reason, 'login does not exist');
  assert.deepEqual(none.reqs, {});

  const weak = world({ [E]: req({ password: 'aaaaaaaa' }) });
  await weak.run();
  assert.match(weak.statuses[E].reason, /^weak password/);
  assert.equal(sets(weak).length, 0);
  assert.deepEqual(weak.reqs, {});

  const fb = world({ [E]: req() }); fb.failSet = 'auth/invalid-password';
  await fb.run();
  assert.match(fb.statuses[E].reason, /weak password/);
  assert.deepEqual(fb.reqs, {});
});

test('a temporary error keeps the request for the next run (until it expires); then it succeeds', async () => {
  const w = world({ [E]: req() }); w.failSet = 'auth/network-request-failed';
  const r1 = await w.run();
  assert.equal(r1.retry, 1);
  assert.ok(w.reqs[E] && !w.reqs[E].lease);
  assert.equal(w.statuses[E].state, 'pending');
  w.failSet = null; w.now += 60000;
  assert.equal((await w.run()).done, 1);
  assert.deepEqual(w.reqs, {});
  // and if the problem lasts past the expiry, it is dropped and reported
  const w2 = world({ [E]: req() }); w2.failSet = 'auth/network-request-failed';
  await w2.run(); w2.now += EXPIRY_MS + 1;
  assert.equal((await w2.run()).expired, 1);
  assert.equal(w2.statuses[E].reason, 'expired');
});

test('if signing out old sessions fails, the password is still reported as set, with a note', async () => {
  const w = world({ [E]: req() }); w.failRevoke = 'auth/internal-error';
  assert.equal((await w.run()).done, 1);
  assert.equal(w.statuses[E].state, 'done');
  assert.match(w.statuses[E].note, /could not be signed out/);
});

test('firestore.rules: requests are commissioner-only, create-once, shaped; status record cannot hold a password', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const block = (name) => { const i = rules.indexOf(`match /${name}/{key} {`); assert.ok(i > 0, name); return rules.slice(i, rules.indexOf('\n    }\n', i)); };
  const rq = block('pwRequests'), st = block('pwStatus');
  assert.match(rq, /allow read, delete: if isAdmin\(\)/);
  assert.match(rq, /allow update: if false/);
  assert.match(rq, /allow create: if isAdmin\(\)/);
  assert.match(rq, /hasOnly\(\['password', 'requestedAt'\]\)/);
  assert.match(rq, /password\.size\(\) >= 8/);
  assert.match(st, /allow read, delete: if isAdmin\(\)/);
  assert.match(st, /hasOnly\(\['state', 'requestedAt', 'at'\]\)/);
  assert.ok(!/password/.test(st.replace(/password-free|NEVER holds a password/g, '')), 'status rule mentions a password field');
  assert.ok(!/allow [^;]*if (true|signedIn\(\))/.test(rq + st));
});
