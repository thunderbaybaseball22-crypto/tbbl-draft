// Firebase initialisation (Firebase JS SDK 10.12.2 from the Google CDN, no build step).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

export const SDK = '10.12.2';

export async function initFirebase() {
  let cfg;
  try {
    cfg = (await import('./firebase-config.js')).default;
  } catch (e) {
    throw new Error('Missing public/js/firebase-config.js. Copy firebase-config.example.js to firebase-config.js and paste your Firebase web-app settings (see docs/SETUP-DEPLOY.md).');
  }
  if (!cfg || String(cfg.apiKey).startsWith('PASTE')) {
    throw new Error('firebase-config.js still contains the PASTE_ placeholders. See docs/SETUP-DEPLOY.md.');
  }
  const app = initializeApp(cfg);
  return { app, cfg, auth: getAuth(app), db: getFirestore(app) };
}
