import type { RepositoryModel } from "@ctm/model";
import type { DependencyEdge, Timeline } from "@ctm/temporal";
import type { Milestone } from "./types.ts";

/** A step with at least this many moves is reported as a restructuring. */
const REFACTOR_MOVE_THRESHOLD = 5;
/** Directories this deep (e.g. "src/auth") count as structural units. */
const STRUCTURE_DEPTH = 2;

function structuralUnit(path: string): string | null {
  const parts = path.split("/");
  if (parts.length < 2) return null;
  return parts.slice(0, Math.min(STRUCTURE_DEPTH, parts.length - 1)).join("/");
}

/**
 * Milestones are derived only from recorded facts: tags, directories that
 * first appear, packages that are first imported, mass moves and merges.
 * Nothing is inferred from commit wording.
 */
export function detectMilestones(model: RepositoryModel, timeline: Timeline, edges: readonly DependencyEdge[]): Milestone[] {
  const milestones: Milestone[] = [];
  const tagsByCommit = new Map<string, string[]>();
  for (const ref of model.refs) {
    if (ref.kind !== "tag") continue;
    tagsByCommit.set(ref.target, [...(tagsByCommit.get(ref.target) ?? []), ref.name]);
  }

  const seenUnits = new Set<string>();
  const seenPackages = new Set<string>();
  const externalByStep = new Map<number, string[]>();
  for (const edge of edges) {
    if (edge.external) externalByStep.set(edge.fromStep, [...(externalByStep.get(edge.fromStep) ?? []), edge.external]);
  }

  for (const info of timeline.steps) {
    for (const tag of tagsByCommit.get(info.commitId) ?? []) {
      milestones.push({ step: info.step, kind: "tag", title: tag, detail: info.subject });
    }
    const events = timeline.eventsAt(info.step);
    const newUnits = new Set<string>();
    for (const event of events) {
      if (event.kind !== "born" && event.kind !== "moved") continue;
      const unit = structuralUnit(event.path);
      if (unit && !seenUnits.has(unit)) newUnits.add(unit);
    }
    for (const file of info.step === 0 ? timeline.snapshotAt(0).values() : []) {
      const unit = structuralUnit(file.path);
      if (unit) seenUnits.add(unit);
    }
    if (info.step > 0 && newUnits.size > 0) {
      const units = [...newUnits].sort();
      milestones.push({
        step: info.step,
        kind: "structure",
        title: `${units.slice(0, 3).map((u) => `${u}/`).join(", ")}${units.length > 3 ? ` +${units.length - 3}` : ""} introduced`,
        detail: info.subject,
      });
    }
    newUnits.forEach((unit) => seenUnits.add(unit));

    const packages = [...new Set(externalByStep.get(info.step) ?? [])].filter((name) => !seenPackages.has(name));
    if (info.step > 0 && packages.length > 0) {
      milestones.push({ step: info.step, kind: "dependency", title: `Started using ${packages.slice(0, 3).join(", ")}${packages.length > 3 ? ` +${packages.length - 3}` : ""}`, detail: info.subject });
    }
    packages.forEach((name) => seenPackages.add(name));

    const moves = events.filter((event) => event.kind === "moved").length;
    if (moves >= REFACTOR_MOVE_THRESHOLD) {
      milestones.push({ step: info.step, kind: "refactor", title: `Restructuring: ${moves} files moved`, detail: info.subject });
    }
    if (info.isMerge) milestones.push({ step: info.step, kind: "merge", title: info.subject, detail: `${info.introducedCommitIds.length - 1} commits merged` });
  }
  return milestones;
}
