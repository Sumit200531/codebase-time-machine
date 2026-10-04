import { basename } from "node:path";
import {
  CtmError,
  MODEL_SCHEMA_VERSION,
  type Commit,
  type FileChange,
  type ObjectId,
  type RefInfo,
  type RefKind,
  type RepositoryModel,
} from "@ctm/model";
import { revisionArgs, runGit, streamGit } from "./git.ts";
import { LOG_FORMAT, parseGitLog } from "./parse-log.ts";
import { measureBlobs } from "./blobs.ts";

export interface CollectOptions {
  /** Revision the timeline is anchored to. Defaults to HEAD. */
  readonly ref?: string;
  /** Refuse repositories with more reachable commits than this. */
  readonly maxCommits?: number;
  readonly timeoutMs?: number;
  /** Display label stored on the model. Defaults to the directory name. */
  readonly label?: string;
}

export const DEFAULT_MAX_COMMITS = 200_000;

/**
 * Pseudo-revisions selecting what history we collect: every local branch,
 * remote-tracking branch and tag, plus the anchor ref. Deliberately not
 * `--all`, which would also pull in stashes and notes.
 */
const HISTORY_SELECTORS = ["--branches", "--remotes", "--tags"] as const;

/** Conservative ref syntax check, applied before Git ever sees the string. */
const SAFE_REF = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/@{}~^-]{1,255}$/;

async function gitText(cwd: string, args: readonly string[], allowedExitCodes?: readonly number[]) {
  const result = await runGit(args, { cwd, ...(allowedExitCodes ? { allowedExitCodes } : {}) });
  return { text: result.stdout.toString("utf8").trim(), exitCode: result.exitCode };
}

async function assertRepository(cwd: string): Promise<void> {
  try {
    const { text } = await gitText(cwd, ["rev-parse", "--is-inside-work-tree", "--is-bare-repository"]);
    if (!text.includes("true")) throw new Error("not a repository");
  } catch (error) {
    if (error instanceof CtmError && error.code !== "GIT_COMMAND_FAILED") throw error;
    throw new CtmError("NOT_A_REPOSITORY", "The path is not a Git repository.");
  }
}

async function resolveAnchor(cwd: string, ref: string): Promise<{ id: ObjectId; name: string | null }> {
  if (!SAFE_REF.test(ref)) {
    throw new CtmError("INVALID_REF", "The requested ref contains characters that are not allowed.", { ref });
  }
  const resolved = await gitText(
    cwd,
    ["rev-parse", "--verify", "--quiet", ...revisionArgs([`${ref}^{commit}`])],
    [0, 1],
  );
  if (resolved.exitCode !== 0) {
    if (ref === "HEAD") {
      throw new CtmError("EMPTY_REPOSITORY", "The repository has no commits yet.");
    }
    throw new CtmError("INVALID_REF", `Ref "${ref}" does not resolve to a commit.`, { ref });
  }
  // --verify is required: without it rev-parse echoes `--end-of-options` to stdout.
  // Output is "HEAD" when detached and empty for non-ref expressions like HEAD~1.
  const symbolic = await gitText(cwd, ["rev-parse", "--verify", "--quiet", "--abbrev-ref", ...revisionArgs([ref])], [0, 1]);
  const name = symbolic.exitCode === 0 && symbolic.text !== "" && symbolic.text !== "HEAD" ? symbolic.text : null;
  return { id: resolved.text, name };
}

async function listRefs(cwd: string): Promise<RefInfo[]> {
  // %(*objectname) is the peeled target for annotated tags, empty otherwise.
  const { text } = await gitText(cwd, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)",
    "refs/heads",
    "refs/remotes",
    "refs/tags",
  ]);
  const refs: RefInfo[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const [fullName = "", objectId = "", peeledId = "", type = "", peeledType = ""] = line.split("\0");
    const kind: RefKind | null = fullName.startsWith("refs/heads/")
      ? "branch"
      : fullName.startsWith("refs/remotes/")
        ? "remote-branch"
        : fullName.startsWith("refs/tags/")
          ? "tag"
          : null;
    const targetType = peeledId ? peeledType : type;
    // Skip symbolic remote HEADs and tags of non-commit objects.
    if (kind === null || targetType !== "commit" || fullName.endsWith("/HEAD")) continue;
    refs.push({
      name: fullName.replace(/^refs\/(heads|remotes|tags)\//, ""),
      kind,
      target: peeledId || objectId,
    });
  }
  return refs;
}

