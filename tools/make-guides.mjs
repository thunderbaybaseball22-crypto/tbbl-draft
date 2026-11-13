// Turns docs/OWNER-GUIDE.md and docs/COMMISSIONER-GUIDE.md into styled HTML in guides/ (git-ignored).
// tools/make-guides.ps1 then prints each one to PDF (Edge) and wraps it as a .docx.
// Small Markdown subset used by these guides: #-headings, paragraphs, - and 1. lists, | tables |,
// ``` code blocks, **bold**, `code`, [text](url) and <url>.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s)
    .replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, '<a href="$1">$1</a>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => (/^https?:/.test(u) ? `<a href="${u}">${t}</a>` : t))
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
}

export function mdToHtml(md) {
  const lines = md.replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (l.startsWith('```')) {
      const buf = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++; out.push(`<pre>${esc(buf.join('\n'))}</pre>`); continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      out.push(`<table><thead><tr>${cells(body[0]).map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.slice(1).map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const li = l.match(/^(\s*)(-|\d+\.)\s+(.*)/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)(-|\d+\.)\s+(.*)/);
        if (m) { items.push(m[3]); i++; continue; }
        if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + lines[i].trim(); i++; continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*\||\s*(-|\d+\.)\s)/.test(lines[i])) buf.push(lines[i++].trim());
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

const CSS = `body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.35;color:#1d2939}
h1{font-size:22pt;color:#14532d;border-bottom:2px solid #14532d;padding-bottom:4pt}
h2{font-size:15pt;color:#14532d;margin-top:16pt}h3{font-size:12.5pt;color:#14532d}
code{font-family:Consolas,monospace;font-size:10pt;background:#f2f4f7}
pre{font-family:Consolas,monospace;font-size:9.5pt;background:#f2f4f7;border:1px solid #d0d5dd;padding:6pt}
table{border-collapse:collapse;margin:6pt 0}th,td{border:1px solid #98a2b3;padding:3pt 6pt;text-align:left;vertical-align:top}
th{background:#e7f2ea}li{margin:2pt 0}a{color:#1d4ed8}`;

const root = new URL('../', import.meta.url);
mkdirSync(new URL('guides/', root), { recursive: true });
const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
for (const [src, out, title] of [['docs/OWNER-GUIDE.md', 'TBBL-Draft-Owner-Guide', 'TBBL Draft: Owner Guide'], ['docs/COMMISSIONER-GUIDE.md', 'TBBL-Draft-Commissioner-Guide', 'TBBL Draft: Commissioner Guide']]) {
  const body = mdToHtml(readFileSync(new URL(src, root), 'utf8')).replace(/^<h1>.*?<\/h1>/, `<h1>${title}</h1>`);
  writeFileSync(new URL(`guides/${out}.html`, root), `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${CSS}</style></head><body>${body}<p style="color:#667085;font-size:9pt;margin-top:18pt">Updated ${date}</p></body></html>`);
  console.log(`guides/${out}.html`);
}
