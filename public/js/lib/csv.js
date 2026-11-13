// CSV parsing, loaders with validation, and exporters. Pure, no DOM, no Firebase.
import { normName } from './writein.js';
import { pickLabel, overallLabel } from './pickno.js';

/** RFC 4180 parser. Handles BOM, quotes, escaped quotes, CRLF, embedded newlines. */
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = '', inQ = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; }
    else if (c === ',') { row.push(field); field = ''; i++; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; rows.push(row); row = []; i++;
    } else { field += c; i++; }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Parses text into {headers, records} where each record maps normalised header -> trimmed value. */
export function parseRecords(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map(norm);
  const records = rows.slice(1).map((r, idx) => {
    const o = { _line: idx + 2 };
    headers.forEach((h, k) => { if (h && !(h in o)) o[h] = (r[k] ?? '').trim(); });
    return o;
  });
  return { headers, records };
}

/** Finds the first alias present in the headers; returns the normalised key or null. */
function pick(headers, aliases) {
  for (const a of aliases) if (headers.includes(a)) return a;
  return null;
}

const ALIASES = {
  round: ['round', 'rd'],
  slot: ['pickinround', 'slot', 'pick', 'pickno', 'roundpick'],
  overall: ['overallpicknumber', 'overallpick', 'overall', 'overallnumber'],
  orig: ['originalteam', 'origteam', 'originalowner', 'originalteamowned', 'originalteamownedpick', 'originalteamthatownedpick', 'origowner'],
  current: ['draftingteam', 'currentteam', 'currentowner', 'currentteamowned', 'currentteamownedpick', 'currentteamthatownspick', 'currentteamowner', 'owner'],
  traded: ['tradedteam'],
  pid: ['playerid', 'id', 'puid', 'pid'],
  pname: ['playername', 'name', 'player', 'fullname'],
  pteam: ['teamcode', 'team', 'tbblteam', 'teamid', 'owner', 'tbblowner', 'currentteam'],
  ppos: ['pos', 'position', 'p'],
  page: ['age'],
  pmlb: ['mlbteam', 'mlb'],
  pdob: ['dob', 'birthdate', 'birthday', 'dateofbirth'],
  paaa: ['aaa', 'aaaflag'],
  email: ['email', 'emailaddress', 'owneremail', 'manageremail'],
  oteam: ['teamcode', 'team', 'teams', 'teamcodes', 'abb', 'abbreviation'],
  oteamname: ['teamname', 'franchise'],
  omanager: ['managername', 'manager', 'ownername'],
};

const isBlankTeam = (v) => v === '' || v.toUpperCase() === 'AVAILABLE';
const upper = (v) => String(v || '').trim().toUpperCase();

/**
 * Draft order loader.
 * Returns {picks, teams, errors}. `errors` empty means OK.
 * Drafting (current) team is the authority; the original team is preserved.
 */
export function loadSchedule(text, { expectedTeams = 24 } = {}) {
  const { headers, records } = parseRecords(text);
  const errors = [];
  const col = {};
  for (const k of ['round', 'slot', 'overall', 'orig', 'current']) {
    col[k] = pick(headers, ALIASES[k]);
    if (!col[k]) errors.push(`Missing column for ${k} (accepted: ${ALIASES[k].join(', ')})`);
  }
  const tradedCol = pick(headers, ALIASES.traded);
  if (errors.length) return { picks: [], teams: [], errors };

  const picks = [];
  const seen = new Set();
  for (const r of records) {
    const overall = Number(r[col.overall]);
    const round = Number(r[col.round]);
    const slot = Number(r[col.slot]);
    const orig = upper(r[col.orig]);
    const owner = upper(r[col.current]);
    if (!Number.isInteger(overall) || overall < 1) { errors.push(`Line ${r._line}: bad overall pick "${r[col.overall]}"`); continue; }
    if (seen.has(overall)) errors.push(`Line ${r._line}: duplicate overall pick ${overall}`);
    seen.add(overall);
    if (!Number.isInteger(round) || !Number.isInteger(slot)) errors.push(`Line ${r._line}: bad round/pick-in-round`);
    if (!orig) errors.push(`Line ${r._line}: original team blank for pick ${overall}`);
    if (!owner) errors.push(`Line ${r._line}: current team blank for pick ${overall}`);
    if (tradedCol && r[tradedCol] && upper(r[tradedCol]) !== owner) {
      errors.push(`Line ${r._line}: Traded Team ${r[tradedCol]} differs from Drafting Team ${owner} for pick ${overall}`);
    }
    picks.push({ overall, round, slot, origTeam: orig, ownerTeam: owner });
  }
  picks.sort((a, b) => a.overall - b.overall);
  for (let i = 0; i < picks.length; i++) {
    if (picks[i].overall !== i + 1) { errors.push(`Overall picks must run 1..N with no gaps (problem near ${picks[i].overall})`); break; }
  }
  const teams = [...new Set(picks.flatMap((p) => [p.origTeam, p.ownerTeam]))].filter(Boolean).sort();
  if (expectedTeams && teams.length !== expectedTeams) errors.push(`Expected ${expectedTeams} distinct teams, found ${teams.length}`);
  if (!picks.length) errors.push('No picks found');
  return { picks, teams, errors };
}

