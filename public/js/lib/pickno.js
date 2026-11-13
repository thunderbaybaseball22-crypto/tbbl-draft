// Pick labels and ordering for added (lettered) picks. Pure.
// An added pick keeps every existing label: it sits after pick `base` and is named round.slot + letter
// (5.12a, 5.12b). Its internal `overall` key is base + seq/100 (60.01, 60.02) so ordering by overall is
// well defined (60 < 60.01 < 61) and nothing else is renumbered. The overall NUMBER shown is base + letter (60a).
export const MAX_ADDED_PER_PICK = 26;
export const orderKey = (base, seq) => Math.round((base + seq / 100) * 100) / 100;
export const suffixOf = (p) => (p && p.added ? String.fromCharCode(96 + (p.addSeq || 1)) : '');
/** "5.12" or "5.12a" */
export const pickLabel = (p) => `${p.round}.${p.slot}${suffixOf(p)}`;
/** "60" or "60a" */
export const overallLabel = (p) => (p.added ? `${p.base}${suffixOf(p)}` : String(p.overall));
