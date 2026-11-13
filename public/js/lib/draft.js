// Pure draft state machine. No DOM, no Firebase. Every function takes a state and
// returns {state, audit} (a NEW state; the input is never mutated) or throws DraftError.
//
// state = {
//   config: { status: 'pending'|'live'|'paused'|'complete', startAt, clockMinutes,
//             currentPick, deadline, remainingMs },
//   picks:   { [overall]: { overall, round, slot, origTeam, ownerTeam,
//                           status: 'open'|'skipped'|'made', playerId, wasSkipped, skippedAt, madeBy, madeAt } },
//   players: { [id]: { id, name, pos, mlbTeam, ownerTeam ('' = available), drafted (overall|null) } },
// }
// actor = { email, isAdmin, teams: ['NHH', ...] }   times are epoch milliseconds.
//
// Clock rules: the clock runs on the earliest `open` pick (skipped picks never get a clock).
// When it expires the pick becomes `skipped` and the clock moves on. An owner may fill only
// the pick on the clock (if their team owns it) and any skipped pick their team owns (late picks,
// in any order). The commissioner may fill any unmade pick at any time. A pick goes on the clock the\n// moment the pick before it is made, at any hour; outside 11 AM-11 PM ET the countdown simply waits\n// (owners may still pick unless the commissioner turned allowPickWhenClockPaused off).\n// Auto-draft (see autoDraft below) only ever picks from the owner's own list, and only when switched on.

import { addOpenTime, remainingOpenMs, isOpen } from './clock.js';
import { checkWriteIn } from './writein.js';
import { orderKey, pickLabel, overallLabel, MAX_ADDED_PER_PICK } from './pickno.js';

export class DraftError extends Error {
  constructor(message, code = 'invalid') { super(message); this.name = 'DraftError'; this.code = code; }
}

const MIN = 60000;
const clone = (s) => structuredClone(s);
const fail = (m, c) => { throw new DraftError(m, c); };
const clockMs = (s) => s.config.clockMinutes * MIN;

export function createState({ picks, players, clockMinutes = 60, startAt = null }) {
  const s = {
    config: { status: 'pending', startAt, clockMinutes, currentPick: null, deadline: null, remainingMs: null, allowPickWhenClockPaused: true },
    picks: {}, players: {},
  };
  for (const p of picks) {
    s.picks[p.overall] = {
      overall: p.overall, round: p.round, slot: p.slot, origTeam: p.origTeam, ownerTeam: p.ownerTeam,
      status: 'open', playerId: null, wasSkipped: false, skippedAt: null, madeBy: null, madeAt: null, writeIn: null,
    };
  }
  for (const pl of players) s.players[pl.id] = { ...pl, ownerTeam: pl.ownerTeam || '', drafted: null };
  return s;
}

const entry = (type, actor, now, details) => ({ type, by: actor ? actor.email : 'system', at: now, ...details });
const requireAdmin = (actor) => { if (!actor || !actor.isAdmin) fail('Only the commissioner can do that', 'forbidden'); };
const allPicks = (s) => Object.values(s.picks).sort((a, b) => a.overall - b.overall);

/** Earliest pick that is still `open` (not skipped, not made), or null. */
export function earliestOpen(s) {
  const p = allPicks(s).find((x) => x.status === 'open');
  return p ? p.overall : null;
}
const unfilled = (s) => allPicks(s).filter((x) => x.status !== 'made' && x.status !== 'void').length;

/** Put the earliest open pick on the clock with a fresh full clock. Mutates the (cloned) state. */
function putOnClock(s, now) {
  const c = s.config;
  if (unfilled(s) === 0) { c.status = 'complete'; c.currentPick = null; c.deadline = null; c.remainingMs = null; return; }
  const n = earliestOpen(s);
  c.currentPick = n;
  c.deadline = null; c.remainingMs = null;
  if (n === null) return; // only skipped picks remain: no clock, owners may still fill them
  if (c.status === 'live') c.deadline = addOpenTime(now, clockMs(s));
  else if (c.status === 'paused') c.remainingMs = clockMs(s);
}