/** Stat columns of the two rating files (display names; headers are matched ignoring case and punctuation). */
export const BAT_STATS = ['AVG', 'OBP', 'SPC', 'AB', 'H', '2B', '3B', 'HR', 'R', 'RBI', 'HBP', 'BB', 'K', 'SB', 'CS'];
export const PIT_STATS = ['ERA', 'W', 'L', 'S', 'G', 'GS', 'CG', 'SHO', 'INN', 'H', 'R', 'ER', 'HR', 'HBP', 'BB', 'IW', 'K', 'GDP'];

/**
 * Player loader. Takes one CSV text (the original player file) or { hitters, pitchers } (the two rating files:
 * each needs the stat columns above; hitters land in player.bat, pitchers in player.pit, and a player present in
 * both files, such as a two-way player, is merged into one record with both).
 *  - Real MLB players have a PUID above 9,999. Players who never played in MLB are created by hand
 *    with PUID -1 and the AAA flag: that is VALID. They get a stable internal key built from name + DOB
 *    (the original -1 and the AAA flag are kept for export).
 *  - A -1/AAA row and a real-ID row with the same name + DOB are MERGED: the real-ID record is kept and
 *    receives the team from the -1/AAA row; the -1 row is dropped (listed in `merges`).
 *  - A PUID of -1 without the AAA flag is a warning. Same name + DOB on any other pair of rows is a warning.
 * `teamCodes` (optional array) enables unknown-team-code checking.
 * Returns {players, errors, warnings, merges}. Blank team or AVAILABLE = available.
 */
