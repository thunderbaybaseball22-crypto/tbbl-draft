// UI for the live draft. Plain DOM + template strings; every dynamic value goes through esc().
import * as D from './lib/draft.js';
import { remainingOpenMs, isOpen, etParts, etToUtc } from './lib/clock.js';
import { addToQueue, removeFromQueue, moveInQueue, visibleQueue, topOfQueue, itemKey, checkQueueWriteIn, queueOwnerWarning } from './lib/queue.js';
import * as T from './lib/tick.js';
import { exportSchedule, exportResults, exportNewPlayers, BAT_STATS, PIT_STATS } from './lib/csv.js';
import { checkPassword, PASSWORD_RULES, REQUEST_EXPIRY_MINUTES } from './lib/password-check.js';
import { RESTART_WORD, lockedReason } from './lib/restart.js';
import { pickLabel, overallLabel } from './lib/pickno.js';
import { checkOwnerEdit, ownerFormValues } from './lib/owners.js';
import { onlineTeams, onlineText, ONLINE_MS } from './lib/presence.js';
import * as S from './store.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ET = (ms) => (ms ? new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET' : '');
const hms = (ms) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

const ui = { tab: 'board', built: null, search: '', pos: '', kind: '', avail: 'available', view: 'bat', editOwner: null, sort: { key: 'name', dir: 1 }, target: null, rosterTeam: '', msg: '', adminBuilt: false };
const TABS = [['board', 'Board'], ['players', 'Players'], ['mine', 'My picks'], ['queue', 'Queue'], ['rosters', 'Rosters'], ['history', 'History']];

const teamsOf = (st) => [...new Set(Object.values(st.picks).flatMap((p) => [p.origTeam, p.ownerTeam]))].sort();
const sortedPicks = (st) => Object.values(st.picks).sort((a, b) => a.overall - b.overall);
const label = (p) => `#${overallLabel(p)} (${pickLabel(p)}) ${p.ownerTeam}${p.ownerTeam !== p.origTeam ? ` via ${p.origTeam}` : ''}${p.status === 'void' ? ' - VOID' : ''}`;

function say(msg, bad = false) {
  ui.msg = msg;
  const el = $('#msg');
  if (el) { el.textContent = msg; el.className = bad ? 'msg bad' : 'msg'; }
}
async function run(fn) {
  try { await fn(); say(''); } catch (e) {
    const m = e && e.code === 'permission-denied' ? 'The server refused that (the pick, clock or your role just changed). Check the board and try again.' : (e && e.message) || String(e);
    say(m, true);
  }
}
const download = (name, text) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name; document.body.append(a); a.click(); a.remove();
};
const readFile = (input) => (input.files && input.files[0] ? input.files[0].text() : Promise.reject(new Error('Choose a file first')));
/** Hitters + pitchers files (with stats) if chosen, otherwise the old single players file. */
const readPlayerFiles = async () => {
  const h = $('#f-hit').files[0], p = $('#f-pit').files[0];
  if (h || p) {
    if (!(h && p)) throw new Error('Choose both the hitters file and the pitchers file');
    return { hitters: await h.text(), pitchers: await p.text() };
  }
  return readFile($('#f-pl'));
};

// ---------------------------------------------------------------- shell
export function mount(root) {
  root.innerHTML = '<div id="shell"></div>';
  S.onChange(render);
  setInterval(tick, 1000);
  render();
}

function render() {
  const r = S.raw();
  const shell = $('#shell');
  if (!r.user) { ui.built = null; ui.adminBuilt = false; return renderLogin(shell); }
  if (!$('#main')) {
    shell.innerHTML = `
      <header class="top"><h1>TBBL Draft</h1><div class="who"><span id="who"></span>
        <button id="chpw" class="link">Change password</button> <button id="logout">Sign out</button></div></header>
      <div id="banner" class="banner" role="status"></div>
      <p id="online" class="online" title="Teams with the site open in the last ${ONLINE_MS / 60000} minutes"></p>
      <p id="msg" class="msg" role="alert"></p>
      <nav id="nav" aria-label="Sections"></nav>
      <main id="main" tabindex="-1"></main>`;
    $('#logout').onclick = () => S.logout();
    $('#chpw').onclick = () => run(async () => {
      const pw = prompt('New password (at least 8 characters):');
      if (!pw) return;
      if (pw.length < 8) throw new Error('Use at least 8 characters.');
      await S.changePassword(pw); say('Password changed.');
    });
    shell.addEventListener('click', onClick);
    shell.addEventListener('input', onInput);
    shell.addEventListener('change', onInput);
    if (!ui.presenceHooks) {
      ui.presenceHooks = true;
      // back on the page: show up as online at once; page closing: drop off the list (best effort)
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') S.presenceTick(true); });
      window.addEventListener('pagehide', () => { S.clearPresence(); });
    }
  }
  $('#who').textContent = `${r.user.email}${r.isAdmin ? ' (commissioner)' : ''}${r.teams.length ? ' · team ' + r.teams.join(', ') : ''}`;
  const tabs = r.isAdmin ? [...TABS, ['admin', 'Commissioner'], ['monitor', 'Monitor']] : TABS;
  $('#nav').innerHTML = tabs.map(([k, n]) => `<button data-tab="${k}" aria-current="${ui.tab === k}">${esc(n)}</button>`).join('');
  updateBanner();
  updateOnline();
  if (r.error) say('Connection problem: ' + r.error, true);
  if (!r.ready) { $('#main').textContent = 'Loading…'; return; }
  if (!r.config) { $('#main').innerHTML = '<p>The draft has not been set up yet. The commissioner needs to import the draft order and players (Commissioner tab).</p>'; if (r.isAdmin) { ui.tab = 'admin'; } else return; }
  if (ui.built !== ui.tab) { $('#main').innerHTML = skeleton(ui.tab); ui.built = ui.tab; ui.adminBuilt = ui.tab === 'admin'; }
  fill(ui.tab);
}

function renderLogin(shell) {
  if ($('#loginform')) return;
  shell.innerHTML = `<section class="login"><h1>TBBL Draft</h1>
    <form id="loginform"><label>Email <input id="em" type="email" autocomplete="username" required></label>
    <label>Password <input id="pw" type="password" autocomplete="current-password" required></label>
    <button type="submit">Sign in</button> <button type="button" id="forgot" class="link">Forgot password / first-time setup</button></form>
    <p id="msg" class="msg" role="alert"></p></section>`;
  $('#loginform').onsubmit = (e) => { e.preventDefault(); run(() => S.login($('#em').value, $('#pw').value)); };
  $('#forgot').onclick = () => run(async () => {
    if (!$('#em').value) throw new Error('Type your email first.');
    await S.resetPassword($('#em').value); say('If that email has an account, a password-reset message has been sent.');
  });
}

// ---------------------------------------------------------------- banner / clock
/** "Online now (3): JER RAV SCA" under the banner (team codes only). */
function updateOnline() {
  const el = $('#online'); if (!el) return;
  const txt = onlineText(onlineTeams(S.raw().presence, S.serverNow()));
  if (el.textContent !== txt) el.textContent = txt;
}
function updateBanner() {
  const el = $('#banner'); if (!el) return;
  const r = S.raw(), c = r.config;
  if (!c) { el.textContent = ''; return; }
  const st = S.getState(), now = S.serverNow();
  let html = '';
  if (c.status === 'pending') html = `<strong>Draft not started.</strong> ${c.startAt ? 'Scheduled start: ' + esc(ET(c.startAt)) : 'No start time set yet.'}`;
  else if (c.status === 'complete') html = '<strong>The draft is complete.</strong>';
  else {
    const p = c.currentPick != null ? st.picks[c.currentPick] : null;
    const allMade = Object.values(st.picks).every((x) => x.status === 'made' || x.status === 'void');
    const who = p ? `<strong>On the clock: ${esc(label(p))}</strong>`
      : allMade ? '<strong>All picks are made.</strong> The draft closes when the commissioner is online.'
        : '<strong>No pick on the clock.</strong> Only skipped picks remain; owners can still fill them.';
    let time = '';
    if (p && c.status === 'live' && c.deadline != null) {
      time = ` <span class="count" role="timer">${hms(remainingOpenMs(now, c.deadline))}</span>` + (isOpen(now) ? '' : ' <em>(clock paused until 11:00 AM ET)</em>');
    } else if (p && c.status === 'paused') time = ` <span class="count">${hms(c.remainingMs ?? 0)}</span>`;
    html = `${who}${time}${c.status === 'paused' ? ' <em>Draft paused by the commissioner.</em>' : ''}`;
    if (p && c.status === 'live' && r.teams.includes(p.ownerTeam)) html += ' <span class="yours">It is your pick!</span>';
  }
  if (c.status === 'live') {
    html += exhaustedHtml(st);
    // "Last clock check": skips and auto-draft only happen while some browser is open (see the guides).
    const at = r.tickAt, age = at ? now - at : null;
    const stale = age == null || age > 10 * 60000;
    html += `<div class="tickinfo${stale && isOpen(now) ? ' stale' : ''}">Clock last checked: ${at ? esc(ET(at)) + ` (${Math.max(0, Math.round(age / 60000))} min ago)` : 'not yet'}${stale && isOpen(now) ? ' <strong>No browser has checked the clock for over 10 minutes: skips and auto-drafts are waiting for someone to open the site.</strong>' : ''}</div>`;
  }
  el.innerHTML = html;
}
function tick() {
  if (!S.raw().user) return;
  updateBanner();
  updateOnline();
  S.presenceTick();
  S.autoAdvance(T);
}