export function startDraft(state, actor, now) {
  requireAdmin(actor);
  if (state.config.status !== 'pending') fail('Draft already started');
  const s = clone(state);
  s.config.status = 'live';
  putOnClock(s, now);
  return { state: s, audit: [entry('start', actor, now, {})] };
}

/** Auto-start when the designated start time has arrived (any client may trigger). */
export function startIfDue(state, now) {
  const c = state.config;
  if (c.status !== 'pending' || !c.startAt || now < c.startAt) return { state, audit: [], changed: false };
  const s = clone(state);
  s.config.status = 'live';
  putOnClock(s, now);
  return { state: s, audit: [entry('start', null, now, { auto: true })], changed: true };
}

export function setStartAt(state, actor, startAt, now) {
  requireAdmin(actor);
  if (state.config.status !== 'pending') fail('Start time can only be changed before the draft starts');
  const s = clone(state);
  s.config.startAt = startAt;
  return { state: s, audit: [entry('startAt', actor, now, { startAt })] };
}

export function pause(state, actor, now) {
  requireAdmin(actor);
  if (state.config.status !== 'live') fail('Draft is not live');
  const s = clone(state);
  const c = s.config;
  if (c.deadline != null) c.remainingMs = remainingOpenMs(now, c.deadline);
  c.deadline = null;
  c.status = 'paused';
  return { state: s, audit: [entry('pause', actor, now, { remainingMs: c.remainingMs })] };
}

export function resume(state, actor, now) {
  requireAdmin(actor);
  if (state.config.status !== 'paused') fail('Draft is not paused');
  const s = clone(state);
  const c = s.config;
  c.status = 'live';
  if (c.currentPick != null) {
    c.deadline = addOpenTime(now, c.remainingMs ?? clockMs(s));
    c.remainingMs = null;
  } else {
    putOnClock(s, now);
  }
  return { state: s, audit: [entry('resume', actor, now, {})] };
}

/**
 * Change clock length. The pick currently on the clock keeps the same FRACTION of its
 * clock remaining (e.g. half used stays half used); later picks get the full new length.
 */
export function setClockMinutes(state, actor, minutes, now) {
  requireAdmin(actor);
  if (!(Number(minutes) > 0)) fail('Clock length must be a positive number of minutes');
  const s = clone(state);
  const c = s.config;
  const oldMs = clockMs(s);
  const newMs = Number(minutes) * MIN;
  if (c.status === 'live' && c.deadline != null) {
    const ratio = Math.min(1, remainingOpenMs(now, c.deadline) / oldMs);
    c.deadline = addOpenTime(now, ratio * newMs);
  } else if (c.status === 'paused' && c.remainingMs != null) {
    c.remainingMs = Math.min(1, c.remainingMs / oldMs) * newMs;
  }
  c.clockMinutes = Number(minutes);
  return { state: s, audit: [entry('clock', actor, now, { from: oldMs / MIN, to: Number(minutes) })] };
}

function checkAvailable(s, playerId) {
  const pl = s.players[playerId];
  if (!pl) fail(`Unknown player ${playerId}`, 'no-player');
  if (pl.removed) fail(`${pl.name} was removed from the draft list`, 'removed');
  if (pl.ownerTeam || pl.drafted != null) fail(`${pl.name} is not available`, 'taken');
  return pl;
}

/** True if an owner (not the commissioner) may fill this pick now: on the clock, or skipped earlier. */
const ownerTurn = (state, p) => p.status === 'skipped' || state.config.currentPick === p.overall;

export function canPick(state, actor, overall, now = null) {
  const p = state.picks[overall];
  if (!p || p.status === 'made' || p.status === 'void') return false;
  const st = state.config.status;
  if (actor && actor.isAdmin) return st === 'live' || st === 'paused';
  return st === 'live' && !!actor && (actor.teams || []).includes(p.ownerTeam) && ownerTurn(state, p)
    && (now == null || windowAllows(state, now));
}

