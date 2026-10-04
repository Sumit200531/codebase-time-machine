import { languageOf, type Language } from "@ctm/analysis";
import {
  CtmError,
  type Commit,
  type EntryKind,
  type FileChange,
  type ObjectId,
  type RepositoryModel,
} from "@ctm/model";
import type {
  FileState,
  LanguageStats,
  LifecycleEvent,
  LineageId,
  StatsPoint,
  Step,
  TimelineStepInfo,
} from "./types.ts";

/**
 * A full copy of the file map is stored every KEYFRAME_INTERVAL steps; any
 * other step is reconstructed by replaying at most KEYFRAME_INTERVAL - 1
 * deltas. Memory is O(steps / interval × files) instead of O(steps × files).
 */
export const KEYFRAME_INTERVAL = 64;

type Operation =
  | { readonly op: "set"; readonly state: FileState }
  | { readonly op: "delete"; readonly path: string };

function countsLines(kind: EntryKind): boolean {
  return kind === "file" || kind === "executable";
}

function contributorKey(commit: Commit): string {
  const email = commit.author.email.trim().toLowerCase();
  return email !== "" ? email : `name:${commit.author.name.trim()}`;
}

function inconsistent(message: string, details: Record<string, unknown>): never {
  throw new CtmError("INCONSISTENT_HISTORY", message, details);
}

/** Mutable language totals, kept incrementally and frozen once per step. */
class LanguageAccumulator {
  private readonly totals = new Map<Language, { files: number; loc: number }>();

  add(state: FileState, sign: 1 | -1): void {
    const language = languageOf(state.path);
    const entry = this.totals.get(language) ?? { files: 0, loc: 0 };
    entry.files += sign;
    entry.loc += sign * (state.loc ?? 0);
    if (entry.files === 0) this.totals.delete(language);
    else this.totals.set(language, entry);
  }

  freeze(): Record<Language, LanguageStats> {
    const result: Record<Language, LanguageStats> = {};
    for (const [language, { files, loc }] of this.totals) result[language] = { files, loc };
    return result;
  }
}

/**
 * The temporal model of a repository along its mainline (the first-parent
 * chain of the anchor commit). Built in a single O(total changes) pass.
 */
export class Timeline {
  readonly steps: readonly TimelineStepInfo[];
  readonly stats: readonly StatsPoint[];
  readonly events: readonly LifecycleEvent[];

  private readonly keyframes: ReadonlyMap<Step, ReadonlyMap<string, FileState>>;
  private readonly operations: readonly (readonly Operation[])[];
  private readonly eventsByLineage: ReadonlyMap<LineageId, readonly LifecycleEvent[]>;
  private readonly eventsByStep: ReadonlyMap<Step, readonly LifecycleEvent[]>;
  private readonly stepByCommit: ReadonlyMap<ObjectId, Step>;
  /** Running maximum of commit time, so date lookup is monotonic despite clock skew. */
  private readonly effectiveTimes: readonly number[];

  private constructor(init: {
    steps: TimelineStepInfo[];
    stats: StatsPoint[];
    events: LifecycleEvent[];
    keyframes: Map<Step, Map<string, FileState>>;
    operations: Operation[][];
  }) {
    this.steps = init.steps;
    this.stats = init.stats;
    this.events = init.events;
    this.keyframes = init.keyframes;
    this.operations = init.operations;

    const byLineage = new Map<LineageId, LifecycleEvent[]>();
    for (const event of init.events) {
      const list = byLineage.get(event.lineage);
      if (list) list.push(event);
      else byLineage.set(event.lineage, [event]);
    }
    this.eventsByLineage = byLineage;
    const byStep = new Map<Step, LifecycleEvent[]>();
    for (const event of init.events) {
      const list = byStep.get(event.step);
      if (list) list.push(event);
      else byStep.set(event.step, [event]);
    }
    this.eventsByStep = byStep;
    this.stepByCommit = new Map(init.steps.map((info) => [info.commitId, info.step]));

    let max = Number.NEGATIVE_INFINITY;
    this.effectiveTimes = init.steps.map((info) => (max = Math.max(max, Date.parse(info.committedAt))));
  }

