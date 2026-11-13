// Validation and normalisation for write-in picks (players not in the pool). Pure.

/** Lower-case, accent-free, punctuation-free name; drops a trailing Jr/Sr/II/III/IV. */
export function normName(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+(jr|sr|ii|iii|iv)$/, '');
}

/**
 * Any well-formed http(s) URL is accepted. For baseball-reference.com links the player id is
 * extracted (/players/x/idhere.shtml or /register/player.fcgi?id=...) so the same player cannot
 * be written in twice through different URL spellings.
 */
export function parseLink(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return { ok: false, error: 'That link is not a valid web address (include https://).' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'The link must start with http:// or https://' };
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let brId = null;
  if (host === 'baseball-reference.com' || host.endsWith('.baseball-reference.com')) {
    let m = u.pathname.match(/^\/players\/[a-z]\/([a-z0-9._'-]+)\.shtml$/i);
    if (m) brId = m[1].toLowerCase();
    else if (/^\/register\/player\.fcgi$/i.test(u.pathname) && u.searchParams.get('id')) brId = u.searchParams.get('id').toLowerCase();
  }
  const path = u.pathname.replace(/\/+$/, '');
  const url = `https://${host}${path}${u.search}`;
  const urlKey = brId ? `br:${brId}` : `${host}${path}${u.search}`.toLowerCase();
  return { ok: true, url, urlKey, brId, host };
}

/**
 * input: {name, url, note}; ctx: {pool: [{name,...}], writeIns: [{name, nameKey, urlKey, brId, overall}] (excluding the one being edited), allowInPool}
 * Returns {value} or {error, code}.
 */
export function checkWriteIn(input, ctx) {
  const name = String(input.name || '').trim().replace(/\s+/g, ' ');
  const url = String(input.url || '').trim();
  const note = String(input.note || '').trim();
  if (!name) return { error: 'Enter the player\'s name.', code: 'name-required' };
  if (name.length > 100 || note.length > 500) return { error: 'Name or note is too long.', code: 'too-long' };
  if (!url && !note) return { error: 'Enter a link to the player\'s page (baseball-reference.com if possible) or a note that identifies him.', code: 'link-required' };
  let link = null;
  if (url) {
    link = parseLink(url);
    if (!link.ok) return { error: link.error, code: 'bad-url' };
  }
  const nameKey = normName(name);
  if (!ctx.allowInPool) {
    const hit = (ctx.pool || []).find((p) => normName(p.name) === nameKey);
    if (hit) return { error: `"${hit.name}" is already in the player pool. Pick that player from the list instead.`, code: 'in-pool' };
  }
  for (const w of ctx.writeIns || []) {
    if ((link && link.brId && w.brId === link.brId) || (link && w.urlKey === link.urlKey) || w.nameKey === nameKey) {
      return { error: `That player was already written in at pick #${w.overall}.`, code: 'duplicate' };
    }
  }
  return { value: { name, nameKey, url: link ? link.url : '', urlKey: link ? link.urlKey : '', brId: link ? link.brId : null, note } };
}
