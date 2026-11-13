// Pure clock logic. The pick clock only runs 11:00-23:00 America/New_York (DST aware).
// All inputs/outputs are epoch milliseconds (numbers) or Date objects for inputs.

export const TZ = 'America/New_York';
export const OPEN_HOUR = 11;
export const CLOSE_HOUR = 23;

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', second: 'numeric',
});

const ms = (d) => (d instanceof Date ? d.getTime() : d);

/** Wall-clock parts in Eastern time for an instant. */
export function etParts(t) {
  const o = {};
  for (const p of fmt.formatToParts(new Date(ms(t)))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, h: o.hour, mi: o.minute, s: o.second };
}

/** Epoch ms of an Eastern wall-clock time (day overflow such as d+1 is normalised). */
export function etToUtc(y, m, d, h, mi = 0) {
  const norm = new Date(Date.UTC(y, m - 1, d, h, mi));
  const want = norm.getTime();
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = etParts(guess);
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    guess += want - shown;
  }
  return guess;
}

const windowStart = (p) => etToUtc(p.y, p.m, p.d, OPEN_HOUR);
const windowEnd = (p) => etToUtc(p.y, p.m, p.d, CLOSE_HOUR);

export function isOpen(t) {
  const p = etParts(t);
  return p.h >= OPEN_HOUR && p.h < CLOSE_HOUR;
}

/** The instant itself if the window is open, otherwise the next 11:00 ET. */
export function nextOpen(t) {
  t = ms(t);
  if (isOpen(t)) return t;
  const p = etParts(t);
  if (p.h < OPEN_HOUR) return windowStart(p);
  return etToUtc(p.y, p.m, p.d + 1, OPEN_HOUR);
}

/** Instant after consuming `durationMs` of open-window time, starting at `start`. */
export function addOpenTime(start, durationMs) {
  let t = nextOpen(start);
  let left = durationMs;
  for (let guard = 0; guard < 100000; guard++) {
    const p = etParts(t);
    const avail = windowEnd(p) - t;
    if (left <= avail) return t + left;
    left -= avail;
    t = etToUtc(p.y, p.m, p.d + 1, OPEN_HOUR);
  }
  throw new Error('addOpenTime: duration too large');
}

/** Open-window time between `from` and `deadline` (0 if deadline has passed). */
export function remainingOpenMs(from, deadline) {
  let t = nextOpen(from);
  deadline = ms(deadline);
  let total = 0;
  for (let guard = 0; guard < 100000 && t < deadline; guard++) {
    const p = etParts(t);
    const end = windowEnd(p);
    total += Math.min(end, deadline) - t;
    t = etToUtc(p.y, p.m, p.d + 1, OPEN_HOUR);
  }
  return total;
}

// Bounds the security rules (firestore.rules, deadlineOk) enforce on a client-supplied deadline for a
// pick put on the clock at time now with a full clock of clockMinutes. Closed hours only ever ADD time, so
// the deadline is never earlier than now + clock length (less a small allowance for clock skew), and
// never later than: wait up to 12 h for the window, plus the clock, plus up to 12 h closed per started day.
export const SKEW_MS = 120000;
export const deadlineFloor = (now, clockMinutes) => now + clockMinutes * 60000 - SKEW_MS;
export const deadlineCeiling = (now, clockMinutes) => now + 2 * clockMinutes * 60000 + 86400000;