  static build(model: RepositoryModel): Timeline {
    const commitsById = new Map<ObjectId, Commit>(model.commits.map((commit) => [commit.id, commit]));
    const mainline = firstParentChain(model.headCommit, commitsById);

    const tree = new Map<string, FileState>();
    const deadPaths = new Set<string>();
    const languages = new LanguageAccumulator();
    const reachable = new Set<ObjectId>();
    const contributors = new Set<string>();
    let nextLineage: LineageId = 0;
    let totalLoc = 0;
    let unknownLoc = 0;

    const steps: TimelineStepInfo[] = [];
    const stats: StatsPoint[] = [];
    const events: LifecycleEvent[] = [];
    const keyframes = new Map<Step, Map<string, FileState>>();
    const operations: Operation[][] = [];

    const insert = (state: FileState) => {
      tree.set(state.path, state);
      languages.add(state, 1);
      if (state.loc !== null) totalLoc += state.loc;
      else if (countsLines(state.kind)) unknownLoc += 1;
    };
    const remove = (state: FileState) => {
      tree.delete(state.path);
      languages.add(state, -1);
      if (state.loc !== null) totalLoc -= state.loc;
      else if (countsLines(state.kind)) unknownLoc -= 1;
    };

    mainline.forEach((commit, step) => {
      const introduced = collectIntroduced(commit, commitsById, reachable);
      for (const id of introduced) contributors.add(contributorKey(commitsById.get(id)!));

      const stepOps: Operation[] = [];
      for (const change of commit.changes) {
        const event = applyChange(change, step, commit.id);
        if (event) events.push(event);
      }
      operations.push(stepOps);

      steps.push({
        step,
        commitId: commit.id,
        subject: commit.subject,
        author: commit.author,
        authoredAt: commit.authoredAt,
        committedAt: commit.committedAt,
        isMerge: commit.parents.length > 1,
        introducedCommitIds: introduced,
        isShallowBoundary: model.isShallow && commit.parents.length === 0 && step === 0,
      });
      stats.push({
        step,
        files: tree.size,
        loc: totalLoc,
        filesWithUnknownLoc: unknownLoc,
        languages: languages.freeze(),
        commitsReachable: reachable.size,
        contributorsReachable: contributors.size,
      });
      if (step % KEYFRAME_INTERVAL === 0) keyframes.set(step, new Map(tree));

      function applyChange(change: FileChange, at: Step, commitId: ObjectId): LifecycleEvent | null {
        const delta = { additions: change.additions, deletions: change.deletions };
        switch (change.status) {
          case "added": {
            if (tree.has(change.path)) inconsistent("Added path already exists", { path: change.path, commitId });
            const state: FileState = {
              path: change.path,
              lineage: nextLineage++,
              kind: change.kind,
              blobId: change.blobId,
              loc: countsLines(change.kind) ? (change.additions ?? change.lineCount ?? null) : null,
              bornAtStep: at,
              lastChangedAtStep: at,
              changeCount: 0,
            };
            insert(state);
            stepOps.push({ op: "set", state });
            const restored = deadPaths.delete(change.path);
            return { kind: "born", step: at, commitId, lineage: state.lineage, path: state.path, ...delta, locAfter: state.loc, ...(restored ? { restored } : {}) };
          }
          case "modified":
          case "typechanged": {
            const previous = tree.get(change.path) ?? inconsistent("Modified path is missing", { path: change.path, commitId });
            const state = evolve(previous, change, change.path, at);
            remove(previous);
            insert(state);
            stepOps.push({ op: "set", state });
            return { kind: "changed", step: at, commitId, lineage: state.lineage, path: state.path, ...delta, locAfter: state.loc };
          }
          case "renamed": {
            const from = change.previousPath!;
            const previous = tree.get(from) ?? inconsistent("Renamed path is missing", { path: from, commitId });
            if (tree.has(change.path)) inconsistent("Rename target already exists", { path: change.path, commitId });
            const state = evolve(previous, change, change.path, at);
            remove(previous);
            insert(state);
            deadPaths.add(from);
            deadPaths.delete(change.path);
            stepOps.push({ op: "delete", path: from }, { op: "set", state });
            return { kind: "moved", step: at, commitId, lineage: state.lineage, path: state.path, previousPath: from, ...delta, locAfter: state.loc };
          }
          case "deleted": {
            const previous = tree.get(change.path) ?? inconsistent("Deleted path is missing", { path: change.path, commitId });
            remove(previous);
            deadPaths.add(change.path);
            stepOps.push({ op: "delete", path: change.path });
            return { kind: "died", step: at, commitId, lineage: previous.lineage, path: previous.path, ...delta, locAfter: null };
          }
        }
      }
    });

    return new Timeline({ steps, stats, events, keyframes, operations });
  }

