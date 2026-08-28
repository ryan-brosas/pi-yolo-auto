#!/usr/bin/env node
/**
 * Generate detailed, categorized release notes from git history since the last tag.
 * Usage: node scripts/release-notes.mjs [prevTag] [newTag]
 * Prints a markdown release body to stdout.
 *
 * Output:
 *   - Categorized commits (feat/fix/perf/refactor/docs/chore/other) with the
 *     FULL commit message (subject + indented body)
 *   - Per-file diffstat table with totals
 */
import { execSync } from 'node:child_process';
import process from 'node:process';

const [, , prevArg, nextArg] = process.argv;
const next = nextArg || 'HEAD';
// Well-known empty-tree SHA: lets us diff the very first release against nothing.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function lastTag() {
  try {
    const t = execSync('git tag --sort=-v:refname | head -1').toString().trim();
    return t || '';
  } catch {
    return '';
  }
}

const prev = prevArg || lastTag();

function git(args) {
  try {
    return execSync('git ' + args, { maxBuffer: 16 * 1024 * 1024 }).toString();
  } catch {
    return '';
  }
}

function commits(rng) {
  // \x1f separates hash / subject / body, \x1e separates records.
  const raw = git(`log ${rng} --pretty=format:%h%x1f%s%x1f%b%x1e`);
  const out = [];
  for (const rec of raw.split('\x1e')) {
    const parts = rec.split('\x1f');
    if (parts.length < 2 || !parts[0].trim()) continue;
    out.push({ hash: parts[0].trim(), subject: parts[1].trim(), body: (parts[2] || '').trim() });
  }
  return out;
}

function categorize(list) {
  const out = { feat: [], fix: [], docs: [], chore: [], perf: [], refactor: [], other: [] };
  for (const c of list) {
    const m = /^(feat|fix|docs|chore|perf|refactor)(\(.*\))?!?: (.*)$/.exec(c.subject);
    if (m) out[m[1]].push(c);
    else out.other.push(c);
  }
  return out;
}

/** Indent a commit body under its bullet; cap length so one giant message can't blow up the notes. */
function fmtBody(body, maxLines = 15) {
  if (!body) return '';
  const lines = body.split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (!lines.length) return '';
  const cut = lines.length > maxLines ? lines.slice(0, maxLines) : lines;
  const tail = lines.length > maxLines ? '\n  _… truncated_' : '';
  return '\n' + cut.map((l) => '  ' + l).join('\n') + tail;
}

function section(items, emoji, label) {
  if (!items.length) return '';
  return '### ' + emoji + ' ' + label + '\n' +
    items.map((c) => '- `' + c.hash + '` ' + c.subject + fmtBody(c.body)).join('\n') + '\n';
}

function diffstat(a, b) {
  const short = git(`diff --shortstat ${a} ${b}`).trim();
  const rows = git(`diff --numstat ${a} ${b}`).trim();
  const files = rows
    ? rows.split('\n').filter(Boolean).map((l) => {
        const [added, deleted, ...rest] = l.split('\t');
        return { added, deleted, path: rest.join('\t') };
      })
    : [];
  return { short, files };
}

function filesSection(ds) {
  if (!ds.files.length) return '';
  const MAX = 30;
  const shown = ds.files.slice(0, MAX);
  const more = ds.files.length - shown.length;
  const table = [
    '| File | Changes |',
    '| --- | --- |',
    ...shown.map((f) => {
      const a = f.added === '-' ? 'binary' : '+' + f.added;
      const d = f.deleted === '-' ? '' : ' −' + f.deleted;
      return '| `' + f.path + '` | ' + a + d + ' |';
    }),
  ];
  if (more > 0) table.push('| _… ' + more + ' more_ | |');
  const total = ds.short ? '\n_' + ds.short.replace(/\s*\n\s*/g, ' ') + '_\n' : '';
  return '## Files changed\n\n' + table.join('\n') + total + '\n';
}

function gen() {
  const rng = prev ? prev + '..' + next : next;
  const cat = categorize(commits(rng));
  const ds = diffstat(prev || EMPTY_TREE, next);
  const parts = [
    section(cat.feat, '✨', 'Features'),
    section(cat.fix, '🐛', 'Bug fixes'),
    section(cat.perf, '⚡', 'Performance'),
    section(cat.refactor, '♻️', 'Refactors'),
    section(cat.docs, '📝', 'Documentation'),
    section(cat.chore, '🔧', 'Maintenance'),
    section(cat.other, '📄', 'Other'),
  ];
  const body = parts.filter(Boolean).join('\n') || '_No changes in this range._';
  return '## What\u2019s changed\n' + body + '\n' + filesSection(ds);
}

console.log(gen());
