import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { loadSchedule, loadPlayers, loadOwners } from '../public/js/lib/csv.js';

const read = (f) => readFileSync(new URL('../public/sample/' + f, import.meta.url), 'utf8');

test('sample draft order loads: 312 picks, 24 teams, 21 traded', () => {
  const r = loadSchedule(read('SAMPLE-DraftOrder.csv'));
  assert.deepEqual(r.errors, []);
  assert.equal(r.picks.length, 312);
  assert.equal(r.teams.length, 24);
  assert.equal(r.picks.filter((p) => p.origTeam !== p.ownerTeam).length, 21);
});

test('sample players and owners load cleanly against the schedule teams', () => {
  const sch = loadSchedule(read('SAMPLE-DraftOrder.csv'));
  const pl = loadPlayers(read('SAMPLE-players.csv'), { teamCodes: sch.teams });
  assert.deepEqual(pl.errors, []);
  assert.equal(pl.players.length, 500);
  assert.equal(pl.players.filter((p) => !p.ownerTeam).length, 380);
  const ow = loadOwners(read('SAMPLE-owners.csv'), { teamCodes: sch.teams });
  assert.deepEqual(ow.errors, []);
  assert.deepEqual(ow.warnings, []);
  assert.equal(ow.owners.length, 24);
});

// Read-only checks that the league's real files (if present next to the app) are understood.
// Nothing about their content is asserted beyond "headers recognised"; they are never modified.
// Known data issue: PlayerFile.csv uses PUID -1 for many players, which the loader reports as duplicate IDs.
const realFile = (name) => new URL('../' + name, import.meta.url);

test('real player file headers (PUID, FullName, TeamID) are recognised', (t) => {
  const f = realFile('PlayerFile.csv');
  if (!existsSync(f)) return t.skip('PlayerFile.csv not present');
  const r = loadPlayers(readFileSync(f, 'utf8'));
  assert.ok(r.players.length > 1000);
  assert.ok(!r.errors.some((e) => /Missing/.test(e)));
});

test('real owner file headers (Abb, ManagerEmail) are recognised', (t) => {
  const f = realFile('OwnerEmails.csv');
  if (!existsSync(f)) return t.skip('OwnerEmails.csv not present');
  const r = loadOwners(readFileSync(f, 'utf8'));
  assert.ok(!r.errors.some((e) => /Missing/.test(e)));
  assert.equal(r.owners.length, 24);
});
test('real draft order (if present) loads: 312 picks, 13 rounds of 24, overall 1..312', (t) => {
  const f = realFile('2027TBBLDraftSchedule-TESTING.csv');
  if (!existsSync(f)) return t.skip('not present');
  const text = readFileSync(f, 'utf8');
  if (!/^\ufeff?Rd,/.test(text)) return t.skip('not a draft order file');
  const r = loadSchedule(text);
  assert.deepEqual(r.errors, []);
  assert.equal(r.picks.length, 312);
  assert.equal(new Set(r.picks.map((p) => p.round)).size, 13);
  assert.equal(r.teams.length, 24);
});