/** Commissioner switch: when false, owners can pick only while the clock window (11 AM-11 PM ET) is open. */
const windowAllows = (state, now) => state.config.allowPickWhenClockPaused !== false || isOpen(now);

/** Owner-side checks shared by makePick and makeWriteIn. */
function checkOwnerMayPick(state, actor, p0, now) {
  if (actor && actor.isAdmin) return;
  if (!(actor && (actor.teams || []).includes(p0.ownerTeam))) fail(`Pick ${p0.overall} belongs to ${p0.ownerTeam}, not to you`, 'forbidden');
  if (!ownerTurn(state, p0)) fail(`Pick ${p0.overall} is not on the clock yet. You can make it when it comes up.`, 'not-your-turn');
  if (!windowAllows(state, now)) fail('The commissioner has limited picks to 11:00 AM-11:00 PM Eastern. Try again when the window opens.', 'closed-hours');
}

export function makePick(state, actor, overall, playerId, now) {
  const p0 = state.picks[overall];
  if (!p0) fail(`No such pick ${overall}`);
  if (p0.status === 'made') fail(`Pick ${overall} has already been made`);
  if (p0.status === 'void') fail(`Pick ${pickLabel(p0)} is voided and cannot be drafted`, 'void');
  const st = state.config.status;
  if (!(st === 'live' || (st === 'paused' && actor && actor.isAdmin))) fail('The draft is not live', 'not-live');
  checkOwnerMayPick(state, actor, p0, now);
  checkAvailable(state, playerId);
  const s = clone(state);
  const p = s.picks[overall], pl = s.players[playerId];
  const late = p.status === 'skipped';
  p.status = 'made'; p.playerId = playerId; p.madeBy = actor.email; p.madeAt = now;
  pl.ownerTeam = p.ownerTeam; pl.drafted = overall;
  if (s.config.currentPick === overall || unfilled(s) === 0) putOnClock(s, now);
  return { state: s, audit: [entry('pick', actor, now, { overall, team: p.ownerTeam, playerId, player: pl.name, late, onBehalf: !!actor.isAdmin && !(actor.teams || []).includes(p.ownerTeam) })] };
}

/** Skip the pick on the clock if its deadline has passed. Skips at most one pick per call. */
export function expireIfDue(state, now) {
  const c = state.config;
  if (c.status !== 'live' || c.currentPick == null || c.deadline == null || now < c.deadline) {
    return { state, audit: [], changed: false };
  }
  const s = clone(state);
  const p = s.picks[c.currentPick];
  p.status = 'skipped'; p.wasSkipped = true; p.skippedAt = now;
  putOnClock(s, now);
  return { state: s, audit: [entry('skip', null, now, { overall: p.overall, team: p.ownerTeam })], changed: true };
}

/**
 * Mark a live draft complete once every pick is made and no pick is on the clock. The live site
 * runs this from the commissioner's browser (the security rules do not let owners close the draft).
 */
export function completeIfDone(state, now) {
  const c = state.config;
  if (c.status !== 'live' || c.currentPick != null || unfilled(state) !== 0) return { state, audit: [], changed: false };
  const s = clone(state);
  s.config.status = 'complete'; s.config.deadline = null; s.config.remainingMs = null;
  return { state: s, audit: [entry('complete', null, now, {})], changed: true };
}

export function tradePick(state, actor, overall, toTeam, note, now) {
  requireAdmin(actor);
  const p0 = state.picks[overall];
  if (!p0) fail(`No such pick ${overall}`);
  if (p0.status === 'made') fail('That pick has been made. Undo it first, then trade it.');
  if (p0.status === 'void') fail('That pick is voided. Un-void it first, then trade it.');
  const teams = new Set(allPicks(state).flatMap((p) => [p.origTeam, p.ownerTeam]));
  toTeam = String(toTeam || '').trim().toUpperCase();
  if (!teams.has(toTeam)) fail(`Unknown team ${toTeam}`);
  if (toTeam === p0.ownerTeam) fail(`${toTeam} already owns pick ${overall}`);
  const s = clone(state);
  const from = s.picks[overall].ownerTeam;
  s.picks[overall].ownerTeam = toTeam; // origTeam is never touched; clock deadline is left alone
  return { state: s, audit: [entry('trade', actor, now, { overall, from, to: toTeam, orig: p0.origTeam, note: note || '' })] };
}

