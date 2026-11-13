import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkOwnerEdit, ownerFormValues } from '../public/js/lib/owners.js';

const OWNERS = [
  { email: 'a@example.com', teams: ['SCA'], teamNames: { SCA: 'San Carlos Aces' }, manager: 'Al' },
  { email: 'b@example.com', teams: ['RAV', 'COL'], teamNames: { RAV: 'Rock River Ravens', COL: 'Colorado Gladiators' }, manager: 'Bo' },
];
const TEAMS = ['SCA', 'RAV', 'COL', 'LVB', 'PLU'];
const edit = (oldEmail, patch) => checkOwnerEdit(OWNERS, oldEmail, { ...ownerFormValues(OWNERS.find((o) => o.email === oldEmail)), ...patch }, TEAMS);

test('the form starts with the current values (several teams: names in team order, " / " between)', () => {
  assert.deepEqual(ownerFormValues(OWNERS[1]), { email: 'b@example.com', teams: 'RAV COL', teamNames: 'Rock River Ravens / Colorado Gladiators', manager: 'Bo' });
  assert.equal(ownerFormValues({ email: 'x@example.com', teams: ['A', 'B'] }).teamNames, '');
});

test('saving with nothing changed reports no changes', () => {
  const r = edit('a@example.com', {});
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.changes, []);
  assert.equal(r.emailChanged, false);
});

test('change the email: lowercased and trimmed, reported as an email change', () => {
  const r = edit('a@example.com', { email: '  New.Owner@Example.COM ' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.owner.email, 'new.owner@example.com');
  assert.equal(r.emailChanged, true);
  assert.deepEqual(r.changes, ['Email: a@example.com -> new.owner@example.com']);
  assert.deepEqual(r.owner.teams, ['SCA']);
});

test('change manager and team name', () => {
  const r = edit('a@example.com', { manager: 'Jeff Thomas', teamNames: 'San Carlos Aces II' });
  assert.deepEqual(r.owner, { email: 'a@example.com', teams: ['SCA'], teamNames: { SCA: 'San Carlos Aces II' }, manager: 'Jeff Thomas' });
  assert.equal(r.changes.length, 2);
});

test('add a second team (codes upper-cased, any separator), one name per team', () => {
  const r = edit('a@example.com', { teams: 'sca, lvb', teamNames: 'San Carlos Aces / Louisville Bats' });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.owner.teams, ['SCA', 'LVB']);
  assert.deepEqual(r.owner.teamNames, { SCA: 'San Carlos Aces', LVB: 'Louisville Bats' });
  assert.match(r.changes.join('|'), /Teams: SCA -> SCA LVB/);
});

test('a single name with several teams is used for each; blank names are allowed', () => {
  assert.deepEqual(edit('a@example.com', { teams: 'SCA LVB', teamNames: 'Aces' }).owner.teamNames, { SCA: 'Aces', LVB: 'Aces' });
  assert.deepEqual(edit('a@example.com', { teamNames: '' }).owner.teamNames, {});
});

test('errors: bad email, email of another owner, no team, unknown team, team of another owner, name count', () => {
  assert.match(edit('a@example.com', { email: 'not-an-email' }).errors.join('|'), /not a valid email/);
  assert.match(edit('a@example.com', { email: 'B@example.com' }).errors.join('|'), /already an owner/);
  assert.match(edit('a@example.com', { teams: '  ' }).errors.join('|'), /at least one team/);
  assert.match(edit('a@example.com', { teams: 'SCA ZZZ', teamNames: '' }).errors.join('|'), /Team ZZZ is not in the draft order/);
  assert.match(edit('a@example.com', { teams: 'SCA RAV', teamNames: '' }).errors.join('|'), /Team RAV already belongs to b@example.com/);
  assert.match(edit('b@example.com', { teamNames: 'One / Two / Three' }).errors.join('|'), /one team name per team/);
  assert.equal(edit('a@example.com', { email: 'bad' }).owner, null);
});

test('an owner may keep their own teams when changing email (not counted as taken by themselves)', () => {
  const r = edit('b@example.com', { email: 'c@example.com' });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.owner.teams, ['RAV', 'COL']);
});

test('the row being edited must still exist', () => {
  assert.match(checkOwnerEdit(OWNERS, 'gone@example.com', { email: 'x@example.com', teams: 'SCA' }, TEAMS).errors[0], /not found/);
});

test('without a draft order, any team code is accepted', () => {
  assert.deepEqual(checkOwnerEdit(OWNERS, 'a@example.com', { email: 'a@example.com', teams: 'NEW' }, null).errors, []);
});

test('firestore.rules: the commissioner can only CREATE a draft list (to move it to a new email), never change one', () => {
  const r = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const block = r.slice(r.indexOf('match /queues/{key}'), r.indexOf('match /notices/{key}'));
  assert.match(block, /allow write: if signedIn\(\) && key == email\(\)/);
  assert.match(block, /allow create: if isAdmin\(\)\s*&& request\.resource\.data\.keys\(\)\.hasOnly\(\['items', 'autoDraft'\]\)/);
  assert.doesNotMatch(block, /allow (update|write|delete): if isAdmin/);
  const owners = r.slice(r.indexOf('match /owners/{key}'), r.indexOf('match /queues/{key}'));
  assert.match(owners, /allow write: if isAdmin\(\);/);
  assert.doesNotMatch(owners, /locked\(\)/); // editing owners works while the real-draft lock is ON
});
