// Scripted walkthrough used by both the offline demo page and the automated test.
// Shows: a pick, a skip, a late pick, a pick trade (with a rejected old owner), and an undo.

import { loadSchedule, loadPlayers, loadOwners } from './csv.js';
import * as D from './draft.js';
import { etToUtc } from './clock.js';

const HOUR = 3600000, MIN = 60000;
const fmt = (t) => new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' ET';

export function runScenario({ scheduleCsv, playersCsv, ownersCsv }) {
  const sch = loadSchedule(scheduleCsv);
  const pl = loadPlayers(playersCsv, { teamCodes: sch.teams });
  const ow = loadOwners(ownersCsv, { teamCodes: sch.teams });
  const errs = [...sch.errors, ...pl.errors, ...ow.errors];
  if (errs.length) throw new Error('Sample data invalid: ' + errs.join('; '));

  const admin = { email: 'commissioner@example.com', isAdmin: true, teams: [] };
  const owner = (team) => ({ email: ow.owners.find((o) => o.teams.includes(team)).email, isAdmin: false, teams: [team] });
  const avail = pl.players.filter((p) => !p.ownerTeam).map((p) => p.id);
  const own1 = sch.picks[0].ownerTeam, own2 = sch.picks[1].ownerTeam, own3 = sch.picks[2].ownerTeam;
  const newOwner3 = sch.picks.slice(3).find((p) => p.ownerTeam !== own3 && p.ownerTeam !== own1 && p.ownerTeam !== own2).ownerTeam;

  let s = D.createState({ picks: sch.picks, players: pl.players, clockMinutes: 60 });
  let t = etToUtc(2027, 6, 7, 11, 0); // Monday 11:00 ET
  const audit = [], log = [];
  const say = (m) => log.push(`[${fmt(t)}] ${m}`);
  const apply = (r) => { s = r.state; audit.push(...r.audit); };
  const clockLine = () => {
    const c = s.config;
    return c.currentPick == null ? 'no pick on the clock' :
      `pick ${c.currentPick} (${s.picks[c.currentPick].ownerTeam}) on the clock, deadline ${fmt(c.deadline)}`;
  };
  const tryDo = (label, fn) => {
    try { apply(fn()); say(`${label}: OK`); return null; }
    catch (e) { say(`${label}: REJECTED (${e.message})`); return e; }
  };

  say('Commissioner starts the draft'); apply(D.startDraft(s, admin, t)); say(clockLine());

  // 1. a normal pick
  t += 20 * MIN;
  tryDo(`${own1} drafts ${s.players[avail[0]].name} at pick 1`, () => D.makePick(s, owner(own1), 1, avail[0], t));
  say(clockLine());

  // 2. the clock runs out on pick 2 -> skipped
  t += 61 * MIN;
  const ex = D.expireIfDue(s, t); apply(ex);
  say(`Clock expired: pick 2 is ${s.picks[2].status}. ${clockLine()}`);

  // 3. skipped owner picks late
  t += 10 * MIN;
  tryDo(`${own2} makes its late pick 2 (${s.players[avail[1]].name})`, () => D.makePick(s, owner(own2), 2, avail[1], t));
  say(`Pick 2 is ${s.picks[2].status}; ${clockLine()}`);

  // 4. trade pick 3 to another team
  tryDo(`Commissioner trades pick 3 ${own3} -> ${newOwner3}`, () => D.tradePick(s, admin, 3, newOwner3, 'demo trade', t));
  say(`Pick 3 original=${s.picks[3].origTeam}, owner=${s.picks[3].ownerTeam}`);
  tryDo(`${own3} (old owner) tries to draft pick 3`, () => D.makePick(s, owner(own3), 3, avail[2], t));
  t += 5 * MIN;
  tryDo(`${newOwner3} (new owner) drafts ${s.players[avail[2]].name} at pick 3`, () => D.makePick(s, owner(newOwner3), 3, avail[2], t));
  say(clockLine());

  // 5. undo pick 1
  t += 5 * MIN;
  tryDo('Commissioner undoes pick 1', () => D.undoPick(s, admin, 1, t));
  say(`Pick 1 is ${s.picks[1].status}, ${s.players[avail[0]].name} is available again. ${clockLine()}`);

  // 6. write-in pick (player not in the pool), then the commissioner rejects it
  t += 5 * MIN;
  tryDo(`${own1} writes in a player who is not in the pool at pick 1`, () => D.makeWriteIn(s, owner(own1), 1, { name: 'Sample Draftee Nine', url: 'https://www.baseball-reference.com/register/player.fcgi?id=sample01' }, t));
  say(`Pick 1 is ${s.picks[1].status} (write-in ${s.picks[1].writeIn?.status}); ${clockLine()}`);
  tryDo('A second write-in of the same player at pick 4 is blocked', () => D.makeWriteIn(s, owner(s.picks[4].ownerTeam), 4, { name: 'S. Draftee Nine', url: 'https://baseball-reference.com/register/player.fcgi?id=SAMPLE01' }, t));
  t += 5 * MIN;
  tryDo('Commissioner rejects the write-in', () => D.rejectWriteIn(s, admin, 1, t));
  say(`Pick 1 is ${s.picks[1].status} again; ${clockLine()}`);

  return { state: s, audit, log, avail, admin, teams: { own1, own2, own3, newOwner3 } };
}
