# Codebase Time Machine — Architecture

Status: Milestones 1, 4 and 5 complete, plus parts of 2, 6, 7 and 8 (see §13). The explorer
currently runs on precomputed bundles; everything marked **planned** is design, not code. Sections are numbered to match the original brief's
"first action" list.

---

## 1. Current project structure

The project started from an empty repository. Milestone 1 established:

```
packages/
  model/       Normalized Repository Model: types + typed errors. Depends on nothing.
  collector/   Hardened Git runner, streaming log parser, collection orchestration.
  analysis/    Static facts about content (M1: language detection; M2: imports, symbols).
  temporal/    Mainline timeline, keyframed snapshots, lifecycle events, statistics.
  cli/         `npm run analyze -- <repo>`: the whole pipeline end to end.
test-support/  Deterministic fixture-repository builder + Git ground-truth helpers.
docs/          This document.
```

Dependency direction is strictly `model ← collector`, `model ← analysis ← temporal ← cli`.
Nothing imports "upwards". That is the separation the brief asks for (collection / analysis /
visualization / AI) enforced by package boundaries rather than by convention.

## 2. Recommended architecture

```
                 ┌──────────────┐   untrusted input boundary
 repo URL ──────►│ Fetch worker │  git clone --filter=blob:none --no-checkout, sandboxed
                 └──────┬───────┘
                        ▼
                 ┌──────────────┐
                 │  Collector   │  git log -z --raw --numstat  →  Normalized Repository Model
                 └──────┬───────┘
                        ▼
                 ┌──────────────┐  per blob, content-addressed: language, LOC, imports, symbols
                 │  Analysis    │  (tree-sitter WASM, no code execution)
                 └──────┬───────┘
                        ▼
                 ┌──────────────┐  mainline steps, interval-encoded file/edge/architecture state,
                 │  Temporal    │  lifecycle events, precomputed stats per step
                 └──────┬───────┘
                        ▼
                  PostgreSQL  ◄──────────────┐
                        ▲                    │ tools over the model (never raw repo text scraping)
                        │                    │
                 ┌──────┴───────┐     ┌──────┴───────┐
                 │   REST API   │     │ AI Historian │
                 └──────┬───────┘     └──────────────┘
                        ▼
              React client (timeline, engineering graph, galaxy, diff, compare)
```

Two deployable processes: an **API** (stateless, horizontally scalable) and an **analysis
worker** (CPU heavy, sandboxed, the only process that ever touches repository bytes).

## 3. Technology choices

| Concern | Choice | Why (and what was rejected) |
|---|---|---|
| Git access | Git CLI via a hardened runner | Fastest and most correct (pack files, rename detection, SHA-256 repos). Rejected nodegit (native build fragility) and isomorphic-git (slow on large histories, weaker rename detection). |
| Language | TypeScript end to end, strict + `exactOptionalPropertyTypes` | One type system across collector, API contract and UI. |
| Backend | Node 22 + Fastify | JSON-schema validation built in, low overhead. |
| API style | REST | Resources are naturally addressable (`/steps/:n/snapshot`) and HTTP-cacheable because history is immutable. GraphQL's flexibility buys little here. |
| Database | PostgreSQL | Range types + GiST indexes make "state at step t" a single indexed query (see §6). |
| Jobs | pg-boss (Postgres-backed queue) | Avoids running Redis just for a queue. Redis is added later only if caching measurably needs it. |
| Static analysis | web-tree-sitter (WASM) | Many grammars, parses without executing anything, runs in the worker sandbox. |
| Frontend | React + Vite + TanStack Router + TanStack Query, Zustand for the timeline cursor | Server state and UI state kept separate. The cursor is the one piece of hot shared state. |
| Code / diff | CodeMirror 6 + `@codemirror/merge` | Split and unified diffs out of the box at a fraction of Monaco's bundle size. Read-only use doesn't need Monaco's IDE features. |
| Engineering graph | ELK.js layered layout → React SVG | Architecture graphs are tens of nodes; deterministic layered layout reads like a diagram. Force layouts don't. |
| Galaxy | WebGL (regl) instanced points, layout in a Web Worker | Thousands of animated stars at 60 fps. |
| Charts | d3-scale/d3-shape rendered by React | Precise control and small bundle; no chart-library styling to fight. |

## 4. Database schema (planned for M2)

Core idea: **state is stored as intervals over mainline steps**, not as per-commit copies.
A file version that exists from step 120 until step 480 is one row with `steps = [120,480)`.

