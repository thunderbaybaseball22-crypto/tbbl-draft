// Group pick emails: one email to the league group (TBBL@groups.io) for every 5 picks made, plus a final
// one when the draft completes. Pure logic + a runner that talks to an `io` object and a mail `transport`
// (nodemailer in tools/groupmail-io.mjs, a fake in the tests). No DOM, no Firebase, no network here.
//
// State lives in Firestore doc groupMail/state (written only by the ticker; the commissioner can read it):
//   { enabledAt, sent:[overall...], cursor, batchNo, skipReported:[overall...], lastSentAt, lastError,
//     pending: null | { id, overalls:[...], final, status:'sending'|'failed', lockUntil, retryAt, attempts } }
// The switch lives in config/email: { groupEmails: bool, enabledAt, by }. Missing doc = OFF.
//
// "Never twice": a batch is first CLAIMED in a transaction (pending, status 'sending', with a lock),
// then sent, then marked sent in a second transaction. A concurrent run sees the claim and does nothing.
// If sending fails the claim is marked 'failed' and the SAME picks are retried on a later run.
// If the process dies between sending and marking (very rare), the claim expires after LOCK_MS and the
// batch is sent once more: this favours "never lose a batch" over "never repeat in a crash".
export const BATCH = 5;
export const LOCK_MS = 10 * 60000;
export const SKEW_MS = 5 * 60000; // browsers and the ticker may disagree a little on the time

import { pickLabel } from './pickno.js';
export const pickNo = (p) => pickLabel(p); // 5.12, or 5.12a for an added pick
const byMade = (a, b) => (a.madeAt || 0) - (b.madeAt || 0) || a.overall - b.overall;

const ET = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';

/** Made picks that have not been emailed yet, oldest first. Skipped picks are never included. */
export function unsentPicks(picks, sent) {
  const s = new Set(sent || []);
  return picks.filter((p) => p.status === 'made' && !s.has(p.overall)).sort(byMade);
}

/**
 * Which picks go in the next email, or null. Every 5 unsent made picks make a batch; when the draft is
 * complete whatever is left (fewer than 5) goes out as the final batch.
 */
export function nextBatch(picks, sent, complete) {
  const u = unsentPicks(picks, sent);
  if (u.length >= BATCH) return { overalls: u.slice(0, BATCH).map((p) => p.overall), final: complete && u.length === BATCH };
  if (complete && u.length) return { overalls: u.map((p) => p.overall), final: true };
  return null;
}

const nameOf = (p, names) => (names && names[p.playerId]) || (p.writeIn && p.writeIn.name) || String(p.playerId);

/** The email text. batchPicks/skipped/upcoming are pick objects; names maps playerId -> player name. */
export function composeEmail({ batchPicks, skipped = [], voided = [], upcoming = [], config, names, siteUrl, final = false }) {
  const picks = [...batchPicks].sort(byMade);
  const first = pickNo(picks[0]), last = pickNo(picks[picks.length - 1]);
  const subject = `TBBL Draft: ${picks.length === 1 ? 'pick ' + first : `picks ${first} to ${last}`}${final ? ' (FINAL: draft complete)' : ''}`;
  const lines = [final ? 'TBBL Draft update: the draft is complete.' : 'TBBL Draft update', '', picks.length === 1 ? 'Pick made:' : 'Picks made:'];
  for (const p of picks) {
    const via = p.ownerTeam !== p.origTeam ? ` (via ${p.origTeam})` : '';
    const wi = p.writeIn ? (p.writeIn.status === 'pending' ? ' (write-in, pending verification)' : ' (write-in)') : '';
    lines.push(`  ${pickNo(p)}  ${p.ownerTeam}${via}  ${nameOf(p, names)}${wi}${p.wasSkipped ? ' (late pick)' : ''}`);
  }
  if (skipped.length) lines.push('', 'Skipped: ' + [...skipped].sort((a, b) => a.overall - b.overall).map((p) => `${p.ownerTeam} (pick ${pickNo(p)})`).join(', '));
  // A voided pick is listed like a skip (once) and never counts toward the 5 made picks.
  for (const p of [...voided].sort((a, b) => a.overall - b.overall)) lines.push(`Pick ${pickNo(p)} (${p.ownerTeam}): pick voided`);
  lines.push('');
  const next = upcoming.filter((p) => p.status === 'open').sort((a, b) => a.overall - b.overall).slice(0, BATCH);
  if (final || !next.length) lines.push(final ? 'The draft is complete.' : 'No picks are waiting on the clock right now.');
  else {
    lines.push('Up next (on the clock first):');
    next.forEach((p, i) => {
      const onClock = config && p.overall === config.currentPick;
      let tail = '';
      if (i === 0 && onClock) tail = config.status === 'paused' ? ' - on the clock (draft paused)' : config.deadline ? ` - on the clock, deadline ${ET(config.deadline)}` : ' - on the clock';
      lines.push(`  ${i + 1}. ${p.ownerTeam} (pick ${pickNo(p)})${p.ownerTeam !== p.origTeam ? ` (via ${p.origTeam})` : ''}${tail}`);
    });
  }
  if (siteUrl) lines.push('', `Draft site: ${siteUrl}`);
  lines.push('', 'Sent automatically by the TBBL draft site.');
  return { subject, text: lines.join('\n') };
}

