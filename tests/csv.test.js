import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, loadSchedule, loadPlayers, loadOwners, toCsv, exportSchedule, exportResults } from '../public/js/lib/csv.js';

const TEAMS = Array.from({ length: 24 }, (_, i) => 'T' + String(i + 1).padStart(2, '0'));
const scheduleCsv = (mut) => {
  const rows = ['Round,Pick in Round,Overall,Original Team,Current Team'];
  TEAMS.forEach((t, i) => rows.push(`1,${i + 1},${i + 1},${t},${t}`));
  return (mut ? mut(rows) : rows).join('\n');
};

test('parseCsv handles BOM, quotes, escaped quotes, CRLF and embedded newlines', () => {
  const rows = parseCsv('\ufeffa,b\r\n"x, y","say ""hi"""\r\n"multi\nline",z\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'say "hi"'], ['multi\nline', 'z']]);
});

test('schedule loads 24 teams and keeps original owner after trade', () => {
  const r = loadSchedule(scheduleCsv((rows) => { rows[2] = '1,2,2,T02,T05'; return rows; }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.picks.length, 24);
  assert.equal(r.teams.length, 24);
  assert.equal(r.picks[1].origTeam, 'T02');
  assert.equal(r.picks[1].ownerTeam, 'T05');
});

test('schedule accepts the TESTING-style headers (Rd,Slot,Orig Team,Traded Team,Drafting Team,Overall)', () => {
  const lines = ['Rd,Slot,Round/Slot,Orig Team,Traded Team,Drafting Team,Player Drafted,Overall'];
  TEAMS.forEach((t, i) => lines.push(`1,${i + 1},1.${i + 1},${t},${i === 0 ? 'T02' : ''},${i === 0 ? 'T02' : t},,${i + 1}`));
  const r = loadSchedule(lines.join('\r\n'));
  assert.deepEqual(r.errors, []);
  assert.equal(r.picks[0].ownerTeam, 'T02');
});

test('schedule errors: gap, duplicate, blank owner, Traded/Drafting mismatch, wrong team count, missing column', () => {
  assert.match(loadSchedule(scheduleCsv((r) => { r.splice(3, 1); return r; })).errors.join('|'), /no gaps|Expected 24/);
  assert.match(loadSchedule(scheduleCsv((r) => { r[3] = r[2]; return r; })).errors.join('|'), /duplicate overall/);
  assert.match(loadSchedule(scheduleCsv((r) => { r[2] = '1,2,2,T02,'; return r; })).errors.join('|'), /current team blank/);
  const mism = 'Rd,Slot,Orig Team,Traded Team,Drafting Team,Overall\n1,1,A,B,C,1';
  assert.match(loadSchedule(mism, { expectedTeams: 0 }).errors.join('|'), /differs from Drafting/);
  assert.match(loadSchedule(scheduleCsv((r) => r.slice(0, 20))).errors.join('|'), /Expected 24/);
  assert.match(loadSchedule('a,b\n1,2').errors.join('|'), /Missing column/);
});

test('players: aliases, AVAILABLE/blank, quoting, case of team code', () => {
  const csv = 'PUID,FullName,TeamID\n1,"Doe, Jane",nhh\n2,Joe,AVAILABLE\n3,Al,\n';
  const r = loadPlayers(csv, { teamCodes: ['NHH'] });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.players.map((p) => [p.id, p.name, p.ownerTeam]), [['1', 'Doe, Jane', 'NHH'], ['2', 'Joe', ''], ['3', 'Al', '']]);
});

test('players errors: duplicate id, blank id, unknown team, missing columns', () => {
  const r = loadPlayers('id,name,team\n1,A,\n1,B,\n,C,\n4,D,ZZZ\n', { teamCodes: ['NHH'] });
  const e = r.errors.join('|');
  assert.match(e, /Player ID 1 is used by 2 rows/);
  assert.match(e, /blank player ID/);
  assert.match(e, /unknown team code ZZZ/);
  assert.match(loadPlayers('x,y\n1,2').errors.join('|'), /Missing player ID/);
});

test('owners: groups teams per email, flags bad email / unknown / duplicate team', () => {
  const ok = loadOwners('email,team\nA@x.com,NHH\nb@x.com,KBB;COL\n', { teamCodes: ['NHH', 'KBB', 'COL', 'ZZZ'] });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.owners, [{ email: 'a@x.com', teams: ['NHH'] }, { email: 'b@x.com', teams: ['KBB', 'COL'] }]);
  assert.deepEqual(ok.warnings, ['Team ZZZ has no owner email']);
  const bad = loadOwners('email,team\nnope,NHH\nc@x.com,QQQ\nd@x.com,NHH\ne@x.com,NHH\n', { teamCodes: ['NHH'] });
  assert.match(bad.errors.join('|'), /invalid email/);
  assert.match(bad.errors.join('|'), /unknown team QQQ/);
  assert.match(bad.errors.join('|'), /already assigned/);
});

test('exports: schedule columns with Name (ID), results csv, formula neutralised', () => {
  const picks = [
    { overall: 1, round: 1, slot: 1, origTeam: 'A', ownerTeam: 'B', status: 'made', playerId: 'p1', madeAt: 0, madeBy: 'x@y.com' },
    { overall: 2, round: 1, slot: 2, origTeam: 'B', ownerTeam: 'B', status: 'open', playerId: null },
  ];
  const players = { p1: { id: 'p1', name: '=Evil, "Guy"' } };
  const sched = exportSchedule(picks, players).split('\r\n');
  assert.equal(sched[0], 'Rd,Slot,Round/Slot,Orig Team,Traded Team,Drafting Team,Player Drafted,Overall');
  assert.equal(sched[1], `1,1,1.1,A,B,B,"'=Evil, ""Guy"" (p1)",1`);
  assert.equal(sched[2], '1,2,1.2,B,,B,,2');
  const res = exportResults(picks, players).split('\r\n');
  assert.match(res[1], /^1,1,1,A,B,made,p1,/);
  assert.equal(toCsv([['a', 'b,c']]), 'a,"b,c"\r\n');
});
