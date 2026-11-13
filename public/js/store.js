// Firestore-backed store: live listeners, derived draft state, and transactional commits.
// All draft rules live in lib/draft.js; this file only moves state in and out of Firestore.
import {
  onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail, updatePassword,
  createUserWithEmailAndPassword, getAuth,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  doc, collection, onSnapshot, getDoc, getDocs, setDoc, deleteDoc, runTransaction, writeBatch, query, orderBy, limit,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { loadSchedule, loadPlayers, loadOwners, diffPlayers, diffSchedule, diffOwners } from './lib/csv.js';
import { cfgOut, pickOut, same, derivePlayers } from './lib/persist.js';
import * as D from './lib/draft.js';
import { normName } from './lib/writein.js';
import { tickQueues } from './lib/queue.js';
import { planRestart, runPlan, lockedReason, confirmOk } from './lib/restart.js';

const store = {
  fb: null, user: null, isAdmin: false, teams: [], adminEmail: null,
  config: null, picks: {}, basePlayers: [], removed: {}, queue: { items: [], autoDraft: false }, queues: {}, checks: [], tickAt: null, audit: [], owners: [], emailCfg: null, mailState: null, logins: {}, pwStatus: {}, lock: null, restart: null,
  offset: 0, ready: false, error: null,
};
const listeners = new Set();
let unsubs = [];
let derived = null;

export const onChange = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };
const emit = () => { derived = null; listeners.forEach((cb) => cb()); };
export const raw = () => store;
export const serverNow = () => Date.now() + store.offset;

/** The state object consumed by lib/draft.js (players derived from keepers + made picks). */
export function getState() {
  if (derived) return derived;
  const players = derivePlayers(store.basePlayers, store.picks, store.removed);
  derived = { config: store.config, picks: store.picks, players };
  return derived;
}

export const actor = () => ({ email: store.user ? store.user.email.toLowerCase() : '', isAdmin: store.isAdmin, teams: store.teams });

async function syncServerTime() {
  try {
    const r = await fetch(location.href.split('#')[0], { method: 'HEAD', cache: 'no-store' });
    const d = r.headers.get('Date');
    if (d) store.offset = new Date(d).getTime() - Date.now();
  } catch { /* keep 0 */ }
}

export async function start(fb) {
  store.fb = fb;
  await syncServerTime();
  setInterval(syncServerTime, 10 * 60 * 1000);
  onAuthStateChanged(fb.auth, async (u) => {
    unsubs.forEach((f) => f()); unsubs = [];
    Object.assign(store, { user: u, isAdmin: false, teams: [], adminEmail: null, config: null, picks: {}, basePlayers: [], removed: {}, queue: { items: [], autoDraft: false }, queues: {}, checks: [], tickAt: null, audit: [], owners: [], emailCfg: null, mailState: null, logins: {}, pwStatus: {}, lock: null, restart: null, ready: !u });
    emit();
    if (!u) return;
    const email = u.email.toLowerCase();
    const { db } = fb;
    try {
      const [adm, own] = await Promise.all([getDoc(doc(db, 'config', 'admin')), getDoc(doc(db, 'owners', email))]);
      store.adminEmail = adm.exists() ? String(adm.data().email || '').toLowerCase() : null;
      store.isAdmin = store.adminEmail === email;
      store.teams = own.exists() ? own.data().teams || [] : [];
      const sub = (ref, fn) => unsubs.push(onSnapshot(ref, fn, (e) => { store.error = e.message; emit(); }));
      sub(doc(db, 'config', 'draft'), (s) => { store.config = s.exists() ? s.data() : null; store.ready = true; emit(); });
      sub(collection(db, 'picks'), (s) => {
        const p = {}; s.forEach((d) => { p[d.id] = d.data(); }); store.picks = p; emit();
      });
      sub(collection(db, 'playerchunks'), (s) => {
        const ch = []; s.forEach((d) => ch.push(d.data()));
        ch.sort((a, b) => a.i - b.i);
        store.basePlayers = ch.flatMap((c) => c.players); emit();
      });
      sub(collection(db, 'removed'), (s) => {
        const r = {}; s.forEach((d) => { r[d.id] = d.data(); }); store.removed = r; emit();
      });
      sub(doc(db, 'queues', email), (s) => { const d = s.exists() ? s.data() : {}; store.queue = { items: d.items || [], autoDraft: !!d.autoDraft }; emit(); });
      sub(doc(db, 'config', 'restart'), (s) => { store.restart = s.exists() ? s.data() : null; emit(); });
      sub(doc(db, 'ticks', 'last'), (s) => { store.tickAt = s.exists() ? s.data().at : null; emit(); });
      sub(query(collection(db, 'audit'), orderBy('at', 'desc'), limit(300)), (s) => {
        store.audit = s.docs.map((d) => d.data()); emit();
      });
      // Record that this login worked (shown to the commissioner on the Owners screen; not a security control).
      setDoc(doc(db, 'logins', email), { at: Date.now() }).catch(() => {});
      if (store.isAdmin) {
        sub(doc(db, 'config', 'lock'), (s) => { store.lock = s.exists() ? s.data() : null; emit(); });
        sub(doc(db, 'config', 'email'), (s) => { store.emailCfg = s.exists() ? s.data() : null; emit(); });
        sub(doc(db, 'groupMail', 'state'), (s) => { store.mailState = s.exists() ? s.data() : null; emit(); });
        sub(collection(db, 'logins'), (s) => { const l = {}; s.forEach((d) => { l[d.id] = d.data().at; }); store.logins = l; emit(); });
        // Status only (never pwRequests, which holds the typed password): the browser never reads a password back.
        sub(collection(db, 'pwStatus'), (s) => { const p = {}; s.forEach((d) => { p[d.id] = d.data(); }); store.pwStatus = p; emit(); });
        sub(collection(db, 'owners'), (s) => { store.owners = s.docs.map((d) => d.data()); emit(); });
        sub(collection(db, 'queues'), (s) => { const q = {}; s.forEach((d) => { q[d.id] = { items: d.data().items || [], autoDraft: !!d.data().autoDraft }; }); store.queues = q; emit(); });
        sub(collection(db, 'writeinChecks'), (s) => { store.checks = s.docs.map((d) => d.id); emit(); });
      }
    } catch (e) { store.error = e.message; store.ready = true; emit(); }
  });
}

