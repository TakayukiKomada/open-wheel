#!/usr/bin/env node
// open-wheel CLI — Wheel (SPEC.md) の init / validate / index / rules / harvest。
// 依存: node builtins のみ。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, renameSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildWheelIndex, validateWheel } from "../lib/entry.mjs";
import { buildExpectedRules, checkRules, writeRules } from "../lib/rules.mjs";
import { GIT_LOG_FORMAT, parseGitLog, detectCandidates, findLaterRefix, renderDraft } from "../lib/harvest.mjs";
import { scaffoldWheel } from "../lib/scaffold.mjs";
import { promoteEntry } from "../lib/promote.mjs";
import { collectSignatures, groupCorroborated } from "../lib/corroborate.mjs";
import { buildCorpusManifest } from "../lib/corpus.mjs";
import { buildHfRecords, renderDatasetCard, writeHfExport, SCRUB_PATTERNS } from "../lib/export-hf.mjs";
import { tallyCitations, defaultNoiseFilter, suggestVerified, suggestReverify } from "../lib/citations.mjs";
import { parseTranscriptEvents, detectStruggleArcs, arcKey, renderTranscriptDraft } from "../lib/transcript.mjs";

const USAGE = `open-wheel <command> [options]

commands:
  init      scaffold the wheel directory (+ first entry) in this repo
  validate  enforce the format contract, cross-links, supersede integrity
  index     emit a JSON index of all entries (stdout, or --out <file>)
  rules     compile paths: frontmatter into path-scoped agent rules
  harvest   draft failure entries from fix commits (drafts only, never adopts)
  pull      subscribe to a remote wheel: fetch it, compile its rules + index locally
  promote   draft a private entry into a global (world-shared) wheel checkout
  corroborate  find signatures (vendor error codes etc.) independently reported
               by 2+ sources (your wheel + any pulled ones) — the same trouble
               recurring across independent parties is itself a signal
  corpus    collect verified entries (problem→fix→outcome all three grounded)
            into a training-corpus candidate manifest (pointers + content
            hashes only; unverified entries never enter — SPEC.md §3)
  citations tally which entries were CHOSEN (cited in commit messages, SPEC.md
            §4) and whether the choice held up (clean = no later re-fix of the
            citing commit's files; refixed = the guidance may have missed).
            "chosen and clean" count is an evidence signal when two entries
            conflict — correlation, not proof
  harvest-transcripts
            draft failure entries from session transcripts (JSONL): detects
            "struggle arcs" — the same attempt failing 2+ times, then finally
            succeeding. The dead ends live only in transcripts, not in git.
            Drafts only, never adopts
  export-hf collect the verified corpus into a Hugging Face dataset layout
            (data/corpus.jsonl + dataset-card README.md). Meant to run against a
            GLOBAL-layer wheel checkout; a fail-closed scrub also excludes any
            entry that looks like it contains secrets / emails / local paths.
            Uploading to the Hub is a human decision, outside this tool

options:
  --dir <path>         wheel directory            (default: docs/wheel; pull: dir inside the remote, auto-detected)
  --out <path>         output target              (index: stdout / rules: .claude/rules/wheel / harvest: .tmp/wheel-runs / pull: .claude/rules/wheel-pull/<name>)
  --pointer <base>     rules: base for the "full entry" pointer (default: --dir).
                       Use an absolute path or URL when emitting user-level rules
                       (e.g. --out ~/.claude/rules/wheel) so pointers resolve from any repo
  --check              rules: verify sync instead of writing (CI mode)
  --ref <ref>          harvest: git ref to scan   (default: origin/main)
  --since-days <n>     harvest: lookback window   (default: 14)
  --transcripts <dir>  harvest-transcripts: directory to scan for *.jsonl (required)
  --min-failures <n>   harvest-transcripts: failures needed to call it a struggle arc (default: 2)
  --suggest-verified   citations: propose verified candidates (all cites clean + aged)
  --min-age-days <n>   citations --suggest-verified: quiet days required (default: 14)
  --suggest-reverify   citations: propose re-verification for verified entries with later refixes
  --name <label>       pull: label for the source (default: derived from the URL/path)
                       export-hf: dataset pretty name (default: open-wheel-corpus)
  --to <path>          promote: local checkout of the global wheel repo (required)
  --ns <namespace>     promote: your namespace in the global repo (e.g. io.gamefork, required)
                       export-hf: optional id prefix for exported records
  --license <spdx>     export-hf: dataset card license (default: mit)
  --pull-dir <path>    corroborate: where to look for pulled indices (default: .claude/wheel-pull)
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.check = true;
    else if (a === "--suggest-verified") args["suggest-verified"] = true;
    else if (a === "--suggest-reverify") args["suggest-reverify"] = true;
    else if (a === "--include-superseded") args["include-superseded"] = true;
    else if (a === "--json") args.json = true;
    else if (a.startsWith("--")) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

async function loadHarvested(statePath) {
  try {
    const raw = await readFile(statePath, "utf-8");
    const shas = new Set();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.sha) shas.add(rec.sha);
      } catch {
        // append-only 台帳の壊れた行は無視
      }
    }
    return shas;
  } catch {
    return new Set();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const wheelDir = args.dir ?? path.join("docs", "wheel");

  if (command === "init") {
    const created = scaffoldWheel(wheelDir, new Date().toISOString().slice(0, 10));
    for (const f of created) console.log(`created: ${f}`);
    console.log(created.length ? `wheel scaffolded at ${wheelDir}` : `nothing to do (already scaffolded)`);
    return 0;
  }

  if (command === "validate") {
    const { entries, problems } = validateWheel(wheelDir);
    if (problems.length) {
      console.error(`open-wheel validate FAILED (${problems.length}):`);
      for (const p of problems) console.error(`  - ${p}`);
      return 1;
    }
    console.log(`open-wheel validate OK (${entries.length} entries)`);
    return 0;
  }

  if (command === "index") {
    const entries = buildWheelIndex(wheelDir);
    const json = `${JSON.stringify(entries, null, 2)}\n`;
    if (args.out) {
      await writeFile(args.out, json, "utf-8");
      console.log(`wheel index: ${entries.length} entries -> ${args.out}`);
    } else {
      process.stdout.write(json);
    }
    return 0;
  }

  if (command === "rules") {
    const rulesDir = args.out ?? path.join(".claude", "rules", "wheel");
    const entries = buildWheelIndex(wheelDir);
    // --pointer: user-level 配信 (~/.claude/rules) の時に正本 pointer を絶対パス/URL に
    // 差し替える。既定はリポジトリ相対 (--dir)。
    const expected = buildExpectedRules(entries, args.pointer ?? wheelDir);
    if (args.check) {
      const problems = checkRules(expected, rulesDir);
      if (problems.length) {
        console.error(`open-wheel rules --check FAILED (${problems.length}):`);
        for (const p of problems) console.error(`  - ${p}`);
        console.error(`-> run \`open-wheel rules\` and commit the result`);
        return 1;
      }
      console.log(`open-wheel rules --check OK (${expected.size} rules in sync)`);
      return 0;
    }
    writeRules(expected, rulesDir);
    console.log(`open-wheel rules: ${expected.size} rules -> ${rulesDir}`);
    return 0;
  }

  if (command === "harvest") {
    const outDir = args.out ?? path.join(".tmp", "wheel-runs");
    const ref = args.ref ?? "origin/main";
    const sinceDays = Number(args["since-days"] ?? "14");
    await mkdir(outDir, { recursive: true });
    const statePath = path.join(outDir, "state.jsonl");
    const harvested = await loadHarvested(statePath);
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
    const raw = execFileSync(
      "git",
      ["log", ref, "--no-merges", `--since=${since}`, `--pretty=format:${GIT_LOG_FORMAT}`, "--name-only", "--date=iso-strict"],
      { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
    );
    const commits = parseGitLog(raw);
    const candidates = detectCandidates(commits, harvested, wheelDir);
    console.log(`open-wheel harvest: window=${sinceDays}d ref=${ref} commits=${commits.length} candidates=${candidates.length}`);
    if (candidates.length === 0) return 0;
    const runDir = path.join(outDir, new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
    await mkdir(runDir, { recursive: true });
    for (const candidate of candidates) {
      const draftPath = path.join(runDir, `failure-draft-${candidate.commit.sha.slice(0, 7)}.md`);
      const refix = findLaterRefix(candidate, commits);
      await writeFile(draftPath, renderDraft(candidate, { onMain: true, refix }), "utf-8");
      await appendFile(statePath, `${JSON.stringify({ sha: candidate.commit.sha, at: new Date().toISOString(), draft: draftPath })}\n`, "utf-8");
      console.log(`draft: ${draftPath} (${candidate.commit.subject})`);
    }
    console.log(`${candidates.length} drafts written. Adoption is human: verify, number, commit (SPEC.md §4).`);
    return 0;
  }

  if (command === "pull") {
    // 購読: リモート (または別ローカル) の公開 wheel を取り込み、
    //   (1) paths 付きエントリ → path-scoped rules (自動出現)
    //   (2) 全エントリ → index JSON (.claude/rules の外 = 常時ロードさせない)
    // をこのリポジトリに生成する。読む側の機能 — これで wheel は配信網になる。
    const src = args._[1];
    if (!src) {
      console.error("usage: open-wheel pull <git-url-or-path> [--dir <dir-in-remote>] [--name <label>] [--out <rules-dir>]");
      return 1;
    }
    const isRemote = /^(https?:\/\/|git@|ssh:\/\/)/.test(src);
    const name = (args.name ?? path.basename(src.replace(/\.git$/, "")).replace(/[^A-Za-z0-9._-]/g, "-")) || "remote";
    // --name はディレクトリ名として join される。`../../victim` のような値が
    // .tmp の外を再帰削除できてしまう (2026-07-10 監査指摘) ため形式で弾く。
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
      console.error(`open-wheel pull: --name must be a plain label ([A-Za-z0-9._-]+): ${name}`);
      return 1;
    }
    let rootPath = src;
    if (isRemote) {
      rootPath = path.join(".tmp", "open-wheel", "pull", name);
      // clone が失敗した時に既存の取り込み結果まで消えないよう、staging に
      // clone 成功してから入れ替える (削除が先に走る監査指摘の修正)
      const staging = `${rootPath}.staging`;
      rmSync(staging, { recursive: true, force: true });
      await mkdir(path.dirname(rootPath), { recursive: true });
      execFileSync("git", ["clone", "--depth", "1", src, staging], { stdio: "pipe" });
      rmSync(rootPath, { recursive: true, force: true });
      renameSync(staging, rootPath);
    }
    // wheel ディレクトリの自動検出: docs/wheel → リポジトリ直下 (design/failures/code を持つ場合)
    let remoteDir = args.dir;
    if (!remoteDir) {
      if (existsSync(path.join(rootPath, "docs", "wheel"))) remoteDir = path.join("docs", "wheel");
      else if (["design", "failures", "code"].some((d) => existsSync(path.join(rootPath, d)))) remoteDir = ".";
      else {
        console.error(`open-wheel pull: cannot locate a wheel in ${src} — pass --dir <dir-in-remote>`);
        return 1;
      }
    }
    const entries = buildWheelIndex(path.join(rootPath, remoteDir));
    const pointerBase = isRemote
      ? `${src.replace(/\.git$/, "")}${remoteDir === "." ? "" : ` :: ${remoteDir}`}`
      : path.join(src, remoteDir === "." ? "" : remoteDir);
    const rulesDir = args.out ?? path.join(".claude", "rules", "wheel-pull", name);
    const expected = buildExpectedRules(entries, pointerBase);
    writeRules(expected, rulesDir);
    const indexPath = path.join(".claude", "wheel-pull", `${name}.index.json`);
    await mkdir(path.dirname(indexPath), { recursive: true });
    await writeFile(indexPath, `${JSON.stringify(entries, null, 2)}\n`, "utf-8");
    console.log(
      `open-wheel pull: ${entries.length} entries from ${src} -> ${expected.size} rules (${rulesDir}), index (${indexPath})`,
    );
    if (expected.size === 0) {
      console.log("note: no entries carry paths: globs — nothing auto-surfaces; the index is still searchable.");
    }
    return 0;
  }

  if (command === "promote") {
    // private → global の昇格下書き。機械的な部分 (採番・配置・内部参照の検出・
    // published: の追記) のみ自動化し、汎用化と公開判断は人間 (SPEC.md §6)。
    const id = args._[1];
    if (!id || !args.to || !args.ns) {
      console.error("usage: open-wheel promote <entry-id> --to <global-wheel-checkout> --ns <namespace> [--dir docs/wheel]");
      return 1;
    }
    const entries = buildWheelIndex(wheelDir);
    const entry = entries.find((e) => e.id === id);
    if (!entry) {
      console.error(`open-wheel promote: entry not found: ${id}`);
      return 1;
    }
    const result = promoteEntry(entry, path.join(wheelDir, entry.file), {
      globalRoot: args.to,
      namespace: args.ns,
      today: new Date().toISOString().slice(0, 10),
    });
    if (result.alreadyPublished) {
      // 冪等: 既公開エントリは global 側に何も書かない (同内容の次番号が増殖する監査指摘の修正)
      console.log(`note: ${entry.file} is already published as ${result.publishedId} — nothing written`);
      return 0;
    }
    console.log(`promotion draft: ${result.draftPath}`);
    console.log(`published: ${result.publishedId} recorded on ${entry.file} (commit it in this repo)`);
    console.log(
      `self-containment TODOs detected: ${result.internalRefCount} — `
      + `edit the draft, complete the checklist in its header, then commit in the global repo.`,
    );
    return 0;
  }

  if (command === "corpus") {
    // 検証済み (verified) エントリだけの学習コーパス候補 manifest (design-0010/0017 の
    // docs 層版)。--out 省略で stdout。--include-superseded で陳腐化エントリも含める。
    const entries = buildWheelIndex(wheelDir);
    const manifest = buildCorpusManifest(entries, {
      includeSuperseded: !!args["include-superseded"],
      generatedAt: new Date().toISOString(),
    });
    const json = `${JSON.stringify(manifest, null, 2)}\n`;
    if (args.out) {
      await mkdir(path.dirname(args.out), { recursive: true });
      await writeFile(args.out, json, "utf-8");
      console.log(
        `open-wheel corpus: ${manifest.count} verified entrie(s) -> ${args.out} `
        + `(${manifest.skipped_unverified} unverified skipped — a record without an outcome is not a lesson)`,
      );
    } else {
      process.stdout.write(json);
    }
    return 0;
  }

  if (command === "export-hf") {
    // verified コーパスを HF dataset 形式 (data/corpus.jsonl + dataset card) に書き出す
    // (design-0023 の一段階目の出口)。アップロード自体は人間の公開判断で行う。
    const outDir = args.out ?? path.join(".tmp", "wheel-hf-export");
    const entries = buildWheelIndex(wheelDir);
    const { records, excluded, skipped_unverified } = buildHfRecords(entries, { ns: args.ns ?? null });
    const card = renderDatasetCard(records, {
      license: args.license ?? "mit",
      name: args.name ?? "open-wheel-corpus",
    });
    writeHfExport(outDir, records, card);
    console.log(
      `open-wheel export-hf: ${records.length} record(s) -> ${outDir} `
      + `(${skipped_unverified} unverified/superseded skipped)`,
    );
    for (const x of excluded) {
      console.error(`  scrub-excluded: ${x.id} (${x.reasons.join(", ")}) — 秘密情報らしき一致。エントリを自己完結化してから再実行`);
    }
    return excluded.length > 0 ? 1 : 0;
  }

  if (command === "harvest-transcripts") {
    // セッション transcript (JSONL) から「失敗→挑戦→成功」の苦闘 arc を検出して
    // failure 下書きを出力する (design-0024)。drafts only — 採用は検証ゲートの先 (SPEC §4)。
    const trDir = args.transcripts;
    if (!trDir) {
      console.error("usage: open-wheel harvest-transcripts --transcripts <dir> [--out .tmp/wheel-runs] [--min-failures 2]");
      return 1;
    }
    const outDir = args.out ?? path.join(".tmp", "wheel-runs");
    const minFailures = Number(args["min-failures"] ?? "2");
    await mkdir(outDir, { recursive: true });
    const statePath = path.join(outDir, "transcript-state.jsonl");
    const seen = new Set();
    const scannedFiles = new Map(); // rel path → 前回スキャン時の署名 "size:mtimeMs"
    try {
      for (const line of (await readFile(statePath, "utf-8")).split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.key) seen.add(rec.key);
          else if (rec.file) scannedFiles.set(rec.file, rec.sig);
        } catch { /* 壊れた行は無視 */ }
      }
    } catch { /* state 無し = 初回 */ }

    const files = readdirSync(trDir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
    let drafted = 0;
    let scanned = 0;
    for (const rel of files) {
      const full = path.join(trDir, rel);
      // 変化の無いファイルは再走査しない。transcript コーパスは増える一方なので、
      // 全ファイル再パースは常駐 runner の周回ごとに O(コーパス全体) へ育つ —
      // arc 単位の dedup (seen) は出力を抑えるだけで走査は抑えないため、ここで切る
      let sig;
      try {
        const st = statSync(full);
        sig = `${st.size}:${Math.trunc(st.mtimeMs)}`;
      } catch { continue; }
      if (scannedFiles.get(rel) === sig) continue;
      let text;
      try { text = readFileSync(full, "utf-8"); } catch { continue; }
      scanned += 1;
      const arcs = detectStruggleArcs(parseTranscriptEvents(text), { minFailures });
      for (const arc of arcs) {
        const key = arcKey(rel, arc);
        if (seen.has(key)) continue;
        const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
        const draftPath = path.join(outDir, `transcript-${hash}.md`);
        // 多層防御: transcript 由来のエラー文には秘密情報が混ざりうる。scrub に当たったら
        // 先頭コメントで警告する (除外はしない — draft は人間レビュー前提のローカル成果物。
        // export-hf 側の fail-closed 除外が最終ゲート)
        let draft = renderTranscriptDraft(arc, { sessionFile: rel, date: new Date().toISOString().slice(0, 10) });
        const scrubHits = SCRUB_PATTERNS.filter((p) => p.re.test(draft)).map((p) => p.name);
        if (scrubHits.length > 0) {
          draft = `<!-- SCRUB WARNING: 秘密情報らしき一致 (${scrubHits.join(", ")}) — 採用前に必ず該当箇所を除去すること -->\n${draft}`;
          console.error(`  scrub-warning: ${draftPath} (${scrubHits.join(", ")})`);
        }
        await writeFile(draftPath, draft, "utf-8");
        await appendFile(statePath, `${JSON.stringify({ key, draft: draftPath })}\n`, "utf-8");
        seen.add(key);
        drafted += 1;
        console.log(`draft: ${draftPath} (${arc.attempts.length} failed attempts, sig "${arc.signature}")`);
      }
      // このファイルの署名を記録 → 次回以降、無変化なら走査をスキップ
      await appendFile(statePath, `${JSON.stringify({ file: rel, sig })}\n`, "utf-8");
      scannedFiles.set(rel, sig);
    }
    console.log(
      `open-wheel harvest-transcripts: ${drafted} draft(s) from ${scanned} transcript(s) `
      + `(drafts only — adopt after the verification gate)`,
    );
    return 0;
  }

  if (command === "citations") {
    // 「どれを選んだか」(引用) と「選んで正解だったか」(後続再修正の有無) の集計。
    // --since-days 省略 = 全履歴。--json で機械可読出力。
    const ref = args.ref ?? "origin/main";
    const gitArgs = ["log", ref, "--no-merges", `--pretty=format:${GIT_LOG_FORMAT}`, "--name-only", "--date=iso-strict"];
    if (args["since-days"]) {
      const since = new Date(Date.now() - Number(args["since-days"]) * 24 * 60 * 60 * 1000).toISOString();
      gitArgs.splice(2, 0, `--since=${since}`);
    }
    const raw = execFileSync("git", gitArgs, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
    const commits = parseGitLog(raw);
    const tally = tallyCitations(commits, { isNoise: defaultNoiseFilter(wheelDir) });
    const indexEntries = buildWheelIndex(wheelDir);
    const known = new Set(indexEntries.map((e) => e.id));

    if (args["suggest-reverify"]) {
      // verified 済みエントリの引用後 refix は、再検証を促すシグナルとして提示する。
      // 自動降格はせず、候補提示だけに留める (design-0024)。
      const suggestions = suggestReverify(tally, indexEntries);
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ ref, suggestions }, null, 2)}\n`);
        return 0;
      }
      if (suggestions.length === 0) {
        console.log(`open-wheel citations --suggest-reverify: no candidates (ref=${ref})`);
        return 0;
      }
      console.log(`open-wheel citations --suggest-reverify: ${suggestions.length} candidate(s)\n`);
      for (const sg of suggestions) {
        console.log(
          `${sg.id.padEnd(14)} verified=${sg.verified} citations=${sg.citations} refixed=${sg.refixed}`,
        );
        for (const rf of sg.refixes) {
          console.log(
            `  cite ${rf.citeSha.slice(0, 7)} (${rf.citeDate}) -> refix ${rf.refixSha.slice(0, 7)}`,
          );
        }
      }
      console.log(
        "\nThese are NUDGES from a correlated signal (a later refix after citation)."
        + "\nRe-check the real-world outcome and keep, update, or supersede the entry manually; verified is not auto-removed.",
      );
      return 0;
    }

    if (args["suggest-verified"]) {
      // verified 自動スタンプの提案 (design-0024): 全引用 clean + 最新引用から
      // --min-age-days (既定 14) 経過で候補提示。付与は人間が実地確認してから。
      const minAgeDays = Number(args["min-age-days"] ?? "14");
      const suggestions = suggestVerified(tally, indexEntries, { nowMs: Date.now(), minAgeDays });
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ ref, min_age_days: minAgeDays, suggestions }, null, 2)}\n`);
        return 0;
      }
      if (suggestions.length === 0) {
        console.log(`open-wheel citations --suggest-verified: no candidates (ref=${ref}, min-age-days=${minAgeDays})`);
        return 0;
      }
      console.log(`open-wheel citations --suggest-verified: ${suggestions.length} candidate(s)\n`);
      for (const sg of suggestions) {
        console.log(
          `${sg.id.padEnd(14)} citations=${sg.citations} all clean, latest cite ${sg.latestCite.sha.slice(0, 7)} `
          + `(${sg.ageDays}d ago)`,
        );
      }
      console.log(
        "\nThese are NUDGES from mechanical evidence (cited, never re-fixed, aged)."
        + "\nConfirm the real-world outcome yourself, then set verified: YYYY-MM-DD in the frontmatter.",
      );
      return 0;
    }

    const rows = [...tally.entries()]
      .map(([id, t]) => ({ id, known: known.has(id), ...t }))
      .sort((a, b) => b.citations - a.citations || a.id.localeCompare(b.id));

    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ref, commits: commits.length, entries: rows }, null, 2)}\n`);
      return 0;
    }
    console.log(`open-wheel citations: ref=${ref} commits=${commits.length} cited-entries=${rows.length}\n`);
    if (rows.length === 0) {
      console.log("No citations found. Cite entry ids in commit messages when a lesson guided a decision (SPEC.md §4).");
      return 0;
    }
    for (const r of rows) {
      const flag = r.known ? "" : "  ⚠ UNKNOWN ID (typo? entry removed?)";
      console.log(`${r.id.padEnd(14)} citations=${r.citations} clean=${r.clean} refixed=${r.refixed}${flag}`);
    }
    console.log(
      "\nclean = citing commit's files saw no later fix-type commit (the choice held up)."
      + "\nrefixed = they did — the guidance may have missed; inspect before trusting."
      + "\nUse 'chosen and clean' as an evidence signal between conflicting entries (correlation, not proof).",
    );
    return 0;
  }

  if (command === "corroborate") {
    // 独立ソース (自分の wheel + pull した各ソース) を横断し、同じ signature
    // (ベンダーのエラーコード等、決定論的に抽出できる識別子) が 2 つ以上の
    // ソースに現れるものを報告する (design-0016)。同じトラブルを複数の
    // 独立した組織が別々に踏んでいる、という事実そのものが信号になる。
    const pullDir = args["pull-dir"] ?? path.join(".claude", "wheel-pull");
    const ownEntries = buildWheelIndex(wheelDir);
    const rows = collectSignatures("self", ownEntries);

    let pulledSourceCount = 0;
    if (existsSync(pullDir)) {
      const indexFiles = readdirSync(pullDir).filter((f) => f.endsWith(".index.json"));
      pulledSourceCount = indexFiles.length;
      for (const f of indexFiles) {
        const name = f.replace(/\.index\.json$/, "");
        const entries = JSON.parse(readFileSync(path.join(pullDir, f), "utf-8"));
        rows.push(...collectSignatures(name, entries));
      }
    }

    const groups = groupCorroborated(rows);
    if (groups.length === 0) {
      console.log(
        `open-wheel corroborate: no signature corroborated across 2+ independent sources yet `
        + `(scanned: self + ${pulledSourceCount} pulled source(s)).`,
      );
      console.log(
        "This needs entries whose text contains a matching deterministic signature "
        + "(currently: vendor error codes like \"[code: 10074]\", HTTP status+reason) "
        + "in 2+ different sources. Pull more wheels, or wait for more to be promoted.",
      );
      return 0;
    }

    console.log(`open-wheel corroborate: ${groups.length} signature(s) independently corroborated:\n`);
    for (const g of groups) {
      console.log(`[${g.signature}] seen in ${g.sourceCount} independent sources: ${g.sources.join(", ")}`);
      for (const e of g.entries) console.log(`  - (${e.source}) [${e.id}] ${e.title}`);
      console.log("");
    }
    return 0;
  }

  console.error(USAGE);
  return command ? 1 : 0;
}

process.exitCode = await main().catch((err) => {
  console.error(`open-wheel: ${err.message ?? err}`);
  return 1;
});
