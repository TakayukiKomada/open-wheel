// Integrity check for the Open Wheel registry.
//
// Verifies, for every wheels/<namespace>/<type>/NNNN-slug.md:
//   1. namespace directory looks like reverse-DNS (e.g. io.gamefork)
//   2. type is one of failures | design | code, filename is NNNN-slug.md, numbering unique
//   3. required frontmatter keys exist (id/namespace/title/status/created/origin)
//   4. frontmatter id matches "<type-prefix>-<NNNN>" derived from the file location,
//      and frontmatter namespace matches the directory
//   5. status is active | superseded | deprecated; superseded requires superseded_by
//   6. each namespace has a README.md that links every entry (no orphans, no dead links)
//   7. [[id]] and [[ns/id]] cross-references resolve to existing entries
//   8. (warning) frontmatter has `aliases: [<id>]` so [[id]] links resolve when the
//      repo is opened as an Obsidian vault (filenames are NNNN-slug.md, not the id)
//   9. (warning) stray files — Obsidian vault defaults (attachments, daily notes,
//      sync conflicted copies) must not land inside wheels/
//
// Node builtins only — no install step. Run: node scripts/verify-wheel.mjs

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WHEELS_DIR = path.join(ROOT, 'wheels');

const TYPES = { failures: 'failure', design: 'design', code: 'code' };
const TYPE_ALT = Object.keys(TYPES).join('|');
const PREFIX_ALT = Object.values(TYPES).join('|');
const VALID_STATUS = new Set(['active', 'superseded', 'deprecated']);
const REQUIRED_KEYS = ['id', 'namespace', 'title', 'summary', 'status', 'created', 'source', 'origin'];
const NS_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/; // reverse-DNS-ish
// Local-only Obsidian vault dirs (gitignored) — excluded from the stray-file sweep
const VAULT_LOCAL_DIRS = new Set(['.obsidian', '.smart-env']);

const errors = [];
// Non-fatal notices (exit 0) — used for the Obsidian-vault conventions so that
// existing forks/branches without them are not broken retroactively
const warnings = [];

function parseFrontmatter(text, file) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) {
    errors.push(`${file}: missing frontmatter (--- block)`);
    return {};
  }
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

// fullIds: "io.gamefork/failure-0001"; also track per-namespace short ids
const fullIds = new Set();
const entriesByNs = new Map(); // ns -> [{relLink, file}]