// ---------- auth ----------
export const login = (email, pw) => signInWithEmailAndPassword(store.fb.auth, email.trim(), pw);
export const logout = () => signOut(store.fb.auth);
export const resetPassword = (email) => sendPasswordResetEmail(store.fb.auth, email.trim());
export const changePassword = (pw) => updatePassword(store.fb.auth.currentUser, pw);

/** Create an owner login without signing the commissioner out (uses a throw-away second app instance). */
export async function createOwnerAccount(email, tempPassword) {
  const sec = initializeApp(store.fb.cfg, 'secondary-' + Date.now());
  const auth = getAuth(sec);
  try {
    await createUserWithEmailAndPassword(auth, email.trim(), tempPassword);
  } finally {
    await signOut(auth).catch(() => {});
  }
}

/**
 * Commissioner: ask the ticker (on the commissioner's PC) to set an owner's password. One atomic batch writes the
 * request (holds the password until the ticker applies and deletes it) and the password-free status "pending".
 * Rules: commissioner only, create-once (a pending request must be cancelled first), see firestore.rules.
 */
export async function requestPassword(email, password) {
  const key = String(email).trim().toLowerCase(), at = Date.now();
  const { db } = store.fb;
  const b = writeBatch(db);
  b.set(doc(db, 'pwRequests', key), { password, requestedAt: at });
  b.set(doc(db, 'pwStatus', key), { state: 'pending', requestedAt: at, at });
  await b.commit();
}
/** Commissioner: withdraw a request that has not been applied yet (removes the stored password). */
export async function cancelPasswordRequest(email) {
  const key = String(email).trim().toLowerCase(), { db } = store.fb;
  const b = writeBatch(db);
  b.delete(doc(db, 'pwRequests', key));
  b.delete(doc(db, 'pwStatus', key));
  await b.commit();
}

/** Commissioner: turn the group pick emails ON or OFF (default OFF). Turning ON restarts counting from the current pick. */
export const setGroupEmails = (on) => setDoc(doc(store.fb.db, 'config', 'email'), {
  groupEmails: !!on, enabledAt: on ? Date.now() : (store.emailCfg && store.emailCfg.enabledAt) || null, by: store.user.email.toLowerCase(), at: Date.now(),
});

