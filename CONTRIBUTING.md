# Contributing

## Adding your team's wheel

1. **Pick your namespace**: reverse-DNS of a domain you control (e.g. `com.example`,
   `io.yourproject`). One namespace per team/project. First PR claims it.
2. **Create entries** under `wheels/<namespace>/{failures,design,code}/NNNN-slug.md`,
   following the entry format in [README.md](README.md). Numbering is sequential and
   independent per directory.
3. **Add an index**: `wheels/<namespace>/README.md` with one line per entry.
4. **Run the verifier**: `node scripts/verify-wheel.mjs`. CI runs it on every PR.

## Hard requirements

- **Provenance.** `origin` must state, in plain words, where the lesson came from
  (production incident, verified audit finding, shipped design). Speculative or
  secondhand lessons will not be merged. This is what separates Open Wheel from a tips blog.
- **Self-containment.** No private-repo links, internal ticket ids, or company-internal
  context. A stranger (or an AI agent) must be able to act on the entry as-is.
- **Fixed before published.** For failures: the vulnerability or defect must be fixed and
  verified before the entry lands here. Never publish your live attack surface.
- **Supersede, don't delete.** To retire an entry, set `status: superseded` and point
  `superseded_by` at the replacement.

## Scope of entry types

- `failures/` — something that actually went wrong (or verifiably almost did), with the
  conditions to reproduce/recognize it and the correct pattern.
- `design/` — a decision plus the *why*, including which alternatives were rejected and why.
- `code/` — a reusable part. Include the essential snippet and a pointer to a canonical
  public implementation if one exists. Entries whose only content is "use library X" belong
  in `design/`, not `code/`.

## Cross-references

`[[failure-0002]]` refers to an entry in the **same namespace**.
`[[io.other/failure-0001]]` refers across namespaces. The verifier rejects links to
nonexistent entries. Never link to anything that isn't in this repository.

## Language

English is the registry's shared language. A translation section inside an entry
(e.g. `## 日本語`) is welcome as long as the English version is complete on its own.