export function undoPick(state, actor, overall, now) {
  requireAdmin(actor);
  const p0 = state.picks[overall];
  if (!p0) fail(`No such pick ${overall}`);
  if (p0.status !== 'made') fail(`Pick ${overall} has not been made`);
  const s = clone(state);
  const p = s.picks[overall];
  const pl = s.players[p.playerId];
  const undone = p.playerId;
  const wasWriteIn = p.writeIn;
  if (wasWriteIn) delete s.players[undone];
  else if (pl) { pl.ownerTeam = ''; pl.drafted = null; }
  p.writeIn = null;
  // A pick that was once skipped goes back to skipped (it does not jump the clock again).
  p.status = p.wasSkipped ? 'skipped' : 'open';
  p.playerId = null; p.madeBy = null; p.madeAt = null;
  const c = s.config;
  if (c.status === 'complete') c.status = 'live';
  if ((c.status === 'live' || c.status === 'paused') && earliestOpen(s) !== c.currentPick) putOnClock(s, now);
  return { state: s, audit: [entry('undo', actor, now, { overall, team: p.ownerTeam, playerId: undone, player: pl ? pl.name : '', writeIn: !!wasWriteIn })] };
}

/** Commissioner swaps the player on a made pick. */
export function editPick(state, actor, overall, newPlayerId, now) {
  requireAdmin(actor);
  const p0 = state.picks[overall];
  if (!p0 || p0.status !== 'made') fail(`Pick ${overall} has not been made`);
  if (p0.playerId === newPlayerId) fail('Same player');
  checkAvailable(state, newPlayerId);
  const s = clone(state);
  const p = s.picks[overall];
  const old = s.players[p.playerId];
  if (p.writeIn) { delete s.players[p.playerId]; p.writeIn = null; }
  else if (old) { old.ownerTeam = ''; old.drafted = null; }
  const nw = s.players[newPlayerId];
  nw.ownerTeam = p.ownerTeam; nw.drafted = overall;
  const oldId = p.playerId;
  p.playerId = newPlayerId; p.madeBy = actor.email; p.madeAt = now;
  return { state: s, audit: [entry('edit', actor, now, { overall, from: oldId, to: newPlayerId })] };
}

// ---------- void / un-void / add pick (commissioner, while the draft is live or paused) ----------
// Before the draft starts use the draft-order CSV instead. A voided pick (status 'void') stays on the board,
// is never put on the clock, skipped or drafted. An added pick gets a letter suffix (see lib/pickno.js).
function requireRunning(state, what) {
  const st = state.config.status;
  if (st === 'pending') fail(`${what} works once the draft has started. Before that, change the draft-order CSV and re-import it.`);
  if (st === 'complete') fail(`The draft is complete, so you cannot ${what.toLowerCase()}.`);
}

export function voidPick(state, actor, overall, note, now) {
  requireAdmin(actor);
  requireRunning(state, 'Void pick');
  const p0 = state.picks[overall];
  if (!p0) fail(`No such pick ${overall}`);
  if (p0.status === 'made') fail(`Pick ${pickLabel(p0)} has already been drafted. Undo it first, then void it.`, 'made');
  if (p0.status === 'void') fail(`Pick ${pickLabel(p0)} is already voided`);
  const s = clone(state);
  const p = s.picks[overall];
  const wasSkipped = p.status === 'skipped';
  p.status = 'void'; p.voidedAt = now; p.voidedBy = actor.email; p.voidNote = String(note || '').slice(0, 200);
  if (s.config.currentPick === overall || unfilled(s) === 0) putOnClock(s, now);
  return { state: s, audit: [entry('void', actor, now, { overall, label: pickLabel(p), team: p.ownerTeam, wasSkipped, note: p.voidNote })] };
}

