import type { Language } from "@ctm/analysis";
import type { EntryKind, ObjectId, Person } from "@ctm/model";

/** Index into the mainline timeline. Step 0 is the oldest mainline commit. */
export type Step = number;

/**
 * Stable identity of a file across renames. A lineage is born when a path is
 * added and dies when it is deleted; renames keep the lineage. Re-adding a
 * deleted path starts a new lineage (flagged `restored`).
 */
export type LineageId = number;

export interface FileState {
  readonly path: string;
  readonly lineage: LineageId;
  readonly kind: EntryKind;
  readonly blobId: ObjectId | null;
  /**
   * Line count derived from numstat deltas. null for entries where lines are
   * not meaningful (symlinks, submodules) or not known (binary content).
   */
  readonly loc: number | null;
  readonly bornAtStep: Step;
  readonly lastChangedAtStep: Step;
  /** Number of mainline steps that touched this lineage after its birth. */
  readonly changeCount: number;
}

export type LifecycleEventKind = "born" | "changed" | "moved" | "died";

export interface LifecycleEvent {
  readonly kind: LifecycleEventKind;
  readonly step: Step;
  readonly commitId: ObjectId;
  readonly lineage: LineageId;
  readonly path: string;
  /** Set for "moved" events. */
  readonly previousPath?: string;
  /** Set on "born" events when the path previously existed and was deleted. */
  readonly restored?: boolean;
  readonly additions: number | null;
  readonly deletions: number | null;
  /** The lineage's line count after this event (null for "died" and unknown counts). */
  readonly locAfter: number | null;
}

export interface TimelineStepInfo {
  readonly step: Step;
  readonly commitId: ObjectId;
  readonly subject: string;
  readonly author: Person;
  readonly authoredAt: string;
  readonly committedAt: string;
  readonly isMerge: boolean;
  /**
   * Commits that became reachable at this step: the mainline commit itself,
   * plus every side-branch commit a merge brought in.
   */
  readonly introducedCommitIds: readonly ObjectId[];
  /** True for root commits of a shallow clone, where earlier history is unknown. */
  readonly isShallowBoundary: boolean;
}

export interface LanguageStats {
  readonly files: number;
  readonly loc: number;
}

export interface StatsPoint {
  readonly step: Step;
  readonly files: number;
  readonly loc: number;
  /** Text-like files whose LOC is unknown (binary content). Excluded from `loc`. */
  readonly filesWithUnknownLoc: number;
  readonly languages: Readonly<Record<Language, LanguageStats>>;
  readonly commitsReachable: number;
  readonly contributorsReachable: number;
}
