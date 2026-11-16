// firebase-admin and Gmail side of the owner invites (the logic and its tests are in invites.mjs).
import { randomBytes } from 'node:crypto';
const clean = (o) => JSON.parse(JSON.stringify(o)); // drops undefined, which Firestore rejects

export function makeInviteIo(db, auth, { sendMail, from }) {
  return {
    async listIds() { return (await db.collection('invites').where('state', 'in', ['pending', 'sending']).select().get()).docs.map((d) => d.id); },
    txInvite(id, fn) {
      const ref = db.doc(`invites/${id}`);
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const out = fn(snap.exists ? snap.data() : null);
        if (out.write) tx.set(ref, clean(out.write));
        return out.result;
      });
    },
    async getOwner(email) { const s = await db.doc(`owners/${email}`).get(); return s.exists ? s.data() : null; },
    async ensureUser(email) {
      try { await auth.getUserByEmail(email); return { created: false }; } catch (e) {
        if (!e || e.code !== 'auth/user-not-found') throw e;
      }
      // Random password nobody knows; the owner sets their own from the setup screen.
      await auth.createUser({ email, password: randomBytes(24).toString('base64url') });
      return { created: true };
    },
    send({ to, subject, text }) { return sendMail({ from, to, subject, text }); },
  };
}
