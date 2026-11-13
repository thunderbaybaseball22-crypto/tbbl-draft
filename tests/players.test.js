import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPlayers, loadSchedule, diffPlayers, diffSchedule, diffOwners } from '../public/js/lib/csv.js';

const HDR = 'PUID,FullName,TeamID,AAA,DOB\n';

test('PUID -1 with AAA is valid: stable key from name + DOB, original -1 and AAA kept', () => {
  const r = loadPlayers(HDR + '-1,Aidan Miller,KBB,AAA,9-Jun-04\n-1,Aiva Arquette,PLU,AAA,17-Oct-03\n12345,Real Guy,,,1-Jan-90\n');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  const a = r.players[0];
  assert.deepEqual([a.id, a.puid, a.aaa, a.kind, a.ownerTeam], ['N-aidan_miller-9_jun_04', '-1', true, 'Non-MLB', 'KBB']);
  assert.equal(r.players[2].kind, 'MLB');
  // key is stable across re-imports and row order
  const again = loadPlayers(HDR + '12345,Real Guy,,,1-Jan-90\n-1,Aiva Arquette,PLU,AAA,17-Oct-03\n-1,Aidan Miller,KBB,AAA,9-Jun-04\n');
  assert.equal(again.players[2].id, a.id);
});

test('PUID -1 without AAA is only a warning', () => {
  const r = loadPlayers(HDR + '-1,No Flag,,,1-Jan-01\n');
  assert.deepEqual(r.errors, []);
  assert.match(r.warnings.join('|'), /PUID -1 but no AAA flag/);
});

test('ids at or below 9,999 (other than -1) are Non-MLB; larger are MLB', () => {
  const r = loadPlayers(HDR + '9999,Low,,,\n10000,High,,,\n');
  assert.deepEqual(r.players.map((p) => p.kind), ['Non-MLB', 'MLB']);
});

test('MERGE: -1/AAA row and a real-ID row with same name + DOB become one record with the real ID and the team', () => {
  const csv = HDR + '-1,Anthony Kay,RAV,AAA,21-Mar-95\n32193,Anthony Kay,,,21-Mar-95\n-1,Foster Griffin,RAV,AAA,27-Jul-95\n31878,Foster Griffin,,,27-Jul-95\n-1,Solo Prospect,KBB,AAA,1-Feb-05\n';
  const r = loadPlayers(csv);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.players.map((p) => [p.id, p.ownerTeam]), [['32193', 'RAV'], ['31878', 'RAV'], ['N-solo_prospect-1_feb_05', 'KBB']]);
  assert.equal(r.merges.length, 2);
  assert.match(r.merges[0].text, /Anthony Kay .* kept real ID 32193 .* took team RAV; dropped the -1\/AAA row on line 2/);
  assert.equal(r.players[0].kind, 'MLB');
});

test('merge conflict (both rows have different teams) keeps the real-ID team and warns', () => {
  const r = loadPlayers(HDR + '-1,Dup Guy,RAV,AAA,1-Jan-95\n40000,Dup Guy,KBB,,1-Jan-95\n');
  assert.equal(r.players[0].ownerTeam, 'KBB');
  assert.match(r.warnings.join('|'), /Merge conflict/);
});

test('same name + DOB on two real-ID rows is a warning, nothing dropped', () => {
  const r = loadPlayers(HDR + '40001,Twin Guy,,,1-Jan-95\n40002,Twin Guy,,,1-Jan-95\n');
  assert.deepEqual(r.errors, []);
  assert.equal(r.players.length, 2);
  assert.match(r.warnings.join('|'), /appears on 2 rows/);
});

test('two -1 rows with identical name + DOB collide on the key and are reported as an error', () => {
  const r = loadPlayers(HDR + '-1,Same Same,,AAA,1-Jan-05\n-1,Same Same,,AAA,1-Jan-05\n');
  assert.match(r.errors.join('|'), /is used by 2 rows/);
});

test('diffPlayers summarises added / removed / team change / rename', () => {
  const prev = loadPlayers(HDR + '1,A One,KBB,,1-Jan-90\n2,B Two,,,1-Jan-90\n3,C Three,,,1-Jan-90\n').players;
  const next = loadPlayers(HDR + '1,A One,,,1-Jan-90\n2,B Twoo,,,1-Jan-90\n4,D Four,NHH,,1-Jan-90\n').players;
  const d = diffPlayers(prev, next);
  assert.deepEqual([d.previousCount, d.newCount, d.added.length, d.removed.length], [3, 3, 1, 1]);
  assert.deepEqual(d.teamChanged, [{ id: '1', name: 'A One', from: 'KBB', to: '(available)' }]);
  assert.deepEqual(d.renamed, [{ id: '2', from: 'B Two', to: 'B Twoo' }]);
});

test('diffSchedule and diffOwners', () => {
  const a = [{ overall: 1, origTeam: 'A', ownerTeam: 'A' }, { overall: 2, origTeam: 'B', ownerTeam: 'B' }];
  const b = [{ overall: 1, origTeam: 'A', ownerTeam: 'B' }, { overall: 2, origTeam: 'B', ownerTeam: 'B' }, { overall: 3, origTeam: 'C', ownerTeam: 'C' }];
  const d = diffSchedule(a, b);
  assert.deepEqual([d.added, d.removed, d.changed.length], [1, 0, 1]);
  const o = diffOwners([{ email: 'a@x.com', teams: ['A'] }, { email: 'b@x.com', teams: ['B'] }], [{ email: 'a@x.com', teams: ['A', 'C'] }, { email: 'c@x.com', teams: ['B'] }]);
  assert.deepEqual([o.added, o.removed, o.changed.length], [['c@x.com'], ['b@x.com'], 1]);
});
