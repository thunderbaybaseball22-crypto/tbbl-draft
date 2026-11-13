// Mail settings and transport for the group pick emails. The Gmail app password is a secret:
// it lives OUTSIDE the repo (%USERPROFILE%\.tbbl\mail.json, or the env var TBBL_GMAIL_APP_PASSWORD for
// GitHub Actions) and is never printed or logged. See docs/TICKER.md.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_FROM = 'thunderbaybaseball22@gmail.com';
export const DEFAULT_TO = 'TBBL@groups.io';

/** Site link for the emails: mail.json "siteUrl", env TBBL_SITE_URL, else https://<projectId>.web.app. */
function siteUrlFromConfig() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const m = /projectId:\s*'([^']+)'/.exec(readFileSync(join(here, '..', 'public', 'js', 'firebase-config.js'), 'utf8'));
    return m ? `https://${m[1]}.web.app` : '';
  } catch { return ''; }
}

/** Returns { user, pass, from, to, siteUrl } or throws a message that never contains the password. */
export function loadMailConfig() {
  const file = process.env.TBBL_MAIL_FILE || join(homedir(), '.tbbl', 'mail.json');
  let f = {};
  if (existsSync(file)) {
    try { f = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`Could not read ${file} (it must be valid JSON). See docs/TICKER.md.`); }
  }
  const pass = String(process.env.TBBL_GMAIL_APP_PASSWORD || f.appPassword || '').replace(/\s+/g, '');
  if (!pass) throw new Error(`No Gmail app password found. Create ${file} as described in docs/TICKER.md (or set TBBL_GMAIL_APP_PASSWORD).`);
  const user = String(f.user || DEFAULT_FROM).trim();
  return {
    user, pass, from: String(f.from || user).trim(), to: String(f.to || DEFAULT_TO).trim(),
    siteUrl: String(f.siteUrl || process.env.TBBL_SITE_URL || siteUrlFromConfig()).trim(),
  };
}

/** Real transport (Gmail SMTP). nodemailer is loaded only when needed. */
export async function createTransport(cfg) {
  const nodemailer = (await import('nodemailer')).default;
  return nodemailer.createTransport({ service: 'gmail', auth: { user: cfg.user, pass: cfg.pass } });
}
