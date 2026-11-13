import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../public/js/lib/draft.js';
import { parseLink, normName } from '../public/js/lib/writein.js';
import { exportResults, exportNewPlayers, exportSchedule } from '../public/js/lib/csv.js';
import { etToUtc } from '../public/js/lib/clock.js';

const H = 3600000, MIN = 60000;
const T0 = etToUtc(2027, 6, 7, 11);
const admin = { email: 'comm@example.com', isAdmin: true, teams: [] };
const own = (t) => ({ email: `${t.toLowerCase()}@example.com`, isAdmin: false, teams: [t] });
const BR = 'https://www.baseball-reference.com/players/s/smithjo01.shtml';

function live() {
  const order = ['A', 'B', 'C', 'A', 'B', 'C'];
  const picks = order.map((t, i) => ({ overall: i + 1, round: Math.floor(i / 3) + 1, slot: (i % 3) + 1, origTeam: t, ownerTeam: t }));
  const players = [{ id: 'p1', name: 'José Pool-Player Jr.', ownerTeam: '' }, { id: 'p2', name: 'Other Guy', ownerTeam: 'C', puid: '123', aaa: false }];
  return D.startDraft(D.createState({ picks, players }), admin, T0).state;
}

test('link parsing: BR id extracted from player pages and register links; any http(s) URL accepted', () => {
  assert.equal(parseLink(BR).brId, 'smithjo01');
  assert.equal(parseLink('http://baseball-reference.com/players/s/smithjo01.shtml#x').urlKey, 'br:smithjo01');
  assert.equal(parseLink('https://www.baseball-reference.com/register/player.fcgi?id=AbC123').brId, 'abc123');
  const other = parseLink('https://example.com/hs/kid/');
  assert.equal(other.ok, true); assert.equal(other.brId, null); assert.equal(other.urlKey, 'example.com/hs/kid');
  assert.equal(parseLink('not a url').ok, false);
  assert.equal(parseLink('ftp://example.com/x').ok, false);
  assert.equal(normName('José  Pool-Player Jr.'), 'jose pool player');
});

test('write-in counts immediately, advances the clock, is flagged pending, and is a player on the roster', () => {
  const r = D.makeWriteIn(live(), own('A'), 1, { name: ' Joe   Smith ', url: BR }, T0 + 5 * MIN);
  const p = r.state.picks[1];
  assert.equal(p.status, 'made');
  assert.equal(p.playerId, 'WI-1');
  assert.deepEqual([p.writeIn.name, p.writeIn.status, p.writeIn.brId], ['Joe Smith', 'pending', 'smithjo01']);
  assert.equal(r.state.config.currentPick, 2);
  assert.equal(r.state.config.deadline, T0 + 5 * MIN + H);
  assert.equal(r.state.players['WI-1'].writeIn, true);
  assert.deepEqual(D.roster(r.state, 'A').map((x) => x.name), ['Joe Smith']);
  assert.equal(r.audit[0].type, 'writein');
});

test('write-in validation: name, link-or-note, bad url, ownership, not live', () => {
  const s = live();
  const t = (actor, o, input) => D.makeWriteIn(s, actor, o, input, T0);
  assert.throws(() => t(own('A'), 1, { name: '', url: BR }), /name/);
  assert.throws(() => t(own('A'), 1, { name: 'X Y' }), /link/);
  assert.throws(() => t(own('A'), 1, { name: 'X Y', url: 'nope' }), /valid web address/);
  assert.throws(() => t(own('B'), 1, { name: 'X Y', url: BR }), /belongs to A/);
  assert.equal(t(own('A'), 1, { name: 'X Y', note: 'HS shortstop, Tulsa OK, class of 2027' }).state.picks[1].writeIn.url, '');
  assert.equal(t(own('A'), 1, { name: 'X Y', url: 'https://example.com/p/1' }).state.picks[1].status, 'made');
  assert.throws(() => D.makeWriteIn(D.pause(s, admin, T0).state, own('A'), 1, { name: 'X Y', url: BR }, T0), /not live/);
});

test('name matching a pool player is blocked for owners; commissioner can override', () => {
  const s = live();
  assert.throws(() => D.makeWriteIn(s, own('A'), 1, { name: 'jose pool-player', url: BR }, T0), /already in the player pool/);
  assert.throws(() => D.makeWriteIn(s, own('A'), 1, { name: 'Other Guy', url: BR, override: true }, T0), /already in the player pool/); // owner cannot override
  const ok = D.makeWriteIn(s, admin, 1, { name: 'Other Guy', url: BR, override: true }, T0);
  assert.equal(ok.state.picks[1].writeIn.name, 'Other Guy');
  assert.equal(ok.audit[0].override, true);
});

