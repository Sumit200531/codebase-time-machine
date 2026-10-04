/**
 * The exploration bundle: everything the explorer UI needs for one repository,
 * produced by the real pipeline. Type-only module so the browser can import it.
 */
import type { ChangeStatus } from "@ctm/model";
import type { CommitPatch } from "@ctm/collector";
import type { DependencyEdge, LifecycleEventKind, StatsPoint } from "@ctm/temporal";

export const BUNDLE_SCHEMA_VERSION = 1;

export interface BundleContributor {
  readonly id: number;
  readonly name: string;
  readonly email: string;
}

export interface BundleStep {
  readonly step: number;
  readonly commitId: string;
  readonly subject: string;
  readonly body: string;
  readonly authorId: number;
  readonly committedAt: string;
  readonly isMerge: boolean;
  /** Side-branch commits brought in by this step (merges only). */
  readonly sideCommitIds: readonly string[];
  readonly tags: readonly string[];
}

export interface BundleSideCommit {
  readonly id: string;
  readonly subject: string;
  readonly authorId: number;
  readonly committedAt: string;
  readonly introducedAtStep: number;
  readonly additions: number;
  readonly deletions: number;
  readonly paths: readonly string[];
}

export interface BundleStats extends StatsPoint {
  readonly internalDependencies: number;
  readonly externalPackages: number;
}

export interface BundleEvent {
  readonly kind: LifecycleEventKind;
  readonly step: number;
  readonly lineage: number;
  readonly path: string;
  readonly previousPath?: string;
  readonly restored?: boolean;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly locAfter: number | null;
}

export interface BundleChange {
  readonly status: ChangeStatus;
  readonly path: string;
  readonly previousPath?: string;
  readonly additions: number | null;
  readonly deletions: number | null;
}

export interface BundleCommitDetail {
  readonly changes: readonly BundleChange[];
  readonly patch: CommitPatch | null;
}

export type MilestoneKind = "tag" | "structure" | "dependency" | "refactor" | "merge";

export interface Milestone {
  readonly step: number;
  readonly kind: MilestoneKind;
  readonly title: string;
  readonly detail: string;
}

export interface Bundle {
  readonly schemaVersion: typeof BUNDLE_SCHEMA_VERSION;
  readonly meta: {
    readonly label: string;
    /** Set for synthetic demo repositories; the UI must display it. */
    readonly demoNotice: string | null;
    readonly anchorRef: string | null;
    readonly anchorCommit: string;
    readonly isShallow: boolean;
    readonly generatedAt: string;
    readonly importAnalysis: "lexical";
  };
  readonly contributors: readonly BundleContributor[];
  readonly steps: readonly BundleStep[];
  readonly sideCommits: readonly BundleSideCommit[];
  readonly stats: readonly BundleStats[];
  readonly events: readonly BundleEvent[];
  readonly dependencies: readonly DependencyEdge[];
  readonly commits: Readonly<Record<string, BundleCommitDetail>>;
  readonly milestones: readonly Milestone[];
  readonly branches: readonly { readonly name: string; readonly kind: string; readonly target: string }[];
}