// ---------------------------------------------------------------- tabs
function skeleton(tab) {
  if (tab === 'players') {
    return `<div class="controls">
      <label>Search <input id="q" type="search" value="${esc(ui.search)}"></label>
      <label id="view-l">Stats <select id="view"><option value="bat">Hitters</option><option value="pit">Pitchers</option></select></label>
      <label>Position <select id="pos"><option value="">All</option></select></label>
      <label>Show <select id="avail"><option value="available">Available</option><option value="taken">Drafted / kept</option><option value="all">All</option><option value="removed">Removed from list</option></select></label>
      <label>Type <select id="kind"><option value="">All</option><option value="MLB">MLB (PUID above 9,999)</option><option value="Non-MLB">Non-MLB (-1 / AAA)</option></select></label>
      <label>Drafting for <select id="target"></select></label></div>
      <details class="writein"><summary>Player not in the list? Write him in</summary>
        <p class="note">Use this only if the player is not in the pool. The pick counts right away and the commissioner verifies it afterward. Give a link to his page (baseball-reference.com if possible) or a note that identifies him (for example a high-school player with no page).</p>
        <div class="controls"><label>Player name <input id="wi-name" maxlength="100" autocomplete="off"></label>
        <label>Link (https://...) <input id="wi-url" type="url" size="40" placeholder="https://www.baseball-reference.com/..."></label>
        <label>Or a note <input id="wi-note" maxlength="500" size="30" placeholder="e.g. HS SS, Tulsa OK, class of 2027"></label>
        <label id="wi-ov" hidden><span><input id="wi-override" type="checkbox"> Allow even though the name is in the pool</span></label>
        <button data-writein>Draft write-in</button></div></details>
      <div id="plist"></div>`;
  }
  if (tab === 'admin') return adminSkeleton();
  return '<div id="body"></div>';
}

function fill(tab) {
  const st = S.getState();
  if (tab === 'board') return ($('#body').innerHTML = boardHtml(st));
  if (tab === 'players') return fillPlayers(st);
  if (tab === 'mine') return ($('#body').innerHTML = mineHtml(st));
  if (tab === 'queue') return ($('#body').innerHTML = queueHtml(st));
  if (tab === 'rosters') return ($('#body').innerHTML = rostersHtml(st));
  if (tab === 'history') return ($('#body').innerHTML = historyHtml(st));
  if (tab === 'admin') return fillAdmin(st);
  if (tab === 'monitor') return fillMonitor();
}

// ---------------------------------------------------------------- monitor mode (commissioner keep-alive page)
const mon = { lock: null, lockMsg: 'Screen wake lock not requested yet.', lastRun: null, timer: null };
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) { mon.lockMsg = 'This browser cannot keep the screen awake. Turn off screen sleep in the device settings and keep this page in the foreground.'; return; }
  try {
    mon.lock = await navigator.wakeLock.request('screen');
    mon.lockMsg = 'Screen will stay awake while this page is visible.';
    mon.lock.addEventListener('release', () => { mon.lock = null; mon.lockMsg = 'Wake lock was released (the page was hidden or the device saved power). It is requested again when the page is visible.'; });
  } catch (e) { mon.lockMsg = 'Could not keep the screen awake (' + ((e && e.name) || 'error') + '). Turn off screen sleep in the device settings.'; }
}
function monitorRun() {
  if (!S.raw().isAdmin) return;
  mon.lastRun = S.serverNow();
  S.autoAdvance(T);
  if (ui.tab === 'monitor') fillMonitor();
}
function fillMonitor() {
  const body = $('#body'); if (!body) return;
  const r = S.raw(), c = r.config;
  if (!mon.timer) { mon.timer = setInterval(monitorRun, 30000); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !mon.lock && ui.tab === 'monitor') requestWakeLock().then(fillMonitor); }); }
  if (!mon.lock && !mon.asked) { mon.asked = true; requestWakeLock().then(fillMonitor); }
  const now = S.serverNow();
  const m = T.monitorStatus({ now, tickAt: r.tickAt, deadline: c && c.deadline, status: c && c.status, windowOpen: isOpen(now) });
  const mins = (ms) => `${Math.round(ms / 60000)} min`;
  const html = `<section class="monitor"><h2>Monitor Mode</h2>
    <p class="note">Leave this page open on a spare phone, tablet or PC during clock hours (11:00 AM-11:00 PM ET). It checks the clock about every 30 seconds and records the skips and auto-drafts that are due. Sign in as the commissioner.</p>
    ${m.stale ? `<p class="tickinfo stale" role="alert"><strong>WARNING: no clock check has been recorded ${m.ageMs == null ? 'yet' : 'for ' + mins(m.ageMs)} while the clock window is open.</strong> Check that this page is awake and online.</p>` : ''}
    <ul><li>Draft status: <b>${esc(c ? c.status : 'not set up')}</b></li>
    <li>Last recorded clock check (any browser): <b>${r.tickAt ? esc(ET(r.tickAt)) + ` (${mins(m.ageMs)} ago)` : 'none yet'}</b></li>
    <li>This page last ran the check: <b>${mon.lastRun ? esc(ET(mon.lastRun)) : 'waiting for the first run'}</b></li>
    <li>Next deadline: <b>${m.msToDeadline != null ? esc(ET(c.deadline)) + ' (' + hms(Math.max(0, m.msToDeadline)) + ' left; the countdown only runs 11 AM-11 PM ET)' : 'none (no pick is running)'}</b></li>
    <li>Clock window now: <b>${isOpen(now) ? 'open' : 'closed (paused until 11:00 AM ET)'}</b></li>
    <li>${esc(mon.lockMsg)}</li></ul>
    <button data-monitor="lock">Keep screen awake</button> <button data-monitor="run">Check the clock now</button></section>`;
  if (body.dataset.h !== html) { body.dataset.h = html; body.innerHTML = html; }
}

const wiTag = (p) => (p.writeIn ? ` <small class="wi">[write-in${p.writeIn.status === 'pending' ? ', pending verification' : ''}]</small>` : '');

// What one pick shows inside a board cell. Used for the base pick and for added (lettered) picks.
function pickParts(st, p) {
  const pl = p.playerId ? st.players[p.playerId] : null;
  const cur = st.config.currentPick === p.overall;
  const traded = p.ownerTeam !== p.origTeam;
  const cls = [p.status, cur ? 'current' : '', traded && p.status !== 'void' ? 'traded' : '', S.raw().teams.includes(p.ownerTeam) ? 'mine' : ''].join(' ');
  const via = traded ? ` <small>via ${esc(p.origTeam)}</small>` : '';
  const what = pl ? esc(pl.name) + wiTag(p) : p.status === 'void' ? '<strong class="voidtag">VOID</strong>' : p.status === 'skipped' ? '<em>skipped</em>' : cur ? '<em>on the clock</em>' : '—';
  const plain = pl ? pl.name + (p.writeIn ? (p.writeIn.status === 'pending' ? ' [write-in, pending verification]' : ' [write-in]') : '') : p.status === 'void' ? 'VOID (cannot be drafted)' : p.status === 'skipped' ? 'skipped' : cur ? 'on the clock' : 'not picked yet';
  const tip = `${pickLabel(p)} (#${overallLabel(p)}) ${p.ownerTeam}${traded ? ' via ' + p.origTeam : ''}${p.added ? ' (added pick)' : ''}: ${plain}`;
  return { cls, via, what, tip };
}
function pickCell(st, p, added = []) {
  const m = pickParts(st, p);
  // Added picks (5.12a, 5.12b) share the cell of the pick they follow, one line each, so the grid keeps its
  // 24 rows and its columns; the row only grows taller when a pick was added there.
  const extra = added.map((a) => { const x = pickParts(st, a); return `<div class="pk added ${x.cls}" title="${esc(x.tip)}"><span class="addno">${esc(pickLabel(a))}</span> <b>${esc(a.ownerTeam)}</b> ${x.what}</div>`; }).join('');
  return `<td class="${m.cls}${p.writeIn ? ' writein' : ''}${added.length ? ' hasadded' : ''}" title="${esc(m.tip)}"><b>${esc(p.ownerTeam)}</b>${m.via} ${m.what}${extra}</td>`;
}

