/**
 * The Normalized Repository Model.
 *
 * This is the single contract between data collection and everything downstream
 * (analysis, temporal reconstruction, API, AI). It deliberately contains only
 * facts Git itself asserts — no inferred architecture, no derived statistics.
 * Derived data lives in the analysis/temporal layers so it can be recomputed
 * when heuristics improve without re-reading Git.
 */

export const MODEL_SCHEMA_VERSION = 1;

/** Full object id: 40 hex chars (SHA-1) or 64 hex chars (SHA-256 repositories). */
export type ObjectId = string;

export interface Person {
  readonly name: string;
  readonly email: string;
}

/**
 * How a single path changed in a commit, relative to the commit's first parent
 * (or the empty tree for root commits).
 */
export type ChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "typechanged";

/** Git tree entry kinds we distinguish. Derived from the file mode. */
export type EntryKind = "file" | "executable" | "symlink" | "submodule";

export interface FileChange {
  readonly status: ChangeStatus;
  /** Path after the change. For deletions, the path that was removed. */
  readonly path: string;
  /** Only present for renames. */
  readonly previousPath?: string;
  /** Git's rename similarity index (0-100). Only present for renames. */
  readonly similarity?: number;
  /** Entry kind after the change (before the change, for deletions). */
  readonly kind: EntryKind;
  /** Blob id after the change; null for deletions. Used for content-addressed analysis caching. */
  readonly blobId: ObjectId | null;
  /** Lines added/deleted. null when Git reports the content as binary. */
  readonly additions: number | null;
  readonly deletions: number | null;
  /**
   * Measured line count of `blobId`. Present only when Git could not report a
   * line delta (binary content on either side of the change), so line totals
   * can recover after a file stops being binary. null when the blob is itself
   * binary or too large to measure.
   */
  readonly lineCount?: number | null;
}

export interface Commit {
  readonly id: ObjectId;
  /** Parent ids in Git order. parents[0] is the first parent (the "mainline" side of a merge). */
  readonly parents: readonly ObjectId[];
  readonly author: Person;
  /** ISO-8601 with the author's original offset preserved. */
  readonly authoredAt: string;
  readonly committedAt: string;
  readonly subject: string;
  readonly body: string;
  /**
   * Changes relative to the first parent. For merge commits this is exactly the
   * set of changes the merge brought into the first-parent line.
   */
  readonly changes: readonly FileChange[];
}

export type RefKind = "branch" | "remote-branch" | "tag";

export interface RefInfo {
  /** Short name, e.g. "main", "origin/main", "v1.2.0". */
  readonly name: string;
  readonly kind: RefKind;
  /** The commit the ref points to (annotated tags are peeled). */
  readonly target: ObjectId;
}

export interface RepositorySource {
  readonly kind: "local-path";
  /** Human-readable label only. Never used to locate the repository again. */
  readonly label: string;
}

export interface RepositoryModel {
  readonly schemaVersion: typeof MODEL_SCHEMA_VERSION;
  readonly source: RepositorySource;
  /** Commit the default timeline is built from (HEAD unless another ref was requested). */
  readonly headCommit: ObjectId;
  readonly headRefName: string | null;
  /**
   * True when the repository is a shallow clone. History before the shallow
   * boundary is unknown; boundary commits appear as root commits.
   */
  readonly isShallow: boolean;
  /** Every collected commit, parents always before children (topological order). */
  readonly commits: readonly Commit[];
  readonly refs: readonly RefInfo[];
}