/** Reverse a void: the pick returns to its place (open, or skipped if it had been skipped before). */
export function unvoidPick(state, actor, overall, now) {
  requireAdmin(actor);
  const p0 = state.picks[overall];
  if (!p0 || p0.status !== 'void') fail(`Pick ${overall} is not voided`);
  const s = clone(state);
  const p = s.picks[overall];
  p.status = p.wasSkipped ? 'skipped' : 'open';
  p.voidedAt = null; p.voidedBy = null; p.voidNote = null;
  const c = s.config;
  if (c.status === 'complete') c.status = 'live';
  if ((c.status === 'live' || c.status === 'paused') && earliestOpen(s) !== c.currentPick) putOnClock(s, now);
  return { state: s, audit: [entry('unvoid', actor, now, { overall, label: pickLabel(p), team: p.ownerTeam })] };
}

/**
 * Insert a new open pick owned by `team` (also its original team) directly after pick `afterOverall`.
 * Letters follow the base pick: after 5.12 -> 5.12a; adding again after 5.12 or 5.12a -> 5.12b (always at the end
 * of that pick's lettered run, so no existing label ever changes). If the new pick is now the earliest open pick
 * (it was added before the clock) it goes on the clock with a fresh full clock, like an undo.
 */
export function addPick(state, actor, afterOverall, team, now) {
  requireAdmin(actor);
  requireRunning(state, 'Add pick');
  const after = state.picks[afterOverall];
  if (!after) fail(`No such pick ${afterOverall}`);
  team = String(team || '').trim().toUpperCase();
  const teams = new Set(allPicks(state).flatMap((p) => [p.origTeam, p.ownerTeam]));
  if (!teams.has(team)) fail(`Unknown team ${team}`);
  const base = after.added ? after.base : after.overall;
  const run = allPicks(state).filter((p) => p.added && p.base === base);
  const seq = Math.max(0, ...run.map((p) => p.addSeq)) + 1;
  if (seq > MAX_ADDED_PER_PICK) fail('Too many picks added after the same pick (a to z)');
  const overall = orderKey(base, seq);
  const s = clone(state);
  const sorted = allPicks(s);
  const pred = run.length ? s.picks[run[run.length - 1].overall] : s.picks[base];
  const idx = sorted.findIndex((p) => p.overall === pred.overall);
  const nxt = sorted[idx + 1] ? sorted[idx + 1].overall : null;
  const bp = s.picks[base];
  s.picks[overall] = {
    overall, round: bp.round, slot: bp.slot, origTeam: team, ownerTeam: team, importedOwner: team,
    added: true, base, addSeq: seq, addedBy: actor.email, addedAt: now, next: nxt,
    status: 'open', playerId: null, wasSkipped: false, skippedAt: null, madeBy: null, madeAt: null, writeIn: null,
  };
  pred.next = overall; // lets the security rules walk the order (see firestore.rules)
  const c = s.config;
  if ((c.status === 'live' || c.status === 'paused') && earliestOpen(s) !== c.currentPick) putOnClock(s, now);
  return { state: s, audit: [entry('addpick', actor, now, { overall, label: pickLabel(s.picks[overall]), after: pickLabel(after), team })] };
}

// ---------- write-in picks (player not in the pool) ----------
// The pick counts immediately and the clock advances. It is flagged writeIn.status = 'pending'
// until the commissioner confirms, edits or rejects it. Rejecting reopens the pick like an undo.

export const writeInId = (overall) => `WI-${overall}`;

/** The player record a write-in pick stands for (the store adds these to the derived player map). */
export function writeInPlayer(pick) {
  const w = pick.writeIn;
  return { id: pick.playerId, puid: '-1', aaa: true, name: w.name, pos: '', mlbTeam: '', kind: 'Non-MLB', writeIn: true, ownerTeam: pick.ownerTeam, drafted: pick.overall };
}

