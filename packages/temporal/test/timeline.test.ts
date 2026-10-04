import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectRepository } from "@ctm/collector";
import type { RepositoryModel } from "@ctm/model";
import { KEYFRAME_INTERVAL, Timeline, buildDirectoryTree } from "../src/index.ts";
import { ALICE, BOB, CARA, FixtureRepo, groundTruthAt, seededRandom, type Identity } from "../../../test-support/fixture-repo.ts";

const disposables: FixtureRepo[] = [];
afterAll(() => disposables.forEach((repo) => repo.dispose()));

function fixture(): FixtureRepo {
  const repo = FixtureRepo.create();
  disposables.push(repo);
  return repo;
}

function lines(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join("\n") + "\n";
}

/**
 * The central correctness property: at every mainline step, the reconstructed
 * file set, entry kinds and line counts equal what Git itself reports.
 */
function expectMatchesGit(repo: FixtureRepo, model: RepositoryModel, timeline: Timeline): void {
  for (const info of timeline.steps) {
    const truth = groundTruthAt(repo.dir, info.commitId);
    const snapshot = timeline.snapshotAt(info.step);
    const actual = new Map([...snapshot.values()].map((f) => [f.path, { kind: f.kind, loc: f.loc }]));
    expect(actual, `tree mismatch at step ${info.step} (${info.subject})`).toEqual(truth);

    const stats = timeline.stats[info.step]!;
    expect(stats.files).toBe(truth.size);
    expect(stats.loc).toBe([...truth.values()].reduce((sum, entry) => sum + (entry.loc ?? 0), 0));

    const reachable = Number(execFileSync("git", ["rev-list", "--count", info.commitId], { cwd: repo.dir, encoding: "utf8" }));
    expect(stats.commitsReachable, `reachable count at step ${info.step}`).toBe(reachable);
  }
  expect(timeline.steps.at(-1)!.commitId).toBe(model.headCommit);
}

async function build(repo: FixtureRepo) {
  const model = await collectRepository(repo.dir);
  return { model, timeline: Timeline.build(model) };
}

