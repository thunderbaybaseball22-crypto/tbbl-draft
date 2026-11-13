// COMMISSIONER ONLY. Sets a temporary password for one owner login, for an owner who cannot use the
// "Forgot password" email. Uses the same service-account key as the ticker (see docs/TICKER.md).
// Usage: tools\set-password.cmd owner@example.com     (you are asked for the password twice, hidden)
// The password is never printed, logged, or stored; the only output is a confirmation.
// Afterwards, tell the owner to sign in and press "Change password" right away.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { openFirestore, failFast } from './firestore-rest.mjs';
import { checkEmail, checkPassword } from './password-check.mjs';

const fail = (m) => { console.error('set-password: ' + m); process.exit(1); };

function loadKey() {
  if (process.env.TBBL_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.TBBL_SERVICE_ACCOUNT_JSON);
  const file = process.env.TBBL_SERVICE_ACCOUNT_FILE || join(homedir(), '.tbbl', 'serviceAccount.json');
  if (!existsSync(file)) throw new Error(`No service-account key found at ${file}. See docs/TICKER.md.`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Reads a line from the terminal without echoing it. */
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error('Run this from a normal terminal window (the password is typed hidden).'));
    process.stdout.write(prompt);
    let buf = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { done(); return resolve(buf); }
        if (c === '\u0003') { done(); return reject(new Error('Cancelled.')); }
        if (c === '\b' || c === '\u007f') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    const done = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stdout.write('\n'); };
    process.stdin.on('data', onData);
  });
}

const em = checkEmail(process.argv[2]);
if (!em.ok) fail(`${em.error} Usage: set-password.cmd owner@example.com`);

try {
  const pw = await askHidden('New temporary password (not shown): ');
  const chk = checkPassword(pw, em.email);
  if (!chk.ok) fail(chk.error);
  if (pw !== await askHidden('Type it again: ')) fail('The two entries do not match. Nothing was changed.');

  const app = initializeApp({ credential: cert(loadKey()) });
  const auth = getAuth();
  let user;
  try { user = await auth.getUserByEmail(em.email); } catch (e) {
    if (e && e.code === 'auth/user-not-found') fail(`No login exists for ${em.email}. Create it first (Commissioner tab > Create owner logins), or check the spelling.`);
    throw e;
  }
  const owner = await failFast(openFirestore(app).doc(`owners/${em.email}`).get());
  await auth.updateUser(user.uid, { password: pw });
  await auth.revokeRefreshTokens(user.uid); // signs out any old session
  console.log(`Password changed for ${em.email}.${owner.exists ? '' : ' Note: this email is not in the owners list.'}`);
  console.log('Tell the owner to sign in with it and press "Change password" right away.');
  process.exit(0);
} catch (e) {
  fail('FAILED: ' + String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 300));
}
