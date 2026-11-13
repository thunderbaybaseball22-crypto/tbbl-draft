// Shared Firestore setup for the firebase-admin tools.
// Uses the REST transport (plain HTTPS) instead of gRPC/HTTP/2, which corporate TLS-inspecting networks break
// ("14 UNAVAILABLE: No connection established. Last error: Protocol error"). See docs/TICKER.md.
import { initializeFirestore } from 'firebase-admin/firestore';

/** Firestore client for an initialized firebase-admin app. Call once, before any other Firestore use. */
export function openFirestore(app) {
  return initializeFirestore(app, { preferRest: true });
}

/** Rejects with a clear message if `promise` does not finish in `ms` (so a bad connection never hangs for minutes). */
export function failFast(promise, ms = 45000, what = 'Firestore') {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `${what} did not answer within ${Math.round(ms / 1000)}s. Check the network/proxy (see "No connection established" in docs/TICKER.md).`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