// ---------- edit one owner (commissioner, Owners screen) ----------
/**
 * Save an edited owner (validated by lib/owners.js checkOwnerEdit). One atomic batch: write owners/{new email};
 * if the email changed, delete owners/{old email} and copy the owner's draft list and Auto-draft switch to the new
 * email (only if the new email has no list yet; the old list is left alone). Plus one audit entry.
 * Works at any time, including while the draft is live and the real-draft lock is ON.
 */
export async function updateOwner(oldEmail, owner, changes) {
  const { db } = store.fb;
  const b = writeBatch(db);
  b.set(doc(db, 'owners', owner.email), { email: owner.email, teams: owner.teams, teamNames: owner.teamNames || {}, manager: owner.manager || '' });
  let listMoved = false;
  if (owner.email !== oldEmail) {
    b.delete(doc(db, 'owners', oldEmail));
    const q = store.queues[oldEmail];
    if (q && q.items.length && !store.queues[owner.email]) {
      b.set(doc(db, 'queues', owner.email), { items: q.items, autoDraft: !!q.autoDraft });
      listMoved = true;
    }
  }
  b.set(doc(collection(db, 'audit')), { type: 'owner-edit', by: actor().email, at: serverNow(), email: oldEmail, newEmail: owner.email, teams: owner.teams, changes, listMoved });
  await b.commit();
  return { listMoved };
}

// ---------- remove / restore a player (commissioner) ----------
/**
 * Take a player out of the draft list (he is in the pool by mistake). Works while the draft is live. Refuses a player
 * already drafted (undo the pick first). The check and the write share one transaction, so a pick made a moment
 * earlier by someone else cannot slip through. Rules: removed/{id} is commissioner-only.
 */
export async function removePlayer(id, reason = '') {
  const { db } = store.fb;
  const res = D.removePlayer(getState(), actor(), id, reason, serverNow());
  const pl = getState().players[id];
  await runTransaction(db, async (tx) => {
    const t = await tx.get(doc(db, 'taken', id));
    if (t.exists() && t.data().overall > 0) throw new Error(`${pl.name} was just drafted at pick #${t.data().overall}. Undo that pick first, then remove him.`);
    tx.set(doc(db, 'removed', id), { name: pl.name, reason: String(reason || '').slice(0, 200), by: actor().email, at: Date.now() });
    for (const e of res.audit) tx.set(doc(collection(db, 'audit')), JSON.parse(JSON.stringify(e)));
  });
}
/** Put a removed player back in the draft list. */
export async function restorePlayer(id) {
  const { db } = store.fb;
  const res = D.restorePlayer(getState(), actor(), id, serverNow());
  const b = writeBatch(db);
  b.delete(doc(db, 'removed', id));
  for (const e of res.audit) b.set(doc(collection(db, 'audit')), JSON.parse(JSON.stringify(e)));
  await b.commit();
}

// ---------- queue ----------
export const saveQueue = (items, autoDraft = store.queue.autoDraft) =>
  setDoc(doc(store.fb.db, 'queues', store.user.email.toLowerCase()), { items, autoDraft: !!autoDraft });
/** Commissioner: mark a queued write-in (by normalised name) verified ahead of time, or clear it. */
export const setWriteInVerified = (nameKey, on) => (on
  ? setDoc(doc(store.fb.db, 'writeinChecks', nameKey), { by: store.user.email.toLowerCase(), at: Date.now() })
  : deleteDoc(doc(store.fb.db, 'writeinChecks', nameKey)));

// ---------- transactional commit ----------
/**
 * fn(state, nowMs, actor) -> {state, audit} from lib/draft.js (may throw DraftError).
 * Writes only what changed, inside a transaction that first checks nobody else changed it.
 */