describe("Timeline reconstruction", () => {
  it("matches git through renames, deletions, restorations, merges and odd entry types", async () => {
    const repo = fixture();
    repo.write("README.md", "# TaskFlow\n").write("src/main.js", lines(10)).write("src/utils.js", lines(5)).commit("Initial project");
    repo.write("src/auth.js", lines(30, "auth")).commit("Add authentication", BOB);
    repo.move("src/auth.js", "src/auth/login.js");
    repo.write("src/auth/login.js", lines(30, "auth") + "export default login;\n").write("src/auth/middleware.js", lines(8)).commit("Split auth module", BOB);

    repo.checkout("feature/db", true);
    repo.write("src/db/schema.sql", lines(12)).commit("Add schema", CARA);
    repo.write("src/db/client.js", lines(7)).write("src/main.js", lines(14)).commit("Add db client", CARA);
    repo.checkout("main");
    repo.write("assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1])).symlink("docs", "README.md").commit("Branding");
    repo.merge("feature/db", "Merge feature/db");

    repo.remove("src/utils.js").commit("Remove utils");
    repo.commit("Release marker", ALICE, { allowEmpty: true });
    repo.write("src/utils.js", "restored\n").commit("Restore utils");
    repo.unlink("docs").write("docs", "now a regular file\nwith two lines\n").commit("Replace symlink with file");
    repo.write("tail.txt", "no trailing newline").commit("Edge: missing final newline");

    const { model, timeline } = await build(repo);
    expectMatchesGit(repo, model, timeline);

    // The merge is one mainline step that introduces the two side-branch commits.
    const merge = timeline.steps.find((s) => s.subject === "Merge feature/db")!;
    expect(merge.isMerge).toBe(true);
    expect(merge.introducedCommitIds).toHaveLength(3);
    expect(timeline.stats.at(-1)!.contributorsReachable).toBe(3);
  });

  it("matches git for randomized histories spanning several keyframes", async () => {
    // Long enough to cross keyframe boundaries so delta replay is exercised.
    const repo = randomHistory(20_240_101, KEYFRAME_INTERVAL * 3);
    const { model, timeline } = await build(repo);
    expect(timeline.length).toBeGreaterThan(KEYFRAME_INTERVAL * 2);
    expectMatchesGit(repo, model, timeline);
  });

  it.each([7, 42, 1_337])("matches git for randomized history with merges (seed %i)", async (seed) => {
    const repo = randomHistory(seed, 40);
    const { model, timeline } = await build(repo);
    expectMatchesGit(repo, model, timeline);
  });
});

describe("Binary transitions", () => {
  // Regression: expressjs/express docs/api.html briefly gained NUL bytes in 2010.
  // numstat reports no delta across a binary version, so line totals must come
  // from measuring the blob, or they stay unknown for the rest of history.
  it("recovers line counts after a file stops being binary", async () => {
    const repo = fixture();
    repo.write("docs/api.html", lines(40)).commit("Text");
    repo.write("docs/api.html", `${lines(40)}stray\0nul\n`).commit("Accidentally binary");
    repo.write("docs/api.html", lines(45)).commit("Text again");
    repo.write("docs/api.html", lines(47)).commit("Normal edit");
    repo.write("assets/huge-text.bin", Buffer.from([0, 1, 2])).commit("Binary born");

    const { model, timeline } = await build(repo);
    expectMatchesGit(repo, model, timeline);
    expect(timeline.steps.map((s) => timeline.snapshotAt(s.step).get("docs/api.html")?.loc)).toEqual([40, null, 45, 47, 47]);
    expect(timeline.stats.at(-1)!.filesWithUnknownLoc).toBe(1);
  });
});

describe("Lifecycle events", () => {
  it("tracks a file's identity across renames until it dies, and flags restorations", async () => {
    const repo = fixture();
    repo.write("src/auth.ts", lines(20)).commit("Born");
    repo.write("src/auth.ts", lines(22)).commit("Changed");
    repo.move("src/auth.ts", "src/auth/login.ts");
    repo.commit("Moved");
    repo.remove("src/auth/login.ts").commit("Died");
    repo.write("src/auth/login.ts", "new\n").commit("Restored");

    const { timeline } = await build(repo);
    const born = timeline.events.find((e) => e.path === "src/auth.ts" && e.kind === "born")!;
    expect(timeline.lineageHistory(born.lineage).map((e) => [e.kind, e.path, e.step])).toEqual([
      ["born", "src/auth.ts", 0],
      ["changed", "src/auth.ts", 1],
      ["moved", "src/auth/login.ts", 2],
      ["died", "src/auth/login.ts", 3],
    ]);
    const restored = timeline.events.at(-1)!;
    expect(restored).toMatchObject({ kind: "born", path: "src/auth/login.ts", restored: true });
    expect(restored.lineage).not.toBe(born.lineage);

    const state = timeline.snapshotAt(2).get("src/auth/login.ts")!;
    expect(state).toMatchObject({ bornAtStep: 0, lastChangedAtStep: 2, changeCount: 2, loc: 22 });
    expect(timeline.eventsBetween(0, 2).map((e) => e.kind)).toEqual(["changed", "moved"]);
  });
});

describe("Time lookup and aggregates", () => {
  it("finds steps by date and commit, tolerating out-of-order commit timestamps", async () => {
    const repo = fixture();
    const a = repo.write("a", "1\n").commit("a", ALICE, { hoursLater: 10 }); // 2024-01-01T10:00Z
    repo.write("a", "2\n").commit("b", ALICE, { hoursLater: 10 }); // T20:00
    // Simulate clock skew: a later commit with an earlier timestamp.
    repo.write("a", "3\n").commit("c", ALICE, { hoursLater: -15 }); // T05:00
    const { timeline } = await build(repo);

    expect(timeline.stepOfCommit(a)).toBe(0);
    expect(timeline.stepAtOrBefore(new Date("2023-12-31T00:00:00Z"))).toBeUndefined();
    expect(timeline.stepAtOrBefore(new Date("2024-01-01T12:00:00Z"))).toBe(0);
    expect(timeline.stepAtOrBefore(new Date("2024-01-02T00:00:00Z"))).toBe(2);
    expect(() => timeline.snapshotAt(3)).toThrow(RangeError);
  });

  it("aggregates directories and languages", async () => {
    const repo = fixture();
    repo.write("src/api/users.ts", lines(10)).write("src/api/tasks.ts", lines(5)).write("src/index.js", lines(2)).write("README.md", "hi\n");
    repo.commit("Layout");
    const { timeline } = await build(repo);

    const root = buildDirectoryTree(timeline.snapshotAt(0));
    expect(root).toMatchObject({ fileCount: 4, loc: 18 });
    const src = root.directories.find((d) => d.name === "src")!;
    expect(src).toMatchObject({ path: "src", fileCount: 3, loc: 17 });
    expect(src.directories.map((d) => [d.path, d.fileCount, d.loc])).toEqual([["src/api", 2, 15]]);

    expect(timeline.stats[0]!.languages).toEqual({
      TypeScript: { files: 2, loc: 15 },
      JavaScript: { files: 1, loc: 2 },
      Markdown: { files: 1, loc: 1 },
    });
  });
});

/**
 * Generate a reproducible random history: adds, edits, deletes, renames
 * (some with edits) and conflict-free feature branches merged with --no-ff
 * or fast-forwarded.
 */
function randomHistory(seed: number, commits: number): FixtureRepo {
  const random = seededRandom(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const authors: readonly Identity[] = [ALICE, BOB, CARA];
  const repo = fixture();
  const dirs = ["src", "src/api", "src/auth", "lib", "test", "docs"];
  const content = () => lines(1 + Math.floor(random() * 25), `v${Math.floor(random() * 1e6)}`);

  // Files are namespaced per branch so merges never conflict.
  const files = new Map<string, string[]>([["main", []]]);
  let fileCounter = 0;
  let branchCounter = 0;
  let current = "main";

  const mutate = (owned: string[]) => {
    const operations = owned.length === 0 ? 1 : 1 + Math.floor(random() * 3);
    for (let i = 0; i < operations; i++) {
      const roll = random();
      const prefix = current === "main" ? "" : `${current}/`;
      if (owned.length === 0 || roll < 0.35) {
        const path = `${prefix}${pick(dirs)}/file${fileCounter++}.ts`;
        repo.write(path, content());
        owned.push(path);
      } else if (roll < 0.7) {
        repo.write(pick(owned), content());
      } else if (roll < 0.85) {
        const index = Math.floor(random() * owned.length);
        repo.remove(owned[index]!);
        owned.splice(index, 1);
      } else {
        const index = Math.floor(random() * owned.length);
        const target = `${prefix}${pick(dirs)}/moved${fileCounter++}.ts`;
        repo.move(owned[index]!, target);
        if (random() < 0.5) repo.write(target, `${readFileSync(join(repo.dir, target), "utf8")}edit\n`);
        owned[index] = target;
      }
    }
  };

  for (let i = 0; i < commits; i++) {
    const roll = random();
    if (current === "main" && i > 0 && roll < 0.1) {
      current = `feature${branchCounter++}`;
      files.set(current, []);
      repo.checkout(current, true);
    } else if (current !== "main" && roll < 0.25) {
      const branch = current;
      repo.checkout("main");
      current = "main";
      // Fast-forward when main has not moved; otherwise a real merge commit.
      const behind = repo.git("rev-list", "--count", `${branch}..main`).trim() === "0";
      repo.merge(branch, `Merge ${branch}`, pick(authors), behind && random() < 0.5);
      files.get("main")!.push(...files.get(branch)!);
      continue;
    }
    mutate(files.get(current)!);
    // Operations can cancel out (add then remove); allow the resulting empty commit.
    repo.commit(`Commit ${i}`, pick(authors), { allowEmpty: true });
  }
  if (current !== "main") {
    const branch = current;
    repo.checkout("main");
    repo.merge(branch, `Merge ${branch}`);
  }
  return repo;
}
