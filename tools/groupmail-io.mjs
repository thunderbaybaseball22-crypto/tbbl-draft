// Firestore (firebase-admin) side of the group pick emails. The logic is in public/js/lib/groupmail.js.
// Reads are kept small on purpose (free plan): the switch, the mail state, the draft config, and only the
// picks made recently. The player pool (~350 reads) is loaded only when an email is actually sent.

const data = (s) => (s.exists ? s.data() : null);

export function makeGroupMailIo(db) {
  const stateRef = db.doc('groupMail/state');
  return {
    async getSwitch() { return data(await db.doc('config/email').get()); },
    async getMail() { return data(await stateRef.get()); },
    async getConfig() { return data(await db.doc('config/draft').get()); },
    /** Made picks with madeAt after ms (single-field query: needs no composite index). */
    async getPicksSince(ms) {
      const s = await db.collection('picks').where('madeAt', '>', ms).get();
      return s.docs.map((d) => d.data()).filter((p) => p.status === 'made');
    },
    async getSendContext(overalls) {
      const config = data(await db.doc('config/draft').get());
      const docs = overalls.length ? await db.getAll(...overalls.map((n) => db.doc(`picks/${n}`))) : [];
      const picks = docs.filter((d) => d.exists).map((d) => d.data());
      const upcoming = config && config.currentPick != null
        ? (await db.collection('picks').where('overall', '>=', config.currentPick).orderBy('overall').limit(40).get()).docs.map((d) => d.data())
        : [];
      const skipped = (await db.collection('picks').where('status', '==', 'skipped').get()).docs.map((d) => d.data());
      const voided = (await db.collection('picks').where('status', '==', 'void').get()).docs.map((d) => d.data());
      const need = new Set(picks.map((p) => p.playerId).filter(Boolean));
      const names = {};
      if (need.size) {
        (await db.collection('playerchunks').get()).forEach((c) => {
          for (const p of c.data().players || []) if (need.has(p.id)) names[p.id] = p.name;
        });
      }
      return { config, picks, upcoming, skipped, voided, names };
    },
    transact(fn) {
      return db.runTransaction(async (tx) => {
        const out = fn(data(await tx.get(stateRef)));
        if (out.write) tx.set(stateRef, JSON.parse(JSON.stringify(out.write)));
        return out.result;
      });
    },
  };
}