export async function commit(fn, { system = false } = {}) {
  const { db } = store.fb;
  const before = getState();
  const res = fn(before, serverNow(), system ? null : actor());
  let after = res.state;
  // The security rules do not let owners close the draft (they cannot see every pick in one
  // rule). An owner's last pick leaves it live with nothing on the clock; the commissioner's
  // browser then marks it complete (see autoAdvance).
  if (!store.isAdmin && after.config.status === 'complete') after = { ...after, config: { ...after.config, status: 'live' } };
  const cfgChanged = !same(cfgOut(before.config), cfgOut(after.config));
  const changedPicks = Object.keys(after.picks).filter((k) => !same(pickOut(before.picks[k]), pickOut(after.picks[k])));
  await runTransaction(db, async (tx) => {
    const cref = doc(db, 'config', 'draft');
    const cs = await tx.get(cref);
    if (!same(cfgOut(cs.data()), cfgOut(before.config))) throw new Error('The draft just changed. Please try again.');
    for (const k of changedPicks) {
      const ps = await tx.get(doc(db, 'picks', k));
      const d = ps.data(), b = before.picks[k];
      if (!b) { if (ps.exists()) throw new Error('The draft just changed. Please try again.'); continue; } // new pick (Add pick)
      if (d.status !== b.status || d.ownerTeam !== b.ownerTeam || (d.playerId ?? null) !== (b.playerId ?? null)) {
        throw new Error(`Pick ${k} just changed. Please try again.`);
      }
    }
    for (const k of changedPicks) {
      const a = after.picks[k], b = before.picks[k];
      if (b && b.playerId && b.playerId !== a.playerId) tx.delete(doc(db, 'taken', b.playerId));
    }
    for (const k of changedPicks) {
      const a = after.picks[k], b = before.picks[k];
      tx.set(doc(db, 'picks', k), pickOut(a));
      if (a.playerId && a.playerId !== (b && b.playerId)) tx.set(doc(db, 'taken', a.playerId), { overall: a.overall, team: a.ownerTeam });
    }
    if (cfgChanged) tx.set(cref, cfgOut(after.config));
    for (const e of res.audit) tx.set(doc(collection(db, 'audit')), JSON.parse(JSON.stringify(e)));
  });
}

let busy = false;
let beating = false;

/** What the clock logic (lib/tick.js) needs to know about auto-draft lists. Owners see only their own list; the commissioner sees all. */
export function tickContext() {
  const queues = tickQueues({ isAdmin: store.isAdmin, email: store.user ? store.user.email : '', teams: store.teams, ownQueue: store.queue, owners: store.owners, queues: store.queues });
  return { isAdmin: store.isAdmin, queues, verifiedKeys: new Set(store.checks) };
}

/** Record "the clock was last checked" at most every 5 minutes (the rules allow one write per 4). */
async function heartbeat(now) {
  if (beating || (store.tickAt && now - store.tickAt < 5 * 60000)) return;
  beating = true;
  try { await setDoc(doc(store.fb.db, 'ticks', 'last'), { at: Date.now(), by: store.user.email.toLowerCase() }); } catch { /* another client wrote it first */ } finally { beating = false; }
}

/** Called every second by the UI: runs lib/tick.js (start, auto-draft, skip, confirm, complete) against the live state. */
export async function autoAdvance(T) {
  const st = store.config && getState();
  if (busy || !st || store.restart) return; // a restart is (or was) under way: the clock stands still until it is finished
  const now = serverNow();
  if (st.config.status === 'live') heartbeat(now);
  const ctx = tickContext();
  const first = T.tick(st, ctx, now);
  if (!first.changed) return;
  busy = true;
  try {
    // A skip only becomes valid 1 s after the deadline; spread out competing clients
    await new Promise((r) => setTimeout(r, first.kind === 'skip' ? 1000 + Math.random() * 1500 : Math.random() * 500));
    await commit((s, n) => { const r = T.tick(s, ctx, n); if (!r.changed) throw new Error('nothing to do'); return r; }, { system: true });
  } catch { /* another client won, or rules said not yet; next tick re-evaluates */ } finally { busy = false; }
}
// ---------- bulk writes (commissioner) ----------
/** Run (batch) => batch.set/delete(...) operations in batches of 400 (Firestore allows 500). */
async function runOps(ops) {
  const { db } = store.fb;
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach((op) => op(b));
    await b.commit();
  }
}
async function clearCollection(name) {
  const snap = await getDocs(collection(store.fb.db, name));
  await runOps(snap.docs.map((d) => (b) => b.delete(d.ref)));
}
/** Reset the taken/{id} markers to just the keepers (players already owned by a team; overall 0). */
async function writeKeepers(players) {
  const { db } = store.fb;
  await clearCollection('taken');
  await runOps(players.filter((p) => p.ownerTeam).map((p) => (b) => b.set(doc(db, 'taken', p.id), { overall: 0, team: p.ownerTeam })));
}