test('duplicate write-ins are blocked by BR id (any URL spelling), by URL, and by name', () => {
  const s = D.makeWriteIn(live(), own('A'), 1, { name: 'Joe Smith', url: BR }, T0).state;
  const dup = (input) => assert.throws(() => D.makeWriteIn(s, own('B'), 2, input, T0), /already written in at pick #1/);
  dup({ name: 'Somebody Else', url: 'http://baseball-reference.com/register/player.fcgi?id=SMITHJO01' });
  dup({ name: 'Somebody Else', url: BR });
  dup({ name: 'joe smith', url: 'https://example.com/other' });
  const other = D.makeWriteIn(s, own('B'), 2, { name: 'Different Person', url: 'https://example.com/other' }, T0);
  assert.equal(other.state.picks[2].status, 'made');
  // non-BR links are compared by normalised URL
  const s2 = D.makeWriteIn(live(), own('A'), 1, { name: 'Kid One', url: 'https://www.Example.com/kid/' }, T0).state;
  assert.throws(() => D.makeWriteIn(s2, own('B'), 2, { name: 'Kid Two', url: 'https://example.com/kid' }, T0), /already written in/);
});

test('late write-in on a skipped pick keeps the clock where it is', () => {
  let s = D.expireIfDue(live(), T0 + H).state;
  const dl = s.config.deadline;
  s = D.makeWriteIn(s, own('A'), 1, { name: 'Late Guy', url: BR }, T0 + H + MIN);
  assert.equal(s.audit[0].late, true);
  assert.equal(s.state.config.deadline, dl);
});

test('confirm and edit; edit is revalidated against other write-ins', () => {
  let s = D.makeWriteIn(live(), own('A'), 1, { name: 'Joe Smith', url: BR }, T0).state;
  s = D.makeWriteIn(s, own('B'), 2, { name: 'Pat Jones', note: 'JC pitcher' }, T0).state;
  assert.throws(() => D.confirmWriteIn(s, own('A'), 1, T0), /commissioner/);
  assert.throws(() => D.confirmWriteIn(s, admin, 4, T0), /not a write-in/);
  const c = D.confirmWriteIn(s, admin, 1, T0 + MIN);
  assert.equal(c.state.picks[1].writeIn.status, 'confirmed');
  const e = D.editWriteIn(c.state, admin, 1, { name: 'Joseph Smith', url: 'https://example.com/js', note: '' }, T0 + 2 * MIN);
  assert.equal(e.state.players['WI-1'].name, 'Joseph Smith');
  assert.equal(e.state.picks[1].writeIn.status, 'confirmed');
  assert.deepEqual(e.audit[0].before, { name: 'Joe Smith', url: 'https://baseball-reference.com/players/s/smithjo01.shtml', note: '' });
  assert.throws(() => D.editWriteIn(e.state, admin, 1, { name: 'Pat Jones', url: 'https://example.com/js' }, T0), /already written in at pick #2/);
});

test('reject reopens the pick like an undo (fresh clock, player gone, audited); can be written in again', () => {
  let s = D.makeWriteIn(live(), own('A'), 1, { name: 'Joe Smith', url: BR }, T0 + MIN).state; // pick 2 on clock
  const r = D.rejectWriteIn(s, admin, 1, T0 + 10 * MIN);
  assert.equal(r.state.picks[1].status, 'open');
  assert.equal(r.state.picks[1].writeIn, null);
  assert.equal(r.state.picks[1].playerId, null);
  assert.ok(!('WI-1' in r.state.players));
  assert.equal(r.state.config.currentPick, 1);
  assert.equal(r.state.config.deadline, T0 + 10 * MIN + H);
  assert.equal(r.audit[0].type, 'writein-reject');
  assert.equal(r.audit[0].player, 'Joe Smith');
  assert.throws(() => D.rejectWriteIn(r.state, admin, 1, T0), /not a write-in/);
  assert.throws(() => D.rejectWriteIn(s, own('A'), 1, T0), /commissioner/);
  // the same player can be written in again after rejection
  assert.equal(D.makeWriteIn(r.state, own('A'), 1, { name: 'Joe Smith', url: BR }, T0 + 11 * MIN).state.picks[1].status, 'made');
});

test('plain undo of a write-in also removes the player; editPick replaces it with a pool player', () => {
  const s = D.makeWriteIn(live(), own('A'), 1, { name: 'Joe Smith', url: BR }, T0).state;
  assert.ok(!('WI-1' in D.undoPick(s, admin, 1, T0).state.players));
  const e = D.editPick(s, admin, 1, 'p1', T0).state;
  assert.equal(e.picks[1].writeIn, null);
  assert.equal(e.players.p1.ownerTeam, 'A');
  assert.ok(!('WI-1' in e.players));
});

test('exports: write-ins are PUID -1 / AAA with link; separate new-players CSV', () => {
  let s = D.makeWriteIn(live(), own('A'), 1, { name: 'Joe, "J" Smith', url: BR }, T0).state;
  s = D.makePick(s, own('B'), 2, 'p1', T0).state;
  s = D.makeWriteIn(s, own('C'), 3, { name: 'Kid Hs', note: 'HS, no BR page' }, T0).state;
  const picks = Object.values(s.picks);
  const res = exportResults(picks, s.players).split('\r\n');
  assert.equal(res[0], 'overall,round,pick_in_round,original_team,drafting_team,status,puid,aaa,player_name,write_in,write_in_status,link,baseball_reference_id,note,made_at_utc,made_by,pick_label,added_pick,void_note');
  assert.match(res[1], /^1,1,1,A,A,made,-1,AAA,"Joe, ""J"" Smith",yes,pending,https:\/\/baseball-reference\.com\/players\/s\/smithjo01\.shtml,smithjo01,,/);
  assert.match(res[2], /^2,1,2,B,B,made,p1,,José Pool-Player Jr\.,,,,,/);
  assert.match(res[3], /^3,1,3,C,C,made,-1,AAA,Kid Hs,yes,pending,,,"HS, no BR page",/);
  const np = exportNewPlayers(picks).split('\r\n');
  assert.equal(np[0], 'puid,aaa,player_name,drafting_team,round,pick_in_round,overall,link,baseball_reference_id,note,verification');
  assert.equal(np.length, 4); // header, 2 rows, trailing empty
  assert.match(np[1], /^-1,AAA,"Joe, ""J"" Smith",A,1,1,1,/);
  assert.match(exportSchedule(picks, s.players), /Kid Hs \(WRITE-IN\)/);
  // rejected write-ins disappear from the new-players export
  const rej = D.rejectWriteIn(s, admin, 1, T0).state;
  assert.equal(exportNewPlayers(Object.values(rej.picks)).split('\r\n').length, 3);
});
