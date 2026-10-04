# Codebase Time Machine

> **See how software becomes software.**

An instrument for exploring how a Git repository evolved: its files, architecture, people and
decisions, step by step through time.

**Status:** the engine, dependency analysis, the TaskFlow demo and the explorer UI are built
and tested. Postgres persistence, the HTTP API, GitHub import and the AI Historian are next.
The full design and roadmap live in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## The explorer

`npm run dev` opens the explorer on the TaskFlow demo. `npm run build:web` produces one
self-contained HTML file (about 87 KB gzipped) that works offline.

- **Seismograph timeline**: lines of code over time, births above the axis and deaths below,
  milestones along the top. Drag, click, use the keyboard, jump to a milestone or date, and
  play at 0.5×–10×, optionally milestones only.
- **Map**: folders as regions, files sized by lines, imports as arrows. Positions come from a
  layout computed once over every path that ever existed, so moving through time never
  reshuffles anything. Includes a table alternative.
- **Galaxy**: the same layout drawn as light, with brightness for churn and pulses for this
  commit's births, changes, moves and deaths.
- **Architecture**: modules inferred from directories, layered by measured imports
  (importers above what they import), morphing between points in time.
- **Compare**: what changed between any two milestones, saved snapshots or positions.
- **People**: activity per contributor up to the current point, with merges credited to the
  branch authors rather than the person who merged.
- **Inspector**: commit details with a split or unified diff, and per-file lifecycle
  (born → changed → moved → died) across renames.
- **History search**: keyword matching over commit messages and paths, labeled as such.

To explore your own repository:

```bash
npm run analyze -- path/to/repo --bundle repo.json   # then "Open bundle" in the explorer
```

## The TaskFlow demo

`npm run demo:build` generates TaskFlow as a **real Git repository**: 12 eras over 2.5 years,
six fictional contributors, feature branches, a monolith-to-services refactor and real
imports. It then runs through the same pipeline as any import. Milestones such as "Started
using ioredis" or "Restructuring: 13 files moved" are detected from the history, not
scripted. The UI labels it as demo data.

## What works today

```
$ npm run analyze -- /path/to/express

CODEBASE TIME MACHINE · express
Anchor      master @ 7ef98448f8
Span        2009-06-26 → 2026-09-28
Commits     6,430 collected · 3,903 mainline steps
Now         214 files · 26,798 lines · 395 contributors
Lifecycle   775 born · 8,066 changed · 155 moved · 561 died

Evolution
  2009-06-26  step      0       7 files         92 lines     1 people
  2010-03-18  step    780      92 files      7,860 lines    10 people
  2011-10-07  step   2341     227 files     16,761 lines    41 people
  2026-09-28  step   3902     214 files     26,798 lines   395 people

Collected in 2756 ms · temporal model in 162 ms
```

- **Collector**: one streaming `git log -z --raw --numstat` pass, parsed by a deterministic
  NUL-token state machine (filenames with tabs, newlines and split multi-byte characters are
  safe). Renames, merges (as first-parent diffs), tags, shallow clones, empty commits, symlinks,
  submodules and binary files are all handled.
- **Temporal engine**: mainline timeline, file lineages that survive renames
  (BORN / CHANGED / MOVED / DIED, with restorations), keyframed snapshots giving any point in
  history in O(files + 63 deltas), incremental per-step statistics, and date lookup that is
  robust to clock skew.
- **Hardened Git access**: repositories are untrusted input. Repo-configured programs
  (fsmonitor, pagers, textconv, external diff, hooks) are neutralised, and user-supplied refs
  can never become options. Both are covered by tests that plant a malicious script.

## Correctness

The core property, *the reconstructed repository at step t equals what Git says at step t*, is
checked directly against `git ls-tree` and real blob contents:

- in tests, at **every step** of scripted and seeded-random histories (merges, fast-forwards,
  renames with edits, deletions, restorations, binary transitions, typechanges);
- on real repositories via `npm run verify -- <repo>` (expressjs/express and pallets/flask
  match exactly).

That verification found a real-world bug during development: a 2010 Express commit made an
HTML file briefly binary, which silently froze its line count. The fix (measuring the blob
directly) is now a regression test.

## Quick start

Requires Node 20+ and Git 2.24+.

```bash
npm install
npm test                        # 40 tests, ~45 s (integration tests build real repositories)
npm run typecheck
npm run analyze -- <repo-path> [--ref <ref>] [--json out.json]
npm run verify  -- <repo-path>  # check reconstruction against git
npm run demo:build              # regenerate the TaskFlow demo bundle
npm run dev                     # explorer at http://localhost:5173
```

## Layout

| Package | Responsibility |
|---|---|
| `@ctm/model` | Normalized Repository Model and typed errors. The contract between layers. |
| `@ctm/collector` | Hardened Git runner, streaming parser, blob measurement, collection. |
| `@ctm/analysis` | Facts about content (language detection now; imports and symbols next). |
| `@ctm/temporal` | Timeline, snapshots, lifecycle events, statistics, directory aggregation. |
| `@ctm/export` | Builds the exploration bundle: patches, dependencies, milestones. |
| `@ctm/web` | The explorer (React + TypeScript, single-file build). |
| `@ctm/cli` | End-to-end command-line pipeline. |

## Known limitations

- No server yet: the explorer reads precomputed bundles. Postgres, the API and GitHub import
  are the next milestones.
- Import detection is lexical (JS/TS and Python); tree-sitter is the planned replacement.
  Architecture modules are inferred from directories.
- Milestone detection is noisy on large repositories (703 for Express); ranking is planned.
- Patches are only embedded for histories of up to 2,000 steps.
- The AI Historian is not built. Nothing in the UI pretends otherwise.
- Copy detection (`-C`) is off; copies appear as additions.
- Blobs over 4 MiB whose line delta Git cannot report keep an unknown line count.
