// Owner invites that never expire (docs/COMMISSIONER-GUIDE.md, "Inviting owners").
// Firebase's own password-setup links expire after about an hour and that cannot be changed. So the invite
// email sent here only links to the site's first-time setup screen (https://<site>/#setup?email=...); the owner
// presses one button there and Firebase sends its 1-hour link at that moment.
//
// Flow: the commissioner's Owners screen writes invites/{email} = { state:'pending', requestedAt, by }.
// Each ticker run: claim the invite with a lease (one transaction), make sure a login exists for the email
// (created with a random password nobody knows), send the invite from the league Gmail account, then mark it
// sent. All Firestore, Auth and mail access goes through `io` so the tests can fake it (tests/invites.test.js):
//   io.listIds()              -> [email, ...] of invite documents
//   io.txInvite(id, fn)       -> one transaction on invites/{id}; fn(doc|null) returns { write?, result }
//   io.getOwner(email)        -> owners/{email} data or null
//   io.ensureUser(email)      -> { created: bool } (creates the login if missing)
//   io.send({ to, subject, text })
import { randomUUID } from 'node:crypto';

export const LEASE_MS = 2 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
/** An invite still not sent after this long (ticker off, mail broken) is marked failed so it does not go out by surprise later. */
export const GIVE_UP_MS = 7 * 24 * 3600 * 1000;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const PERMANENT = { 'auth/invalid-email': 'invalid email address', 'auth/email-already-exists': null, EENVELOPE: 'the email address was refused' };
const codeOf = (e) => String((e && (e.code || e.responseCode)) || 'error').replace(/[^\w/.-]/g, '').slice(0, 60);

/** The setup link for one owner. */
export function setupLink(siteUrl, email) {
  return `${String(siteUrl || '').replace(/\/+$/, '')}/#setup?email=${encodeURIComponent(email)}`;
}

/** Subject and plain text of the invite. owner = owners/{email} data (teams, teamNames, manager). */
export function composeInvite({ email, owner, siteUrl }) {
  const teams = (owner && owner.teams) || [];
  const names = teams.map((t) => ((owner.teamNames || {})[t] ? `${t} (${owner.teamNames[t]})` : t));
  const hello = owner && owner.manager ? `Hi ${owner.manager},` : 'Hi,';
  const text = [
    hello,
    '',
    `You are set up to draft for ${names.length ? names.join(' and ') : 'your team'} on the TBBL draft site.`,
    '',
    'To set your password:',
    `1. Open this link: ${setupLink(siteUrl, email)}`,
    '2. Press "Email me a link to set my password".',
    '3. Open that email (from noreply, check spam) and choose your password. That second link works for about 1 hour; if it runs out, open the link above again and press the button again.',
    '',
    `Your sign-in email is ${email}. The link in THIS email does not expire.`,
    `After that, sign in any time at ${String(siteUrl || '').replace(/\/+$/, '')}`,
    '',
    'If you already have a password for the draft site, just sign in; you can ignore this email.',
    '',
    'TBBL Commissioner',
  ].join('\n');
  return { subject: 'TBBL Draft: set up your login for the draft site', text };
}

/** One pass over all invites. Returns counts: { sent, failed, busy, retry, skipped }. */
export async function processInvites(io, { siteUrl, now = Date.now, token = () => randomUUID(), log = () => {} } = {}) {
  const out = { sent: 0, failed: 0, busy: 0, retry: 0, skipped: 0 };
  for (const id of await io.listIds()) {
    const me = token();
    try {
      const claim = await io.txInvite(id, (inv) => {
        const t = now();
        if (!inv || !['pending', 'sending'].includes(inv.state)) return { result: { kind: 'skipped' } };
        if (inv.lease && inv.lease.until > t && inv.lease.token !== me) return { result: { kind: 'busy' } };
        if (!EMAIL_RE.test(id) || id !== id.toLowerCase()) return { write: { ...strip(inv), state: 'failed', at: t, reason: 'invalid email address' }, result: { kind: 'failed' } };
        if (typeof inv.requestedAt !== 'number' || t - inv.requestedAt > GIVE_UP_MS) return { write: { ...strip(inv), state: 'failed', at: t, reason: 'not sent within 7 days (was the ticker running?); press Send invite again' }, result: { kind: 'failed' } };
        return { write: { ...inv, state: 'sending', lease: { token: me, until: t + LEASE_MS } }, result: { kind: 'claimed', attempts: inv.attempts || 0 } };
      });
      if (claim.kind !== 'claimed') { out[claim.kind] += 1; continue; }
      const owner = await io.getOwner(id);
      if (!owner) {
        await finish(io, id, me, now, (inv) => ({ ...strip(inv), state: 'failed', at: now(), reason: 'no longer an owner' }));
        out.failed += 1; log(`${id}: failed (not an owner)`); continue;
      }
      let created = false;
      try {
        ({ created } = await io.ensureUser(id));
        const msg = composeInvite({ email: id, owner, siteUrl });
        await io.send({ to: id, subject: msg.subject, text: msg.text });
      } catch (e) {
        const code = codeOf(e);
        const attempts = claim.attempts + 1;
        const permanent = PERMANENT[code];
        const giveUp = permanent || attempts >= MAX_ATTEMPTS;
        await finish(io, id, me, now, (inv) => (giveUp
          ? { ...strip(inv), state: 'failed', at: now(), attempts, reason: permanent || `could not send (${code}) after ${attempts} tries` }
          : { ...strip(inv), state: 'pending', at: now(), attempts, note: `retrying after an error (${code})` }));
        out[giveUp ? 'failed' : 'retry'] += 1; log(`${id}: ${giveUp ? 'failed' : 'will retry'} (${code})`);
        continue;
      }
      const ok = await finish(io, id, me, now, (inv) => ({ ...strip(inv), state: 'sent', at: now(), sentAt: now(), loginCreated: created, attempts: claim.attempts + 1 }));
      if (ok) { out.sent += 1; log(`${id}: sent${created ? ' (login created)' : ''}`); } else out.busy += 1;
    } catch (e) {
      out.retry += 1; log(`${id}: error (${codeOf(e)}); will retry`);
    }
  }
  return out;
}

const strip = (inv) => { const { lease, note, reason, ...rest } = inv || {}; return rest; }; // eslint-disable-line no-unused-vars

/** Only the lease holder may finish. A re-request made meanwhile (state back to pending, no lease) wins. */
function finish(io, id, me, now, build) {
  return io.txInvite(id, (inv) => {
    if (!inv || !inv.lease || inv.lease.token !== me) return { result: false };
    return { write: build(inv), result: true };
  });
}