// ---------- imports (commissioner) ----------
// Each importer has a check (no writes: validation, warnings, merge notices, and a summary of what
// changes versus the previous import) and an import (runs the same check, then writes).
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const teamList = () => [...new Set(Object.values(store.picks).flatMap((p) => [p.origTeam, p.ownerTeam]))];
const anyMade = () => Object.values(store.picks).some((p) => p.status === 'made');
const list = (label, arr, max = 15) => (arr.length ? [`${label} (${arr.length}):`, ...arr.slice(0, max).map((x) => '  ' + x), ...(arr.length > max ? [`  ...and ${arr.length - max} more`] : [])] : []);

/** `text` is the single player CSV, or { hitters, pitchers } with the two rating files. */
export function checkPlayers(text) {
  const teams = teamList();
  const r = loadPlayers(text, { teamCodes: teams.length ? teams : null });
  const errors = [...r.errors];
  for (const p of r.players) if (!SAFE_ID.test(p.id)) errors.push(`Player key "${p.id}" has characters other than letters, numbers, - and _`);
  if (anyMade()) errors.push('Picks have already been made, so the player pool is locked. Undo all picks first (or ask the developer to reset the draft).');
  const d = diffPlayers(store.basePlayers, r.players);
  const nRemoved = Object.keys(store.removed).length;
  const summary = [
    ...(nRemoved ? [`${nRemoved} player(s) are on the removed list and stay hidden after this import (Players tab > Show > Removed, then Restore).`] : []),
    `${r.players.length} players in the file (${store.basePlayers.length} in the current pool).`,
    `${r.players.filter((p) => !p.ownerTeam).length} available, ${r.players.filter((p) => p.ownerTeam).length} owned by a team, ${r.players.filter((p) => p.kind === 'Non-MLB').length} non-MLB (-1/AAA).`,
    ...(r.players.some((p) => p.bat || p.pit) ? [`Stats: ${r.players.filter((p) => p.bat).length} with hitting stats, ${r.players.filter((p) => p.pit).length} with pitching stats, ${r.players.filter((p) => p.bat && p.pit).length} with both.`] : []),
    ...(store.basePlayers.length ? [
      ...list('New players', d.added.map((p) => p.name)), ...list('Removed players', d.removed.map((p) => p.name)),
      ...list('Team changes', d.teamChanged.map((x) => `${x.name}: ${x.from} -> ${x.to}`)), ...list('Renamed', d.renamed.map((x) => `${x.from} -> ${x.to}`)),
    ] : ['First import: nothing to compare with.']),
  ];
  return { errors, warnings: r.warnings, notices: r.merges.map((m) => 'MERGED: ' + m.text), summary, players: r.players };
}
export async function importPlayers(text) {
  const c = checkPlayers(text);
  if (c.errors.length) return c;
  const why = lockedReason(store.lock);
  if (why) throw new Error(why);
  const { db } = store.fb;
  await clearCollection('playerchunks');
  const chunks = [];
  for (let i = 0; i < c.players.length; i += 400) chunks.push(c.players.slice(i, i + 400));
  await runOps(chunks.map((pl, i) => (b) => b.set(doc(db, 'playerchunks', 'c' + String(i).padStart(3, '0')), { i, players: pl })));
  // pool/{id} markers let the security rules check that an owner's pick names a real pool player.
  await clearCollection('pool');
  await runOps(c.players.map((p) => (b) => b.set(doc(db, 'pool', p.id), {})));
  await writeKeepers(c.players);
  return c;
}

export function checkSchedule(text) {
  const r = loadSchedule(text);
  const errors = [...r.errors];
  if (store.config && store.config.status !== 'pending') errors.push(`The draft is ${store.config.status}; the draft order can only be replaced before the draft starts.`);
  const hasPrev = Object.keys(store.picks).length > 0;
  const d = hasPrev ? diffSchedule(Object.values(store.picks), r.picks) : null;
  const summary = [`${r.picks.length} picks, ${r.teams.length} teams, ${r.picks.filter((p) => p.origTeam !== p.ownerTeam).length} traded.`,
    ...(d ? [`Previously ${d.previousCount} picks: ${d.added} added, ${d.removed} removed, ${d.changed.length} with a different owner.`, ...list('Owner changes', d.changed.map((x) => `#${x.overall}: ${x.from} -> ${x.to}`))] : ['First import: nothing to compare with.']),
    ...(hasPrev ? ['Importing resets every pick to open.'] : [])];
  return { errors, warnings: [], notices: [], summary, picks: r.picks };
}
export async function importSchedule(text) {
  const c = checkSchedule(text);
  if (c.errors.length) return c;
  const why = lockedReason(store.lock);
  if (why) throw new Error(why);
  const { db } = store.fb;
  const prev = store.config || {};
  await clearCollection('picks');
  await runOps(c.picks.map((p) => (b) => b.set(doc(db, 'picks', String(p.overall)), pickOut({
    ...p, importedOwner: p.ownerTeam, status: 'open', playerId: null, wasSkipped: false, skippedAt: null, madeBy: null, madeAt: null, writeIn: null,
  }))));
  await setDoc(doc(db, 'config', 'draft'), cfgOut({
    status: 'pending', startAt: prev.startAt ?? null, clockMinutes: prev.clockMinutes ?? 60,
    currentPick: null, deadline: null, remainingMs: null,
  }));
  await writeKeepers(store.basePlayers);
  return c;
}

