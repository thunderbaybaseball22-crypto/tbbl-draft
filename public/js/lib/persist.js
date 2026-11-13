// Pure helpers shared by the browser store (store.js) and the unattended ticker (tools/ticker.mjs):
// how draft state is rebuilt from stored documents, and exactly which documents a state change writes.
import { writeInPlayer } from './draft.js';

const CFG_KEYS = ['status', 'startAt', 'clockMinutes', 'currentPick', 'deadline', 'remainingMs'];
export const cfgOut = (c) => ({ ...Object.fromEntries(CFG_KEYS.map((k) => [k, c[k] ?? null])), allowPickWhenClockPaused: c.allowPickWhenClockPaused !== false });
export const pickOut = (p) => (p == null ? null : { ...p, playerId: p.playerId ?? null, skippedAt: p.skippedAt ?? null, madeBy: p.madeBy ?? null, madeAt: p.madeAt ?? null, wasSkipped: !!p.wasSkipped, writeIn: p.writeIn ?? null });
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Players map for lib/draft.js: the pool plus whoever the made picks took (write-ins become players). */
export function derivePlayers(basePlayers, picks, removed = {}) {
  const players = {};
  // `removed` (ids the commissioner took out of the draft list, see removed/{id}) keeps the player's data but flags him.
  for (const p of basePlayers) players[p.id] = { ...p, drafted: null, ...(removed && removed[p.id] ? { removed: true } : {}) };
  for (const k of Object.keys(picks)) {
    const pk = picks[k];
    if (pk.status === 'made' && players[pk.playerId]) {
      players[pk.playerId].ownerTeam = pk.ownerTeam;
      players[pk.playerId].drafted = pk.overall;
    } else if (pk.status === 'made' && pk.writeIn) {
      players[pk.playerId] = writeInPlayer(pk);
    }
  }
  return players;
}

/**
 * The set of document writes that turns `before` into `after`, plus the values the database must
 * still hold for the write to be valid ("expect"). A committer applies it in ONE transaction and
 * refuses (ConflictError) if any expected value changed, so two writers can never both apply the
 * same step (no double pick, no double skip).
 */
export function planWrites(before, after, audit) {
  const cfgChanged = !same(cfgOut(before.config), cfgOut(after.config));
  const keys = Object.keys(after.picks).filter((k) => !same(pickOut(before.picks[k]), pickOut(after.picks[k])));
  const expect = {
    config: cfgOut(before.config),
    picks: Object.fromEntries(keys.map((k) => {
      const b = before.picks[k];
      if (!b) return [k, null]; // a brand-new pick (Add pick): nothing existed before
      return [k, { status: b.status, ownerTeam: b.ownerTeam, playerId: b.playerId ?? null }];
    })),
  };
  const takenDelete = [], takenSet = [];
  for (const k of keys) {
    const a = after.picks[k], b = before.picks[k];
    if (b && b.playerId && b.playerId !== a.playerId) takenDelete.push(b.playerId);
  }
  for (const k of keys) {
    const a = after.picks[k], b = before.picks[k];
    if (a.playerId && a.playerId !== (b && b.playerId)) takenSet.push({ id: a.playerId, data: { overall: a.overall, team: a.ownerTeam } });
  }
  return {
    expect,
    config: cfgChanged ? cfgOut(after.config) : null,
    picks: keys.map((k) => ({ key: k, data: pickOut(after.picks[k]) })),
    takenDelete, takenSet,
    audit: audit.map((e) => JSON.parse(JSON.stringify(e))),
  };
}

/** True if the stored documents still match what the plan was based on. */
export function planStillValid(plan, storedConfig, storedPicks) {
  if (!same(cfgOut(storedConfig), plan.expect.config)) return false;
  for (const [k, e] of Object.entries(plan.expect.picks)) {
    const d = storedPicks[k];
    if (e === null) { if (d) return false; continue; }
    if (!d || d.status !== e.status || d.ownerTeam !== e.ownerTeam || (d.playerId ?? null) !== e.playerId) return false;
  }
  return true;
}
