import type { Bundle, BundleEvent, BundleStep } from "@ctm/export/types";

/** Read-only, memoized views over a bundle. All derivation lives here, not in components. */

export interface FileNow {
  readonly lineage: number;
  readonly path: string;
  readonly loc: number | null;
  readonly bornStep: number;
  readonly lastChangedStep: number;
  readonly changeCount: number;
}

export interface ModuleNode {
  readonly id: string;
  readonly files: number;
  readonly loc: number;
  readonly rank: number;
}

export interface Architecture {
  readonly modules: readonly ModuleNode[];
  readonly edges: readonly { from: string; to: string; weight: number }[];
  readonly packages: readonly string[];
}

export interface ContributorSummary {
  readonly id: number;
  readonly name: string;
  readonly commits: number;
  readonly merges: number;
  readonly additions: number;
  readonly deletions: number;
  readonly firstStep: number;
  readonly lastStep: number;
  readonly areas: readonly { module: string; touches: number }[];
}

export interface SearchResult {
  readonly query: string;
  readonly steps: readonly number[];
  readonly firstStep: number | null;
  readonly currentFiles: readonly string[];
  readonly contributors: readonly string[];
}

export interface Comparison {
  readonly from: number;
  readonly to: number;
  readonly born: readonly BundleEvent[];
  readonly died: readonly BundleEvent[];
  readonly moved: readonly BundleEvent[];
  readonly modulesAdded: readonly string[];
  readonly modulesRemoved: readonly string[];
  readonly packagesAdded: readonly string[];
  readonly packagesRemoved: readonly string[];
  readonly commits: number;
}

const KEYFRAME_EVERY = 32;
/** Directories whose children are the meaningful architectural units. */
const CONTAINER_DIRECTORIES = new Set(["src", "backend", "server", "services", "packages", "apps", "libs", "modules", "app", "lib"]);
export const ROOT_MODULE = "(root files)";

export function moduleOf(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) return ROOT_MODULE;
  if (CONTAINER_DIRECTORIES.has(parts[0]!) && parts.length >= 3) return `${parts[0]}/${parts[1]}`;
  return parts[0]!;
}

export class RepoView {
  readonly eventsByStep: readonly (readonly BundleEvent[])[];
  readonly eventsByLineage: ReadonlyMap<number, readonly BundleEvent[]>;
  readonly milestoneSteps: readonly number[];
  private readonly keyframes = new Map<number, Map<number, FileNow>>();
  private readonly cache = new Map<string, unknown>();

  constructor(readonly bundle: Bundle) {
    const byStep: BundleEvent[][] = bundle.steps.map(() => []);
    const byLineage = new Map<number, BundleEvent[]>();
    for (const event of bundle.events) {
      byStep[event.step]!.push(event);
      const list = byLineage.get(event.lineage);
      if (list) list.push(event);
      else byLineage.set(event.lineage, [event]);
    }
    this.eventsByStep = byStep;
    this.eventsByLineage = byLineage;
    this.milestoneSteps = [...new Set(bundle.milestones.map((m) => m.step))].sort((a, b) => a - b);
  }

  get lastStep(): number {
    return this.bundle.steps.length - 1;
  }

  step(index: number): BundleStep {
    return this.bundle.steps[index]!;
  }

  author(id: number): string {
    return this.bundle.contributors[id]?.name ?? "Unknown";
  }