function boardHtml(st) {
  const picks = sortedPicks(st);
  // Rows = pick slot within the round (1-24), columns = rounds. The row header shows the slot and the team
  // that owns that slot in the first round; each cell shows the current owner, 'via' original team, and player.
  const byKey = new Map(picks.filter((p) => !p.added).map((p) => [`${p.round}-${p.slot}`, p]));
  const addedBy = new Map();
  for (const p of picks.filter((x) => x.added)) { const k = `${p.round}-${p.slot}`; addedBy.set(k, [...(addedBy.get(k) || []), p]); }
  const rounds = [...new Set(picks.map((p) => p.round))].sort((a, b) => a - b);
  const slots = [...new Set(picks.map((p) => p.slot))].sort((a, b) => a - b);
  const slotTeam = (s) => { const p = picks.find((x) => x.slot === s && !x.added); return p ? p.origTeam : ''; };
  const head = `<tr><th scope="col" class="slot">Pick</th>${rounds.map((r) => `<th scope="col">Rd ${esc(r)}</th>`).join('')}</tr>`;
  const grid = slots.map((s) => `<tr><th scope="row" class="slot"><span class="slotno">${esc(s)}</span> ${esc(slotTeam(s))}</th>${rounds.map((r) => { const p = byKey.get(`${r}-${s}`); return p ? pickCell(st, p, addedBy.get(`${r}-${s}`) || []) : '<td></td>'; }).join('')}</tr>`).join('');
  const recent = picks.filter((p) => p.status === 'made').sort((a, b) => b.madeAt - a.madeAt).slice(0, 10);
  const legend = '<ul class="legend" aria-label="Board legend"><li><span class="sw t"></span>Traded (shows "via" the original team)</li><li><span class="sw c"></span>On the clock</li><li><span class="sw v"></span>VOID</li><li><span class="sw s"></span>Skipped</li><li><span class="sw w"></span>Write-in (marked [write-in])</li></ul>';
  return `<h2 class="boardtitle">Draft board</h2>${legend}<div class="boardwrap"><table class="grid"><caption class="sr">Draft board: pick slots down, rounds across</caption><thead>${head}</thead><tbody>${grid}</tbody></table></div>
    <h2>Recent picks</h2><ol class="recent">${recent.map((p) => `<li>#${esc(overallLabel(p))} ${esc(p.ownerTeam)}: ${esc(st.players[p.playerId]?.name)}${wiTag(p)}</li>`).join('') || '<li>None yet</li>'}</ol>`;
}