export function loadPlayers(input, { teamCodes = null } = {}) {
  // `input` is one CSV text (the original single player file) or { hitters, pitchers } (two files with stats).
  const sources = typeof input === 'string'
    ? [{ text: input, kind: null, label: '' }]
    : [{ text: input.hitters, kind: 'bat', label: 'Hitters file' }, { text: input.pitchers, kind: 'pit', label: 'Pitchers file' }]
      .filter((s) => s.text && s.text.trim());
  const errors = [], warnings = [], merges = [];
  if (!sources.length) return { players: [], errors: ['No player file was provided.'], warnings, merges };
  const known = teamCodes ? new Set(teamCodes) : null;
  const slug = (s) => normName(s).replace(/ /g, '_');
  const at = (s, line) => (s.label ? `${s.label}, line ${line}` : `Line ${line}`);
  let rows = [];
  for (const s of sources) {
    const { headers, records } = parseRecords(s.text);
    const pre = s.label ? `${s.label}: ` : '';
    const cid = pick(headers, ALIASES.pid);
    const cname = pick(headers, ALIASES.pname);
    const cteam = pick(headers, ALIASES.pteam);
    const cpos = pick(headers, ALIASES.ppos);
    const cage = pick(headers, ALIASES.page);
    const cmlb = pick(headers, ALIASES.pmlb);
    const cdob = pick(headers, ALIASES.pdob);
    const caaa = pick(headers, ALIASES.paaa);
    const statCols = (s.kind === 'bat' ? BAT_STATS : s.kind === 'pit' ? PIT_STATS : []).map((n) => [n, norm(n)]);
    const before = errors.length;
    if (!cid) errors.push(`${pre}Missing player ID column (accepted: ${ALIASES.pid.join(', ')})`);
    if (!cname) errors.push(`${pre}Missing player name column (accepted: ${ALIASES.pname.join(', ')})`);
    if (!cteam) errors.push(`${pre}Missing team column (accepted: ${ALIASES.pteam.join(', ')})`);
    for (const [n, h] of statCols) if (!headers.includes(h)) errors.push(`${pre}Missing stat column ${n}`);
    if (errors.length > before) continue;
    for (const r of records) {
      const puid = r[cid];
      const name = r[cname];
      const team = isBlankTeam(r[cteam]) ? '' : upper(r[cteam]);
      const dob = cdob ? r[cdob] : '';
      const aaa = !!(caaa && r[caaa] && !/^(0|n|no|false)$/i.test(r[caaa]));
      if (!puid) { errors.push(`${at(s, r._line)}: blank player ID (${name || 'no name'})`); continue; }
      if (!name) errors.push(`${at(s, r._line)}: blank player name for ID ${puid}`);
      if (known && team && !known.has(team)) errors.push(`${at(s, r._line)}: unknown team code ${team} for ${name}`);
      const isNew = puid === '-1';
      // Stat files carry no AAA column: PUID -1 is the marker there, so only warn when a flag column exists.
      if (isNew && !aaa && (caaa || !s.kind)) warnings.push(`${at(s, r._line)}: ${name} has PUID -1 but no AAA flag.`);
      const id = isNew ? `N-${slug(name)}${dob ? '-' + slug(dob) : ''}` : puid;
      const row = {
        line: r._line, src: s, id, puid, aaa: isNew ? true : aaa, dob, name, pos: cpos ? r[cpos] : '', mlbTeam: cmlb ? r[cmlb] : '', ownerTeam: team,
        kind: isNew || (Number.isFinite(Number(puid)) && Number(puid) <= 9999) ? 'Non-MLB' : 'MLB',
      };
      if (cage && Number.isFinite(Number(r[cage])) && r[cage] !== '') row.age = Number(r[cage]);
      if (s.kind) {
        const stats = {};
        for (const [n, h] of statCols) {
          const x = r[h] === '' ? NaN : Number(r[h]);
          if (Number.isFinite(x)) stats[n] = x;
          else errors.push(`${at(s, r._line)}: ${name || puid} has a blank or non-numeric ${n} ("${r[h]}")`);
        }
        row[s.kind] = stats;
      }
      rows.push(row);
    }
  }
  // A player in both files (a two-way player) becomes one record carrying both stat lines.
  if (sources.length > 1) {
    const first = new Map();
    const kept = [];
    for (const p of rows) {
      const o = first.get(p.id);
      if (o && o.src !== p.src) {
        const kindKey = p.bat ? 'bat' : 'pit';
        o[kindKey] = p[kindKey];
        if (p.ownerTeam && !o.ownerTeam) o.ownerTeam = p.ownerTeam;
        else if (p.ownerTeam && o.ownerTeam && p.ownerTeam !== o.ownerTeam) warnings.push(`${p.name}: the two files list different teams (${o.ownerTeam} and ${p.ownerTeam}). Kept ${o.ownerTeam}.`);
        if (!o.pos) o.pos = p.pos;
        merges.push({ name: p.name, keptId: o.id, text: `${p.name} (ID ${p.puid}) is in both files: combined into one player with hitting and pitching stats.` });
        continue;
      }
      if (!first.has(p.id)) first.set(p.id, p);
      kept.push(p);
    }
    rows = kept;
  }
  // merge -1/AAA rows into the real-ID row with the same name + DOB
  const keyOf = (p) => `${normName(p.name)}|${normName(p.dob)}`;
  const real = new Map();
  for (const p of rows) if (p.puid !== '-1') { const k = keyOf(p); if (!real.has(k)) real.set(k, []); real.get(k).push(p); }
  const dropped = new Set();
  for (const p of rows) {
    if (p.puid !== '-1' || !p.dob) continue;
    const m = real.get(keyOf(p));
    if (!m || m.length !== 1) { if (m && m.length > 1) warnings.push(`Line ${p.line}: ${p.name} (${p.dob}) matches ${m.length} real-ID rows, so it was not merged.`); continue; }
    const target = m[0];
    let note = '';
    if (p.ownerTeam && !target.ownerTeam) { target.ownerTeam = p.ownerTeam; note = ` and took team ${p.ownerTeam}`; }
    else if (p.ownerTeam && target.ownerTeam && p.ownerTeam !== target.ownerTeam) warnings.push(`Merge conflict for ${p.name}: -1 row says ${p.ownerTeam}, real-ID row says ${target.ownerTeam}. Kept ${target.ownerTeam}.`);
    dropped.add(p);
    merges.push({ name: p.name, dob: p.dob, keptId: target.id, droppedLine: p.line, team: target.ownerTeam, text: `${p.name} (${p.dob}): kept real ID ${target.id} (line ${target.line})${note}; dropped the -1/AAA row on line ${p.line}.` });
  }
  rows = rows.filter((p) => !dropped.has(p));
  // remaining duplicates
  const ids = new Map(), people = new Map();
  for (const p of rows) {
    if (!ids.has(p.id)) ids.set(p.id, []);
    ids.get(p.id).push(p.src && p.src.label ? `${p.src.kind === 'bat' ? 'hitters' : 'pitchers'} ${p.line}` : p.line);
    if (p.dob) { const k = keyOf(p); if (!people.has(k)) people.set(k, []); people.get(k).push(p); }
  }
  for (const [id, lines] of ids) {
    if (lines.length > 1) errors.push(`Player ID ${id} is used by ${lines.length} rows (lines ${lines.slice(0, 5).join(', ')}${lines.length > 5 ? ', ...' : ''}). Every player needs a unique ID.`);
  }
  for (const list of people.values()) {
    if (list.length > 1) {
      warnings.push(`${list[0].name} (${list[0].dob}) appears on ${list.length} rows (lines ${list.map((p) => p.line).join(', ')}). Neither was dropped.`);
    }
  }
  const players = rows.map(({ line, src, ...p }) => p);
  return { players, errors, warnings, merges };
}