async function countCommits(cwd: string, anchor: ObjectId): Promise<number> {
  const { text } = await gitText(cwd, ["rev-list", "--count", ...HISTORY_SELECTORS, ...revisionArgs([anchor])]);
  return Number(text);
}

/** Stream commits, parents before children. Exposed for incremental pipelines. */
export function streamCommits(
  cwd: string,
  anchor: ObjectId,
  options: Pick<CollectOptions, "timeoutMs"> = {},
): AsyncGenerator<Commit> {
  const args = [
    "log",
    "-z",
    "--raw",
    "--numstat",
    "-M",
    "--no-abbrev",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    // Lift the rename-detection pair limit so large refactors are still
    // recognised as renames instead of add+delete pairs. Trades CPU for
    // correctness; the analysis worker runs this off the request path.
    "-l0",
    "--topo-order",
    "--reverse",
    "--diff-merges=first-parent",
    `--format=${LOG_FORMAT}`,
    ...HISTORY_SELECTORS,
    ...revisionArgs([anchor]),
  ];
  return parseGitLog(streamGit(args, { cwd, timeoutMs: options.timeoutMs ?? 600_000 }));
}

/**
 * Collect the full normalized model of a local repository.
 *
 * The repository is only read. Nothing from it is executed.
 */
export async function collectRepository(path: string, options: CollectOptions = {}): Promise<RepositoryModel> {
  await assertRepository(path);
  const anchor = await resolveAnchor(path, options.ref ?? "HEAD");

  const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS;
  const total = await countCommits(path, anchor.id);
  if (total > maxCommits) {
    throw new CtmError(
      "REPOSITORY_TOO_LARGE",
      `Repository has ${total} commits; the configured limit is ${maxCommits}.`,
      { total, maxCommits },
    );
  }

  const [shallow, refs] = await Promise.all([
    gitText(path, ["rev-parse", "--is-shallow-repository"]),
    listRefs(path),
  ]);

  const commits: Commit[] = [];
  for await (const commit of streamCommits(path, anchor.id, options)) {
    commits.push(commit);
  }
  if (commits.length !== total) {
    throw new CtmError("INCONSISTENT_HISTORY", "Parsed commit count differs from rev-list count.", {
      parsed: commits.length,
      expected: total,
    });
  }

  const measured = await withMeasuredLineCounts(path, commits, options);

  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    source: { kind: "local-path", label: options.label ?? basename(path) },
    headCommit: anchor.id,
    headRefName: anchor.name,
    isShallow: shallow.text === "true",
    commits: measured,
    refs,
  };
}

function needsMeasurement(change: FileChange): boolean {
  return (
    change.additions === null &&
    change.blobId !== null &&
    (change.kind === "file" || change.kind === "executable")
  );
}

/** Attach `lineCount` to every change whose line delta Git reported as binary. */
async function withMeasuredLineCounts(
  cwd: string,
  commits: readonly Commit[],
  options: Pick<CollectOptions, "timeoutMs">,
): Promise<Commit[]> {
  const wanted = new Set<ObjectId>();
  for (const commit of commits) {
    for (const change of commit.changes) if (needsMeasurement(change)) wanted.add(change.blobId!);
  }
  if (wanted.size === 0) return [...commits];
  const counts = await measureBlobs(cwd, wanted, options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {});
  return commits.map((commit) =>
    commit.changes.some(needsMeasurement)
      ? {
          ...commit,
          changes: commit.changes.map((change) =>
            needsMeasurement(change) ? { ...change, lineCount: counts.get(change.blobId!) ?? null } : change,
          ),
        }
      : commit,
  );
}
