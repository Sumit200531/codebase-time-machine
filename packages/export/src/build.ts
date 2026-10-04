import { extractImports, supportsImports } from "@ctm/analysis";
import { collectRepository, readBlobs, readCommitPatch, isBinaryContent, type CollectOptions } from "@ctm/collector";
import type { ObjectId } from "@ctm/model";
import { Timeline, buildDependencyIntervals, edgesAt } from "@ctm/temporal";
import { detectMilestones } from "./milestones.ts";
import { BUNDLE_SCHEMA_VERSION, type Bundle, type BundleStats } from "./types.ts";

/** Source files larger than this are not scanned for imports. */
const MAX_IMPORT_SCAN_BYTES = 512 * 1024;
/** Patches are embedded only for histories up to this many mainline steps. */
const MAX_STEPS_WITH_PATCHES = 2_000;

export interface BuildBundleOptions extends CollectOptions {
  readonly demoNotice?: string;
  readonly includePatches?: boolean;
  readonly onProgress?: (message: string) => void;
}

export async function buildBundle(path: string, options: BuildBundleOptions = {}): Promise<Bundle> {
  const progress = options.onProgress ?? (() => undefined);
  progress("Collecting history");
  const model = await collectRepository(path, options);
  const timeline = Timeline.build(model);

  progress("Extracting imports");
  // Blob id -> one path it appeared under (the path only selects the language).
  const pathForBlob = new Map<ObjectId, string>();
  for (const info of timeline.steps) {
    const events = timeline.eventsAt(info.step).filter((e) => e.kind !== "died" && supportsImports(e.path));
    if (events.length === 0) continue;
    const snapshot = timeline.snapshotAt(info.step);
    for (const event of events) {
      const blob = snapshot.get(event.path)?.blobId;
      if (blob && !pathForBlob.has(blob)) pathForBlob.set(blob, event.path);
    }
  }
  const imports = new Map<ObjectId, string[]>();
  for await (const { id, content } of readBlobs(path, pathForBlob.keys(), { maxBytes: MAX_IMPORT_SCAN_BYTES })) {
    if (isBinaryContent(content)) continue;
    imports.set(id, extractImports(pathForBlob.get(id)!, content.toString("utf8")));
  }

  progress("Building dependency intervals");
  const dependencies = buildDependencyIntervals(timeline, (blob) => imports.get(blob));

  const contributorIds = new Map<string, number>();
  const contributors: Bundle["contributors"][number][] = [];
  const contributorOf = (author: { name: string; email: string }) => {
    const key = author.email.trim().toLowerCase() || `name:${author.name}`;
    let id = contributorIds.get(key);
    if (id === undefined) {
      id = contributors.length;
      contributorIds.set(key, id);
      contributors.push({ id, name: author.name, email: author.email });
    }
    return id;
  };

  const commitsById = new Map(model.commits.map((commit) => [commit.id, commit]));
  const tags = new Map<string, string[]>();
  for (const ref of model.refs) if (ref.kind === "tag") tags.set(ref.target, [...(tags.get(ref.target) ?? []), ref.name]);

  const includePatches = (options.includePatches ?? true) && timeline.length <= MAX_STEPS_WITH_PATCHES;
  progress(includePatches ? "Reading patches" : "Skipping patches (history too long)");
  const commits: Record<string, Bundle["commits"][string]> = {};
  const sideCommits: Bundle["sideCommits"][number][] = [];
  const steps = [];
  for (const info of timeline.steps) {
    const commit = commitsById.get(info.commitId)!;
    commits[commit.id] = {
      changes: commit.changes.map((change) => ({
        status: change.status,
        path: change.path,
        ...(change.previousPath ? { previousPath: change.previousPath } : {}),
        additions: change.additions,
        deletions: change.deletions,
      })),
      patch: includePatches ? await readCommitPatch(path, commit.id) : null,
    };
    const side = info.introducedCommitIds.slice(1);
    for (const id of side) {
      const sideCommit = commitsById.get(id)!;
      sideCommits.push({
        id,
        subject: sideCommit.subject,
        authorId: contributorOf(sideCommit.author),
        committedAt: sideCommit.committedAt,
        introducedAtStep: info.step,
        additions: sideCommit.changes.reduce((sum, c) => sum + (c.additions ?? 0), 0),
        deletions: sideCommit.changes.reduce((sum, c) => sum + (c.deletions ?? 0), 0),
        paths: sideCommit.changes.map((c) => c.path),
      });
    }
    steps.push({
      step: info.step,
      commitId: commit.id,
      subject: commit.subject,
      body: commit.body,
      authorId: contributorOf(commit.author),
      committedAt: commit.committedAt,
      isMerge: info.isMerge,
      sideCommitIds: side,
      tags: tags.get(commit.id) ?? [],
    });
  }

  const stats: BundleStats[] = timeline.stats.map((point) => {
    const alive = edgesAt(dependencies, point.step);
    return {
      ...point,
      internalDependencies: alive.filter((edge) => edge.to !== null).length,
      externalPackages: new Set(alive.flatMap((edge) => (edge.external ? [edge.external] : []))).size,
    };
  });

  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    meta: {
      label: model.source.label,
      demoNotice: options.demoNotice ?? null,
      anchorRef: model.headRefName,
      anchorCommit: model.headCommit,
      isShallow: model.isShallow,
      generatedAt: new Date().toISOString(),
      importAnalysis: "lexical",
    },
    contributors,
    steps,
    sideCommits,
    stats,
    events: timeline.events.map(({ commitId: _commitId, ...event }) => event),
    dependencies,
    commits,
    milestones: detectMilestones(model, timeline, dependencies),
    branches: model.refs.map((ref) => ({ name: ref.name, kind: ref.kind, target: ref.target })),
  };
}
