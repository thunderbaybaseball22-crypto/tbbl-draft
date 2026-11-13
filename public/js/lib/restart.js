// Commissioner "Restart draft": the plan of document writes, with no Firebase and no DOM here (store.js runs it).
//
// Restart: all picks open, skips cleared, write-ins removed, taken markers (drafted players) cleared,
// draft back to not-started (start time and clock length unchanged), trades reverted to the imported
// draft order, added picks deleted, voids cleared, group email switched OFF and its batch state reset, audit log cleared plus ONE entry for
// the restart, password-set requests and owner notices cleared.
// Kept: players, draft order, owners and logins, each owner's draft list and Auto-draft setting, keeper markers.
//
// Safe to interrupt and to run again (every write sets a fixed final value or deletes):
//   1. header (one batch): config/restart marker, draft config -> pending (nobody can pick, the clock and
//      the ticker stand still), group emails OFF, group email state deleted;
//   2. body (chunks): picks reset, taken markers deleted, notices / password requests / audit log deleted;
//   3. footer (one batch): the single audit entry (fixed id) and removal of the marker.
// If it stops part way the marker stays, the draft stays not-started and the UI says "run Restart again".
import { cfgOut, pickOut } from './persist.js';

export const RESTART_WORD = 'RESTART';
export const CHUNK = 400; // Firestore allows 500 writes per batch

/** The typed word must be exactly RESTART (spaces around it are ignored; case matters). */
export const confirmOk = (typed) => String(typed == null ? '' : typed).trim() === RESTART_WORD;

/** Why a restart (or a re-import that resets picks) is not allowed right now, or null. */
export function lockedReason(lock) {
  return lock && lock.locked === true
    ? 'The real-draft lock is ON. Restart and the re-imports that reset picks are disabled until you turn the lock off (Commissioner tab, section 3).'
    : null;
}

/**
 * Where each pick was owned when the draft order was imported. New imports store it on the pick
 * (importedOwner). Older data does not have it: the earliest trade in the audit log recorded the owner it
 * was traded away from; with no trade the current owner is the imported one.
 */
export function importedOwners(picks, auditDocs = []) {
  const firstFrom = {};
  for (const a of [...auditDocs].sort((x, y) => (x.at || 0) - (y.at || 0))) {
    if (a && a.type === 'trade' && a.overall != null && a.from && !(a.overall in firstFrom)) firstFrom[a.overall] = a.from;
  }
  const out = {};
  for (const k of Object.keys(picks)) {
    const p = picks[k];
    out[k] = p.importedOwner || firstFrom[p.overall] || p.ownerTeam;
  }
  return out;
}

/**
 * ops: [{ op:'set'|'delete', path:'coll/id', data? }] in three phases.
 * in: { config, picks:{n:pick}, emailCfg, takenDocs:[{id, overall}], auditDocs:[{id, ...}], noticeIds, pwRequestIds, pwStatusIds, by, now }
 */
export function planRestart(i) {
  const c = i.config || {};
  const owners = importedOwners(i.picks, i.auditDocs);
  // A re-run after an interruption sees fewer used picks, so the count carries over in the marker.
  const picksCleared = Math.max(i.prevPicksCleared || 0, Object.values(i.picks).filter((p) => !p.added && p.status !== 'open').length);
  const header = [
    { op: 'set', path: 'config/restart', data: { at: i.now, by: i.by, picksCleared } },
    { op: 'set', path: 'config/draft', data: cfgOut({ status: 'pending', startAt: c.startAt ?? null, clockMinutes: c.clockMinutes ?? 60, currentPick: null, deadline: null, remainingMs: null, allowPickWhenClockPaused: c.allowPickWhenClockPaused }) },
    { op: 'set', path: 'config/email', data: { groupEmails: false, enabledAt: (i.emailCfg && i.emailCfg.enabledAt) || null, by: i.by, at: i.now } },
    { op: 'delete', path: 'groupMail/state' },
  ];
  const body = [];
  for (const k of Object.keys(i.picks).sort((a, b) => a - b)) {
    const p = i.picks[k];
    if (p.added) { body.push({ op: 'delete', path: `picks/${k}` }); continue; } // added picks do not exist in the imported order
    body.push({ op: 'set', path: `picks/${k}`, data: pickOut({
      overall: p.overall, round: p.round, slot: p.slot, origTeam: p.origTeam, ownerTeam: owners[k], importedOwner: owners[k],
      status: 'open', playerId: null, wasSkipped: false, skippedAt: null, madeBy: null, madeAt: null, writeIn: null,
    }) });
  }
  // Keepers (players already owned by a team, overall 0) stay; every marker made by a pick goes.
  for (const t of i.takenDocs || []) if (!(t.overall === 0)) body.push({ op: 'delete', path: `taken/${t.id}` });
  for (const id of i.noticeIds || []) body.push({ op: 'delete', path: `notices/${id}` });
  for (const id of i.pwRequestIds || []) body.push({ op: 'delete', path: `pwRequests/${id}` });
  for (const id of i.pwStatusIds || []) body.push({ op: 'delete', path: `pwStatus/${id}` });
  for (const a of i.auditDocs || []) body.push({ op: 'delete', path: `audit/${a.id}` });
  const footer = [
    { op: 'set', path: `audit/restart-${i.now}`, data: { type: 'restart', by: i.by, at: i.now, picksCleared, tradesReverted: Object.keys(i.picks).filter((k) => !i.picks[k].added && i.picks[k].ownerTeam !== owners[k]).length, ...extraCounts(i.picks) } },
    { op: 'delete', path: 'config/restart' },
  ];
  return { header, body, footer, batches: [header, ...chunk(body), footer] };
}

/** Only present when the restart actually removed added picks / cleared voids (keeps old audit records unchanged). */
function extraCounts(picks) {
  const added = Object.values(picks).filter((p) => p.added).length, voids = Object.values(picks).filter((p) => p.status === 'void').length;
  return { ...(added ? { addedRemoved: added } : {}), ...(voids ? { voidsCleared: voids } : {}) };
}

function chunk(ops) {
  const out = [];
  for (let n = 0; n < ops.length; n += CHUNK) out.push(ops.slice(n, n + CHUNK));
  return out;
}

/** Run the plan batch by batch through commitBatch(ops). A thrown error leaves the marker in place (re-run). */
export async function runPlan(plan, commitBatch) {
  for (const b of plan.batches) await commitBatch(b);
}
