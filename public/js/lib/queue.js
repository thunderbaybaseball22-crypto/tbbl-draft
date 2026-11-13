// Personal draft list (pick queue). Pure helpers over an array of items.
// An item is a pool player ID (string) or a write-in: { writeIn: { name, url, note } }.
// The list only ever drafts for the owner when their auto-draft switch is On (see draft.js autoDraft).
import { normName, checkWriteIn } from './writein.js';

/** Identity of an item, so the same player is not listed twice. */
export const itemKey = (item) => (typeof item === 'string' ? item : `wi:${normName(item.writeIn.name)}`);

export function addToQueue(queue, item) {
  const k = itemKey(item);
  return queue.some((x) => itemKey(x) === k) ? [...queue] : [...queue, item];
}

export function removeFromQueue(queue, item) {
  const k = itemKey(item);
  return queue.filter((x) => itemKey(x) !== k);
}

/** Move an item to `toIndex` (clamped). Unknown items leave the queue unchanged. */
export function moveInQueue(queue, item, toIndex) {
  const k = itemKey(item);
  const from = queue.findIndex((x) => itemKey(x) === k);
  if (from < 0) return [...queue];
  const moving = queue[from];
  const q = queue.filter((_, i) => i !== from);
  const i = Math.max(0, Math.min(q.length, toIndex));
  q.splice(i, 0, moving);
  return q;
}

/** Validate a new write-in list entry with the same rules as a write-in pick (name, link or note, length). */
export function checkQueueWriteIn(input, state) {
  const r = checkWriteIn(input, writeInCtx(state));
  return r.error ? { error: r.error, code: r.code } : { item: { writeIn: { name: r.value.name, url: r.value.url, note: r.value.note } } };
}

function writeInCtx(state) {
  return {
    pool: Object.values(state.players).filter((p) => !p.writeIn),
    writeIns: Object.values(state.picks).filter((p) => p.writeIn)
      .map((p) => ({ overall: p.overall, name: p.writeIn.name, nameKey: p.writeIn.nameKey, urlKey: p.writeIn.urlKey, brId: p.writeIn.brId })),
    allowInPool: false,
  };
}

/**
 * List as shown to the owner: drafted/unknown pool players are dropped. With `state`, write-ins that
 * would now be refused (already in the pool or already written in) are dropped too; without it they are kept.
 */
export function visibleQueue(queue, playersById, state = null) {
  const ctx = state ? writeInCtx(state) : null;
  return queue.filter((item) => {
    if (typeof item !== 'string') return !ctx || !checkWriteIn(item.writeIn, ctx).error;
    const p = playersById[item];
    return p && !p.ownerTeam && p.drafted == null && !p.removed;
  });
}

/** First usable entry (what auto-draft would take now), or null when the list is exhausted. */
export function topOfQueue(queue, playersById, state = null) {
  return visibleQueue(queue, playersById, state)[0] ?? null;
}

/**
 * The auto-draft lists a browser (or the ticker) hands to lib/tick.js. Pure, so it is unit tested.
 * Commissioner: every owner's list, keyed by the owner's login email (so a commissioner who is also an owner
 * contributes the one list stored under that email). Owner: only their own list, and only if they own a team.
 * A login that owns no team never contributes a list: auto-draft could never use it.
 */
export function tickQueues({ isAdmin, email, teams, ownQueue, owners, queues }) {
  const out = [];
  if (isAdmin) {
    for (const o of owners || []) {
      const q = (queues || {})[o.email];
      if (q) out.push({ email: o.email, teams: o.teams, ...q });
    }
  } else if (email && (teams || []).length) {
    out.push({ email: email.toLowerCase(), teams, ...ownQueue });
  }
  return out;
}

/** Warning shown on the Queue tab when the signed-in login owns no team (its list can never be used), else ''. */
export function queueOwnerWarning(teams, isAdmin) {
  if ((teams || []).length) return '';
  return isAdmin
    ? 'This login (commissioner) does not own any team, so a list built here will never be auto-drafted. Auto-draft uses the list of the login that owns the team. To use your own list, make your email the owner of your team in the owners file.'
    : 'This login is not linked to a team, so a list built here will never be auto-drafted. Ask the commissioner to add your email to the owners list.';
}
