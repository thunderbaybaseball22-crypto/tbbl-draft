import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runScenario } from '../public/js/lib/scenario.js';

const read = (f) => readFileSync(new URL('../public/sample/' + f, import.meta.url), 'utf8');

test('demo walkthrough: pick, skip, late pick, trade, undo', () => {
  const r = runScenario({
    scheduleCsv: read('SAMPLE-DraftOrder.csv'),
    playersCsv: read('SAMPLE-players.csv'),
    ownersCsv: read('SAMPLE-owners.csv'),
  });
  const s = r.state;
  const types = r.audit.map((a) => a.type);
  assert.deepEqual(types, ['start', 'pick', 'skip', 'pick', 'trade', 'pick', 'undo', 'writein', 'writein-reject']);
  assert.equal(r.audit[3].late, true);                       // CCC's late pick
  assert.equal(s.picks[2].status, 'made');
  assert.equal(s.picks[2].ownerTeam, r.teams.own2);
  assert.equal(s.picks[3].origTeam, r.teams.own3);           // trade keeps original owner
  assert.equal(s.picks[3].ownerTeam, r.teams.newOwner3);
  assert.equal(s.picks[3].status, 'made');
  assert.equal(s.picks[1].status, 'open');                   // undone
  assert.equal(s.players[r.avail[0]].ownerTeam, '');
  assert.equal(s.config.currentPick, 1);                     // undone pick is back on the clock
  assert.ok(r.log.some((l) => /second write-in .* is blocked: REJECTED/.test(l)));
  assert.equal(s.picks[1].writeIn, null);                    // rejected write-in reopened the pick
  assert.ok(!('WI-1' in s.players));
  assert.ok(r.log.some((l) => /\(old owner\) tries to draft pick 3: REJECTED/.test(l)));
});
