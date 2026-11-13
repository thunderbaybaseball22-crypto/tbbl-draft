// The ONE place that decides what the draft clock should do next. Pure: no DOM, no Firebase.
// The browser calls it once a second today; a scheduled Cloud Function (Blaze plan) could call
// the same function later with ctx.queues loaded from the database.
//
// tick(state, ctx, now) performs at most one step and returns {state, audit, changed, kind}:
//   'start'    the start time has arrived
//   'autopick' the pick on the clock belongs to a team whose owner has auto-draft On and a usable entry
//   'skip'     the pick on the clock ran out of time
//   'confirm'  (commissioner only) a write-in the commissioner verified ahead of time
//   'complete' (commissioner only) every pick is made
// ctx = { isAdmin, queues: [{email, teams, autoDraft, items}], verifiedKeys: Set<normalised write-in name> }
// Auto-draft runs BEFORE the skip, so a pick whose owner's list can fill it is never skipped just
// because nobody had a browser open when it arrived.
import { startIfDue, autoDraft, expireIfDue, completeIfDone, confirmWriteIn } from './draft.js';

const noChange = (state) => ({ state, audit: [], changed: false, kind: null });
const SYSTEM_ADMIN = { email: 'system', isAdmin: true, teams: [] };

/** Which listed owner (if any) would auto-draft the pick on the clock, and why not otherwise. */
export function autoDraftStatus(state, ctx, now) {
  const c = state.config;
  if (c.status !== 'live' || c.currentPick == null) return { kind: 'none' };
  const p = state.picks[c.currentPick];
  if (!p || p.status !== 'open') return { kind: 'none' };
  const q = (ctx.queues || []).find((x) => (x.teams || []).includes(p.ownerTeam) && x.autoDraft);
  if (!q) return { kind: 'none' };
  const r = autoDraft(state, q, q, now);
  return { kind: r.reason, owner: q.email, team: p.ownerTeam, overall: p.overall };
}

export function tick(state, ctx, now) {
  let r = startIfDue(state, now);
  if (r.changed) return { ...r, kind: 'start' };
  for (const q of ctx.queues || []) {
    if (!q.autoDraft) continue;
    r = autoDraft(state, q, q, now);
    if (r.changed) return { ...r, kind: 'autopick' };
  }
  r = expireIfDue(state, now);
  if (r.changed) return { ...r, kind: 'skip' };
  if (ctx.isAdmin) {
    for (const p of Object.values(state.picks)) {
      if (p.status === 'made' && p.writeIn && p.writeIn.status === 'pending' && ctx.verifiedKeys && ctx.verifiedKeys.has(p.writeIn.nameKey)) {
        const x = confirmWriteIn(state, SYSTEM_ADMIN, p.overall, now);
        return { ...x, changed: true, kind: 'confirm' };
      }
    }
    r = completeIfDone(state, now);
    if (r.changed) return { ...r, kind: 'complete' };
  }
  return noChange(state);
}

/**
 * What the commissioner's Monitor Mode page shows. Pure.
 * tickAt = when any browser last recorded a clock check (ticks/last); windowOpen = isOpen(now) (11 AM-11 PM ET).
 * stale = live draft, clock window open, and no recorded check for more than staleMs (default 6 minutes).
 */
export function monitorStatus({ now, tickAt, deadline, status, windowOpen }, staleMs = 6 * 60000) {
  const ageMs = tickAt ? Math.max(0, now - tickAt) : null;
  const live = status === 'live';
  const stale = live && windowOpen && (ageMs == null || ageMs > staleMs);
  return { ageMs, stale, live, msToDeadline: live && deadline != null ? deadline - now : null };
}

/** Run tick repeatedly until nothing is left to do (used by tests and a future scheduled function). */
export function tickAll(state, ctx, now, max = 1000) {
  const audit = [];
  let s = state;
  for (let i = 0; i < max; i++) {
    const r = tick(s, ctx, now);
    if (!r.changed) break;
    s = r.state; audit.push(...r.audit);
  }
  return { state: s, audit };
}