if (!fs.existsSync(WHEELS_DIR)) {
  errors.push('wheels/ directory not found');
} else {
  for (const ns of fs.readdirSync(WHEELS_DIR).sort()) {
    const nsPath = path.join(WHEELS_DIR, ns);
    if (!fs.statSync(nsPath).isDirectory()) {
      // Stray file at wheels/ root (vault attachment / conflicted copy landing spot)
      warnings.push(`wheels/${ns}: unexpected file — wheels/ holds namespace directories only`);
      continue;
    }
    if (VAULT_LOCAL_DIRS.has(ns)) continue;
    if (!NS_PATTERN.test(ns)) {
      errors.push(`wheels/${ns}: namespace is not reverse-DNS shaped (e.g. io.example)`);
    }
    entriesByNs.set(ns, []);
    for (const type of fs.readdirSync(nsPath).sort()) {
      const typePath = path.join(nsPath, type);
      if (!fs.statSync(typePath).isDirectory()) {
        if (type !== 'README.md') {
          warnings.push(`wheels/${ns}/${type}: unexpected file — a namespace holds README.md and type directories only (stray attachment / conflicted copy?)`);
        }
        continue;
      }
      if (VAULT_LOCAL_DIRS.has(type)) continue;
      if (!(type in TYPES)) {
        errors.push(`wheels/${ns}/${type}: unknown entry type (allowed: ${TYPE_ALT})`);
        continue;
      }
      const prefix = TYPES[type];
      const seenNums = new Map();
      for (const name of fs.readdirSync(typePath).sort()) {
        if (!name.endsWith('.md')) {
          warnings.push(`wheels/${ns}/${type}/${name}: unexpected non-entry file (stray attachment / conflicted copy?)`);
          continue;
        }
        const rel = `wheels/${ns}/${type}/${name}`;
        const fnMatch = name.match(/^(\d{4})-[a-z0-9-]+\.md$/);
        if (!fnMatch) {
          errors.push(`${rel}: filename must be NNNN-slug.md`);
          continue;
        }
        const num = fnMatch[1];
        if (seenNums.has(num)) {
          errors.push(`${rel}: number ${num} duplicates ${seenNums.get(num)}`);
        }
        seenNums.set(num, name);
        entriesByNs.get(ns).push({ relLink: `${type}/${name}`, file: rel });

        const text = fs.readFileSync(path.join(typePath, name), 'utf8');
        const fm = parseFrontmatter(text, rel);
        for (const key of REQUIRED_KEYS) {
          if (!fm[key]) errors.push(`${rel}: frontmatter missing "${key}"`);
        }
        const expectedId = `${prefix}-${num}`;
        if (fm.id && fm.id !== expectedId) {
          errors.push(`${rel}: id is "${fm.id}" but file location implies "${expectedId}"`);
        }
        if (fm.namespace && fm.namespace !== ns) {
          errors.push(`${rel}: namespace is "${fm.namespace}" but directory is "${ns}"`);
        }
        if (fm.status && !VALID_STATUS.has(fm.status)) {
          errors.push(`${rel}: status "${fm.status}" must be active | superseded | deprecated`);
        }
        if (fm.status === 'superseded' && (!fm.superseded_by || fm.superseded_by === 'null')) {
          errors.push(`${rel}: status is superseded but superseded_by is not set`);
        }
        if (fm.verified && fm.verified !== 'null' && !/^\d{4}-\d{2}-\d{2}$/.test(fm.verified)) {
          errors.push(`${rel}: verified must be null or a YYYY-MM-DD date (got "${fm.verified}")`);
        }
        // Obsidian vault support: filenames are NNNN-slug.md, so [[failure-0001]]-style
        // links only resolve through a frontmatter alias carrying the id
        if (!fm.aliases || !fm.aliases.includes(expectedId)) {
          warnings.push(`${rel}: frontmatter has no aliases: [${expectedId}] — [[${expectedId}]] links will not resolve in an Obsidian vault`);
        }
        if (fm.id) fullIds.add(`${ns}/${expectedId}`);
      }
    }
  }
}

// Per-namespace README index: every entry linked, every link resolves
for (const [ns, entries] of entriesByNs) {
  const readmePath = path.join(WHEELS_DIR, ns, 'README.md');
  if (!fs.existsSync(readmePath)) {
    errors.push(`wheels/${ns}/README.md: missing namespace index`);
    continue;
  }
  const readme = fs.readFileSync(readmePath, 'utf8');
  const linked = new Set(
    [...readme.matchAll(new RegExp(`\\]\\(((?:${TYPE_ALT})\\/[^)]+\\.md)\\)`, 'g'))].map((m) => m[1]),
  );
  for (const e of entries) {
    if (!linked.has(e.relLink)) {
      errors.push(`wheels/${ns}/README.md: ${e.relLink} is not listed in the index`);
    }
  }
  const existing = new Set(entries.map((e) => e.relLink));
  for (const link of linked) {
    if (!existing.has(link)) {
      errors.push(`wheels/${ns}/README.md: dead link ${link}`);
    }
  }
}

// Cross-references: [[failure-0002]] (same namespace) or [[io.other/failure-0001]]
for (const [ns, entries] of entriesByNs) {
  for (const e of entries) {
    const text = fs.readFileSync(path.join(ROOT, e.file), 'utf8');
    const refRe = new RegExp(
      `\\[\\[((?:[a-z0-9.-]+\\/)?(?:${PREFIX_ALT})-\\d{4})\\]\\]`,
      'g',
    );
    for (const m of text.matchAll(refRe)) {
      const ref = m[1].includes('/') ? m[1] : `${ns}/${m[1]}`;
      if (!fullIds.has(ref)) {
        errors.push(`${e.file}: cross-reference [[${m[1]}]] does not resolve`);
      }
    }
  }
}

// Warnings are non-fatal (exit 0); shown as ::warning:: annotations under GitHub Actions
for (const w of warnings) {
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::warning file=${w.split(':')[0]}::${w}`);
  } else {
    console.warn(`  warn: ${w}`);
  }
}

if (errors.length > 0) {
  console.error(`open-wheel verify: ${errors.length} problem(s)\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `open-wheel verify: OK (${fullIds.size} entries across ${entriesByNs.size} namespace(s)${warnings.length ? `, ${warnings.length} warning(s)` : ''})`,
);
