import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onlineTeams, beatDue, onlineText, BEAT_MS, ONLINE_MS } from '../public/js/lib/presence.js';

const NOW = 1_800_000_000_000, MIN = 60000;

test('online = a beat within the last 12 minutes; teams merged, de-duplicated and sorted', () => {
  const docs = {
    u1: { teams: ['SCA'], at: NOW - 1 * MIN },
    u2: { teams: ['RAV', 'COL'], at: NOW - 11 * MIN },
    u3: { teams: ['LVB'], at: NOW - 13 * MIN },         // too old
    u4: { teams: ['SCA'], at: NOW - 2 * MIN },          // same team on a second device
    u5: { teams: ['PLU'], at: NOW + 30 * MIN },         // bogus future time ignored
    u6: { at: NOW }, u7: null, u8: { teams: ['JER'], at: 'soon' },
  };
  assert.deepEqual(onlineTeams(docs, NOW), ['COL', 'RAV', 'SCA']);
  assert.deepEqual(onlineTeams({}, NOW), []);
  assert.deepEqual(onlineTeams(undefined, NOW), []);
  assert.equal(ONLINE_MS > 2 * BEAT_MS, true); // one late beat does not make a team flicker offline
});

test('a beat is written only for an owner with a visible page, at most every 5 minutes (or when forced)', () => {
  const base = { teams: ['SCA'], visible: true, lastBeat: NOW - BEAT_MS, now: NOW };
  assert.equal(beatDue(base), true);
  assert.equal(beatDue({ ...base, lastBeat: null }), true);
  assert.equal(beatDue({ ...base, lastBeat: NOW - BEAT_MS + 1000 }), false);
  assert.equal(beatDue({ ...base, lastBeat: NOW - 1000, force: true }), true);
  assert.equal(beatDue({ ...base, visible: false, force: true }), false); // a hidden tab is not "on the site"
  assert.equal(beatDue({ ...base, teams: [] }), false);                   // a login with no team (e.g. commissioner only) is not listed
});

test('the line shown under the banner', () => {
  assert.equal(onlineText(['JER', 'SCA']), 'Online now (2): JER SCA');
  assert.equal(onlineText([]), 'No teams online right now.');
});

test('firestore.rules: presence is own-document only, team codes must be the login\'s own teams, readable by signed-in users', () => {
  const r = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const block = r.slice(r.indexOf('match /presence/{uid}'), r.indexOf('match /playerchunks/{id}'));
  assert.ok(block.length > 50);
  assert.match(block, /allow read: if signedIn\(\);/);
  assert.match(block, /uid == request\.auth\.uid/);
  assert.match(block, /keys\(\)\.hasOnly\(\['teams', 'at'\]\)/);
  assert.match(block, /request\.resource\.data\.teams == myTeams\(\)/);
  assert.match(block, /at > now\(\) - 120000 && request\.resource\.data\.at < now\(\) \+ 120000/);
  assert.doesNotMatch(block.replace(/\/\/.*$/gm, ''), /email/); // keyed by uid, stores team codes only: no email
});

test('the page wires presence: beat every tick, show the line, clear on sign-out', () => {
  const ui = readFileSync(new URL('../public/js/ui.js', import.meta.url), 'utf8');
  const st = readFileSync(new URL('../public/js/store.js', import.meta.url), 'utf8');
  assert.ok(ui.includes('S.presenceTick()') && ui.includes('updateOnline()') && ui.includes('id="online"'));
  assert.match(st, /export async function logout\(\) \{\s*await clearPresence\(\);/);
  assert.match(st, /setDoc\(doc\(store\.fb\.db, 'presence', u\.uid\), \{ teams: store\.teams, at: now \}\)/);
});
