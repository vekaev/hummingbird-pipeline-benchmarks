/**
 * Lifts generated markdown into HTML for both pages.
 *
 * A heading in results/*.md is an interface. mdTable() throws when a heading or a table is
 * missing, so renaming a heading in an analysis script fails the build instead of silently
 * dropping a table from the page — which is the failure mode that lets a page quietly stop
 * matching its data.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Minimal inline markdown: bold, code, italics, links. Enough for generated tables. */
export function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>');
}

/**
 * Find `heading`, collect the nth run of consecutive `|` lines under it, and convert.
 * Scanning stops at the next heading of the same or higher level, so a table cannot be
 * lifted out of the wrong section by accident. `---:` marks a numeric column.
 */
export function mdTable(file, heading, nth = 1, opts = {}) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n');
  let start = 0;
  let level = 0;
  if (heading) {
    start = lines.findIndex((l) => /^#{1,6} /.test(l) && l.includes(heading));
    if (start === -1) throw new Error(`heading not found: "${heading}" in ${file}`);
    level = lines[start].match(/^#+/)[0].length;
  }

  const blocks = [];
  let current = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    const h = l.match(/^(#{1,6}) /);
    if (heading && h && h[1].length <= level) break;
    if (l.startsWith('|')) {
      if (!current) { current = []; blocks.push(current); }
      current.push(l);
    } else current = null;
  }
  const block = blocks[nth - 1];
  if (!block) throw new Error(`table ${nth} not found after "${heading}" in ${file}`);

  const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const head = cells(block[0]);
  const align = cells(block[1]).map((a) => (a.endsWith(':') && !a.startsWith(':') ? 'n' : ''));
  const body = block.slice(2).map(cells);
  const drop = opts.dropColumns ?? [];
  const keep = (i) => !drop.includes(head[i]);

  const th = head.map((c, i) => (keep(i) ? `<th${align[i] ? ' class="n"' : ''}>${inline(c)}</th>` : '')).join('');
  const tr = body.map((r) => `<tr>${r.map((c, i) => (keep(i) ? `<td${align[i] ? ' class="n"' : ''}>${inline(c)}</td>` : '')).join('')}</tr>`).join('\n');
  return `<div class="tw${opts.wide ? ' wide' : ''}"><table><thead><tr>${th}</tr></thead><tbody>\n${tr}\n</tbody></table></div>`;
}

/** Pull a single cell, so prose can quote a generated number without retyping it. */
export function mdCell(file, heading, rowMatch, colIndex, nth = 1) {
  const html = mdTable(file, heading, nth);
  const rows = html.split('<tr>').slice(2);
  const row = rows.find((r) => r.includes(rowMatch));
  if (!row) throw new Error(`row "${rowMatch}" not found after "${heading}" in ${file}`);
  const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
  const v = cells[colIndex];
  if (v === undefined) throw new Error(`column ${colIndex} missing in row "${rowMatch}"`);
  return v;
}