  get length(): number {
    return this.steps.length;
  }

  /** The complete file map as of `step` (inclusive). */
  snapshotAt(step: Step): ReadonlyMap<string, FileState> {
    this.assertStep(step);
    const base = step - (step % KEYFRAME_INTERVAL);
    const keyframe = this.keyframes.get(base);
    if (!keyframe) throw new Error(`Missing keyframe ${base}`); // invariant: built in Timeline.build
    if (base === step) return keyframe;
    const tree = new Map(keyframe);
    for (let s = base + 1; s <= step; s++) {
      for (const operation of this.operations[s]!) {
        if (operation.op === "set") tree.set(operation.state.path, operation.state);
        else tree.delete(operation.path);
      }
    }
    return tree;
  }

  stepOfCommit(commitId: ObjectId): Step | undefined {
    return this.stepByCommit.get(commitId);
  }

  /** Last step at or before `date`, or undefined if `date` predates the history. */
  stepAtOrBefore(date: Date): Step | undefined {
    const target = date.getTime();
    let low = 0;
    let high = this.effectiveTimes.length - 1;
    let found: Step | undefined;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      if (this.effectiveTimes[mid]! <= target) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  /** Lifecycle events of exactly one step, in commit change order. */
  eventsAt(step: Step): readonly LifecycleEvent[] {
    return this.eventsByStep.get(step) ?? [];
  }

  /** Lifecycle events in the half-open step range (fromStep, toStep]. */
  eventsBetween(fromStep: Step, toStep: Step): LifecycleEvent[] {
    return this.events.filter((event) => event.step > fromStep && event.step <= toStep);
  }

  /** Full birth-to-death history of one file lineage, across renames. */
  lineageHistory(lineage: LineageId): readonly LifecycleEvent[] {
    return this.eventsByLineage.get(lineage) ?? [];
  }

  private assertStep(step: Step): void {
    if (!Number.isInteger(step) || step < 0 || step >= this.steps.length) {
      throw new RangeError(`Step ${step} is outside the timeline (0..${this.steps.length - 1})`);
    }
  }
}

function evolve(previous: FileState, change: FileChange, path: string, step: Step): FileState {
  let loc: number | null = null;
  if (countsLines(change.kind)) {
    if (change.additions === null || change.deletions === null) {
      // Binary on either side: Git has no delta, so use the collector's direct
      // measurement of the new blob (null if that blob is itself binary).
      loc = change.lineCount ?? null;
    } else if (!countsLines(previous.kind)) {
      // e.g. symlink -> file: every line of the new content is an addition.
      loc = change.additions;
    } else if (previous.loc !== null) {
      loc = previous.loc + change.additions - change.deletions;
    }
  }
  return {
    path,
    lineage: previous.lineage,
    kind: change.kind,
    blobId: change.blobId,
    loc,
    bornAtStep: previous.bornAtStep,
    lastChangedAtStep: step,
    changeCount: previous.changeCount + 1,
  };
}

/** Walk first parents from the anchor back to the root, returned oldest first. */
function firstParentChain(anchor: ObjectId, commitsById: ReadonlyMap<ObjectId, Commit>): Commit[] {
  const chain: Commit[] = [];
  let current: ObjectId | undefined = anchor;
  while (current !== undefined) {
    const commit = commitsById.get(current);
    if (!commit) inconsistent("Mainline commit was not collected", { commitId: current });
    chain.push(commit);
    current = commit.parents[0];
  }
  return chain.reverse();
}

/**
 * Mark `commit` and everything newly reachable through its non-first parents.
 * Each commit is visited once across the whole timeline, so the total cost is
 * O(commits) rather than O(steps × commits).
 */
function collectIntroduced(
  commit: Commit,
  commitsById: ReadonlyMap<ObjectId, Commit>,
  reachable: Set<ObjectId>,
): ObjectId[] {
  const introduced: ObjectId[] = [commit.id];
  reachable.add(commit.id);
  const pending = commit.parents.slice(1);
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    const parent = commitsById.get(id);
    // Missing parents only occur beyond a shallow boundary.
    if (!parent) continue;
    reachable.add(id);
    introduced.push(id);
    pending.push(...parent.parents);
  }
  return introduced;
}
