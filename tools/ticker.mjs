// Unattended ticker: runs ONE pass of the shared clock logic (start, auto-draft, skip, complete) and exits.
// Run it every minute (Windows Task Scheduler) or every ~5 minutes (GitHub Actions). See docs/TICKER.md.
//
// SECURITY: the service-account key lets this script bypass the Firestore security rules and read every
// private draft list. Keep the key outside the repo, never commit or share it, use it only as the commissioner.
// Business rules are enforced by public/js/lib/{tick,draft,runner}.js, not by the rules.
//
// Key location (first found): env TBBL_SERVICE_ACCOUNT_JSON (the JSON text, e.g. a GitHub secret),
// env TBBL_SERVICE_ACCOUNT_FILE, "--key <path>", or %USERPROFILE%\.tbbl\serviceAccount.json
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { openFirestore, failFast } from './firestore-rest.mjs';
import { runTicker, ConflictError } from '../public/js/lib/runner.js';
import { planStillValid } from '../public/js/lib/persist.js';
import { runGroupMail } from '../public/js/lib/groupmail.js';
import { makeGroupMailIo } from './groupmail-io.mjs';
import { loadMailConfig, createTransport } from './mail-config.mjs';
import { getAuth } from 'firebase-admin/auth';
import { processPasswordRequests } from './pwrequests.mjs';
import { makePasswordIo } from './pwrequests-io.mjs';

let transport = null;
const transportOnce = async (cfg) => (transport ||= await createTransport(cfg));

