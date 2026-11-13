// "Who is online": each signed-in owner's open, visible page writes presence/{uid} = { teams, at } every
// BEAT_MS. A team counts as online while its newest beat is younger than ONLINE_MS. Only team codes are
// stored and shown (never emails). Pure helpers; store.js does the writes, ui.js the display.
//
// Cost on the free plan: every beat is one write, and every page that has the site open reads each beat.
// With N owners online that is about N*N/5 reads a minute (10 online all day: about 14,000 reads in 12 hours).

export const BEAT_MS = 5 * 60000;     // a visible page refreshes its presence every 5 minutes
export const ONLINE_MS = 12 * 60000;  // online = a beat in the last 12 minutes (covers a late beat or two)

/** Team codes online now, sorted. docs: { [uid]: { teams: [...], at } }. */
export function onlineTeams(docs, now, onlineMs = ONLINE_MS) {
  const set = new Set();
  for (const d of Object.values(docs || {})) {
    if (!d || typeof d.at !== 'number' || !Array.isArray(d.teams)) continue;
    if (d.at > now - onlineMs && d.at < now + 2 * 60000) for (const t of d.teams) if (t) set.add(String(t));
  }
  return [...set].sort();
}

/** Should this page write a beat now? */
export function beatDue({ teams, visible, lastBeat, now, force = false }) {
  if (!teams || !teams.length || !visible) return false;
  return force || lastBeat == null || now - lastBeat >= BEAT_MS;
}

/** The line shown under the banner. */
export function onlineText(teams) {
  return teams.length ? `Online now (${teams.length}): ${teams.join(' ')}` : 'No teams online right now.';
}
