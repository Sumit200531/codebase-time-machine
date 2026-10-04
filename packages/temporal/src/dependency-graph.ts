import { resolveImport } from "@ctm/analysis";
import type { ObjectId } from "@ctm/model";
import type { Timeline } from "./timeline.ts";
import type { FileState, LineageId, Step } from "./types.ts";

/**
 * A dependency that existed over the half-open mainline interval
 * [fromStep, toStep). toStep is null while the edge still exists at HEAD.
 */
export interface DependencyEdge {
  readonly from: LineageId;
  /** Target file lineage for internal imports, otherwise null. */
  readonly to: LineageId | null;
  /** Package name for external imports, otherwise null. */
  readonly external: string | null;
  readonly fromStep: Step;
  toStep: Step | null;
}

/** Import specifiers per blob id; undefined when the blob was not analyzed. */
export type ImportLookup = (blobId: ObjectId) => readonly string[] | undefined;

/**
 * Build interval-encoded dependency edges over the whole timeline.
 *
 * Imports are re-resolved for files whose content changed and, when files
 * appear, move or disappear, for every file (a new file can satisfy an import
 * that previously dangled). Edges are keyed by lineage, so renames preserve them.
 */
export function buildDependencyIntervals(timeline: Timeline, importsOf: ImportLookup): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  const open = new Map<LineageId, Map<string, DependencyEdge>>();

  const resolveFile = (file: FileState, snapshot: ReadonlyMap<string, FileState>): Map<string, Omit<DependencyEdge, "fromStep" | "toStep">> => {
    const targets = new Map<string, Omit<DependencyEdge, "fromStep" | "toStep">>();
    const specifiers = file.blobId ? importsOf(file.blobId) : undefined;
    for (const specifier of specifiers ?? []) {
      const resolved = resolveImport(file.path, specifier, (path) => snapshot.has(path));
      if (!resolved) continue;
      if (resolved.kind === "internal") {
        const target = snapshot.get(resolved.path)!;
        if (target.lineage !== file.lineage) {
          targets.set(`L${target.lineage}`, { from: file.lineage, to: target.lineage, external: null });
        }
      } else {
        targets.set(`X${resolved.name}`, { from: file.lineage, to: null, external: resolved.name });
      }
    }
    return targets;
  };

  const closeAll = (lineage: LineageId, step: Step) => {
    for (const edge of open.get(lineage)?.values() ?? []) edge.toStep = step;
    open.delete(lineage);
  };

  for (const info of timeline.steps) {
    const events = timeline.eventsAt(info.step);
    if (events.length === 0) continue;
    const snapshot = timeline.snapshotAt(info.step);
    for (const event of events) if (event.kind === "died") closeAll(event.lineage, info.step);

    const structural = events.some((event) => event.kind !== "changed");
    const touched = new Set(events.map((event) => event.lineage));
    const files = structural ? [...snapshot.values()] : [...snapshot.values()].filter((f) => touched.has(f.lineage));

    for (const file of files) {
      const next = resolveFile(file, snapshot);
      const current = open.get(file.lineage) ?? new Map<string, DependencyEdge>();
      for (const [key, edge] of current) {
        if (!next.has(key)) {
          edge.toStep = info.step;
          current.delete(key);
        }
      }
      for (const [key, target] of next) {
        if (current.has(key)) continue;
        const edge: DependencyEdge = { ...target, fromStep: info.step, toStep: null };
        edges.push(edge);
        current.set(key, edge);
      }
      if (current.size > 0) open.set(file.lineage, current);
      else open.delete(file.lineage);
    }
  }
  return edges;
}

/** Edges alive at `step`. */
export function edgesAt(edges: readonly DependencyEdge[], step: Step): DependencyEdge[] {
  return edges.filter((edge) => edge.fromStep <= step && (edge.toStep === null || edge.toStep > step));
}