const otherWriteIns = (s, exceptOverall) => allPicks(s)
  .filter((p) => p.writeIn && p.overall !== exceptOverall)
  .map((p) => ({ overall: p.overall, name: p.writeIn.name, nameKey: p.writeIn.nameKey, urlKey: p.writeIn.urlKey, brId: p.writeIn.brId }));
const poolOnly = (s) => Object.values(s.players).filter((p) => !p.writeIn);

function validateWriteIn(s, actor, input, exceptOverall) {
  const r = checkWriteIn(input, {
    pool: poolOnly(s), writeIns: otherWriteIns(s, exceptOverall),
    allowInPool: !!(actor && actor.isAdmin && input.override),
  });
  if (r.error) fail(r.error, r.code);
  return r.value;
}

/** input: {name, url, note, override}. `override` (name matches a pool player) is honoured only for the commissioner. */
export function makeWriteIn(state, actor, overall, input, now) {
  const p0 = state.picks[overall];
  if (!p0) fail(`No such pick ${overall}`);
  if (p0.status === 'made') fail(`Pick ${overall} has already been made`);
  if (p0.status === 'void') fail(`Pick ${pickLabel(p0)} is voided and cannot be drafted`, 'void');
  const st = state.config.status;
  if (!(st === 'live' || (st === 'paused' && actor && actor.isAdmin))) fail('The draft is not live', 'not-live');
  const isAdmin = !!(actor && actor.isAdmin);
  checkOwnerMayPick(state, actor, p0, now);
  const v = validateWriteIn(state, actor, input, overall);
  const s = clone(state);
  const p = s.picks[overall];
  const late = p.status === 'skipped';
  p.status = 'made'; p.playerId = writeInId(overall); p.madeBy = actor.email; p.madeAt = now;
  p.writeIn = { ...v, status: 'pending' };
  s.players[p.playerId] = writeInPlayer(p);
  if (s.config.currentPick === overall || unfilled(s) === 0) putOnClock(s, now);
  return { state: s, audit: [entry('writein', actor, now, { overall, team: p.ownerTeam, playerId: p.playerId, player: v.name, url: v.url, note: v.note, late, onBehalf: isAdmin && !(actor.teams || []).includes(p.ownerTeam), override: !!(isAdmin && input.override) })] };
}

function requireWriteIn(state, overall) {
  const p = state.picks[overall];
  if (!p || p.status !== 'made' || !p.writeIn) fail(`Pick ${overall} is not a write-in`);
  return p;
}

export function confirmWriteIn(state, actor, overall, now) {
  requireAdmin(actor);
  requireWriteIn(state, overall);
  const s = clone(state);
  s.picks[overall].writeIn.status = 'confirmed';
  return { state: s, audit: [entry('writein-confirm', actor, now, { overall, player: s.picks[overall].writeIn.name })] };
}

/** Commissioner edits name / link / note of a write-in (revalidated; duplicates still blocked). */
export function editWriteIn(state, actor, overall, input, now) {
  requireAdmin(actor);
  const p0 = requireWriteIn(state, overall);
  const v = validateWriteIn(state, actor, { ...input, override: true }, overall);
  const s = clone(state);
  const p = s.picks[overall];
  const before = { name: p0.writeIn.name, url: p0.writeIn.url, note: p0.writeIn.note };
  p.writeIn = { ...v, status: p.writeIn.status };
  s.players[p.playerId] = writeInPlayer(p);
  return { state: s, audit: [entry('writein-edit', actor, now, { overall, before, after: { name: v.name, url: v.url, note: v.note } })] };
}

/** Reject = undo: the pick reopens for the owner (back to skipped if it had been). */
export function rejectWriteIn(state, actor, overall, now) {
  requireAdmin(actor);
  const p = requireWriteIn(state, overall);
  const w = p.writeIn;
  const r = undoPick(state, actor, overall, now);
  r.audit = [entry('writein-reject', actor, now, { overall, team: p.ownerTeam, player: w.name, url: w.url })];
  return r;
}

