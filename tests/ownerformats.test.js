import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOwners } from '../public/js/lib/csv.js';
import { checkEmail, checkPassword } from '../tools/password-check.mjs';

test('owners importer accepts the sample layout email,team_code', () => {
  const r = loadOwners('email,team_code\nA@x.com,BEA\nb@x.com,BOM\n');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.owners.map((o) => [o.email, o.teams]), [['a@x.com', ['BEA']], ['b@x.com', ['BOM']]]);
});

test('owners importer accepts the league layout Abb,TeamName,ManagerName,ManagerEmail and keeps names', () => {
  const r = loadOwners('Abb,TeamName,ManagerName,ManagerEmail\nBEA,Beasts,Pat Doe,pat@x.com\nBOM,Bombers,Sam Roe,sam@x.com\n', { teamCodes: ['BEA', 'BOM'] });
  assert.deepEqual(r.errors, []); assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.owners[0], { email: 'pat@x.com', teams: ['BEA'], teamNames: { BEA: 'Beasts' }, manager: 'Pat Doe' });
  assert.equal(r.owners[1].manager, 'Sam Roe');
});

test('set-password validates the email and refuses weak passwords', () => {
  assert.equal(checkEmail('nope').ok, false);
  assert.deepEqual(checkEmail(' Pat@X.com '), { ok: true, email: 'pat@x.com' });
  for (const bad of ['', 'abc12', '1234567', 'aaaaaaaaaa', 'password', 'Password123', '12345678', ' spaced pw ']) assert.equal(checkPassword(bad, 'pat@x.com').ok, false, bad);
  assert.equal(checkPassword('patrick99', 'patrick99@x.com').ok, false);
  assert.equal(checkPassword('Tr1cky-Horse-42', 'pat@x.com').ok, true);
  assert.doesNotMatch(checkPassword('Password123').error, /Password123/);
});