  private memo<T>(key: string, compute: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, compute());
    return this.cache.get(key) as T;
  }

  /** Files alive after `step`, keyed by lineage. Replays events from the nearest keyframe. */
  snapshot(step: number): ReadonlyMap<number, FileNow> {
    return this.memo(`snapshot:${step}`, () => {
      const base = step - (step % KEYFRAME_EVERY);
      let start = 0;
      let files = new Map<number, FileNow>();
      for (let k = base; k > 0; k -= KEYFRAME_EVERY) {
        const frame = this.keyframes.get(k - 1);
        if (frame) {
          files = new Map(frame);
          start = k;
          break;
        }
      }
      for (let s = start; s <= step; s++) {
        for (const event of this.eventsByStep[s]!) {
          if (event.kind === "died") {
            files.delete(event.lineage);
            continue;
          }
          const previous = files.get(event.lineage);
          files.set(event.lineage, {
            lineage: event.lineage,
            path: event.path,
            loc: event.locAfter,
            bornStep: previous?.bornStep ?? event.step,
            lastChangedStep: event.step,
            changeCount: previous ? previous.changeCount + 1 : 0,
          });
        }
        if ((s + 1) % KEYFRAME_EVERY === 0) this.keyframes.set(s, new Map(files));
      }
      return files;
    });
  }

  /** Every path any file has ever had: the domain of the stable layout. */
  allPaths(): readonly string[] {
    return this.memo("allPaths", () => {
      const paths = new Set<string>();
      for (const event of this.bundle.events) {
        paths.add(event.path);
        if (event.previousPath) paths.add(event.previousPath);
      }
      return [...paths].sort();
    });
  }

  /** Largest line count each path ever had, for sizing in the stable layout. */
  peakLoc(): ReadonlyMap<string, number> {
    return this.memo("peakLoc", () => {
      const peak = new Map<string, number>();
      for (const event of this.bundle.events) {
        peak.set(event.path, Math.max(peak.get(event.path) ?? 0, event.locAfter ?? 0));
      }
      return peak;
    });
  }

  /** Number of modifications/moves per lineage up to and including `step`. */
  churn(step: number): ReadonlyMap<number, number> {
    return this.memo(`churn:${step}`, () => {
      const churn = new Map<number, number>();
      for (let s = 0; s <= step; s++) {
        for (const event of this.eventsByStep[s]!) {
          if (event.kind === "changed" || event.kind === "moved") churn.set(event.lineage, (churn.get(event.lineage) ?? 0) + 1);
        }
      }
      return churn;
    });
  }

  dependenciesAt(step: number) {
    return this.bundle.dependencies.filter((edge) => edge.fromStep <= step && (edge.toStep === null || edge.toStep > step));
  }

  architecture(step: number): Architecture {
    return this.memo(`arch:${step}`, () => {
      const files = this.snapshot(step);
      const modules = new Map<string, { files: number; loc: number }>();
      for (const file of files.values()) {
        const id = moduleOf(file.path);
        if (id === ROOT_MODULE) continue;
        const entry = modules.get(id) ?? { files: 0, loc: 0 };
        entry.files += 1;
        entry.loc += file.loc ?? 0;
        modules.set(id, entry);
      }
      const weights = new Map<string, number>();
      const packages = new Set<string>();
      for (const edge of this.dependenciesAt(step)) {
        const from = files.get(edge.from);
        if (!from) continue;
        if (edge.external) {
          packages.add(edge.external);
          continue;
        }
        const to = edge.to === null ? undefined : files.get(edge.to);
        if (!to) continue;
        const a = moduleOf(from.path);
        const b = moduleOf(to.path);
        if (a === b || !modules.has(a) || !modules.has(b)) continue;
        weights.set(`${a}\u0000${b}`, (weights.get(`${a}\u0000${b}`) ?? 0) + 1);
      }
      const edges = [...weights].map(([key, weight]) => {
        const [from, to] = key.split("\u0000") as [string, string];
        return { from, to, weight };
      });
      const ranks = layerRanks([...modules.keys()], edges);
      return {
        modules: [...modules].map(([id, m]) => ({ id, ...m, rank: ranks.get(id) ?? 0 })).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id)),
        edges,
        packages: [...packages].sort(),
      };
    });
  }

  contributors(step: number): ContributorSummary[] {
    return this.memo(`people:${step}`, () => {
      const people = new Map<number, { commits: number; merges: number; additions: number; deletions: number; first: number; last: number; areas: Map<string, number> }>();
      const touch = (id: number, at: number, additions: number, deletions: number, paths: readonly string[], merge = false) => {
        const p = people.get(id) ?? { commits: 0, merges: 0, additions: 0, deletions: 0, first: at, last: at, areas: new Map() };
        if (merge) p.merges += 1;
        else p.commits += 1;
        p.additions += additions;
        p.deletions += deletions;
        p.last = Math.max(p.last, at);
        for (const path of paths) p.areas.set(moduleOf(path), (p.areas.get(moduleOf(path)) ?? 0) + 1);
        people.set(id, p);
      };
      for (const info of this.bundle.steps.slice(0, step + 1)) {
        if (info.isMerge) {
          // A merge's diff is the branch's work; credit it to the branch authors below, not the merger.
          touch(info.authorId, info.step, 0, 0, [], true);
          continue;
        }
        const changes = this.bundle.commits[info.commitId]?.changes ?? [];
        touch(info.authorId, info.step, sum(changes.map((c) => c.additions ?? 0)), sum(changes.map((c) => c.deletions ?? 0)), changes.map((c) => c.path));
      }
      for (const side of this.bundle.sideCommits) {
        if (side.introducedAtStep <= step) touch(side.authorId, side.introducedAtStep, side.additions, side.deletions, side.paths);
      }
      return [...people]
        .map(([id, p]) => ({
          id,
          name: this.author(id),
          commits: p.commits,
          merges: p.merges,
          additions: p.additions,
          deletions: p.deletions,
          firstStep: p.first,
          lastStep: p.last,
          areas: [...p.areas].map(([module, touches]) => ({ module, touches })).sort((a, b) => b.touches - a.touches).slice(0, 4),
        }))
        .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
    });
  }

  /** Keyword search over commit messages and file paths (not semantic; see AI Historian roadmap). */
  search(query: string, step: number): SearchResult {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    const matches = (text: string) => terms.some((term) => text.toLowerCase().includes(term));
    const steps: number[] = [];
    const people = new Set<string>();
    for (const info of this.bundle.steps) {
      const paths = this.bundle.commits[info.commitId]?.changes.map((c) => c.path) ?? [];
      if (terms.length > 0 && (matches(info.subject) || matches(info.body) || paths.some(matches))) {
        steps.push(info.step);
        people.add(this.author(info.authorId));
      }
    }
    const currentFiles = terms.length === 0 ? [] : [...this.snapshot(step).values()].map((f) => f.path).filter(matches).sort();
    return { query, steps, firstStep: steps[0] ?? null, currentFiles, contributors: [...people] };
  }

  compare(from: number, to: number): Comparison {
    const [a, b] = from <= to ? [from, to] : [to, from];
    const between = this.bundle.events.filter((e) => e.step > a && e.step <= b);
    const before = this.architecture(a);
    const after = this.architecture(b);
    const ids = (arch: Architecture) => new Set(arch.modules.map((m) => m.id));
    const minus = <T,>(x: Set<T>, y: Set<T>) => [...x].filter((v) => !y.has(v));
    return {
      from: a,
      to: b,
      born: between.filter((e) => e.kind === "born"),
      died: between.filter((e) => e.kind === "died"),
      moved: between.filter((e) => e.kind === "moved"),
      modulesAdded: minus(ids(after), ids(before)),
      modulesRemoved: minus(ids(before), ids(after)),
      packagesAdded: minus(new Set(after.packages), new Set(before.packages)),
      packagesRemoved: minus(new Set(before.packages), new Set(after.packages)),
      commits: (this.bundle.stats[b]?.commitsReachable ?? 0) - (this.bundle.stats[a]?.commitsReachable ?? 0),
    };
  }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Layer modules so importers sit above what they import: rank = longest path
 * from any module nobody imports. Cycles are broken by ignoring back edges.
 */
function layerRanks(ids: readonly string[], edges: readonly { from: string; to: string }[]): Map<string, number> {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) out.get(edge.from)?.push(edge.to);
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const depthBelow = (id: string): number => {
    if (rank.has(id)) return rank.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const below = Math.max(-1, ...(out.get(id) ?? []).map(depthBelow));
    visiting.delete(id);
    rank.set(id, below + 1);
    return below + 1;
  };
  ids.forEach(depthBelow);
  // Convert "height above sinks" into top-down rows.
  const max = Math.max(0, ...rank.values());
  return new Map([...rank].map(([id, height]) => [id, max - height]));
}