```sql
CREATE TABLE repositories (
  id            uuid PRIMARY KEY,
  label         text NOT NULL,
  source_url    text,                       -- validated https URL; never a local path from users
  anchor_ref    text, head_commit text,
  is_shallow    boolean NOT NULL,
  is_demo       boolean NOT NULL DEFAULT false,
  status        text NOT NULL,              -- queued | collecting | analyzing | ready | failed
  error_code    text, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commits (
  repository_id uuid REFERENCES repositories ON DELETE CASCADE,
  id            text,                       -- object id
  mainline_step int,                        -- null for side-branch commits
  introduced_at_step int NOT NULL,          -- step at which it became reachable
  author_id     bigint NOT NULL REFERENCES contributors,
  authored_at   timestamptz NOT NULL, committed_at timestamptz NOT NULL,
  subject text NOT NULL, body text NOT NULL,
  search        tsvector GENERATED ALWAYS AS (to_tsvector('english', subject || ' ' || body)) STORED,
  PRIMARY KEY (repository_id, id)
);
CREATE INDEX ON commits (repository_id, mainline_step);
CREATE INDEX ON commits USING gin (search);

CREATE TABLE commit_parents (repository_id uuid, commit_id text, parent_id text, ordinal smallint,
                             PRIMARY KEY (repository_id, commit_id, ordinal));
CREATE TABLE contributors (id bigserial PRIMARY KEY, repository_id uuid, name text, email_key text,
                           UNIQUE (repository_id, email_key));
CREATE TABLE refs (repository_id uuid, name text, kind text, target text, PRIMARY KEY (repository_id, kind, name));

CREATE TABLE file_lineages (repository_id uuid, id int, born_step int, died_step int,
                            restored boolean NOT NULL, PRIMARY KEY (repository_id, id));

CREATE TABLE file_versions (                 -- one row per (lineage, path, blob) interval
  repository_id uuid, lineage_id int, path text, blob_id text, kind text,
  loc int, steps int4range NOT NULL
);
CREATE INDEX ON file_versions USING gist (repository_id, steps);   -- "files at step t"
CREATE INDEX ON file_versions (repository_id, lineage_id);

CREATE TABLE file_changes (repository_id uuid, commit_id text, status text, path text,
                           previous_path text, lineage_id int, additions int, deletions int);

CREATE TABLE blob_analysis (                 -- content-addressed: shared across repos and commits
  blob_id text PRIMARY KEY, analyzer_version int NOT NULL,
  language text, loc int, is_binary boolean,
  imports jsonb, exports jsonb, symbols jsonb
);

CREATE TABLE dependency_edges (repository_id uuid, from_lineage int, to_lineage int,
                               kind text, steps int4range NOT NULL);       -- import/call/inherit
CREATE INDEX ON dependency_edges USING gist (repository_id, steps);

CREATE TABLE architecture_nodes (repository_id uuid, id text, label text, layer text,
                                 member_globs text[], steps int4range, inferred boolean NOT NULL DEFAULT true);
CREATE TABLE architecture_edges (repository_id uuid, from_node text, to_node text, weight int, steps int4range);

CREATE TABLE timeline_events (repository_id uuid, step int, kind text,   -- born|changed|moved|died|milestone
                              lineage_id int, path text, previous_path text, payload jsonb);
CREATE INDEX ON timeline_events (repository_id, step);

CREATE TABLE step_stats (repository_id uuid, step int, files int, loc int, languages jsonb,
                         commits_reachable int, contributors_reachable int, PRIMARY KEY (repository_id, step));

CREATE TABLE snapshots (id uuid PRIMARY KEY, repository_id uuid, step int, name text, created_at timestamptz);
CREATE TABLE ai_queries (id uuid PRIMARY KEY, repository_id uuid, question text, answer text,
                         cited_commits text[], cited_paths text[], tool_calls jsonb,
                         model text, grounded boolean, latency_ms int, created_at timestamptz);
```

`state at step t` = `WHERE repository_id = $1 AND steps @> $2`, served by the GiST index.
`what changed between a and b` = rows whose interval contains exactly one of `a`, `b`.

## 5. Repository analysis pipeline

1. **Fetch** (worker, planned M3): `git clone --bare --filter=blob:none` into an ephemeral
   directory. Blobless clones fetch blobs lazily, so history collection never downloads content.
2. **Preflight** (built): repository check, anchor resolution, `rev-list --count` against
   `maxCommits` *before* reading history, shallow detection.
3. **Collect** (built): one streaming `git log -z --raw --numstat -M -l0 --topo-order --reverse
   --diff-merges=first-parent`. Parsed by a NUL-token state machine: each raw entry declares its
   path count, numstat entries pair 1:1 with raw entries, and the parser verifies they match.
   Filenames with tabs, newlines or multi-byte characters split across chunks are handled.
   **Blob measurement** (built): where numstat reports binary (`-`), that blob is measured directly
   via a streaming, size-capped `cat-file --batch`. Without this, a file that was briefly binary
   loses its line count forever. This happened for real in expressjs/express, where a 2010
   commit put NUL bytes into `docs/api.html`, and it is now a regression test.
