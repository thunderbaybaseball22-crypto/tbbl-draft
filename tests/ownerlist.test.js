import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as D from '../public/js/lib/draft.js';
import { tick, autoDraftStatus } from '../public/js/lib/tick.js';
import { tickQueues, queueOwnerWarning } from '../public/js/lib/queue.js';
import { etToUtc } from '../public/js/lib/clock.js';

const T0 = etToUtc(2027, 6, 7, 11);
const COMM = 'comm@example.com';
const admin = { email: COMM, isAdmin: true, teams: [] };

function live() {
  const order = ['JER', 'BEA', 'JER'];
  const picks = order.map((t, i) => ({ overall: i + 1, round: 1, slot: i + 1, origTeam: t, ownerTeam: t }));
  const players = Array.from({ length: 5 }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}`, ownerTeam: '' }));
  return D.startDraft(D.createState({ picks, players, clockMinutes: 60 }), admin, T0).state;
}
const wi = (name) => ({ writeIn: { name, url: '', note: 'HS SS' } });
// What the commissioner's browser builds: owners file + every queue doc, keyed by login email.
const commCtx = (owners, queues) => ({ isAdmin: true, queues: tickQueues({ isAdmin: true, email: COMM, teams: [], ownQueue: { items: [], autoDraft: false }, owners, queues }), verifiedKeys: new Set() });

test('(a) commissioner who is also the owner of JER: their list is the JER list and auto-draft uses it', () => {
  const owners = [{ email: COMM, teams: ['JER'] }, { email: 'bea@example.com', teams: ['BEA'] }];
  const ctx = commCtx(owners, { [COMM]: { items: ['p3'], autoDraft: true } });
  assert.deepEqual(ctx.queues.map((q) => [q.email, q.teams]), [[COMM, ['JER']]]);
  const r = tick(live(), ctx, T0 + 1000);
  assert.equal(r.kind, 'autopick');
  assert.equal(r.state.picks[1].playerId, 'p3');
  // the same login without commissioner rights (own window) builds the same single list
  const own = tickQueues({ isAdmin: false, email: 'Comm@Example.com', teams: ['JER'], ownQueue: { items: ['p3'], autoDraft: true }, owners: [], queues: {} });
  assert.deepEqual(own.map((q) => [q.email, q.teams, q.items]), [[COMM, ['JER'], ['p3']]]);
});

test('(b) a write-in on the list is auto-drafted, pending verification, from the commissioner window / Monitor / ticker context', () => {
  const owners = [{ email: COMM, teams: ['JER'] }];
  const ctx = commCtx(owners, { [COMM]: { items: [wi('Pat Prospect')], autoDraft: true } });
  const r = tick(live(), ctx, T0 + 1000);
  assert.equal(r.kind, 'autopick');
  const p = r.state.picks[1];
  assert.equal(p.status, 'made');
  assert.equal(p.playerId, 'WI-1');
  assert.equal(p.writeIn.name, 'Pat Prospect');
  assert.equal(p.writeIn.status, 'pending');
  assert.equal(r.state.config.currentPick, 2);
  // Auto-draft Off: nothing happens
  const off = commCtx(owners, { [COMM]: { items: [wi('Pat Prospect')], autoDraft: false } });
  assert.equal(tick(live(), off, T0 + 1000).changed, false);
});

test('(b) the pick is only drafted for the team that owns it (a list on a login that owns another team is not used)', () => {
  const owners = [{ email: COMM, teams: ['BEA'] }, { email: 'jer@example.com', teams: ['JER'] }];
  const ctx = commCtx(owners, { [COMM]: { items: [wi('Pat Prospect')], autoDraft: true } });
  assert.equal(tick(live(), ctx, T0 + 1000).changed, false);
});

test('rehearsal scenario: list on the commissioner login, but JER mapped to a different login -> nothing drafted, no warning', () => {
  const owners = [{ email: 'comm+jer@example.com', teams: ['JER'] }];
  const ctx = commCtx(owners, { [COMM]: { items: [wi('Pat Prospect')], autoDraft: true } });
  assert.deepEqual(ctx.queues, []); // the commissioner login owns no team: its list is never consulted
  assert.equal(tick(live(), ctx, T0 + 1000).changed, false);
  assert.equal(autoDraftStatus(live(), ctx, T0 + 1000).kind, 'none');
});

test('(c) a login that owns no team is told its list can never be used', () => {
  assert.match(queueOwnerWarning([], true), /commissioner.*never be auto-drafted/);
  assert.match(queueOwnerWarning([], false), /not linked to a team/);
  assert.equal(queueOwnerWarning(['JER'], true), '');
  assert.deepEqual(tickQueues({ isAdmin: false, email: 'x@example.com', teams: [], ownQueue: { items: ['p1'], autoDraft: true }, owners: [], queues: {} }), []);
  const ui = readFileSync(new URL('../public/js/ui.js', import.meta.url), 'utf8');
  assert.ok(ui.includes('queueOwnerWarning(r.teams, r.isAdmin)'), 'Queue tab must show the warning');
});

test('(d) auto-draft On but nothing usable (duplicate write-ins, drafted players) -> exhausted warning for that login', () => {
  const owners = [{ email: COMM, teams: ['JER'] }];
  // "Rob Capizzano" was already written in earlier by BEA, so the same name on JER's list is a duplicate
  let s = live();
  s = D.makePick(s, admin, 1, 'p1', T0 + 1000).state; // pick 2 (BEA) now on the clock
  s = D.makeWriteIn(s, admin, 2, { name: 'Rob Capizzano', note: 'x' }, T0 + 2000).state; // pick 3 (JER) on the clock
  const ctx = commCtx(owners, { [COMM]: { items: [wi('rob  capizzano'), 'p1'], autoDraft: true } });
  const r = tick(s, ctx, T0 + 3000);
  assert.equal(r.changed, false);
  const st = autoDraftStatus(s, ctx, T0 + 3000);
  assert.equal(st.kind, 'exhausted');
  assert.equal(st.owner, COMM);
  assert.equal(st.team, 'JER');
  // an empty list is also exhausted
  assert.equal(autoDraftStatus(s, commCtx(owners, { [COMM]: { items: [], autoDraft: true } }), T0 + 3000).kind, 'exhausted');
});

test('queue buttons render real symbols with accessible names (no literal "?" placeholders)', () => {
  const ui = readFileSync(new URL('../public/js/ui.js', import.meta.url), 'utf8');
  assert.ok(!/>\?<\/button>/.test(ui));
  for (const [attr, sym, name] of [['data-qup', '&uarr;', 'Move up'], ['data-qdown', '&darr;', 'Move down'], ['data-qdel', '&times;', 'Remove']]) {
    const line = ui.split('\n').find((l) => l.includes(attr));
    assert.ok(line.includes(`aria-label="${name}" title="${name}">${sym}</button>`), attr);
  }
});
