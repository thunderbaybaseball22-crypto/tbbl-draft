import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { processInvites, composeInvite, setupLink, LEASE_MS, MAX_ATTEMPTS, GIVE_UP_MS } from '../tools/invites.mjs';

const T0 = 1_800_000_000_000;
const SITE = 'https://tbbl-draft-test.web.app';
const OWNER = { email: 'jeff@example.com', teams: ['SCA'], teamNames: { SCA: 'San Carlos Aces' }, manager: 'Jeff Thomas' };

function fakeIo({ invites = {}, owners = { [OWNER.email]: OWNER }, users = [], sendFails = [], userFails = null } = {}) {
  const st = { invites: structuredClone(invites), owners, users: new Set(users), sent: [], created: [] };
  let sendCall = 0;
  const io = {
    async listIds() { return Object.keys(st.invites).filter((k) => ['pending', 'sending'].includes(st.invites[k].state)); },
    async txInvite(id, fn) {
      const out = fn(st.invites[id] ? structuredClone(st.invites[id]) : null);
      if (out.write) st.invites[id] = JSON.parse(JSON.stringify(out.write));
      return out.result;
    },
    async getOwner(email) { return st.owners[email] || null; },
    async ensureUser(email) {
      if (userFails) throw userFails;
      if (st.users.has(email)) return { created: false };
      st.users.add(email); st.created.push(email); return { created: true };
    },
    async send(m) { const f = sendFails[sendCall++]; if (f) throw f; st.sent.push(m); },
  };
  return { io, st };
}
const pending = (extra = {}) => ({ state: 'pending', requestedAt: T0 - 60000, by: 'comm@example.com', ...extra });
const run = (io, now = T0) => processInvites(io, { siteUrl: SITE, now: () => now, token: (() => { let n = 0; return () => `t${++n}`; })() });

test('the setup link points at the site\'s #setup screen with the email filled in (and never expires)', () => {
  assert.equal(setupLink(SITE + '/', 'a+b@example.com'), 'https://tbbl-draft-test.web.app/#setup?email=a%2Bb%40example.com');
  const m = composeInvite({ email: OWNER.email, owner: OWNER, siteUrl: SITE });
  assert.match(m.subject, /set up your login/);
  assert.match(m.text, /^Hi Jeff Thomas,/);
  assert.match(m.text, /SCA \(San Carlos Aces\)/);
  assert.ok(m.text.includes(setupLink(SITE, OWNER.email)));
  assert.match(m.text, /does not expire/);
  assert.match(m.text, /about 1 hour/);
  assert.match(composeInvite({ email: 'x@example.com', owner: { teams: ['RAV', 'COL'] }, siteUrl: SITE }).text, /^Hi,[\s\S]*RAV and COL/);
});

test('a queued invite: login created if missing, email sent to the owner, marked sent', async () => {
  const { io, st } = fakeIo({ invites: { [OWNER.email]: pending() } });
  const r = await run(io);
  assert.deepEqual(r, { sent: 1, failed: 0, busy: 0, retry: 0, skipped: 0 });
  assert.deepEqual(st.created, [OWNER.email]);
  assert.equal(st.sent.length, 1);
  assert.equal(st.sent[0].to, OWNER.email);
  const inv = st.invites[OWNER.email];
  assert.equal(inv.state, 'sent'); assert.equal(inv.sentAt, T0); assert.equal(inv.loginCreated, true); assert.equal(inv.lease, undefined);
});

test('an existing login is reused, not recreated', async () => {
  const { io, st } = fakeIo({ invites: { [OWNER.email]: pending() }, users: [OWNER.email] });
  await run(io);
  assert.deepEqual(st.created, []);
  assert.equal(st.invites[OWNER.email].loginCreated, false);
});

test('repeated runs send once; a sent invite is left alone', async () => {
  const { io, st } = fakeIo({ invites: { [OWNER.email]: pending() } });
  await run(io); await run(io, T0 + 60000);
  assert.equal(st.sent.length, 1);
});