4. **Analyze** (planned M2): for each *distinct blob id* touched in mainline history, run
   tree-sitter extraction once and cache by blob id. Analysis is incremental by construction:
   re-importing a repository only analyzes blobs never seen before.
5. **Temporalize** (built in memory, persisted in M2): see §6.
6. **Persist**: bulk `COPY` into the interval tables, then flip repository status to `ready`.

## 6. Temporal data model

- **Mainline = the first-parent chain of the anchor.** Each mainline commit is a *step*. A merge
  is one step that brings in a whole branch; its side-branch commits are recorded as
  `introducedCommitIds` of that step. This matches how engineers reason about "main on date X".
- **Lineage** = stable file identity across renames. Born on add, kept through renames,
  ended on delete. Re-adding a deleted path starts a new lineage flagged `restored`. This powers
  the BORN / CHANGED / MOVED / DIED lifecycle.
- **Snapshots** = full keyframe every 64 steps plus per-step delta operations. Any step is
  materialised in O(files + 63 deltas). In Postgres the same role is played by intervals.
- **Statistics** are maintained incrementally during the single build pass, so scrubbing the
  timeline never recomputes anything.
- **Date lookup** uses the running maximum of commit time, so clock skew and rebased history
  can't break binary search.

Verified against Git itself (`npm run verify -- <repo>`): on expressjs/express (6,430 commits,
2009–2026; 45 steps checked, one every 100) and pallets/flask (5,598 commits), reconstructed
file sets, every file's line count and reachable-commit counts match Git exactly, including both
sides of keyframe boundaries. The test suite runs the same check at *every* step of scripted and
randomized (seeded) histories with merges, fast-forwards, renames and binary transitions.

## 7. API design (planned M3)

```
POST /api/repositories                 { url, ref? }  → 202 { id }   (enqueue import)
GET  /api/repositories/:id             status, progress, error code, summary
GET  /api/repositories/:id/events      SSE progress stream during analysis
GET  /api/repositories/:id/steps?from&to&limit         paginated mainline steps
GET  /api/repositories/:id/stats?from&to&resolution    downsampled series for charts
GET  /api/repositories/:id/steps/:step/tree?path=      directory level, lazily expanded
GET  /api/repositories/:id/steps/:step/graph?level=module|file&root=
GET  /api/repositories/:id/commits/:sha                metadata + changes + impact
GET  /api/repositories/:id/commits/:sha/diff?path=     one file's patch, on demand
GET  /api/repositories/:id/lineages/:lineage           file lifecycle
GET  /api/repositories/:id/compare?from=:step&to=:step what changed
GET  /api/repositories/:id/architecture?step=          inferred architecture at a step
GET  /api/repositories/:id/search?q=                   history search
POST /api/repositories/:id/snapshots                   { step, name }
POST /api/repositories/:id/historian                   { question } → streamed, cited answer
```

History is immutable, so every step- or commit-addressed response is served with
`Cache-Control: immutable` and an ETag of `repository@headCommit`.

## 8. Frontend architecture (planned M4+)

- Routes: `/` landing · `/r/:id` explorer · `/r/:id/compare` · `/r/:id/commit/:sha` · `/about`.
- **Timeline cursor** (current step, playback state, speed) is the single source of truth in a
  small Zustand store; every panel subscribes and derives its view from it. This creates the
  causal chain the brief wants: timeline → file highlight → graph → stats → architecture.
- Server data comes through TanStack Query, keyed by `(repo, step)`, with prefetching of the next
  N steps during playback so animation never waits on the network.
- Commit lists and file trees are virtualized. Trees expand lazily per directory level.
- Every visualization has a table/list alternative (also the screen-reader path), and motion
  is disabled under `prefers-reduced-motion`.

## 9. Visualization strategy

- **Layout stability is the core problem.** Re-running a force layout per step makes nodes
  jump, and the user loses track of what changed. Instead, positions are computed once over the
  **union of every lineage that ever existed** (hierarchical packing by directory), and each step
  only toggles visibility and intensity. Things then appear, move and disappear in place, so
  motion carries meaning.
- **Engineering view**: module-level graph (directories aggregated by dependency edges), ELK
  layered layout, SVG; drill-down to files.
- **Galaxy view**: same stable positions, WebGL; brightness = churn, colour = filter
  (language/contributor), pulses = lifecycle events of the current step.
