// Password and email input checks shared by tools/set-password.mjs, the ticker's set-password requests
// (tools/pwrequests.js) and the Owners screen in the browser, so all three apply the same strength rules.
// Firebase itself only requires 6 characters; the site's own "Change password" button asks for 8, so we do too.
export const MIN_LENGTH = 8;
export const MAX_LENGTH = 128;
/** A set-password request older than this is never applied by the ticker (see tools/pwrequests.mjs). */
export const REQUEST_EXPIRY_MINUTES = 15;
const COMMON = ['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyui', 'qwerty123', 'iloveyou', 'baseball', 'baseball1', 'tbbl2027', 'tbbldraft', 'letmein1', 'welcome1', 'abcd1234', '11111111', '00000000'];

/** The rules in plain words, shown on the Owners screen before the commissioner submits. */
export const PASSWORD_RULES = [
  `At least ${MIN_LENGTH} characters (at most ${MAX_LENGTH}).`,
  'No space at the start or end.',
  'A mix of different characters (not "aaaaaaaa").',
  'Not a very common password, not a keyboard or number run, and not the owner\'s email address.',
];

export function checkEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? { ok: true, email: e } : { ok: false, error: 'That does not look like an email address.' };
}

/** Returns {ok:true} or {ok:false, error}. The error never repeats the password. */
export function checkPassword(pw, email = '') {
  const p = String(pw ?? '');
  if (p.length < MIN_LENGTH) return { ok: false, error: `Too short: use at least ${MIN_LENGTH} characters.` };
  if (p.length > MAX_LENGTH) return { ok: false, error: `Too long: use at most ${MAX_LENGTH} characters.` };
  if (/^\s|\s$/.test(p)) return { ok: false, error: 'Do not start or end the password with a space.' };
  if (new Set(p).size < 4) return { ok: false, error: 'Too simple: use a mix of different characters.' };
  const low = p.toLowerCase();
  if (COMMON.includes(low)) return { ok: false, error: 'That is a very common password. Pick another.' };
  const local = String(email).trim().toLowerCase().split('@')[0];
  if (local && local.length >= 4 && (low === local || low === String(email).trim().toLowerCase())) return { ok: false, error: 'The password must not be the email address.' };
  if (/^(?:0123456789|1234567890|abcdefghij|qwertyuiop)/.test(low) && low.length <= 12) return { ok: false, error: 'Too easy to guess (a keyboard or number run).' };
  return { ok: true };
}