function loadKey() {
  if (process.env.TBBL_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.TBBL_SERVICE_ACCOUNT_JSON);
  const i = process.argv.indexOf('--key');
  const file = (i > 0 && process.argv[i + 1]) || process.env.TBBL_SERVICE_ACCOUNT_FILE || join(homedir(), '.tbbl', 'serviceAccount.json');
  if (!existsSync(file)) throw new Error(`No service-account key found at ${file}. See docs/TICKER.md.`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

const app = initializeApp({ credential: cert(loadKey()) });
const db = openFirestore(app);
const data = (s) => (s.exists ? s.data() : null);

async function queuesFor(ownerDocs) {
  const out = [];
  for (const o of ownerDocs) {
    const email = String(o.data().email || o.id).toLowerCase();
    const q = await db.doc(`queues/${email}`).get();
    if (q.exists) out.push({ email, teams: o.data().teams || [], autoDraft: !!q.data().autoDraft, items: q.data().items || [] });
  }
  return out;
}

const io = {
  async loadLight() {
    // A commissioner Restart is running (or was interrupted): leave the clock alone until it is finished.
    const config = (await db.doc('config/restart').get()).exists ? null : data(await db.doc('config/draft').get());
    const tick = data(await db.doc('ticks/last').get());
    const light = { config, tickAt: tick ? tick.at : null, pick: null, unfilled: null, queues: [], notices: {} };
    if (!config) return light;
    if (config.currentPick != null) {
      light.pick = data(await db.doc(`picks/${config.currentPick}`).get());
      if (light.pick) {
        const owners = await db.collection('owners').where('teams', 'array-contains', light.pick.ownerTeam).get();
        light.queues = await queuesFor(owners.docs);
        for (const q of light.queues) {
          const n = data(await db.doc(`notices/${q.email}`).get());
          if (n) light.notices[q.email] = n;
        }
      }
    } else if (config.status === 'live') {
      light.unfilled = (await db.collection('picks').where('status', 'in', ['open', 'skipped']).count().get()).data().count; // voided picks do not count
    }
    return light;
  },
  async loadFull() {
    const [cfg, picks, chunks, owners, checks, removed] = await Promise.all([
      db.doc('config/draft').get(), db.collection('picks').get(), db.collection('playerchunks').get(),
      db.collection('owners').get(), db.collection('writeinChecks').get(), db.collection('removed').get(),
    ]);
    const p = {}; picks.forEach((d) => { p[d.id] = d.data(); });
    const ch = chunks.docs.map((d) => d.data()).sort((a, b) => a.i - b.i);
    const rm = {}; removed.forEach((d) => { rm[d.id] = true; });
    return {
      config: cfg.data(), picks: p, basePlayers: ch.flatMap((c) => c.players), removed: rm,
      queues: await queuesFor(owners.docs), verifiedKeys: checks.docs.map((d) => d.id),
    };
  },
  /** One transaction: re-check everything the step was based on, then write it all or nothing. */
  async commit(plan) {
    await db.runTransaction(async (tx) => {
      const cs = await tx.get(db.doc('config/draft'));
      const keys = Object.keys(plan.expect.picks);
      const pdocs = keys.length ? await tx.getAll(...keys.map((k) => db.doc(`picks/${k}`))) : [];
      const tdocs = plan.takenSet.length ? await tx.getAll(...plan.takenSet.map((t) => db.doc(`taken/${t.id}`))) : [];
      const stored = {}; pdocs.forEach((d, i) => { if (d.exists) stored[keys[i]] = d.data(); });
      if (!cs.exists || !planStillValid(plan, cs.data(), stored)) throw new ConflictError();
      if (tdocs.some((d) => d.exists)) throw new ConflictError('player already taken');
      for (const id of plan.takenDelete) tx.delete(db.doc(`taken/${id}`));
      for (const p of plan.picks) tx.set(db.doc(`picks/${p.key}`), p.data);
      for (const t of plan.takenSet) tx.set(db.doc(`taken/${t.id}`), t.data);
      if (plan.config) tx.set(db.doc('config/draft'), plan.config);
      for (const e of plan.audit) tx.set(db.collection('audit').doc(), e);
    });
  },
  async heartbeat(at) { await db.doc('ticks/last').set({ at, by: 'ticker' }); },
  async putNotice(email, n) {
    const ref = db.doc(`notices/${email}`);
    const o = data(await ref.get());
    if (!o || o.overall !== n.overall || o.sig !== n.sig) await ref.set(n);
  },
};

const stamp = () => new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET';

// Commissioner "Set password" requests from the Owners screen. Own step: a problem here is logged and retried
// next run, it never fails the clock (and a clock problem does not stop this). Only emails and outcomes are
// logged, never a password.
async function passwordStep() {
  try {
    const r = await failFast(processPasswordRequests(makePasswordIo(db, getAuth(app)), { log: (m) => console.log(`[${stamp()}] set-password ${m}`) }), 60000, 'The set-password step');
    if (r.done + r.failed + r.expired + r.busy + r.retry > 0) console.log(`[${stamp()}] set-password requests: done=${r.done} failed=${r.failed} expired=${r.expired} busy=${r.busy} retry=${r.retry}`);
  } catch (e) {
    console.error(`[${stamp()}] set-password step FAILED (will retry next run): ${String((e && e.code) || 'error')}`);
  }
}

try {
  const r = await failFast(runTicker(io), 60000, 'The ticker');
  console.log(`[${stamp()}] ticker ok: ${r.ran ? 'worked' : 'nothing due'}; steps=${r.steps.join(',') || 'none'}; conflicts=${r.conflicts}; notices=${r.notices.length}`);
  // Group pick emails (own step: a mail problem is logged and retried next run, it never fails the clock).
  try {
    const io = makeGroupMailIo(db);
    const sw = await io.getSwitch();
    if (sw && sw.groupEmails === true) {
      const cfg = loadMailConfig();
      const m = await runGroupMail(io, { sendMail: async (msg) => (await transportOnce(cfg)).sendMail(msg) }, { from: cfg.from, to: cfg.to, siteUrl: cfg.siteUrl });
      console.log(`[${stamp()}] group mail: ${m.status}; emails sent=${m.sent}${m.error ? '; error=' + m.error : ''}`);
    }
  } catch (e) {
    console.error(`[${stamp()}] group mail FAILED (will retry next run): ${String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  await passwordStep();
  process.exit(0);
} catch (e) {
  console.error(`[${stamp()}] ticker FAILED: ${e && e.message ? e.message : e}`);
  await passwordStep();
  process.exit(1);
}