/** Commissioner switch for picks outside 11 AM-11 PM ET (default on). Enforced by the app, not by the server rules. */
export function setAllowPickWhenClockPaused(state, actor, allow, now) {
  requireAdmin(actor);
  const s = clone(state);
  s.config.allowPickWhenClockPaused = !!allow;
  return { state: s, audit: [entry('setting', actor, now, { allowPickWhenClockPaused: !!allow })] };
}

// ---------- remove / restore a player from the draft list (commissioner) ----------
// For a player who is in the pool by mistake. His data stays; he is flagged `removed`, so nobody can pick him,
// he drops out of the Players tab and every owner's draft list (auto-draft moves on to the next entry), and
// the commissioner can restore him. A player already taken by a pick must be undone first.
// The flag itself is stored by the app in removed/{id} (store.js), not in the picks.
export function removePlayer(state, actor, playerId, reason, now) {
  requireAdmin(actor);
  const pl = state.players[playerId];
  if (!pl || pl.writeIn) fail(`Unknown pool player ${playerId}`, 'no-player');
  if (pl.removed) fail(`${pl.name} is already removed`, 'already-removed');
  if (pl.drafted != null) fail(`${pl.name} was drafted at pick #${pl.drafted}. Undo that pick first, then remove him.`, 'drafted');
  const s = clone(state);
  s.players[playerId].removed = true;
  return { state: s, audit: [entry('player-remove', actor, now, { playerId, player: pl.name, team: pl.ownerTeam || '', reason: String(reason || '').slice(0, 200) })] };
}

export function restorePlayer(state, actor, playerId, now) {
  requireAdmin(actor);
  const pl = state.players[playerId];
  if (!pl || pl.writeIn) fail(`Unknown pool player ${playerId}`, 'no-player');
  if (!pl.removed) fail(`${pl.name} is not removed`, 'not-removed');
  const s = clone(state);
  delete s.players[playerId].removed;
  return { state: s, audit: [entry('player-restore', actor, now, { playerId, player: pl.name })] };
}

// ---------- auto-draft (draft list) ----------
// owner = { email, teams }; list = { autoDraft: bool, items: [poolId | {writeIn:{name,url,note}}] }.
// Runs only for the pick on the clock, only when the owner's switch is On. It takes the FIRST entry that
// is still usable (pool player still available, or write-in that passes the duplicate checks right now).
// If nothing is usable it does nothing: the normal clock keeps running and the usual skip rule applies.
// Never picks best-available. Returns {state, audit, changed, reason} with reason one of
// 'picked' | 'off' | 'not-on-clock' | 'not-owner' | 'closed-hours' | 'exhausted'.
export function autoDraft(state, owner, list, now) {
  const none = (reason) => ({ state, audit: [], changed: false, reason });
  const c = state.config;
  if (!list || !list.autoDraft) return none('off');
  if (c.status !== 'live' || c.currentPick == null) return none('not-on-clock');
  const p = state.picks[c.currentPick];
  if (!p || p.status !== 'open') return none('not-on-clock');
  if (!(owner.teams || []).includes(p.ownerTeam)) return none('not-owner');
  if (!windowAllows(state, now)) return none('closed-hours');
  const who = { email: owner.email, isAdmin: false, teams: owner.teams };
  for (const item of list.items || []) {
    try {
      const r = typeof item === 'string' ? makePick(state, who, p.overall, item, now) : makeWriteIn(state, who, p.overall, item.writeIn, now);
      r.audit[0].auto = true;
      return { ...r, changed: true, reason: 'picked' };
    } catch (e) {
      if (!(e instanceof DraftError)) throw e;
      // taken player, unknown id, or duplicate / invalid write-in: skip this entry and try the next
    }
  }
  return none('exhausted');
}

// ---------- read helpers used by the UI ----------

export const picksOwnedBy = (state, team) =>
  allPicks(state).filter((p) => p.ownerTeam === team && p.status !== 'made' && p.status !== 'void');

export const roster = (state, team) =>
  allPicks(state).filter((p) => p.status === 'made' && p.ownerTeam === team)
    .map((p) => ({ overall: p.overall, ...state.players[p.playerId] }));
