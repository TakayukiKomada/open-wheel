// Wheel エントリの parse / validate (SPEC.md §1-2 の形式契約)。
// gamefork の apps/dev/scripts/wheel-index-lib.mjs から可搬化した正本。
// 依存: node builtins のみ (npx で即動くことが普及の前提)。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const VALID_STATUS = new Set(["active", "superseded", "deprecated"]);
export const MAX_BODY_CHARS = 6000;

// kind → ディレクトリ名 / id prefix
export const KINDS = [
  { kind: "design", dir: "design", prefix: "design-" },
  { kind: "failure", dir: "failures", prefix: "failure-" },
  { kind: "code", dir: "code", prefix: "code-" },
  { kind: "mechanic", dir: "mechanics", prefix: "mechanic-" },
  { kind: "prompt", dir: "prompts", prefix: "prompt-" },
];

// クロスリンク [[<prefix>-NNNN]] の許容 prefix (KINDS から導出、追加時の書き漏れ防止)。
const CROSSLINK_PREFIX_ALT = KINDS.map((k) => k.prefix.replace(/-$/, "")).join("|");

// id 末尾の 2 形式 (SPEC.md §2)。ID を parse/検出する全箇所がこのパターンを共有する
// (verify / citations / nudge / promote — 桁数前提の分岐は各所に複製しない):
//   - 日付形式 (新規はこちら): YYYYMMDD-slug — 並行 PR で採番が衝突しない (連番導出が不要)
//   - 連番形式 (歴史形式): NNNN 4 桁 — 既存 id は引用の永続キーなので永久に有効。新規では使わない
// 日付形式を先に置く (連番 alternative が日付 id の先頭 4 桁に部分一致するのを防ぐ)。
export const ID_TAIL_SOURCE = "(?:\\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*|\\d{4})";

