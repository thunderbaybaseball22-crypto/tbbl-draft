// firebase-admin side of the set-password requests (the logic and its tests are in pwrequests.mjs).
// Same admin calls as tools/set-password.mjs: look the user up by email, updateUser, revokeRefreshTokens.
const clean = (o) => JSON.parse(JSON.stringify(o)); // drops undefined, which Firestore rejects

export function makePasswordIo(db, auth) {
  return {
    async listIds() { return (await db.collection('pwRequests').select().get()).docs.map((d) => d.id); },
    txRequest(id, fn) {
      const ref = db.doc(`pwRequests/${id}`);
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const out = fn(snap.exists ? snap.data() : null);
        if (out.write) tx.set(ref, clean(out.write));
        if (out.del) tx.delete(ref);
        if (out.status) tx.set(db.doc(`pwStatus/${id}`), clean(out.status));
        return out.result;
      });
    },
    async setPassword(email, password) {
      const user = await auth.getUserByEmail(email);
      await auth.updateUser(user.uid, { password });
      return { uid: user.uid };
    },
    revoke(uid) { return auth.revokeRefreshTokens(uid); },
  };
}