/**
 * One pass. Safe to call from the ticker every minute, repeatedly, and from several processes at once.
 * io: getSwitch() getMail() getConfig() getPicksSince(ms) getSendContext(overalls) transact(fn)
 *   transact(fn): atomically fn(currentStateOrNull) -> { write?: newState, result }; fn may run more than once.
 *   getPicksSince(ms): made picks with madeAt > ms.
 *   getSendContext(overalls) -> { config, picks (those overalls), upcoming, skipped, names }
 * transport: { sendMail({from,to,subject,text}) }
 */
export async function runGroupMail(io, transport, { from, to, siteUrl = '', now = Date.now, maxBatches = 20 } = {}) {
  const out = { sent: 0, status: 'idle' };
  const sw = await io.getSwitch();
  if (!sw || sw.groupEmails !== true) return { ...out, status: 'off' };
  let mail = await io.getMail();
  if (!mail || mail.enabledAt !== sw.enabledAt) {
    // Switch was just turned ON: picks made while it was OFF are never emailed; counting starts now.
    const before = (await io.getPicksSince(0)).filter((p) => p.madeAt <= sw.enabledAt);
    const baseline = {
      enabledAt: sw.enabledAt, sent: before.map((p) => p.overall), cursor: Math.max(0, ...before.map((p) => p.madeAt || 0)),
      batchNo: mail ? mail.batchNo || 0 : 0, skipReported: [], pending: null, lastSentAt: null, lastError: null,
    };
    await io.transact((cur) => (cur && cur.enabledAt === sw.enabledAt ? { result: false } : { write: baseline, result: true }));
    return { ...out, status: 'baseline', baselined: before.length };
  }
  const config = await io.getConfig();
  if (!config) return out;
  const complete = config.status === 'complete';
  let recent = [];
  if (!mail.pending) {
    recent = await io.getPicksSince((mail.cursor || 0) - SKEW_MS);
    if (!nextBatch(recent, mail.sent, complete)) return out;
  }
  for (let i = 0; i < maxBatches; i++) {
    const t = now();
    const claim = (await io.transact((cur) => {
      if (!cur || cur.enabledAt !== sw.enabledAt) return { result: null };
      const p = cur.pending;
      if (p) {
        if (p.status === 'sending' && p.lockUntil > t) return { result: { busy: true } };
        if (p.status === 'failed' && (p.retryAt || 0) > t) return { result: { wait: true } };
        const np = { ...p, status: 'sending', lockUntil: t + LOCK_MS, attempts: (p.attempts || 1) + 1 };
        return { write: { ...cur, pending: np }, result: { batch: np } };
      }
      const nb = nextBatch(recent, cur.sent, complete);
      if (!nb) return { result: null };
      const np = { id: (cur.batchNo || 0) + 1, overalls: nb.overalls, final: nb.final, status: 'sending', lockUntil: t + LOCK_MS, attempts: 1 };
      return { write: { ...cur, pending: np }, result: { batch: np } };
    }));
    if (!claim) break;
    if (claim.busy || claim.wait) { out.status = claim.busy ? 'busy' : 'waiting'; break; }
    const batch = claim.batch;
    let ctx, reported = [], reportedV = [];
    try {
      ctx = await io.getSendContext(batch.overalls);
      const live = ctx.picks.filter((p) => p.status === 'made');
      if (live.length) {
        const fresh = await io.getMail();
        const done = new Set((fresh && fresh.skipReported) || []);
        const skipped = ctx.skipped.filter((p) => !done.has(p.overall));
        reported = skipped.map((p) => p.overall);
        const doneV = new Set((fresh && fresh.voidReported) || []);
        const voided = (ctx.voided || []).filter((p) => !doneV.has(p.overall));
        reportedV = voided.map((p) => p.overall);
        const msg = composeEmail({ batchPicks: live, skipped, voided, upcoming: ctx.upcoming, config: ctx.config, names: ctx.names, siteUrl, final: batch.final });
        await transport.sendMail({ from, to, subject: msg.subject, text: msg.text });
        out.sent++;
      }
    } catch (e) {
      const why = String((e && e.message) || e).slice(0, 200);
      await io.transact((cur) => {
        if (!cur || !cur.pending || cur.pending.id !== batch.id) return { result: false };
        const p = { ...cur.pending, status: 'failed', retryAt: now() + Math.min(cur.pending.attempts || 1, 5) * 60000 };
        return { write: { ...cur, pending: p, lastError: why, lastErrorAt: now() }, result: true };
      });
      out.status = 'failed'; out.error = why;
      break;
    }
    const madeAt = Math.max(0, ...ctx.picks.map((p) => p.madeAt || 0));
    await io.transact((cur) => {
      if (!cur || !cur.pending || cur.pending.id !== batch.id) return { result: false };
      return {
        write: {
          ...cur, sent: [...new Set([...(cur.sent || []), ...batch.overalls])], cursor: Math.max(cur.cursor || 0, madeAt),
          batchNo: batch.id, skipReported: [...new Set([...(cur.skipReported || []), ...reported])], voidReported: [...new Set([...(cur.voidReported || []), ...reportedV])], pending: null,
          lastSentAt: now(), lastError: null,
        },
        result: true,
      };
    });
    out.status = 'sent';
    recent = recent.length ? recent : await io.getPicksSince(((await io.getMail()) || mail).cursor - SKEW_MS);
  }
  return out;
}