/** YYYYMMDD (区切りなし 8 桁) 形式かつ実在する日付か (日付形式 id のファイル名検証用)。 */
export function isValidCompactDate(raw) {
  if (typeof raw !== "string" || !/^\d{8}$/.test(raw)) return false;
  return isValidDateString(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`);
}

function parseFrontmatterLines(lines, fileName) {
  const fm = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx === -1) {
      throw new Error(`${fileName}: cannot parse frontmatter line: ${line}`);
    }
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).split(" #")[0].trim();
    if (value === "null" || value === "") value = null;
    fm[key] = value;
  }
  return fm;
}

/** YYYY-MM-DD 形式かつ実在する日付か (2026-99-99 のような形式一致・実在しない日付を弾く)。 */
export function isValidDateString(raw) {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const [y, mo, d] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function parseListField(raw, fieldName, fileName) {
  if (raw == null) return [];
  const m = raw.match(/^\[(.*)\]$/);
  if (!m) {
    throw new Error(`${fileName}: ${fieldName} must be a [a, b] list: ${raw}`);
  }
  return m[1]
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter((t) => t.length > 0);
}

/** 1 エントリの Markdown を構造化する。契約違反は throw。 */
export function parseWheelEntry(markdown, kind, fileName) {
  const spec = KINDS.find((k) => k.kind === kind);
  if (!spec) throw new Error(`unknown kind: ${kind}`);
  const normalized = markdown.replace(/\r\n/g, "\n");
  const m = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`${fileName}: missing frontmatter (--- ... ---)`);
  const fm = parseFrontmatterLines(m[1].split("\n"), fileName);
  const body = m[2].trim();

  for (const key of ["id", "title", "summary", "status", "created", "source"]) {
    if (!fm[key]) throw new Error(`${fileName}: frontmatter '${key}' is required (SPEC.md §2)`);
  }
  // id は prefix + 日付形式 (YYYYMMDD-slug) または連番形式 (ちょうど 4 桁)。
  // startsWith だけだと "failure-not-four-digits" が通る fail-open なので全体一致で検証する
  if (!new RegExp(`^${spec.prefix}${ID_TAIL_SOURCE}$`).test(fm.id)) {
    throw new Error(
      `${fileName}: id must be ${spec.prefix}YYYYMMDD-slug (date form) or ${spec.prefix}NNNN (legacy 4 digits): ${fm.id}`,
    );
  }
  // 日付形式は id とファイル名が同一 (id = prefix + basename)。連番形式の id↔ファイル名
  // 突合は従来通り呼び出し側 (リポジトリの verify) が行う (後方互換のため挙動を変えない)
  const dateFile = fileName.match(/^(\d{8})-([a-z0-9-]+)\.md$/);
  const isDateId = new RegExp(`^${spec.prefix}\\d{8}-`).test(fm.id);
  if (dateFile) {
    if (!isValidCompactDate(dateFile[1])) {
      throw new Error(`${fileName}: filename date ${dateFile[1]} is not a real YYYYMMDD date`);
    }
    const expected = `${spec.prefix}${dateFile[1]}-${dateFile[2]}`;
    if (fm.id !== expected) {
      throw new Error(`${fileName}: date-form id must equal prefix + filename (${expected}): ${fm.id}`);
    }
  } else if (isDateId) {
    throw new Error(`${fileName}: date-form id ${fm.id} requires a YYYYMMDD-slug.md filename`);
  }
  if (!VALID_STATUS.has(fm.status)) {
    throw new Error(`${fileName}: status must be active|superseded|deprecated: ${fm.status}`);
  }
  if (body.length === 0) throw new Error(`${fileName}: body is empty`);
  if (body.length > MAX_BODY_CHARS) {
    throw new Error(
      `${fileName}: body ${body.length} chars > ${MAX_BODY_CHARS} cap — split the entry (SPEC.md §2)`,
    );
  }
  // 日付は形式だけでなく実在も検証する (2026-99-99 を通さない)
  if (!isValidDateString(fm.created)) {
    throw new Error(`${fileName}: created must be a real YYYY-MM-DD date: ${fm.created}`);
  }
  if (fm.verified && !isValidDateString(fm.verified)) {
    throw new Error(`${fileName}: verified must be a real YYYY-MM-DD date: ${fm.verified}`);
  }

  return {
    id: fm.id,
    kind,
    file: `${spec.dir}/${fileName}`,
    title: fm.title,
    summary: fm.summary,
    status: fm.status,
    aliases: parseListField(fm.aliases, "aliases", fileName),
    tags: parseListField(fm.tags, "tags", fileName),
    paths: parseListField(fm.paths, "paths", fileName),
    created: fm.created,
    source: fm.source,
    supersedes: fm.supersedes ?? null,
    superseded_by: fm.superseded_by ?? null,
    published: fm.published ?? null,
    observed_by: fm.observed_by ?? null,
    verified: fm.verified ?? null,
    enforced_by: parseListField(fm.enforced_by, "enforced_by", fileName),
    body,
  };
}

/**
 * wheel ルート (design/ failures/ code/) を走査して id 順の索引を作る。
 * opts.onMalformedFileName: NNNN-slug.md に合わない .md を見つけた時のコールバック
 * (validate が fail-closed で報告するための口。未指定なら従来通り黙ってスキップ)。
 */
export function buildWheelIndex(wheelRootDir, opts = {}) {
  const entries = [];
  for (const { kind, dir } of KINDS) {
    let allFiles;
    try {
      allFiles = readdirSync(join(wheelRootDir, dir));
    } catch (err) {
      // ディレクトリが無い kind はスキップ (code/ 未採用リポジトリ等)。
      // それ以外の I/O エラー (権限等) は黙殺しない (fail-open 防止)。
      if (err && err.code === "ENOENT") continue;
      throw err;
    }
    // 連番 (NNNN-slug.md) と日付 (YYYYMMDD-slug.md) の両形式を索引対象にする。
    // \d{4}- は 5 文字目に "-" を要求するため 8 桁日付とは重ならない (排他)
    const ENTRY_FILE_RE = /^(?:\d{8}|\d{4})-.+\.md$/;
    const files = allFiles.filter((f) => ENTRY_FILE_RE.test(f)).sort();
    if (opts.onMalformedFileName) {
      for (const f of allFiles) {
        if (f.endsWith(".md") && !ENTRY_FILE_RE.test(f) && f !== "README.md") {
          opts.onMalformedFileName(`${dir}/${f}`);
        }
      }
    }
    for (const fileName of files) {
      const markdown = readFileSync(join(wheelRootDir, dir, fileName), "utf-8");
      entries.push(parseWheelEntry(markdown, kind, fileName));
    }
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set();
  for (const e of entries) {
    if (ids.has(e.id)) throw new Error(`duplicate id: ${e.id}`);
    ids.add(e.id);
  }
  return entries;
}

// failure エントリの接地 3 節 (問題→修正→結果、SPEC.md §3)。
// 結果の無い記録は教訓ではない — 節の存在を機械検証する (中身の質は人間)。
const FAILURE_REQUIRED_SECTIONS = ["## Context", "## Failure", "## Consequences"];

/**
 * validate: 索引構築 (= 形式契約) + [[id]] クロスリンク + supersede 整合
 * + failure の接地 3 節。問題の一覧を返す (空 = OK)。
 * fail-closed: wheel ディレクトリ自体が無い / エントリ 0 件 / 不正ファイル名も問題として報告。
 */
export function validateWheel(wheelRootDir) {
  const problems = [];
  try {
    readdirSync(wheelRootDir);
  } catch {
    return { entries: [], problems: [`wheel directory not found: ${wheelRootDir}`] };
  }
  let entries;
  try {
    entries = buildWheelIndex(wheelRootDir, {
      onMalformedFileName: (f) => problems.push(`${f}: filename must be NNNN-slug.md`),
    });
  } catch (err) {
    return { entries: [], problems: [...problems, String(err.message ?? err)] };
  }
  if (entries.length === 0) {
    problems.push(`no entries found under ${wheelRootDir} — run \`open-wheel init\` or check --dir`);
  }
  const ids = new Set(entries.map((e) => e.id));
  for (const e of entries) {
    for (const m of e.body.matchAll(new RegExp(`\\[\\[((?:${CROSSLINK_PREFIX_ALT})-${ID_TAIL_SOURCE})\\]\\]`, "g"))) {
      if (!ids.has(m[1])) problems.push(`${e.file}: broken cross-link [[${m[1]}]]`);
    }
    for (const field of ["supersedes", "superseded_by"]) {
      const target = e[field];
      if (target && !ids.has(target)) problems.push(`${e.file}: ${field} points to unknown id ${target}`);
    }
    if (e.status === "superseded" && !e.superseded_by) {
      problems.push(`${e.file}: status superseded requires superseded_by`);
    }
    // aliases はテンプレートが emit する任意フィールド (SPEC §2)。書くなら id を含むこと —
    // ファイル名 (NNNN-slug.md) と id が一致しないため、[[id]] リンクの解決はここに依存する
    if (e.aliases.length > 0 && !e.aliases.includes(e.id)) {
      problems.push(`${e.file}: aliases must include the entry id ${e.id} — it resolves [[id]] links in Obsidian-style vaults`);
    }
    if (e.kind === "failure") {
      for (const section of FAILURE_REQUIRED_SECTIONS) {
        if (!new RegExp(`^${section}\\b`, "m").test(e.body)) {
          problems.push(`${e.file}: failure entry missing "${section}" section (problem→fix→outcome, SPEC.md §3)`);
        }
      }
    }
  }
  return { entries, problems };
}