export function checkOwners(text) {
  const teams = teamList();
  const r = loadOwners(text, { teamCodes: teams.length ? teams : null });
  const d = diffOwners(store.owners, r.owners);
  const summary = [`${r.owners.length} owners in the file (${store.owners.length} currently).`,
    ...list('New emails', d.added), ...list('Removed emails', d.removed), ...list('Team changes', d.changed.map((x) => `${x.email}: ${x.from.join(' ')} -> ${x.to.join(' ')}`)),
    ...(d.added.length ? ['New emails need logins: press "Create owner logins" after importing.'] : [])];
  return { errors: r.errors, warnings: r.warnings, notices: [], summary, owners: r.owners };
}
export async function importOwners(text) {
  const c = checkOwners(text);
  if (c.errors.length) return c;
  const { db } = store.fb;
  await clearCollection('owners');
  await runOps(c.owners.map((o) => (b) => b.set(doc(db, 'owners', o.email), { email: o.email, teams: o.teams, teamNames: o.teamNames || {}, manager: o.manager || '' })));
  return c;
}

// ---------- real-draft lock and restart (commissioner) ----------
/** Turn the real-draft lock on or off. While ON, Restart and the re-imports that reset picks are refused (also by firestore.rules). Pause/Resume are unaffected. */
export const setRealDraftLock = (locked) => setDoc(doc(store.fb.db, 'config', 'lock'), { locked: !!locked, by: store.user.email.toLowerCase(), at: Date.now() });

const OPS = { set: (b, ref, d) => b.set(ref, d), delete: (b, ref) => b.delete(ref) };
const ids = (snap) => snap.docs.map((d) => d.id);

/**
 * Restart the draft (see lib/restart.js for exactly what is reset and kept). Needs the typed word RESTART.
 * Reads everything first, then writes in ordered batches of at most 400; if it stops part way, run it again.
 */
export async function restartDraft(typed) {
  if (!store.isAdmin) throw new Error('Only the commissioner can restart the draft.');
  const why = lockedReason(store.lock);
  if (why) throw new Error(why);
  if (!confirmOk(typed)) throw new Error('Type RESTART (capital letters) to confirm.');
  const { db } = store.fb;
  const [taken, audit, notices, pwReq, pwStat, cfg, marker] = await Promise.all([
    getDocs(collection(db, 'taken')), getDocs(collection(db, 'audit')), getDocs(collection(db, 'notices')),
    getDocs(collection(db, 'pwRequests')), getDocs(collection(db, 'pwStatus')), getDoc(doc(db, 'config', 'draft')), getDoc(doc(db, 'config', 'restart')),
  ]);
  const plan = planRestart({
    config: cfg.exists() ? cfg.data() : store.config, picks: store.picks, emailCfg: store.emailCfg,
    takenDocs: taken.docs.map((d) => ({ id: d.id, overall: d.data().overall })),
    auditDocs: audit.docs.map((d) => ({ id: d.id, ...d.data() })),
    noticeIds: ids(notices), pwRequestIds: ids(pwReq), pwStatusIds: ids(pwStat),
    prevPicksCleared: marker.exists() ? marker.data().picksCleared : 0,
    by: store.user.email.toLowerCase(), now: Date.now(),
  });
  await runPlan(plan, async (ops) => {
    const b = writeBatch(db);
    ops.forEach((o) => OPS[o.op](b, doc(db, ...o.path.split('/')), o.data));
    await b.commit();
  });
  return plan;
}