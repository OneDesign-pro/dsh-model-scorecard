#!/usr/bin/env node
// `README.md` and `README_ru.md` are one document in two languages, and this
// tool is the only thing that keeps that claim honest. It does not read Russian
// and it does not judge the translation: it compares the *shapes* the two files
// must share, so that a change landed on one side and forgotten on the other
// fails here instead of in a reader's browser.
//
// Four comparisons, in the order the failure is cheapest to explain:
//
//   1. heading sequence — the same number of headings in the same order with
//      the same levels. The text differs by construction (it is a translation),
//      so only level and position are compared.
//   2. fenced blocks — byte-for-byte identical, in the same order. A fence
//      carries commands, JSON keys and comments the panel prints verbatim;
//      "translated" there is a defect, not a translation.
//   3. tables — the same number of tables, each with the same number of rows
//      and the same column count per row. A table row is a claim.
//   4. the language switcher — the link that makes either file reachable from
//      the other, asserted in both directions.
//
// Paragraph counts are reported but never fail the run: a paragraph may be
// split or joined by a translator without the document changing meaning, and a
// checker that fails on that would be turned off within a week.
//
// Plain ESM, zero dependencies, no I/O beyond the two files (AGENTS.md rule 1).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const EN = join(root, 'README.md');
const RU = join(root, 'README_ru.md');

const read = (p) => {
  try {
    return readFileSync(p, 'utf8').split('\n');
  } catch (e) {
    console.error(`cannot read ${p}: ${e.message}`);
    process.exit(2);
  }
};

const HEADING = /^(#{1,6}) (.*)$/;
const FENCE = /^```/;
const TABLE = /^\|/;
const SWITCHER = /^\*\*(English|Русский)\*\* · \[(English|Русский)\]\((README\.md|README_ru\.md)\)$/;

// One pass, because all four shapes are read from the same traversal: lines
// inside a fence are never a heading, a table row or a paragraph, and a fence
// only closes on a line that opens one.
function parse(lines) {
  const headings = [];
  const fences = [];
  const tables = [];
  const switchers = [];
  let paragraphs = 0;
  let inFence = false;
  let fence = null;
  let table = null;

  for (const line of lines) {
    if (FENCE.test(line)) {
      if (inFence) {
        fence.push(line);
        fences.push(fence);
        fence = null;
        inFence = false;
      } else {
        if (table) {
          tables.push(table);
          table = null;
        }
        fence = [line];
        inFence = true;
      }
      continue;
    }

    if (inFence) {
      fence.push(line);
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      if (table) {
        tables.push(table);
        table = null;
      }
      headings.push(h[1].length);
      continue;
    }

    if (TABLE.test(line)) {
      if (!table) table = { rows: [] };
      table.rows.push(line.split('|').length - 2);
      continue;
    }
    if (table) {
      tables.push(table);
      table = null;
    }

    const s = SWITCHER.exec(line.trim());
    if (s) switchers.push({ label: s[1], target: s[3] });

    if (line.trim() !== '' && !/^\s*([-*+]|\d+\.)\s/.test(line)) paragraphs++;
  }

  if (inFence) fence && fences.push({ unterminated: true, lines: fence });
  if (table) tables.push(table);

  return { headings, fences, tables, switchers, paragraphs };
}

const en = parse(read(EN));
const ru = parse(read(RU));

const problems = [];
const notes = [];

const cmp = (what, a, b) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(what);
};

cmp('heading sequence (count or level order) differs', en.headings, ru.headings);

if (en.fences.length !== ru.fences.length) {
  problems.push(`fenced-block count differs: README.md has ${en.fences.length}, README_ru.md has ${ru.fences.length}`);
} else {
  en.fences.forEach((f, i) => {
    if (Array.isArray(f) && Array.isArray(ru.fences[i]) && f.join('\n') !== ru.fences[i].join('\n')) {
      problems.push(`fenced block #${i + 1} is not byte-identical (starts at README.md line "${f[0].slice(0, 40)}")`);
    }
  });
}

cmp('table shapes differ (tables, rows or columns)', en.tables, ru.tables);

const linkOf = (p, target) => p.switchers.some((s) => s.target === target);
if (!linkOf(en, 'README_ru.md')) problems.push('README.md has no link to README_ru.md');
if (!linkOf(ru, 'README.md')) problems.push('README_ru.md has no link to README.md');

if (en.paragraphs !== ru.paragraphs) {
  notes.push(`paragraph count differs (README.md ${en.paragraphs}, README_ru.md ${ru.paragraphs}) — informational`);
}

const widths = (p) => p.tables.reduce((n, t) => n + t.rows.length, 0);

if (problems.length === 0) {
  console.log('README parity OK');
  console.log(`  headings       ${en.headings.length} / ${ru.headings.length}`);
  console.log(`  fenced blocks  ${en.fences.length} / ${ru.fences.length}  (byte-identical)`);
  console.log(`  tables         ${en.tables.length} / ${ru.tables.length}`);
  console.log(`  table rows     ${widths(en)} / ${widths(ru)}`);
  for (const n of notes) console.log(`  note: ${n}`);
  process.exit(0);
}

console.error('README parity FAILED — README.md and README_ru.md have drifted apart:');
for (const p of problems) console.error(`  - ${p}`);
for (const n of notes) console.error(`  note: ${n}`);
console.error('\nThe English README is authoritative. Fix README_ru.md, never README.md.');
process.exit(1);
