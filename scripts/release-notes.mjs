#!/usr/bin/env node
/**
 * Generate categorized release notes from git history since the last tag.
 * Usage: node scripts/release-notes.mjs [prevTag] [newTag]
 * Prints a markdown release body to stdout.
 */
import { execSync } from 'node:child_process';

const [, , prevArg, nextArg] = process.argv;
const next = nextArg || 'HEAD';

function lastTag() {
  try {
    const t = execSync('git tag --sort=-v:refname | head -1').toString().trim();
    return t || '';
  } catch {
    return '';
  }
}

const prev = prevArg || lastTag();

function commits(rng) {
  const log = execSync('git log ' + rng + ' --pretty=format:%h%x09%s').toString().trim();
  if (!log) return [];
  return log.split('\n').map((l) => {
    const i = l.indexOf('\t');
    return { hash: l.slice(0, i), subject: l.slice(i + 1) };
  });
}

function categorize(list) {
  const out = { feat: [], fix: [], docs: [], chore: [], perf: [], refactor: [], other: [] };
  for (const c of list) {
    const m = /^(feat|fix|docs|chore|perf|refactor)(\(.*\))?!?: (.*)$/.exec(c.subject);
    if (m) out[m[1]].push({ hash: c.hash, text: m[3] });
    else out.other.push(c);
  }
  return out;
}

function section(items, emoji, label) {
  if (!items.length) return '';
  return '### ' + emoji + ' ' + label + '\n' +
    items.map((c) => '- `' + c.hash + '` ' + c.text).join('\n') + '\n';
}

function gen() {
  const rng = prev ? prev + '..' + next : next;
  const cat = categorize(commits(rng));
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
  return '## What\u2019s changed\n' + body;
}

console.log(gen());
