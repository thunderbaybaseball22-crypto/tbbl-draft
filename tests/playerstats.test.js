import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPlayers, BAT_STATS, PIT_STATS } from '../public/js/lib/csv.js';

const HIT_HDR = 'PUID,Name,Team,P,Age,AVG,OBP,SPC,AB,H,2B,3B,HR,R,RBI,HBP,BB,K,SB,CS\n';
const PIT_HDR = 'Name,Team,P,Age,ERA,W,L,S,G,GS,CG,SHO,INN,H,R,ER,HR,HBP,BB,IW,K,GDP,PUID\n';
const hit = (puid, name, team = '', pos = 'c', age = 30) => `${puid},${name},${team},${pos},${age},0.276,0.328,0.447,170,47,10,2,5,20,21,2,11,50,3,1\n`;
const pit = (puid, name, team = '', pos = 'sp', age = 27) => `${name},${team},${pos},${age},2.87,10,7,0,9,29,1,1,166.1,148,60,53,19,3,43,0,149,10,${puid}\n`;

test('hitters + pitchers files load into one pool with numeric stats', () => {
  const r = loadPlayers({
    hitters: HIT_HDR + hit('30001', 'Al Hitter', 'NHH', 'ss', 25),
    pitchers: PIT_HDR + pit('40001', 'Bo Pitcher', 'JER', 'sp', 27),
  }, { teamCodes: ['NHH', 'JER'] });
  assert.deepEqual(r.errors, []);
  assert.equal(r.players.length, 2);
  const [h, p] = r.players;
  assert.deepEqual([h.id, h.name, h.pos, h.age, h.ownerTeam, h.kind], ['30001', 'Al Hitter', 'ss', 25, 'NHH', 'MLB']);
  assert.deepEqual(Object.keys(h.bat), BAT_STATS);
  assert.equal(h.bat.AVG, 0.276);
  assert.equal(h.bat.HR, 5);
  assert.equal(h.pit, undefined);
  assert.deepEqual([p.id, p.pos, p.ownerTeam], ['40001', 'sp', 'JER']);
  assert.deepEqual(Object.keys(p.pit), PIT_STATS);
  assert.equal(p.pit.ERA, 2.87);
  assert.equal(p.pit.INN, 166.1);
  assert.equal(p.bat, undefined);
  assert.equal('src' in h, false);
});

test('blank team means available; -1 players need no AAA column and get a key from the name', () => {
  const r = loadPlayers({
    hitters: HIT_HDR + hit('-1', 'Kemp aaaAlderman', 'SMC', 'rf', 23) + hit('30002', 'Free Agent'),
    pitchers: PIT_HDR + pit('-1', 'Kade aaaAnderson', 'OLS', 'sp', 21),
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.players.map((p) => [p.id, p.kind, p.aaa, p.ownerTeam]), [
    ['N-kemp_aaaalderman', 'Non-MLB', true, 'SMC'],
    ['30002', 'MLB', false, ''],
    ['N-kade_aaaanderson', 'Non-MLB', true, 'OLS'],
  ]);
  assert.equal(r.players[0].puid, '-1');
});

test('a two-way player in both files becomes one record with hitting and pitching stats', () => {
  const r = loadPlayers({
    hitters: HIT_HDR + hit('31236', 'Shohei Ohtani', 'SCA', 'dh', 31),
    pitchers: PIT_HDR + pit('31236', 'Shohei Ohtani', 'SCA', 'dh', 31),
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.players.length, 1);
  const o = r.players[0];
  assert.deepEqual([o.id, o.pos, o.ownerTeam], ['31236', 'dh', 'SCA']);
  assert.equal(o.bat.HR, 5);
  assert.equal(o.pit.ERA, 2.87);
  assert.equal(r.merges.length, 1);
  assert.match(r.merges[0].text, /Shohei Ohtani .* in both files/);
});

test('two-way player: different teams in the two files warns and keeps the first', () => {
  const r = loadPlayers({
    hitters: HIT_HDR + hit('31236', 'Two Way', 'SCA', 'dh'),
    pitchers: PIT_HDR + pit('31236', 'Two Way', 'KBB', 'dh'),
  });
  assert.equal(r.players[0].ownerTeam, 'SCA');
  assert.match(r.warnings.join('|'), /list different teams/);
});

test('the same ID twice in one file is an error (stat lines must be one row per player)', () => {
  const r = loadPlayers({
    hitters: HIT_HDR + hit('31350', 'Danny Jansen', 'RAV') + hit('31350', 'Danny Jansen'),
    pitchers: PIT_HDR + pit('40001', 'Bo Pitcher'),
  });
  assert.match(r.errors.join('|'), /Player ID 31350 is used by 2 rows \(lines hitters 2, hitters 3\)/);
});

test('a blank or non-numeric stat is an error naming the file, line, player and column', () => {
  const bad = HIT_HDR + '30003,Bad Row,,c,30,0.2,0.3,0.4,100,25,5,0,3,10,11,1,8,30,egular,0\n';
  const r = loadPlayers({ hitters: bad, pitchers: PIT_HDR + pit('40001', 'Bo Pitcher') });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /Hitters file, line 2: Bad Row has a blank or non-numeric SB \("egular"\)/);
  const blank = loadPlayers({ hitters: HIT_HDR + hit('30001', 'Ok'), pitchers: PIT_HDR + '"Bo, Pitcher",,sp,27,2.87,10,7,0,9,29,1,1,,148,60,53,19,3,43,0,149,10,40001\n' });
  assert.match(blank.errors.join('|'), /Pitchers file, line 2: .* non-numeric INN \(""\)/);
});

test('a stray row with no ID (like a pasted "Regular season" label) is an error, not silently dropped', () => {
  const r = loadPlayers({ hitters: HIT_HDR + hit('30001', 'Ok') + ',,,,R,egular,season,,,,,,,,,,,,,\n', pitchers: PIT_HDR + pit('40001', 'Bo Pitcher') });
  assert.match(r.errors.join('|'), /Hitters file, line 3: blank player ID/);
});

test('missing stat or ID columns are reported per file', () => {
  const r = loadPlayers({
    hitters: 'PUID,Name,Team,P,Age,AVG\n30001,Al,,c,30,0.3\n',
    pitchers: PIT_HDR.replace(',PUID', ',UID') + pit('40001', 'Bo Pitcher'),
  });
  assert.match(r.errors.join('|'), /Hitters file: Missing stat column OBP/);
  assert.match(r.errors.join('|'), /Pitchers file: Missing player ID column/);
  assert.deepEqual(r.players, []);
});

test('unknown team code is an error with the file and line', () => {
  const r = loadPlayers({ hitters: HIT_HDR + hit('30001', 'Al', 'ZZZ'), pitchers: PIT_HDR + pit('40001', 'Bo', 'JER') }, { teamCodes: ['JER'] });
  assert.match(r.errors.join('|'), /Hitters file, line 2: unknown team code ZZZ for Al/);
});

test('the single-file (no stats) format still works and has no stat objects', () => {
  const r = loadPlayers('PUID,FullName,TeamID,AAA,DOB\n12345,Real Guy,,,1-Jan-90\n');
  assert.deepEqual(r.errors, []);
  assert.equal(r.players[0].bat, undefined);
  assert.equal(r.players[0].pit, undefined);
});