/** What changed between two player lists (previous import vs. new file). Keyed by internal id. */
export function diffPlayers(prev, next) {
  const a = new Map(prev.map((p) => [p.id, p])), b = new Map(next.map((p) => [p.id, p]));
  const added = next.filter((p) => !a.has(p.id));
  const removed = prev.filter((p) => !b.has(p.id));
  const teamChanged = [], renamed = [];
  for (const p of next) {
    const o = a.get(p.id);
    if (!o) continue;
    if ((o.ownerTeam || '') !== (p.ownerTeam || '')) teamChanged.push({ id: p.id, name: p.name, from: o.ownerTeam || '(available)', to: p.ownerTeam || '(available)' });
    if (o.name !== p.name) renamed.push({ id: p.id, from: o.name, to: p.name });
  }
  return { added, removed, teamChanged, renamed, previousCount: prev.length, newCount: next.length };
}

/** Same idea for draft orders (by overall pick). */
export function diffSchedule(prev, next) {
  const a = new Map(prev.map((p) => [p.overall, p])), b = new Map(next.map((p) => [p.overall, p]));
  const changed = [];
  for (const p of next) {
    const o = a.get(p.overall);
    if (o && (o.ownerTeam !== p.ownerTeam || o.origTeam !== p.origTeam)) changed.push({ overall: p.overall, from: `${o.ownerTeam} (orig ${o.origTeam})`, to: `${p.ownerTeam} (orig ${p.origTeam})` });
  }
  return { previousCount: prev.length, newCount: next.length, added: next.filter((p) => !a.has(p.overall)).length, removed: prev.filter((p) => !b.has(p.overall)).length, changed };
}

/** Same idea for owners (by email). */
export function diffOwners(prev, next) {
  const a = new Map(prev.map((o) => [o.email, o])), b = new Map(next.map((o) => [o.email, o]));
  return {
    previousCount: prev.length, newCount: next.length,
    added: next.filter((o) => !a.has(o.email)).map((o) => o.email),
    removed: prev.filter((o) => !b.has(o.email)).map((o) => o.email),
    changed: next.filter((o) => a.has(o.email) && a.get(o.email).teams.join() !== o.teams.join()).map((o) => ({ email: o.email, from: a.get(o.email).teams, to: o.teams })),
  };
}

/**
 * Owners loader: email + team code(s) (separate multiple with space, ; or |). Two layouts are accepted:
 * email,team_code (sample/rehearsal files) and Abb,TeamName,ManagerName,ManagerEmail (the league file).
 * Optional team name and manager name columns are kept for the commissioner's Owners screen.
 */