test('two runners at once: the second sees the lease and does nothing', async () => {
  const { io, st } = fakeIo({ invites: { [OWNER.email]: pending({ state: 'sending', lease: { token: 'other', until: T0 + LEASE_MS } }) } });
  const r = await run(io);
  assert.equal(r.busy, 1); assert.equal(st.sent.length, 0);
  // the other runner died: once its lease runs out the invite is taken over and sent
  const r2 = await run(io, T0 + LEASE_MS + 1);
  assert.equal(r2.sent, 1); assert.equal(st.sent.length, 1);
});

test('a temporary mail error is retried on the next run; after 5 tries it is marked failed', async () => {
  const err = Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' });
  const { io, st } = fakeIo({ invites: { [OWNER.email]: pending() }, sendFails: Array(MAX_ATTEMPTS).fill(err) });
  let r = await run(io);
  assert.equal(r.retry, 1);
  assert.equal(st.invites[OWNER.email].state, 'pending');
  assert.match(st.invites[OWNER.email].note, /ETIMEDOUT/);
  for (let i = 1; i < MAX_ATTEMPTS; i++) r = await run(io, T0 + i * 60000);
  assert.equal(r.failed, 1);
  assert.equal(st.invites[OWNER.email].state, 'failed');
  assert.match(st.invites[OWNER.email].reason, /after 5 tries/);
  assert.equal(st.sent.length, 0);
});

test('a refused address fails at once; a removed owner fails; a bad email key fails', async () => {
  const refused = Object.assign(new Error('No recipients'), { code: 'EENVELOPE' });
  let f = fakeIo({ invites: { [OWNER.email]: pending() }, sendFails: [refused] });
  await run(f.io);
  assert.equal(f.st.invites[OWNER.email].reason, 'the email address was refused');
  f = fakeIo({ invites: { 'gone@example.com': pending() } });
  await run(f.io);
  assert.equal(f.st.invites['gone@example.com'].reason, 'no longer an owner');
  f = fakeIo({ invites: { 'Not-An-Email': pending() } });
  await run(f.io);
  assert.equal(f.st.invites['Not-An-Email'].reason, 'invalid email address');
});

test('an invite left unsent for over 7 days is marked failed instead of going out by surprise', async () => {
  const { io, st } = fakeIo({ invites: { [OWNER.email]: pending({ requestedAt: T0 - GIVE_UP_MS - 1 }) } });
  const r = await run(io);
  assert.equal(r.failed, 1); assert.equal(st.sent.length, 0);
  assert.match(st.invites[OWNER.email].reason, /7 days/);
});

test('a login problem (not the mail) is retried too', async () => {
  const { io, st } = fakeIo({ invites: { [OWNER.email]: pending() }, userFails: Object.assign(new Error('x'), { code: 'auth/internal-error' }) });
  const r = await run(io);
  assert.equal(r.retry, 1); assert.equal(st.invites[OWNER.email].state, 'pending');
});

test('firestore.rules: only the commissioner queues invites, only "pending", only for a listed owner', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const b = rules.slice(rules.indexOf('match /invites/{key}'), rules.indexOf('match /presence/{uid}'));
  assert.match(b, /allow read, delete: if isAdmin\(\);/);
  assert.match(b, /allow create, update: if isAdmin\(\)/);
  assert.match(b, /exists\(\/databases\/\$\(db\)\/documents\/owners\/\$\(key\)\)/);
  assert.match(b, /hasOnly\(\['state', 'requestedAt', 'by'\]\)/);
  assert.match(b, /request\.resource\.data\.state == 'pending'/);
});

test('the site opens the setup screen for #setup links, and the ticker runs the invite step', () => {
  const ui = readFileSync(new URL('../public/js/ui.js', import.meta.url), 'utf8');
  assert.ok(ui.includes("/^#setup(?:\\?(.*))?$/") && ui.includes('Email me a link to set my password'));
  const tk = readFileSync(new URL('../tools/ticker.mjs', import.meta.url), 'utf8');
  assert.equal((tk.match(/await inviteStep\(\);/g) || []).length, 2);
});
