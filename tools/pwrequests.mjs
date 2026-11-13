// Commissioner "Set password" requests, applied by the unattended ticker (docs/TICKER.md).
// Flow: the Owners screen writes pwRequests/{email} = { password, requestedAt } plus a password-free status
// pwStatus/{email}. Each ticker run claims a request with a short lease (one transaction), sets the password
// with firebase-admin, signs the owner out of old sessions, then deletes the request and writes the final
// status in ONE transaction. The password lives only in the request document until then.
//
// SECURITY RULES OF THIS FILE: the password is never logged, never copied into a status/audit record,
// never put in an error message. Failures are reported by a fixed reason text or a Firebase error CODE only.
//
// All Firestore and Auth access goes through `io` so tests can fake it (see tests/pwrequests.test.js):
//   io.listIds()                    -> [email, ...] of pending request documents
//   io.txRequest(id, fn)            -> one transaction on pwRequests/{id}; fn(req|null) returns
//                                      { write?: newRequestDoc, del?: true, status?: statusDoc, result }
//   io.setPassword(email, password) -> sets the password; returns { uid } or throws (error.code like 'auth/user-not-found')
//   io.revoke(uid)                  -> signs the user out everywhere
import { randomUUID } from 'node:crypto';
import { checkEmail, checkPassword, MAX_LENGTH, REQUEST_EXPIRY_MINUTES } from '../public/js/lib/password-check.js';

/** A request older than this is never applied: it is deleted and reported as expired. */
export const EXPIRY_MS = REQUEST_EXPIRY_MINUTES * 60 * 1000;
/** How long one runner owns a request. Longer than the ticker's own 60 s limit, so a live run is never overlapped. */
export const LEASE_MS = 2 * 60 * 1000;
/** Allowed clock difference between the commissioner's browser and this PC (the security rules use the same figure). */
export const SKEW_MS = 2 * 60 * 1000;

const PERMANENT = {
  'auth/user-not-found': 'login does not exist',
  'auth/invalid-password': 'weak password (rejected by Firebase)',
  'auth/invalid-email': 'invalid email address',
  'auth/email-not-found': 'login does not exist',
};

/** Status record: never contains the password, only state, times and a fixed reason text. */
const status = (state, requestedAt, at, extra = {}) => ({ state, requestedAt: typeof requestedAt === 'number' ? requestedAt : null, at, ...extra });

/** Returns a reason string when the request must be rejected without touching the account, else null. */
export function rejectReason(id, req, nowMs) {
  if (!checkEmail(id).ok || checkEmail(id).email !== id) return 'invalid request (bad email)';
  if (!req || typeof req.password !== 'string' || typeof req.requestedAt !== 'number') return 'invalid request';
  if (req.requestedAt > nowMs + SKEW_MS) return 'invalid request (time in the future)';
  if (nowMs - req.requestedAt > EXPIRY_MS) return 'expired';
  if (req.password.length > MAX_LENGTH) return 'weak password: Too long';
  const chk = checkPassword(req.password, id);
  if (!chk.ok) return 'weak password: ' + chk.error;
  return null;
}

const codeOf = (e) => String((e && e.code) || 'error').replace(/[^\w/.-]/g, '').slice(0, 60);

/**
 * One pass over all pending requests. Safe to run from several runners at once and to repeat.
 * Returns counts only: { done, failed, expired, busy, retry, gone }.
 */
export async function processPasswordRequests(io, { now = Date.now, token = () => randomUUID(), log = () => {} } = {}) {
  const out = { done: 0, failed: 0, expired: 0, busy: 0, retry: 0, gone: 0 };
  for (const id of await io.listIds()) {
    const me = token();
    try {
      // 1. Claim (or finish off / reject) in a single transaction.
      const claim = await io.txRequest(id, (req) => {
        const t = now();
        if (!req) return { result: { kind: 'gone' } };
        if (req.lease && req.lease.until > t && req.lease.token !== me) return { result: { kind: 'busy' } };
        if (req.applied === true) { // an earlier run already set the password but crashed before cleaning up
          return { del: true, status: status('done', req.requestedAt, t, { note: 'password was set; the request was cleaned up afterwards' }), result: { kind: 'done' } };
        }
        const why = rejectReason(id, req, t);
        if (why) return { del: true, status: status('failed', req.requestedAt, t, { reason: why }), result: { kind: why === 'expired' ? 'expired' : 'failed' } };
        return { write: { ...req, lease: { token: me, until: t + LEASE_MS } }, result: { kind: 'claimed', password: req.password, requestedAt: req.requestedAt } };
      });
      if (claim.kind !== 'claimed') { out[claim.kind] += 1; log(`${id}: ${claim.kind}`); continue; }

      // 2. Set the password.
      let uid;
      try { ({ uid } = await io.setPassword(id, claim.password)); } catch (e) {
        const code = codeOf(e);
        if (PERMANENT[code]) {
          await finish(io, id, me, now, (req) => ({ del: !!req, status: status('failed', claim.requestedAt, now(), { reason: PERMANENT[code] }) }));
          out.failed += 1; log(`${id}: failed (${code})`);
        } else { // temporary problem (network etc.): give the lease back, try again next run until it expires
          await io.txRequest(id, (req) => (req && req.lease && req.lease.token === me
            ? { write: { ...stripLease(req) }, status: status('pending', claim.requestedAt, now(), { note: 'retrying after a temporary error (' + code + ')' }), result: null }
            : { result: null }));
          out.retry += 1; log(`${id}: will retry (${code})`);
        }
        continue;
      }

      // 3. Remember that the password is set (so a crash here never applies it twice), then sign out old sessions.
      const marked = await io.txRequest(id, (req) => (req && req.lease && req.lease.token === me
        ? { write: { ...req, applied: true }, result: true } : { result: false }));
      let note;
      if (marked) { try { await io.revoke(uid); } catch (e) { note = 'password set, but old sessions could not be signed out (' + codeOf(e) + ')'; } }

      // 4. Delete the request and report, atomically.
      const fin = await finish(io, id, me, now, (req) => ({ del: !!req, status: status('done', claim.requestedAt, now(), note ? { note } : {}) }));
      if (fin) { out.done += 1; log(`${id}: done`); } else { out.busy += 1; log(`${id}: taken over by another run`); }
    } catch (e) {
      log(`${id}: error (${codeOf(e)}); will retry`);
      out.retry += 1;
    }
  }
  return out;
}

const stripLease = ({ lease, ...rest }) => rest; // eslint-disable-line no-unused-vars

/** Final transaction: only the lease holder may finish (a vanished request, e.g. cancelled mid-apply, is still reported). */
function finish(io, id, me, now, build) {
  return io.txRequest(id, (req) => {
    if (req && req.lease && req.lease.token !== me && req.lease.until > now()) return { result: false };
    const b = build(req);
    return { del: b.del, status: b.status, result: true };
  });
}