export function loadOwners(text, { teamCodes = null } = {}) {
  const { headers, records } = parseRecords(text);
  const errors = [], warnings = [];
  const cem = pick(headers, ALIASES.email);
  const ctm = pick(headers, ALIASES.oteam);
  const cnm = pick(headers, ALIASES.oteamname);
  const cmg = pick(headers, ALIASES.omanager);
  if (!cem) errors.push('Missing email column');
  if (!ctm) errors.push('Missing team column');
  if (errors.length) return { owners: [], errors, warnings };
  const byEmail = new Map();
  const teamOwner = new Map();
  for (const r of records) {
    const email = r[cem].toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { errors.push(`Line ${r._line}: invalid email "${r[cem]}"`); continue; }
    const teams = r[ctm].split(/[\s;|]+/).map(upper).filter(Boolean);
    if (!teams.length) errors.push(`Line ${r._line}: no team for ${email}`);
    for (const t of teams) {
      if (teamCodes && !teamCodes.includes(t)) errors.push(`Line ${r._line}: unknown team ${t}`);
      if (teamOwner.has(t) && teamOwner.get(t) !== email) errors.push(`Line ${r._line}: team ${t} already assigned to ${teamOwner.get(t)}`);
      teamOwner.set(t, email);
    }
    const cur = byEmail.get(email) || { email, teams: [] };
    for (const t of teams) if (!cur.teams.includes(t)) cur.teams.push(t);
    if (cnm && r[cnm]) { cur.teamNames ||= {}; for (const t of teams) cur.teamNames[t] = r[cnm]; }
    if (cmg && r[cmg] && !cur.manager) cur.manager = r[cmg];
    byEmail.set(email, cur);
  }
  if (teamCodes) for (const t of teamCodes) if (!teamOwner.has(t)) warnings.push(`Team ${t} has no owner email`);
  return { owners: [...byEmail.values()], errors, warnings };
}

// ---------- export ----------

const safe = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+@\t]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
  return s;
};
const q = (v) => {
  const s = safe(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export function toCsv(rows) {
  return rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}

const sorted = (picks) => [...picks].sort((a, b) => a.overall - b.overall);
const playerOf = (p, playersById) => (p.playerId ? playersById[p.playerId] : null);

/** Same columns as the input schedule, with "Player Drafted" filled as "Name (PUID)" or "Name (WRITE-IN)". */
export function exportSchedule(picks, playersById) {
  const rows = [['Rd', 'Slot', 'Round/Slot', 'Orig Team', 'Traded Team', 'Drafting Team', 'Player Drafted', 'Overall']];
  for (const p of sorted(picks)) {
    const pl = playerOf(p, playersById);
    const drafted = p.status === 'void' ? 'VOID' : !pl ? '' : p.writeIn ? `${pl.name} (WRITE-IN)` : `${pl.name} (${pl.puid ?? pl.id})`;
    rows.push([p.round, p.slot, pickLabel(p), p.origTeam,
      p.ownerTeam !== p.origTeam ? p.ownerTeam : '', p.ownerTeam, drafted, overallLabel(p)]);
  }
  return toCsv(rows);
}

/**
 * Full results, one row per pick. Write-ins are PUID -1 with the AAA flag plus their link, so they can be
 * created by hand in the league database afterwards.
 */
export function exportResults(picks, playersById) {
  const rows = [['overall', 'round', 'pick_in_round', 'original_team', 'drafting_team', 'status', 'puid', 'aaa', 'player_name',
    'write_in', 'write_in_status', 'link', 'baseball_reference_id', 'note', 'made_at_utc', 'made_by', 'pick_label', 'added_pick', 'void_note']];
  for (const p of sorted(picks)) {
    const pl = playerOf(p, playersById);
    const w = p.writeIn;
    rows.push([overallLabel(p), p.round, p.slot, p.origTeam, p.ownerTeam, p.status === 'void' ? 'VOID' : p.status,
      !pl ? '' : w ? '-1' : (pl.puid ?? pl.id), !pl ? '' : (w || pl.aaa) ? 'AAA' : '', pl ? pl.name : '',
      w ? 'yes' : '', w ? w.status : '', w ? w.url : '', w ? w.brId || '' : '', w ? w.note : '',
      p.madeAt ? new Date(p.madeAt).toISOString() : '', p.madeBy || '', pickLabel(p), p.added ? 'yes' : '', p.status === 'void' ? p.voidNote || '' : '']);
  }
  return toCsv(rows);
}

/** Only the write-ins: the players the commissioner must create by hand in the league database. */
export function exportNewPlayers(picks) {
  const rows = [['puid', 'aaa', 'player_name', 'drafting_team', 'round', 'pick_in_round', 'overall', 'link', 'baseball_reference_id', 'note', 'verification']];
  for (const p of sorted(picks).filter((x) => x.status === 'made' && x.writeIn)) {
    const w = p.writeIn;
    rows.push(['-1', 'AAA', w.name, p.ownerTeam, p.round, p.slot, overallLabel(p), w.url, w.brId || '', w.note, w.status]);
  }
  return toCsv(rows);
}
