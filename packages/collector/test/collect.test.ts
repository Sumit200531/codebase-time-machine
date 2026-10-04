import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { isCtmError } from "@ctm/model";
import { collectRepository } from "../src/index.ts";
import { runGit } from "../src/git.ts";
import { ALICE, BOB, FixtureRepo } from "../../../test-support/fixture-repo.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()!();
});

function fixture(): FixtureRepo {
  const repo = FixtureRepo.create();
  cleanup.push(() => repo.dispose());
  return repo;
}

function expectCode(code: Parameters<typeof isCtmError>[1]) {
  return (error: unknown) => isCtmError(error, code);
}

describe("collectRepository", () => {
  it("collects commits in topological order with authors, messages and changes", async () => {
    const repo = fixture();
    const first = repo.write("README.md", "# TaskFlow\n").write("src/index.ts", "a\nb\n").commit("Initial commit", ALICE);
    const second = repo.write("src/index.ts", "a\nB\nc\n").commit("Expand index\n\nWith a body.", BOB);

    const model = await collectRepository(repo.dir);

    expect(model.headCommit).toBe(second);
    expect(model.headRefName).toBe("main");
    expect(model.isShallow).toBe(false);
    expect(model.commits.map((c) => c.id)).toEqual([first, second]);
    expect(model.commits[1]).toMatchObject({
      parents: [first],
      author: { name: BOB.name, email: BOB.email },
      subject: "Expand index",
      body: "With a body.",
      changes: [{ status: "modified", path: "src/index.ts", additions: 2, deletions: 1 }],
    });
    expect(model.commits[0]!.authoredAt).toBe("2024-01-01T01:00:00+00:00");
  });

  it("detects renames, including renames with edits", async () => {
    const repo = fixture();
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n";
    repo.write("src/auth.ts", body).commit("Add auth");
    repo.move("src/auth.ts", "src/auth/login.ts");
    repo.write("src/auth/login.ts", body + "extra\n").commit("Move auth into module");

    const model = await collectRepository(repo.dir);
    const change = model.commits[1]!.changes[0]!;
    expect(change).toMatchObject({
      status: "renamed",
      previousPath: "src/auth.ts",
      path: "src/auth/login.ts",
      additions: 1,
      deletions: 0,
    });
    expect(change.similarity).toBeGreaterThan(50);
  });

  it("records merge commits as their first-parent diff and collects side-branch commits", async () => {
    const repo = fixture();
    repo.write("app.ts", "app\n").commit("Initial");
    repo.checkout("feature/cache", true);
    const sideA = repo.write("cache/redis.ts", "redis\n").commit("Add redis client", BOB);
    const sideB = repo.write("cache/policy.ts", "ttl\n").commit("Add cache policy", BOB);
    repo.checkout("main");
    repo.write("app.ts", "app v2\n").commit("Unrelated change on main");
    const merge = repo.merge("feature/cache", "Merge feature/cache");

    const model = await collectRepository(repo.dir);
    const ids = model.commits.map((c) => c.id);
    expect(ids).toContain(sideA);
    expect(ids).toContain(sideB);
    // Parents always precede children.
    for (const commit of model.commits) {
      for (const parent of commit.parents) expect(ids.indexOf(parent)).toBeLessThan(ids.indexOf(commit.id));
    }
    const mergeCommit = model.commits.find((c) => c.id === merge)!;
    expect(mergeCommit.parents).toHaveLength(2);
    expect(mergeCommit.changes.map((c) => [c.status, c.path]).sort()).toEqual([
      ["added", "cache/policy.ts"],
      ["added", "cache/redis.ts"],
    ]);
    expect(model.refs).toEqual(
      expect.arrayContaining([
        { name: "main", kind: "branch", target: merge },
        { name: "feature/cache", kind: "branch", target: sideB },
      ]),
    );
  });

  it("handles empty commits, binary files, symlinks and unusual filenames", async () => {
    const repo = fixture();
    const weird = "docs/tab\tand\nnewline \u00e9.md";
    repo.write(weird, "hello\n").write("assets/logo.bin", Buffer.from([0, 1, 2, 0, 255])).symlink("latest", "docs");
    repo.commit("Assets");
    repo.commit("Empty marker", ALICE, { allowEmpty: true });
    repo.write("after.txt", "x\n").commit("After empty");

    const model = await collectRepository(repo.dir);
    expect(model.commits.map((c) => c.subject)).toEqual(["Assets", "Empty marker", "After empty"]);
    expect(model.commits[1]!.changes).toEqual([]);
    const changes = new Map(model.commits[0]!.changes.map((c) => [c.path, c]));
    expect(changes.get(weird)).toMatchObject({ status: "added", additions: 1 });
    expect(changes.get("assets/logo.bin")).toMatchObject({ additions: null, deletions: null });
    expect(changes.get("latest")).toMatchObject({ kind: "symlink" });
  });

  it("peels annotated tags to their commit", async () => {
    const repo = fixture();
    const commit = repo.write("a.txt", "a\n").commit("Release");
    repo.git("-c", "user.name=T", "-c", "user.email=t@x", "tag", "-a", "v1.0.0", "-m", "Version 1");
    const model = await collectRepository(repo.dir);
    expect(model.refs).toContainEqual({ name: "v1.0.0", kind: "tag", target: commit });
  });

  it("flags shallow clones", async () => {
    const origin = fixture();
    for (let i = 0; i < 4; i++) origin.write("n.txt", `${i}\n`).commit(`Commit ${i}`);
    const cloneDir = mkdtempSync(join(tmpdir(), "ctm-shallow-"));
    cleanup.push(() => rmSync(cloneDir, { recursive: true, force: true }));
    execFileSync("git", ["clone", "-q", "--depth", "2", `file://${origin.dir}`, cloneDir]);

    const model = await collectRepository(cloneDir);
    expect(model.isShallow).toBe(true);
    expect(model.commits).toHaveLength(2);
    expect(model.commits[0]!.parents).toEqual([]);
  });

  describe("errors", () => {
    it("rejects paths that are not repositories", async () => {
      const dir = mkdtempSync(join(tmpdir(), "ctm-not-repo-"));
      cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
      await expect(collectRepository(dir)).rejects.toSatisfy(expectCode("NOT_A_REPOSITORY"));
    });

    it("reports empty repositories", async () => {
      const repo = fixture();
      await expect(collectRepository(repo.dir)).rejects.toSatisfy(expectCode("EMPTY_REPOSITORY"));
    });

    it("reports refs that do not exist", async () => {
      const repo = fixture();
      repo.write("a", "a\n").commit("x");
      await expect(collectRepository(repo.dir, { ref: "nope" })).rejects.toSatisfy(expectCode("INVALID_REF"));
    });

    it("enforces the commit limit before reading history", async () => {
      const repo = fixture();
      for (let i = 0; i < 3; i++) repo.write("a", `${i}\n`).commit(`c${i}`);
      await expect(collectRepository(repo.dir, { maxCommits: 2 })).rejects.toSatisfy(
        expectCode("REPOSITORY_TOO_LARGE"),
      );
    });
  });

  describe("untrusted repositories", () => {
    it("never interprets a user-supplied ref as a git option", async () => {
      const repo = fixture();
      repo.write("a", "a\n").commit("x");
      const target = join(repo.dir, "..", `ctm-injected-${process.pid}`);
      cleanup.push(() => rmSync(target, { force: true }));
      for (const ref of [`--output=${target}`, "-p", "HEAD --all"]) {
        await expect(collectRepository(repo.dir, { ref })).rejects.toSatisfy(expectCode("INVALID_REF"));
      }
      expect(existsSync(target)).toBe(false);
    });

    it("does not run programs configured by the repository", async () => {
      const repo = fixture();
      const marker = join(repo.dir, "..", `ctm-pwned-${process.pid}`);
      cleanup.push(() => rmSync(marker, { force: true }));
      const script = join(repo.dir, ".git", "evil.sh");
      writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat "$1" 2>/dev/null\n`);
      chmodSync(script, 0o755);
      for (const [key, value] of [
        ["core.fsmonitor", script],
        ["core.pager", script],
        ["diff.external", script],
        ["diff.evil.textconv", script],
        ["core.hooksPath", join(repo.dir, ".git")],
      ] as const) {
        repo.git("config", key, value);
      }
      repo.write(".gitattributes", "* diff=evil\n").write("a.txt", "one\n").commit("one");
      repo.write("a.txt", "two\n").commit("two");
      rmSync(marker, { force: true }); // fixture commits themselves may trigger the hooks

      const model = await collectRepository(repo.dir);
      expect(model.commits).toHaveLength(2);
      expect(model.commits[1]!.changes[0]).toMatchObject({ additions: 1, deletions: 1 });
      expect(existsSync(marker)).toBe(false);

      // The collector's numstat queries never reach these hooks, so also prove the
      // runner neutralises the commands that do: patch output (needed by the diff
      // viewer) runs textconv/external diff, and `status` runs fsmonitor.
      // Verified separately: unhardened `git log -p` and `git status` create the marker here.
      await runGit(["log", "-p", "--no-textconv", "--no-ext-diff"], { cwd: repo.dir });
      await runGit(["status", "--porcelain"], { cwd: repo.dir });
      expect(existsSync(marker)).toBe(false);
    });
  });
});
