// Unattended ticker logic. Pure apart from the `io` object it is given, so it is unit tested with an
// in-memory io and run for real by tools/ticker.mjs (firebase-admin, which bypasses the security rules).
// Because the rules are bypassed, EVERY business rule is enforced in code by the shared modules:
//   lib/tick.js -> lib/draft.js: draft is live, only the pick on the clock, owner's auto-draft is On,
//   first still-usable list entry (pool players and write-ins with the duplicate checks), an exhausted
//   list changes nothing, a player can only be taken once.
// Safety against other writers (browsers, Monitor Mode, a second ticker): every step is one
// transaction that first re-checks the stored values the step was based on (planWrites().expect) and
// that no `taken` marker already exists; on any mismatch it writes nothing (ConflictError), the runner
// reloads and re-evaluates, so a pick or skip already done by someone else is never done twice.
//
// io contract:
//   loadLight() -> { config, tickAt, pick, unfilled, queues:[{email,teams,autoDraft,items}], notices:{email:{overall,sig}} }
//       cheap: config, the pick on the clock, only that team's owners' lists, the last tick, and the number of unmade picks.
//   loadFull()  -> { config, picks:{n:pick}, basePlayers:[...], queues:[...], verifiedKeys:[] }
//   commit(plan) -> writes plan (see persist.planWrites) in one transaction; throws ConflictError if stale.
//   heartbeat(at), putNotice(email, {overall, sig, team, at}) (idempotent).
import { tick, autoDraftStatus } from './tick.js';
import { planWrites } from './persist.js';
import { derivePlayers } from './persist.js';
import { itemKey } from './queue.js';

export class ConflictError extends Error {
  constructor(msg = 'The draft changed underneath this step') { super(msg); this.name = 'ConflictError'; }
}

/** Signature of a list, so "exhausted" is only re-examined when the list changes. */
export const listSig = (items) => (items || []).map(itemKey).join('|');

/**
 * Cheap decision from the light load: is anything possibly due? Keeps the free-plan read count low.
 * (A full load is ~350 reads; a light load is ~6.)
 */
export function needsFullRun(light, now) {
  const c = light.config;
  if (!c) return false;
  if (c.status === 'pending') return c.startAt != null && now >= c.startAt;
  if (c.status !== 'live') return false;
  if (c.currentPick == null) return light.unfilled === 0; // everything made: close the draft
  if (c.deadline != null && now >= c.deadline) return true; // skip is due
  const p = light.pick;
  if (!p || p.status !== 'open') return false;
  for (const q of light.queues || []) {
    if (!q.autoDraft || !(q.teams || []).includes(p.ownerTeam)) continue;
    const n = (light.notices || {})[q.email];
    // already known to be exhausted for this pick with this very list: nothing new to try
    if (n && n.overall === p.overall && n.sig === listSig(q.items)) continue;
    return true;
  }
  return false;
}

const ctxOf = (full) => ({ isAdmin: true, queues: full.queues, verifiedKeys: new Set(full.verifiedKeys || []) });
const stateOf = (full) => ({ config: full.config, picks: full.picks, players: derivePlayers(full.basePlayers, full.picks, full.removed || {}) });

/**
 * One ticker run. Returns {ran, steps:[kind...], conflicts, notices}. Safe to run any number of times,
 * at the same moment as browsers or other tickers.
 */
export async function runTicker(io, nowFn = Date.now, { maxSteps = 500, maxReloads = 6 } = {}) {
  const out = { ran: false, steps: [], conflicts: 0, notices: [] };
  const light = await io.loadLight();
  const c0 = light.config;
  if (c0 && c0.status === 'live' && (light.tickAt == null || nowFn() - light.tickAt >= 2 * 60000)) await io.heartbeat(nowFn());
  if (!needsFullRun(light, nowFn())) return out;
  out.ran = true;
  let reloads = 0;
  let full = await io.loadFull();
  let state = stateOf(full);
  for (let i = 0; i < maxSteps; i++) {
    const r = tick(state, ctxOf(full), nowFn());
    if (!r.changed) break;
    try {
      await io.commit(planWrites(state, r.state, r.audit));
      state = r.state;
      out.steps.push(r.kind);
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      out.conflicts++;
      if (++reloads > maxReloads) break;
      full = await io.loadFull();
      state = stateOf(full);
    }
  }
  // Exhausted list: the clock keeps running; leave the owner a message (once per pick and list).
  const st = autoDraftStatus(state, ctxOf(full), nowFn());
  if (st.kind === 'exhausted') {
    const q = full.queues.find((x) => x.email === st.owner);
    const note = { overall: st.overall, team: st.team, sig: listSig(q && q.items), at: nowFn(), type: 'exhausted' };
    await io.putNotice(st.owner, note);
    out.notices.push({ email: st.owner, ...note });
  }
  return out;
}
