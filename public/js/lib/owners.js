// Commissioner edits to one owner on the Owners screen (email, team codes, team names, manager). Pure: no Firebase,
// no DOM. Same rules as the owners importer (lib/csv.js loadOwners): valid lowercase email, at least one team, only
// teams in the draft order, and a team belongs to one email only.

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const splitTeams = (s) => [...new Set(String(s || '').split(/[\s,;|]+/).map((t) => t.trim().toUpperCase()).filter(Boolean))];

/**
 * owners: current owner records [{email, teams, teamNames, manager}]; oldEmail: the row being edited;
 * input: {email, teams: 'SCA RAV', teamNames: 'San Carlos Aces / Rock River Ravens', manager}; teamCodes: draft-order teams (or null).
 * Returns {owner, emailChanged, changes: [text], errors: [text]}. `owner` is null when there are errors.
 */
export function checkOwnerEdit(owners, oldEmail, input, teamCodes = null) {
  const errors = [];
  const old = owners.find((o) => o.email === oldEmail);
  if (!old) return { owner: null, emailChanged: false, changes: [], errors: [`Owner ${oldEmail} not found (the list may have just changed).`] };
  const email = String(input.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) errors.push(`"${input.email}" is not a valid email address.`);
  else if (email !== oldEmail && owners.some((o) => o.email === email)) errors.push(`${email} is already an owner. Edit that row instead (one email can own several teams).`);
  const teams = splitTeams(input.teams);
  if (!teams.length) errors.push('Give at least one team code.');
  for (const t of teams) {
    if (teamCodes && teamCodes.length && !teamCodes.includes(t)) errors.push(`Team ${t} is not in the draft order.`);
    const other = owners.find((o) => o.email !== oldEmail && (o.teams || []).includes(t));
    if (other) errors.push(`Team ${t} already belongs to ${other.email}. Remove it from that owner first.`);
  }
  const names = String(input.teamNames || '').split('/').map((s) => s.trim());
  const teamNames = {};
  if (names.some(Boolean)) {
    if (names.length === teams.length) teams.forEach((t, i) => { if (names[i]) teamNames[t] = names[i].slice(0, 100); });
    else if (names.length === 1) teams.forEach((t) => { teamNames[t] = names[0].slice(0, 100); });
    else errors.push(`Give one team name per team, in the same order, separated by " / " (${teams.length} team(s), ${names.length} name(s)).`);
  }
  const manager = String(input.manager || '').trim().slice(0, 100);
  if (errors.length) return { owner: null, emailChanged: false, changes: [], errors };
  const owner = { email, teams, teamNames, manager };
  const changes = [];
  if (email !== oldEmail) changes.push(`Email: ${oldEmail} -> ${email}`);
  if ((old.teams || []).join(' ') !== teams.join(' ')) changes.push(`Teams: ${(old.teams || []).join(' ') || '(none)'} -> ${teams.join(' ')}`);
  if (JSON.stringify(old.teamNames || {}) !== JSON.stringify(teamNames)) changes.push(`Team name: ${Object.values(old.teamNames || {}).join(' / ') || '(none)'} -> ${Object.values(teamNames).join(' / ') || '(none)'}`);
  if ((old.manager || '') !== manager) changes.push(`Manager: ${old.manager || '(none)'} -> ${manager || '(none)'}`);
  return { owner, emailChanged: email !== oldEmail, changes, errors };
}

/** The text the edit form starts with for one owner. */
export function ownerFormValues(o) {
  return { email: o.email, teams: (o.teams || []).join(' '), teamNames: (o.teams || []).map((t) => (o.teamNames || {})[t] || '').join(' / ').replace(/^( \/ )+$/, ''), manager: o.manager || '' };
}