- Semantic colour: green born/added, red died/deleted, blue changed, purple architecture,
  orange branch/merge, always paired with shape or label so colour isn't the only signal.

## 10. AI architecture (planned M9)

- The Historian never sees the raw repository. It gets **tools over the normalized model**:
  `searchCommits`, `getCommit`, `getLineageHistory`, `compareSteps`, `getArchitectureAt`,
  `getContributorSummary`.
- Every factual claim must cite commit ids or paths. The server **validates every citation**
  against the database before streaming the answer. Unknown ids are stripped and the answer is
  flagged ungrounded.
- "Why" questions get an explicit policy: commit messages and PR text are the only evidence of
  intent. If they are silent, the answer says the history doesn't record why, rather than
  speculating.
- Commit text from imported repos is untrusted. It goes in as quoted data inside tool results,
  never as instructions, which mitigates prompt injection planted in commit messages.
- If the AI is unavailable, the explorer degrades gracefully: search falls back to Postgres
  full-text search plus structured filters.

## 11. Security risks

| Risk | Mitigation |
|---|---|
| Repo config executes programs (fsmonitor, pager, textconv, external diff, hooks) | Overridden on every Git call, plus `--no-textconv --no-ext-diff`. **Tested**: unhardened `git log -p` and `git status` execute a planted script; hardened calls don't. |
| Option injection via refs | Ref allow-list regex + `--end-of-options`. **Tested** with `--output=...` refs. |
| SSRF / local file reads via "repository URL" | Only `https://` URLs to an allow-listed host (github.com initially); never `file://`, `ssh`, or user-supplied local paths over the API. |
| Resource exhaustion (huge repo, zip-bomb-like history) | Pre-read commit limit, process timeouts, output caps, blobless clones, per-job CPU/memory/disk limits in the worker container. |
| Token leakage | GitHub App user tokens are stored server-side only (encrypted), never sent to the client. Clones use short-lived installation tokens. |
| Prompt injection via commit messages | See §10. |
| XSS via filenames/messages | Rendered as text only, never `innerHTML`; diff highlighting tokenizes rather than injecting HTML. |

## 12. Performance risks

- **Rename detection on huge refactors** (`-l0` is quadratic in the worst case). It runs off the
  request path in the worker; if a commit exceeds a pair budget, fall back to the default limit
  and record that renames may be under-detected.
- **Memory for very long histories**: the collector already streams, but the M1 CLI holds all
  commits in memory. M2 streams commits straight into `COPY` batches.
- **Analysis cost**: bounded by distinct blobs, not commits × files, thanks to blob-id caching.
- **Client rendering**: never send more than one directory level or one graph level per request.
  Galaxy point counts are capped with level-of-detail aggregation.
- **Measured baseline (M1)**: express (6,430 commits) collected in ~2.8 s and temporalized in
  ~0.16 s; flask (5,598 commits) in ~3.3 s and ~0.14 s, on a small cloud sandbox. M11 adds benchmarks on much larger repositories.

## 13. Milestone plan

| # | Milestone | Status |
|---|---|---|
| 1 | Foundation: model, hardened collector, temporal engine | ✅ Done, verified against Git |
| 2 | Analysis + persistence | 🟡 Lexical imports, dependency intervals and churn done; tree-sitter, Postgres and worker to do |
| 3 | API + URL import | ⬜ To do. Local import works today via `--bundle` |
| 4 | TaskFlow demo as real Git history | ✅ Done |
| 5 | Explorer shell: timeline, stats, tree, commit panel, diff | ✅ Done |
| 6 | Engineering graph + lifecycle | ✅ Done (map, table alternative, born/changed/moved/died, file lifecycle) |
| 7 | Architecture evolution + compare + snapshots | ✅ Done (inferred, labeled) |
| 8 | Galaxy | 🟡 Canvas 2D on the shared stable layout; WebGL for very large repos to do |
| 9 | AI Historian | ⬜ To do (tool-using, citation-validated) |
| 10 | GitHub App + branch/merge graph | ⬜ To do |
| 11 | Performance | 🟡 Explorer handles Express (3,903 steps) in ~100 ms; large-repo benchmarks to do |
| 12 | Testing | 🟡 40 tests including a full-UI smoke test; Playwright e2e to do |
| 13 | Deployment + landing page + screenshots | ⬜ To do |

The explorer was pulled ahead of persistence and the API so that a complete product exists
early. Because the bundle is produced by the real pipeline, nothing in it is mocked: the server
milestones change where the data lives, not what it is.

Rationale for reordering vs. the brief: the demo repository moves ahead of the UI because it
*is* the UI's development fixture. Building it as real Git history means the demo exercises the
same code path as a real import, which satisfies "do not fake technical functionality".