// ----- players
function fillPlayers(st) {
  const r = S.raw();
  const posSel = $('#pos');
  // Pools built from the hitters + pitchers files carry stats (p.bat / p.pit); the old single file does not.
  const hasStats = Object.values(st.players).some((p) => p.bat || p.pit);
  $('#view-l').hidden = !hasStats;
  const inView = (p) => !hasStats || !!p[ui.view] || !!p.writeIn;
  const poss = [...new Set(Object.values(st.players).filter(inView).map((p) => p.pos).filter(Boolean))].sort();
  if (posSel.dataset.k !== poss.join('|')) { posSel.innerHTML = '<option value="">All</option>' + poss.map((p) => `<option>${esc(p)}</option>`).join(''); posSel.dataset.k = poss.join('|'); }
  if (ui.pos && !poss.includes(ui.pos)) ui.pos = '';
  posSel.value = ui.pos; $('#avail').value = ui.avail; $('#view').value = ui.view;
  // pick target options
  const mine = sortedPicks(st).filter((p) => p.status !== 'made' && p.status !== 'void' && (r.isAdmin || r.teams.includes(p.ownerTeam)));
  const cur = st.config.currentPick;
  if (!mine.some((p) => p.overall === ui.target)) ui.target = (mine.find((p) => p.overall === cur) || mine[0] || {}).overall ?? null;
  $('#target').innerHTML = mine.length
    ? mine.map((p) => `<option value="${p.overall}"${p.overall === ui.target ? ' selected' : ''}>${esc(label(p))}${p.overall === cur ? ' - ON CLOCK' : p.status === 'skipped' ? ' - skipped' : ''}</option>`).join('')
    : '<option value="">(no open picks)</option>';
  let list = Object.values(st.players).filter(inView);
  const q = ui.search.trim().toLowerCase();
  if (q) list = list.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase() === q);
  if (ui.pos) list = list.filter((p) => p.pos === ui.pos);
  if (ui.kind) list = list.filter((p) => p.kind === ui.kind);
  $('#kind').value = ui.kind;
  $('#wi-ov').hidden = !r.isAdmin;
  // Players the commissioner removed (listed by mistake) are hidden everywhere except Show > Removed from list.
  if (ui.avail === 'removed') list = list.filter((p) => p.removed);
  else {
    list = list.filter((p) => !p.removed);
    if (ui.avail === 'available') list = list.filter((p) => !p.ownerTeam);
    else if (ui.avail === 'taken') list = list.filter((p) => p.ownerTeam);
  }
  const { key, dir } = ui.sort;
  // sort keys look like 'name', 'pos', or 'bat.HR' (a stat); players with no value for a stat always sort last
  const val = (p) => (key.includes('.') ? (p[key.split('.')[0]] || {})[key.split('.')[1]] : p[key]);
  list.sort((a, b) => {
    const x = val(a), y = val(b);
    if (typeof x === 'number' || typeof y === 'number') {
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
      return (x - y) * dir;
    }
    return String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true }) * dir;
  });
  const shown = list.slice(0, 250);
  const canDraft = ui.target != null && D.canPick(st, r.isAdmin ? { isAdmin: true, teams: [] } : { teams: r.teams }, ui.target, S.serverNow());
  const qset = new Set(r.queue.items.filter((x) => typeof x === 'string'));
  const th = (k, n) => `<th scope="col"><button class="sort" data-sort="${k}" aria-label="Sort by ${n}">${n}${ui.sort.key === k ? (ui.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`;
  // Draft / Queue for available players; the commissioner also gets Remove (not for a player already drafted) and Restore.
  const actions = (p) => {
    if (p.removed) return r.isAdmin ? `<button data-rsplayer="${esc(p.id)}">Restore</button>` : '';
    const pick = !p.ownerTeam ? `${canDraft ? `<button data-draft="${esc(p.id)}">Draft</button> ` : ''}<button data-q="${esc(p.id)}" ${qset.has(p.id) ? 'disabled' : ''}>${qset.has(p.id) ? 'Queued' : '+ Queue'}</button>` : '';
    const rm = r.isAdmin && p.drafted == null && !p.writeIn ? ` <button data-rmplayer="${esc(p.id)}" title="Take him out of the draft list">Remove</button>` : '';
    return pick + rm;
  };
  const statNames = hasStats ? (ui.view === 'bat' ? BAT_STATS : PIT_STATS) : [];
  const fmt = (n, v) => (v == null ? '' : ['AVG', 'OBP', 'SPC'].includes(n) ? v.toFixed(3).replace(/^0\./, '.') : n === 'ERA' ? v.toFixed(2) : String(v));
  const thNum = (k, n) => th(k, n).replace('<th ', '<th class="num" ');
  const heads = hasStats
    ? `${th('name', 'Player')}${th('pos', 'Pos')}${thNum('age', 'Age')}${statNames.map((n) => thNum(ui.view + '.' + n, n)).join('')}`
    : `${th('name', 'Player')}${th('pos', 'Pos')}${th('mlbTeam', 'MLB')}`;
  const cells = (p) => (hasStats
    ? `<td>${esc(p.name)}</td><td>${esc(p.pos)} <small>${esc(p.kind)}</small></td><td class="num">${esc(p.age ?? '')}</td>${statNames.map((n) => `<td class="num">${esc(fmt(n, (p[ui.view] || {})[n]))}</td>`).join('')}`
    : `<td>${esc(p.name)}</td><td>${esc(p.pos)} <small>${esc(p.kind)}</small></td><td>${esc(p.mlbTeam)}</td>`);
  $('#plist').innerHTML = `<p>${list.length} players${list.length > shown.length ? ` (showing the first ${shown.length}; narrow the search)` : ''}</p>
    <div class="scroll"><table><thead><tr>${heads}${th('ownerTeam', 'Status')}<th scope="col">Actions</th></tr></thead><tbody>
    ${shown.map((p) => `<tr>${cells(p)}
      <td>${p.removed ? 'Removed from list' : p.ownerTeam ? 'Owned by ' + esc(p.ownerTeam) + (p.drafted != null ? ' (#' + p.drafted + ')' : ' (keeper)') : 'Available'}</td>
      <td>${actions(p)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

// ----- my picks / queue
const itemName = (st, it) => (typeof it === 'string' ? (st.players[it] ? st.players[it].name : it) : `${it.writeIn.name} (write-in)`);
function mineHtml(st) {
  const r = S.raw();
  const mine = sortedPicks(st).filter((p) => p.status !== 'made' && p.status !== 'void' && r.teams.includes(p.ownerTeam));
  const top = topOfQueue(r.queue.items, st.players, st);
  const rows = mine.map((p) => {
    const cur = st.config.currentPick === p.overall;
    const can = D.canPick(st, { teams: r.teams }, p.overall, S.serverNow());
    return `<tr><td>${esc(label(p))}</td><td>${cur ? '<b>ON THE CLOCK</b>' : p.status === 'skipped' ? 'Skipped (you can still pick)' : 'Upcoming'}</td>
      <td>${can ? `<button data-target="${p.overall}">Choose a player</button>${top ? ` <button data-drafttop="${p.overall}">Draft top of list: ${esc(itemName(st, top))}</button>` : ''}` : ''}</td></tr>`;
  }).join('');
  return `<h2>My open picks</h2>${exhaustedHtml(st)}${r.teams.length ? '' : '<p>Your login is not linked to a team yet. Ask the commissioner.</p>'}
    <table><thead><tr><th scope="col">Pick</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead><tbody>${rows || '<tr><td colspan="3">No open picks</td></tr>'}</tbody></table>
    <p class="note">${r.queue.autoDraft ? 'Auto-draft is ON: when your pick comes up, the first available player on your list is drafted for you.' : 'Auto-draft is OFF: your list never drafts by itself. "Draft top of list" only runs when you press it.'}</p>`;
}
/** Highlighted message when auto-draft is On, my pick is on the clock, and nothing usable is left on my list. */
function exhaustedHtml(st) {
  const r = S.raw();
  if (!r.user) return '';
  const s = T.autoDraftStatus(st, S.tickContext(), S.serverNow());
  if (s.kind !== 'exhausted' || s.owner !== r.user.email.toLowerCase()) return '';
  return `<p class="alert" role="alert"><strong>Your list is exhausted.</strong> Auto-draft is On but no player on your list is still available for pick #${esc(s.overall)} (${esc(s.team)}). Make a pick yourself before your clock runs out.</p>`;
}
function queueHtml(st) {
  const r = S.raw();
  const q = visibleQueue(r.queue.items, st.players, st);
  const warn = queueOwnerWarning(r.teams, r.isAdmin);
  return `<h2>My draft list</h2>${warn ? `<p class="alert" role="alert"><strong>${esc(warn)}</strong></p>` : ''}
    <p><label><input type="checkbox" id="autodraft" ${r.queue.autoDraft ? 'checked' : ''}> <strong>Auto-draft: ${r.queue.autoDraft ? 'ON' : 'OFF'}</strong></label></p>
    <p class="note">When Auto-draft is ON and your pick comes up, the first player on this list who is still available is drafted for you right away, at any hour. It never picks the best available: if nobody on your list is left, nothing happens, you get a warning, and your normal clock keeps running. Auto-draft runs when your browser or the commissioner's browser is open (see the owner guide). Add players from the Players tab. Drafted players disappear automatically.</p>
    <ol class="queue">${q.map((it, i) => { const k = itemKey(it); return `<li>${esc(itemName(st, it))} <small>${typeof it === 'string' ? esc(st.players[it].pos) : esc(it.writeIn.url || it.writeIn.note)}</small>
      <button data-qup="${esc(k)}" ${i === 0 ? 'disabled' : ''} aria-label="Move up" title="Move up">&uarr;</button>
      <button data-qdown="${esc(k)}" ${i === q.length - 1 ? 'disabled' : ''} aria-label="Move down" title="Move down">&darr;</button>
      <button data-qdel="${esc(k)}" aria-label="Remove" title="Remove">&times;</button></li>`; }).join('') || '<li>Your list is empty</li>'}</ol>
    <details class="writein"><summary>Add a write-in (player not in the pool) to the list</summary>
      <p class="note">Same rules as a write-in pick: a link (baseball-reference.com if possible) or a note that identifies him. If he is drafted this way, the pick is flagged pending verification. If someone else has already written him in, or he is in the pool by then, auto-draft skips him.</p>
      <div class="controls"><label>Player name <input id="qw-name" maxlength="100" autocomplete="off"></label>
      <label>Link (https://...) <input id="qw-url" type="url" size="40"></label>
      <label>Or a note <input id="qw-note" maxlength="500" size="30"></label>
      <button data-qwritein>Add to list</button></div></details>`;
}
// ----- rosters / history
function rostersHtml(st) {
  const teams = teamsOf(st);
  const mine = S.raw().teams[0];
  if (!ui.rosterTeam) ui.rosterTeam = mine || teams[0] || '';
  const t = ui.rosterTeam;
  const keepers = Object.values(st.players).filter((p) => p.ownerTeam === t && p.drafted == null && !p.removed);
  const drafted = D.roster(st, t);
  const upcoming = D.picksOwnedBy(st, t);
  return `<label>Team <select id="rteam">${teams.map((x) => `<option${x === t ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
    <h2>${esc(t)} roster (${keepers.length + drafted.length})</h2>
    <h3>Drafted</h3><ul>${drafted.map((p) => `<li>#${esc(overallLabel(p))} ${esc(p.name)} <small>${esc(p.pos)}</small>${p.writeIn ? ' <small class="wi">[write-in]</small>' : ''}</li>`).join('') || '<li>None yet</li>'}</ul>
    <h3>Kept / previously owned</h3><ul>${keepers.map((p) => `<li>${esc(p.name)} <small>${esc(p.pos)}</small></li>`).join('') || '<li>None</li>'}</ul>
    <h3>Picks still to make</h3><ul>${upcoming.map((p) => `<li>${esc(label(p))}${p.status === 'skipped' ? ' (skipped)' : ''}</li>`).join('') || '<li>None</li>'}</ul>`;
}
function historyHtml(st) {
  const made = sortedPicks(st).filter((p) => p.status === 'made' || p.status === 'void').reverse();
  return `<p><button data-export="results">Download results CSV</button> <button data-export="schedule">Download draft-order CSV (with players)</button></p>
    <div class="scroll"><table><thead><tr><th scope="col">#</th><th scope="col">Rd.Pick</th><th scope="col">Team</th><th scope="col">Player</th><th scope="col">Made by</th><th scope="col">When</th></tr></thead><tbody>
    ${made.map((p) => (p.status === 'void' ? `<tr class="void"><td>${esc(overallLabel(p))}</td><td>${esc(pickLabel(p))}</td><td>${esc(p.ownerTeam)}</td><td><strong>VOID</strong>${p.voidNote ? ' ' + esc(p.voidNote) : ''}</td><td>${esc(p.voidedBy)}</td><td>${esc(ET(p.voidedAt))}</td></tr>` : `<tr><td>${esc(overallLabel(p))}</td><td>${esc(pickLabel(p))}</td><td>${esc(p.ownerTeam)}${p.ownerTeam !== p.origTeam && !p.added ? ` <small>(via ${esc(p.origTeam)})</small>` : ''}${p.added ? ' <small>(added pick)</small>' : ''}</td>
    <td>${esc(st.players[p.playerId]?.name)}${wiTag(p)}${p.writeIn && p.writeIn.url ? ` <a href="${esc(p.writeIn.url)}" target="_blank" rel="noopener noreferrer">link</a>` : ''}</td><td>${esc(p.madeBy)}${p.wasSkipped ? ' <small>(late pick)</small>' : ''}</td><td>${esc(ET(p.madeAt))}</td></tr>`)).join('') || '<tr><td colspan="6">No picks yet</td></tr>'}
    </tbody></table></div>`;
}

// ---------------------------------------------------------------- admin
function adminSkeleton() {
  const startAt = S.raw().config?.startAt;
  let val = '';
  if (startAt) { const p = etParts(startAt); val = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}T${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`; }
  return `<div class="admin">
    <section><h2>1. Import / re-import</h2><p class="note">Order: draft order, then players, then owners. You can replace any file with a newer one (same format) until the draft starts: press Check first to see errors, warnings, merge notices and what changed since the previous import, then Import. Nothing is written by Check. The player pool locks once a pick has been made; the draft order locks once the draft has started.</p>
      <label>Draft order CSV <input type="file" id="f-sch" accept=".csv"></label> <button data-chk="schedule">Check</button> <button data-imp="schedule">Import draft order</button><br>
      <label>Hitters CSV <input type="file" id="f-hit" accept=".csv"></label>
      <label>Pitchers CSV <input type="file" id="f-pit" accept=".csv"></label> <button data-chk="players">Check</button> <button data-imp="players">Import players</button><br>
      <label>Or the old single players CSV (no stats) <input type="file" id="f-pl" accept=".csv"></label><br>
      <label>Owners CSV <input type="file" id="f-ow" accept=".csv"></label> <button data-chk="owners">Check</button> <button data-imp="owners">Import owners</button>
      <p><button data-act="mkaccounts">Create owner logins and email each a password-setup link</button>
      <button data-act="resetall">Re-send password-setup emails to all owners</button></p><pre id="imp-out"></pre></section>
    <section><h2>1b. Owners</h2><p class="note">Every team with its owner. Passwords are never stored or shown here. "Send set-password email" sends the owner Firebase's password-setup/reset email (works only if a login exists; use "Create owner logins" above first). If an owner cannot use that email, use "Set password": you type a temporary password, and the ticker on your PC sets it (the request only goes through while the ticker is running, and is dropped after ${REQUEST_EXPIRY_MINUTES} minutes). Then give the password to the owner privately and ask them to press "Change password" after signing in.</p><p id="own-msg" class="note" role="status"></p>
      <div id="pw-panel" class="pwpanel" hidden>
        <h3>Set password for <span id="pw-who"></span></h3>
        <p class="note">Rules (same as the set-password command):</p>
        <ul class="note">${PASSWORD_RULES.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <label>Temporary password <input id="pw-new" type="password" autocomplete="new-password" maxlength="128" spellcheck="false"></label>
        <label><input type="checkbox" id="pw-show"> Show while typing</label>
        <p id="pw-check" class="note" role="status"></p>
        <p class="note">Nothing happens until the ticker runs (about every minute, only while it is running on your PC). The password is kept only until the ticker applies it, then deleted; it is never shown again here, never logged and never written to the audit log. The owner is also signed out of old sessions.</p>
        <button data-act="pwsend" id="pw-send" disabled>Send request</button> <button data-act="pwclose">Close</button>
      </div>
      <div id="adm-owners" class="scroll"></div></section>
    <section><h2>2. Start time and clock</h2>
      <label>Draft start (Eastern time) <input type="datetime-local" id="startat" value="${val}"></label> <button data-act="setstart">Save start time</button>
      <p>Clock length (minutes) <input type="number" id="clockmin" min="1" step="1" value="${esc(S.raw().config?.clockMinutes ?? 60)}"> <button data-act="setclock">Set clock length</button></p>
      <p class="note">Changing the length while a pick is on the clock keeps the same fraction of time remaining; later picks get the full new length.</p>
      <p><label><input type="checkbox" id="allowclosed" ${S.raw().config?.allowPickWhenClockPaused === false ? '' : 'checked'}> Let owners pick outside 11:00 AM-11:00 PM ET (the countdown still only runs inside those hours)</label></p>
      <p class="note">On (default): an owner can pick as soon as the pick before theirs is made, at any hour. Off: owners can pick only while the window is open. This setting is enforced by the app, not by the server rules.</p></section>
    <section><h2>3. Run the draft</h2><div id="adm-status"></div>
      <button data-act="start">Start now</button> <button data-act="pause">Pause</button> <button data-act="resume">Resume</button>
      <p class="note"><strong>Pause</strong> stops the clock and Resume restarts it. They work at any time, including while the real-draft lock is on.</p>
      <p class="note">To pick on behalf of an owner: Players tab, choose the pick in "Drafting for", press Draft.</p>
      <div id="adm-lock"></div></section>
    <section><h2>3b. Group pick emails</h2><div id="adm-mail"></div></section>
    <section><h2>4. Trade a pick</h2><div id="adm-trade"></div></section>
    <section><h2>5. Undo / edit a made pick</h2><div id="adm-undo"></div></section>
    <section><h2>5b. Void or add a pick (during the draft)</h2><p class="note">Works while the draft is live or paused, also while the real-draft lock is ON. Before the draft starts, change the draft-order CSV and re-import it instead. Restart draft undoes all of this.</p><div id="adm-void"></div></section>
    <section><h2>6. Write-in picks</h2><p class="note">Players picked who are not in the pool. They already count; confirm, edit or reject each one. Rejecting reopens the pick for the owner.</p><div id="adm-wi"></div></section>
    <section><h2>6b. Write-ins waiting in owners' draft lists</h2><p class="note">Tick "Verified" after you have checked the player. If auto-draft later picks him, the write-in is confirmed automatically (while your browser is open).</p><div id="adm-qwi"></div></section>
    <section><h2>7. Export</h2><button data-export="results">Results CSV (includes write-ins as PUID -1 / AAA)</button> <button data-export="newplayers">New players to create (write-ins only)</button> <button data-export="schedule">Draft-order CSV with players</button></section>
    <section><h2>8. Audit log</h2><div id="adm-audit" class="scroll"></div></section>
    <section><h2>9. Restart draft (for test runs)</h2><div id="adm-restart"></div></section></div>`;
}
// Status of a "Set password" request (pwStatus/{email}; it never contains the password).
const pwState = (s) => (s && s.state) || '';
function pwText(s, email) {
  if (!s) return '';
  const when = ET(s.at);
  if (s.state === 'done') return `Password set ${esc(when)}${s.note ? ' (' + esc(s.note) + ')' : ''}. Give it to the owner privately; ask them to press "Change password" after signing in.`;
  if (s.state === 'failed') return `<strong>Not set:</strong> ${esc(s.reason || 'failed')} (${esc(when)})`;
  const old = S.serverNow() - (s.requestedAt || 0) > REQUEST_EXPIRY_MINUTES * 60000;
  return `Pending since ${esc(ET(s.requestedAt))}: waiting for the ticker to run on your PC${s.note ? ' (' + esc(s.note) + ')' : ''}.${old ? ` Older than ${REQUEST_EXPIRY_MINUTES} minutes: it will be dropped, not applied. Cancel it to remove the stored password now.` : ''} <button data-act="pwcancel" data-email="${esc(email)}">Cancel request</button>`;
}
/** Owners table (commissioner). The row in ui.editOwner is shown as an edit form. */
function ownersHtml(r) {
  const loginAt = (em) => r.logins[em];
  const usedSite = (em) => r.queues[em] !== undefined || r.audit.some((a) => a.by === em);
  const editRow = (o) => {
    const v = ownerFormValues(o);
    return `<tr class="editing"><td><input id="oe-teams" size="8" value="${esc(v.teams)}" aria-label="Team codes (separate several with a space)"></td>
    <td><input id="oe-names" size="22" value="${esc(v.teamNames)}" aria-label="Team name (several: separate with /)"></td>
    <td><input id="oe-manager" size="16" maxlength="100" value="${esc(v.manager)}" aria-label="Manager name"></td>
    <td><input id="oe-email" type="email" size="26" maxlength="254" value="${esc(v.email)}" aria-label="Owner email"></td>
    <td colspan="3"><button data-act="ownsave">Save</button> <button data-act="owncancel">Cancel</button>
    <p id="oe-msg" class="note" role="alert"></p>
    <p class="note">Several teams: codes separated by a space, names in the same order separated by " / ". Changing the email moves the team and the owner's draft list to the new address; the old address can no longer draft.</p></td></tr>`;
  };
  const row = (o) => (ui.editOwner === o.email ? editRow(o) : `<tr><td>${esc((o.teams || []).join(' '))}</td><td>${esc(Object.values(o.teamNames || {}).join(' / '))}</td><td>${esc(o.manager || '')}</td><td>${esc(o.email)}</td>
    <td>${loginAt(o.email) ? 'Last signed in ' + esc(ET(loginAt(o.email))) : usedSite(o.email) ? 'Has used the site (saved a list or made a pick)' : 'No sign-in recorded'}</td>
    <td><button data-act="ownedit" data-email="${esc(o.email)}"${ui.editOwner ? ' disabled' : ''}>Edit</button> <button data-act="resetone" data-email="${esc(o.email)}">Send set-password email</button> <button data-act="pwopen" data-email="${esc(o.email)}"${pwState(r.pwStatus[o.email]) === 'pending' ? ' disabled' : ''}>Set password</button></td>
    <td>${pwText(r.pwStatus[o.email], o.email)}</td></tr>`);
  return `<table><thead><tr><th scope="col">Team</th><th scope="col">Team name</th><th scope="col">Manager</th><th scope="col">Email</th><th scope="col">Sign-in status</th><th scope="col">Action</th><th scope="col">Password request</th></tr></thead><tbody>
    ${[...r.owners].sort((a, b) => (a.teams[0] || '').localeCompare(b.teams[0] || '')).map(row).join('') || '<tr><td colspan="7">No owners imported yet.</td></tr>'}</tbody></table>
    <p class="note">What this screen can and cannot know: the browser cannot list Firebase logins on the free plan, so it cannot tell whether an account exists or whether a password has been set. "Last signed in" is recorded when an owner signs in with this version of the site; "No sign-in recorded" means none seen since then, not that the owner never signed in.</p>`;
}
const draftTeams = (st) => [...new Set(Object.values(st.picks).flatMap((p) => [p.origTeam, p.ownerTeam]))].filter(Boolean);
function redrawOwners() {
  const el = $('#adm-owners');
  if (el) { el.innerHTML = ownersHtml(S.raw()); el.dataset.h = ''; }
}
function fillAdmin(st) {
  const r = S.raw();
  const keep = (id, html) => { const el = $(id); if (el && el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; } };
  const c = st.config;
  keep('#adm-status', c ? `Status: <b>${esc(c.status)}</b>${r.adminEmail ? '' : ' <em>(no commissioner email set in config/admin)</em>'}` : 'Not set up');
  const lk = lockedReason(r.lock), rs = r.restart;
  keep('#adm-lock', `<p><label><input type="checkbox" id="reallock" ${r.lock && r.lock.locked ? 'checked' : ''}> <strong>Real draft: ${r.lock && r.lock.locked ? 'LOCKED' : 'unlocked'}</strong></label></p>
    <p class="note">Turn this ON before the real draft. While locked, Restart (section 9) and the re-imports that reset picks (draft order, players) are refused, here and by the server rules. Pause and Resume keep working. It starts unlocked so you can rehearse; unlocking asks for confirmation.</p>`);
  keep('#adm-restart', `<p class="note"><strong>Warning:</strong> Restart erases every pick. It returns all picks to open, clears skips and write-ins, makes every player available again, puts the draft back to not-started (start time and clock length stay), reverts all trades to the imported draft order, deletes added picks and clears voids (the board is exactly as imported), turns the group pick emails OFF and resets their counting, clears the audit log (one entry records the restart), and clears pending password requests and owner notices. It keeps the players, draft order, owners and logins, and each owner's draft list and Auto-draft setting. No email is sent.</p>
    ${rs ? `<p role="alert"><strong>A restart was started ${esc(ET(rs.at))} and did not finish.</strong> The draft is held not-started and the clock is stopped until you run Restart again below.</p>` : ''}
    ${lk ? `<p role="status"><strong>Restart is disabled:</strong> ${esc(lk)}</p>` : ''}
    <label>Type ${RESTART_WORD} to confirm <input id="rs-word" autocomplete="off" spellcheck="false" size="10"${lk ? ' disabled' : ''}></label> <button data-act="restart"${lk ? ' disabled' : ''}>Restart draft</button>
    <p id="rs-msg" class="note" role="status"></p>`);
  const E = r.emailCfg, M = r.mailState, on = !!(E && E.groupEmails);
  keep('#adm-mail', `<p><label><input type="checkbox" id="groupmail" ${on ? 'checked' : ''}> <strong>Group pick emails: ${on ? 'ON' : 'OFF'}</strong></label></p>
    <p class="note">Default OFF. When ON, the ticker on the commissioner's PC emails the league group once for every 5 picks made (and once more when the draft completes). Picks made while this was OFF are never emailed: turning it ON starts counting from the picks made after that moment. Turn it OFF again to stop all emails (a batch already being sent may still go out). Nothing is sent unless the ticker is running.</p>
    <p class="note">${M && M.enabledAt === (E && E.enabledAt) ? `Emails sent so far this time: ${esc(M.batchNo || 0)} batch(es), ${esc((M.sent || []).length)} pick(s) covered.${M.lastSentAt ? ' Last email: ' + esc(ET(M.lastSentAt)) + '.' : ''}${M.pending ? ' A batch is ' + esc(M.pending.status === 'failed' ? 'waiting to be retried' : 'being sent') + '.' : ''}${M.lastError ? ' <strong>Last send problem: ' + esc(M.lastError) + '</strong>' : ''}` : (on ? 'The ticker has not started counting yet (it does so on its next run).' : 'Not enabled.')}</p>`);
  // While a row is being edited the table is not redrawn (live updates would wipe what you are typing).
  if (!ui.editOwner) keep('#adm-owners', ownersHtml(r));
  if (!c) return;
  const open = sortedPicks(st).filter((p) => p.status !== 'made' && p.status !== 'void');
  const openAndSkipped = sortedPicks(st).filter((p) => p.status === 'open' || p.status === 'skipped');
  const voided = sortedPicks(st).filter((p) => p.status === 'void');
  const live = c.status === 'live' || c.status === 'paused';
  const made = sortedPicks(st).filter((p) => p.status === 'made');
  if (!($('#tr-pick') && document.activeElement && ['tr-pick', 'tr-to', 'tr-note'].includes(document.activeElement.id))) {
    keep('#adm-trade', `<label>Pick <select id="tr-pick">${open.map((p) => `<option value="${p.overall}">${esc(label(p))}</option>`).join('')}</select></label>
      <label>New owner <select id="tr-to">${teamsOf(st).map((t) => `<option>${esc(t)}</option>`).join('')}</select></label>
      <label>Note <input id="tr-note" maxlength="200"></label> <button data-act="trade">Trade pick</button>`);
  }
  if (!(document.activeElement && ['un-pick', 'ed-id'].includes(document.activeElement.id))) {
    keep('#adm-undo', `<label>Made pick <select id="un-pick">${made.map((p) => `<option value="${p.overall}">#${p.overall} ${esc(p.ownerTeam)}: ${esc(st.players[p.playerId]?.name)}</option>`).join('')}</select></label>
      <button data-act="undo">Undo pick</button><br>
      <label>Replace with player ID <input id="ed-id" size="12"></label> <button data-act="edit">Replace player on that pick</button>`);
  }
  if (!(document.activeElement && ['vd-pick', 'vd-note', 'ad-after', 'ad-team', 'uv-pick'].includes(document.activeElement.id))) {
    keep('#adm-void', live ? `<p><label>Void pick <select id="vd-pick">${openAndSkipped.map((p) => `<option value="${p.overall}">${esc(label(p))}${p.overall === c.currentPick ? ' - ON CLOCK' : p.status === 'skipped' ? ' - skipped' : ''}</option>`).join('')}</select></label>
      <label>Note <input id="vd-note" maxlength="200"></label> <button data-act="voidpick">Void pick</button></p>
      <p class="note">Only a pick that has not been drafted can be voided. If it was drafted, use Undo (section 5) first. Voiding the pick on the clock moves the clock to the next open pick with a full clock. A voided pick stays on the board marked VOID and can never be drafted.</p>
      <p><label>Voided picks <select id="uv-pick">${voided.map((p) => `<option value="${p.overall}">${esc(label(p))}</option>`).join('')}</select></label> <button data-act="unvoidpick"${voided.length ? '' : ' disabled'}>Un-void pick</button></p>
      <p><label>Add a pick after <select id="ad-after">${sortedPicks(st).map((p) => `<option value="${p.overall}">${esc(label(p))}</option>`).join('')}</select></label>
      <label>Owned by <select id="ad-team">${teamsOf(st).map((t) => `<option>${esc(t)}</option>`).join('')}</select></label> <button data-act="addpick">Add pick</button></p>
      <p class="note">The new pick is labeled with a letter (after 5.12 it becomes 5.12a; adding again gives 5.12b). Nothing else is renumbered. The team you choose owns it and is its original team. It can be traded, drafted, skipped and undone like any pick.</p>` : '<p>Void / add are available once the draft is live or paused. Before that, change the draft-order CSV and re-import it.</p>');
  }
  const wis = made.filter((p) => p.writeIn);
  keep('#adm-wi', wis.length ? `<table><thead><tr><th scope="col">Pick</th><th scope="col">Player</th><th scope="col">Link / note</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead><tbody>${wis.map((p) => `<tr>
    <td>${esc(label(p))}</td><td>${esc(p.writeIn.name)}</td>
    <td>${p.writeIn.url ? `<a href="${esc(p.writeIn.url)}" target="_blank" rel="noopener noreferrer">${esc(p.writeIn.url)}</a>` : ''} ${esc(p.writeIn.note)}</td>
    <td>${esc(p.writeIn.status)}</td>
    <td>${p.writeIn.status === 'pending' ? `<button data-wi="confirm" data-n="${p.overall}">Confirm</button> ` : ''}<button data-wi="edit" data-n="${p.overall}">Edit</button> <button data-wi="reject" data-n="${p.overall}">Reject</button></td></tr>`).join('')}</tbody></table>` : '<p>No write-ins.</p>');
  const qw = Object.entries(r.queues).flatMap(([em, q]) => q.items.filter((x) => typeof x !== 'string').map((x) => ({ em, on: q.autoDraft, w: x.writeIn, key: normName(x.writeIn.name) })));
  keep('#adm-qwi', qw.length ? `<table><thead><tr><th scope="col">Owner</th><th scope="col">Player</th><th scope="col">Link / note</th><th scope="col">Auto-draft</th><th scope="col">Verified</th></tr></thead><tbody>${qw.map((x) => `<tr>
    <td>${esc(x.em)}</td><td>${esc(x.w.name)}</td>
    <td>${x.w.url ? `<a href="${esc(x.w.url)}" target="_blank" rel="noopener noreferrer">${esc(x.w.url)}</a>` : ''} ${esc(x.w.note)}</td>
    <td>${x.on ? 'On' : 'Off'}</td><td><input type="checkbox" data-wiverify="${esc(x.key)}" aria-label="Verified: ${esc(x.w.name)}" ${r.checks.includes(x.key) ? 'checked' : ''}></td></tr>`).join('')}</tbody></table>` : '<p>No write-ins in any list.</p>');
  keep('#adm-audit', `<table><thead><tr><th scope="col">When</th><th scope="col">Type</th><th scope="col">By</th><th scope="col">Details</th></tr></thead><tbody>
    ${r.audit.map((a) => { const { type, by, at, ...d } = a; return `<tr><td>${esc(ET(at))}</td><td>${esc(type)}</td><td>${esc(by)}</td><td>${esc(JSON.stringify(d))}</td></tr>`; }).join('')}</tbody></table>`);
}

const toStartMs = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v || '');
  if (!m) throw new Error('Pick a start date and time first.');
  return etToUtc(+m[1], +m[2], +m[3], +m[4], +m[5]);
};
const randomPw = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => 'abcdefghijkmnpqrstuvwxyz23456789ABCDEFGHJKLMNPQRSTUVWXYZ'[b % 56]).join('');

// ---------------------------------------------------------------- events
function onInput(e) {
  const t = e.target;
  if (t.id === 'q') { ui.search = t.value; fillPlayers(S.getState()); }
  else if (t.id === 'pos') { ui.pos = t.value; fillPlayers(S.getState()); }
  else if (t.id === 'view') { ui.view = t.value; if (ui.sort.key.includes('.')) ui.sort = { key: 'name', dir: 1 }; fillPlayers(S.getState()); }
  else if (t.id === 'kind') { ui.kind = t.value; fillPlayers(S.getState()); }
  else if (t.id === 'avail') { ui.avail = t.value; fillPlayers(S.getState()); }
  else if (t.id === 'target') { ui.target = Number(t.value); fillPlayers(S.getState()); }
  else if (t.id === 'rteam') { ui.rosterTeam = t.value; fill('rosters'); }
  else if (t.id === 'autodraft') { const on = t.checked; run(() => S.saveQueue(S.raw().queue.items, on)); }
  else if (t.id === 'pw-new') pwCheck();
  else if (t.id === 'pw-show') $('#pw-new').type = t.checked ? 'text' : 'password';
  else if (t.id === 'reallock') {
    const on = t.checked;
    if (!on && !confirm('Unlock the real draft? Restart and the re-imports that reset picks become available again.')) { t.checked = true; return; }
    run(() => S.setRealDraftLock(on));
  }
  else if (t.id === 'groupmail') { const on = t.checked; run(() => S.setGroupEmails(on)); }
  else if (t.id === 'allowclosed') { const on = t.checked; run(() => S.commit((s, now, a) => D.setAllowPickWhenClockPaused(s, a, on, now))); }
  else if (t.dataset && t.dataset.wiverify !== undefined) { run(() => S.setWriteInVerified(t.dataset.wiverify, t.checked)); }
}

function onClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  const st = S.getState(), r = S.raw();
  if (d.monitor === 'lock') return void requestWakeLock().then(fillMonitor);
  if (d.monitor === 'run') return monitorRun();
  if (d.tab) { ui.tab = d.tab; ui.built = null; ui.editOwner = null; return render(); }
  // first click on a stat sorts high to low (ERA: low to high); text columns sort A to Z
  if (d.sort) { ui.sort = { key: d.sort, dir: ui.sort.key === d.sort ? -ui.sort.dir : (d.sort.includes('.') && d.sort !== 'pit.ERA' ? -1 : 1) }; return fillPlayers(st); }
  if (d.rmplayer) {
    const p = st.players[d.rmplayer];
    if (!p || !confirm(`Remove ${p.name} from the draft list?\n\nNobody will be able to draft him and he disappears from every owner's list. You can restore him later (Players tab > Show > Removed from list).`)) return;
    const reason = prompt('Reason (saved in the audit log):', 'Listed in error');
    if (reason === null) return;
    return run(() => S.removePlayer(d.rmplayer, reason));
  }
  if (d.rsplayer) {
    const p = st.players[d.rsplayer];
    if (!p || !confirm(`Put ${p.name} back in the draft list?`)) return;
    return run(() => S.restorePlayer(d.rsplayer));
  }
  if (d.q) return run(() => S.saveQueue(addToQueue(r.queue.items, d.q)));
  if (d.qdel || d.qup || d.qdown) {
    const key = d.qdel || d.qup || d.qdown, q = visibleQueue(r.queue.items, st.players, st);
    const i = q.findIndex((x) => itemKey(x) === key);
    if (i < 0) return;
    if (d.qdel) return run(() => S.saveQueue(removeFromQueue(q, q[i])));
    return run(() => S.saveQueue(moveInQueue(q, q[i], d.qup ? i - 1 : i + 1)));
  }
  if (d.qwritein !== undefined) {
    const res = checkQueueWriteIn({ name: $('#qw-name').value, url: $('#qw-url').value, note: $('#qw-note').value }, st);
    if (res.error) return say(res.error, true);
    return run(async () => {
      await S.saveQueue(addToQueue(r.queue.items, res.item));
      ['#qw-name', '#qw-url', '#qw-note'].forEach((f) => { $(f).value = ''; });
    });
  }
  if (d.draft) {
    const p = st.players[d.draft], n = ui.target;
    if (n == null || !confirm(`Draft ${p.name} with ${label(st.picks[n])}?`)) return;
    return run(() => S.commit((s, now, a) => D.makePick(s, a, n, d.draft, now)));
  }
  if (d.target) { ui.target = Number(d.target); ui.tab = 'players'; ui.built = null; return render(); }
  if (d.drafttop) {
    const n = Number(d.drafttop), it = topOfQueue(r.queue.items, st.players, st);
    if (!it || !confirm(`Draft ${itemName(st, it)} with ${label(st.picks[n])}?`)) return;
    return run(() => S.commit((s, now, a) => (typeof it === 'string' ? D.makePick(s, a, n, it, now) : D.makeWriteIn(s, a, n, it.writeIn, now))));
  }
  if (d.export) {
    const list = Object.values(st.picks);
    const files = { results: ['tbbl-draft-results.csv', () => exportResults(list, st.players)], newplayers: ['tbbl-new-players-to-create.csv', () => exportNewPlayers(list)], schedule: ['tbbl-draft-order-results.csv', () => exportSchedule(list, st.players)] };
    return download(files[d.export][0], files[d.export][1]());
  }
  if (d.chk || d.imp) {
    const which = d.chk || d.imp;
    const input = { schedule: '#f-sch', players: '#f-pl', owners: '#f-ow' }[which];
    const fns = { schedule: [S.checkSchedule, S.importSchedule], players: [S.checkPlayers, S.importPlayers], owners: [S.checkOwners, S.importOwners] }[which];
    const show = (res, done) => {
      const out = [];
      if (res.errors.length) out.push('NOT IMPORTED. Fix these problems:', ...res.errors.slice(0, 40), ...(res.errors.length > 40 ? [`...and ${res.errors.length - 40} more`] : []));
      else out.push(done ? 'IMPORTED.' : 'File is valid. Press Import to apply it.');
      if (res.notices.length) out.push('', 'Notices:', ...res.notices);
      if (res.warnings.length) out.push('', `Warnings (${res.warnings.length}):`, ...res.warnings.slice(0, 40));
      out.push('', 'Summary:', ...res.summary);
      const box = $('#imp-out'); // gone if you switched tabs while the import was running
      if (box) box.textContent = out.join('\n');
      else say(res.errors.length ? 'Import not done: ' + res.errors[0] : done ? 'Import finished.' : 'File is valid.', !!res.errors.length);
    };
    return run(async () => {
      const text = which === 'players' ? await readPlayerFiles() : await readFile($(input));
      if (d.chk) return show(fns[0](text), false);
      const pre = fns[0](text);
      if (pre.errors.length) return show(pre, false);
      if (which === 'schedule' && Object.keys(S.raw().picks).length && !confirm('Importing the draft order resets every pick to open. Continue?')) return;
      if (which === 'players' && S.raw().basePlayers.length && !confirm('Replace the player pool with this file?')) return;
      show(await fns[1](text), true);
    });
  }
  if (d.writein !== undefined) {
    const n = ui.target;
    if (n == null) return say('Choose a pick under "Drafting for".', true);
    const input = { name: $('#wi-name').value, url: $('#wi-url').value, note: $('#wi-note').value, override: $('#wi-override').checked };
    if (!confirm(`Write in "${input.name.trim()}" with ${label(st.picks[n])}? He is not in the pool, so the commissioner will verify him afterward.`)) return;
    return run(async () => {
      await S.commit((s, now, a) => D.makeWriteIn(s, a, n, input, now));
      ['#wi-name', '#wi-url', '#wi-note'].forEach((id) => { $(id).value = ''; });
      $('#wi-override').checked = false;
    });
  }
  if (d.wi) {
    const n = Number(d.n), w = st.picks[n].writeIn;
    if (d.wi === 'confirm') return run(() => S.commit((s, now, a) => D.confirmWriteIn(s, a, n, now)));
    if (d.wi === 'reject') {
      if (!confirm(`Reject write-in ${w.name} at pick #${n}? The pick reopens for the owner.`)) return;
      return run(() => S.commit((s, now, a) => D.rejectWriteIn(s, a, n, now)));
    }
    const name = prompt('Player name:', w.name); if (name === null) return;
    const url = prompt('Link (leave empty if none):', w.url); if (url === null) return;
    const note = prompt('Note (optional):', w.note); if (note === null) return;
    return run(() => S.commit((s, now, a) => D.editWriteIn(s, a, n, { name, url, note }, now)));
  }
  if (d.act) return adminAction(d.act, st, r, d);
}

// "Set password" panel helpers: the typed password is cleared and the panel closed after every submit or close.
function pwReset() {
  const p = $('#pw-panel'); if (!p) return;
  $('#pw-new').value = ''; $('#pw-new').type = 'password'; $('#pw-show').checked = false;
  p.hidden = true; p.dataset.email = '';
}
function pwCheck() {
  const p = $('#pw-panel'), v = $('#pw-new').value, chk = checkPassword(v, p.dataset.email || '');
  $('#pw-check').textContent = !v ? 'Type the temporary password.' : chk.ok ? 'This password meets the rules.' : chk.error;
  $('#pw-send').disabled = !chk.ok;
}
function adminAction(act, st, r, d = {}) {
  const sel = (id) => Number($(id).value);
  const A = {
    start: () => S.commit((s, now, a) => D.startDraft(s, a, now)),
    pause: () => S.commit((s, now, a) => D.pause(s, a, now)),
    resume: () => S.commit((s, now, a) => D.resume(s, a, now)),
    setclock: () => S.commit((s, now, a) => D.setClockMinutes(s, a, Number($('#clockmin').value), now)),
    setstart: () => { const ms = toStartMs($('#startat').value); return S.commit((s, now, a) => D.setStartAt(s, a, ms, now)); },
    trade: () => S.commit((s, now, a) => D.tradePick(s, a, sel('#tr-pick'), $('#tr-to').value, $('#tr-note').value, now)),
    undo: () => { const n = sel('#un-pick'); if (!n || !confirm(`Undo pick #${n}?`)) return; return S.commit((s, now, a) => D.undoPick(s, a, n, now)); },
    edit: () => { const n = sel('#un-pick'), id = $('#ed-id').value.trim(); if (!n || !id || !confirm(`Replace the player on pick #${n} with ${id}?`)) return; return S.commit((s, now, a) => D.editPick(s, a, n, id, now)); },
    voidpick: () => {
      const n = sel('#vd-pick'), p = st.picks[n];
      if (!p || !confirm(`Void pick ${label(p)}? It stays on the board marked VOID and can never be drafted.${n === st.config.currentPick ? ' It is on the clock, so the clock moves to the next open pick.' : ''}`)) return;
      const note = $('#vd-note').value;
      return S.commit((s, now, a) => D.voidPick(s, a, n, note, now)).then(() => { $('#vd-note').value = ''; });
    },
    unvoidpick: () => { const n = sel('#uv-pick'), p = st.picks[n]; if (!p || !confirm(`Un-void pick ${label(p)}?`)) return; return S.commit((s, now, a) => D.unvoidPick(s, a, n, now)); },
    addpick: () => {
      const n = sel('#ad-after'), team = $('#ad-team').value, p = st.picks[n];
      if (!p || !confirm(`Add a new pick for ${team} directly after ${label(p)}?`)) return;
      return S.commit((s, now, a) => D.addPick(s, a, n, team, now));
    },
    restart: async () => {
      const why = lockedReason(r.lock);
      if (why) return say(why, true);
      const typed = $('#rs-word').value;
      if (typed.trim() !== RESTART_WORD) return say('Type RESTART (capital letters) in the box first.', true);
      const late = r.config && r.config.startAt && r.config.startAt <= S.serverNow();
      if (!confirm('Restart the draft? This ERASES EVERY PICK and the audit log and cannot be undone.' + (late ? '\n\nThe start time has already passed, so the draft will start again by itself within about a minute. Change the start time first (section 2) if you want to press Start now yourself.' : ''))) return;
      $('#rs-msg').textContent = 'Restarting... do not close this page.';
      const plan = await S.restartDraft(typed);
      $('#rs-word').value = '';
      $('#rs-msg').textContent = `Restarted. ${plan.batches.length} write batches done. The draft is not started; group pick emails are OFF.`;
    },
    mkaccounts: async () => {
      if (!confirm(`Create logins for ${r.owners.length} owner emails and send each a password-setup email?`)) return;
      const out = [];
      for (const o of r.owners) {
        try { await S.createOwnerAccount(o.email, randomPw()); await S.resetPassword(o.email); out.push(`${o.email}: created, setup email sent`); }
        catch (e) { out.push(`${o.email}: ${e.code === 'auth/email-already-in-use' ? 'login already exists (use re-send)' : e.message}`); }
      }
      $('#imp-out').textContent = out.join('\n');
    },
    ownedit: () => {
      if (!d.email) return;
      ui.editOwner = d.email; redrawOwners();
      const f = $('#oe-teams'); if (f) f.focus();
    },
    owncancel: () => { ui.editOwner = null; redrawOwners(); },
    ownsave: async () => {
      const oldEmail = ui.editOwner;
      const res = checkOwnerEdit(r.owners, oldEmail, { email: $('#oe-email').value, teams: $('#oe-teams').value, teamNames: $('#oe-names').value, manager: $('#oe-manager').value }, draftTeams(st));
      if (res.errors.length) { $('#oe-msg').textContent = res.errors.join(' '); return; }
      if (!res.changes.length) { ui.editOwner = null; return redrawOwners(); }
      const extra = res.emailChanged ? `\n\n${oldEmail} will no longer be able to draft. The owner's draft list moves to ${res.owner.email}. If that owner is signed in now, they should sign out and in again.` : '\n\nIf the owner is signed in now, they should reload the page to see a team change.';
      if (!confirm(`Save these changes?\n\n${res.changes.join('\n')}${extra}`)) return;
      const { listMoved } = await S.updateOwner(oldEmail, res.owner, res.changes);
      ui.editOwner = null; redrawOwners();
      let msg = `Saved. ${res.changes.join('; ')}.${listMoved ? ' Draft list moved to the new email.' : ''}`;
      if (res.emailChanged && confirm(`Create a login for ${res.owner.email} and email a password-setup link now?`)) {
        try { await S.createOwnerAccount(res.owner.email, randomPw()); await S.resetPassword(res.owner.email); msg += ` Login created; setup email sent to ${res.owner.email}.`; }
        catch (e) {
          if (e.code !== 'auth/email-already-in-use') throw e;
          await S.resetPassword(res.owner.email); msg += ` A login already existed for ${res.owner.email}; a set-password email was sent.`;
        }
      } else if (res.emailChanged) msg += ' No login was created yet: press "Create owner logins" in section 1 when ready (owners who already have a login are skipped).';
      const m = $('#own-msg'); if (m) m.textContent = msg;
    },
    resetone: async () => {
      if (!d.email || !confirm(`Send a set-password email to ${d.email}?`)) return;
      await S.resetPassword(d.email);
      $('#own-msg').textContent = `Set-password email sent to ${d.email}. If no login exists for that address nothing arrives; use "Create owner logins" first.`;
    },
    pwopen: () => {
      if (!d.email) return;
      const p = $('#pw-panel'); p.hidden = false; p.dataset.email = d.email;
      $('#pw-who').textContent = d.email; $('#pw-new').value = ''; pwCheck(); $('#pw-new').focus();
    },
    pwclose: () => pwReset(),
    pwsend: async () => {
      const p = $('#pw-panel'), email = p.dataset.email, pw = $('#pw-new').value;
      const chk = checkPassword(pw, email);
      if (!email || !chk.ok) return say(chk.error || 'Choose an owner first.', true);
      if (!confirm(`Ask the ticker to set a new password for ${email}? It only happens while the ticker is running on your PC, and the request is dropped after ${REQUEST_EXPIRY_MINUTES} minutes.`)) return;
      try { await S.requestPassword(email, pw); } finally { pwReset(); } // the password is cleared from the screen either way
      $('#own-msg').textContent = `Request sent for ${email}. Watch the "Password request" column: it shows "Password set" once the ticker has applied it.`;
    },
    pwcancel: async () => {
      if (!d.email || !confirm(`Cancel the pending set-password request for ${d.email}? This also deletes the stored password.`)) return;
      await S.cancelPasswordRequest(d.email);
    },
    resetall: async () => {
      const out = [];
      for (const o of r.owners) { try { await S.resetPassword(o.email); out.push(`${o.email}: sent`); } catch (e) { out.push(`${o.email}: ${e.message}`); } }
      $('#imp-out').textContent = out.join('\n');
    },
  };
  return run(async () => { await A[act](); });
}
