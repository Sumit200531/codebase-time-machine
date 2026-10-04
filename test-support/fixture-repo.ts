import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface Identity {
  readonly name: string;
  readonly email: string;
}

export const ALICE: Identity = { name: "Alice Arora", email: "alice@example.com" };
export const BOB: Identity = { name: "Bob Banerjee", email: "bob@example.com" };
export const CARA: Identity = { name: "Cara Chen", email: "cara@example.com" };

const BASE_EPOCH_SECONDS = Date.UTC(2024, 0, 1) / 1000;
const ONE_HOUR = 3_600;

/**
 * Builds real Git repositories for tests with fully deterministic identities
 * and timestamps. Test-only: uses synchronous process calls for readability.
 */
export class FixtureRepo {
  private clock = 0;

  private constructor(readonly dir: string) {}

  static create(prefix = "ctm-fixture-"): FixtureRepo {
    const repo = new FixtureRepo(mkdtempSync(join(tmpdir(), prefix)));
    repo.git("init", "-q", "-b", "main");
    repo.git("config", "commit.gpgsign", "false");
    return repo;
  }

  git(...args: string[]): string {
    return this.exec(args, {});
  }

  write(path: string, content: string | Buffer): this {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return this;
  }

  symlink(path: string, target: string): this {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    symlinkSync(target, full);
    return this;
  }

  remove(path: string): this {
    rmSync(join(this.dir, path), { recursive: true, force: true });
    return this;
  }

  unlink(path: string): this {
    unlinkSync(join(this.dir, path));
    return this;
  }

  /** Filesystem move; Git infers the rename at commit time, exactly as for real users. */
  move(from: string, to: string): this {
    mkdirSync(dirname(join(this.dir, to)), { recursive: true });
    renameSync(join(this.dir, from), join(this.dir, to));
    return this;
  }

  /** Stage everything and commit with a deterministic, strictly increasing timestamp. */
  commit(message: string, author: Identity = ALICE, options: { allowEmpty?: boolean; hoursLater?: number } = {}): string {
    this.git("add", "-A");
    this.commitStaged(message, author, options);
    return this.head();
  }

  merge(branch: string, message: string, author: Identity = ALICE, fastForward = false): string {
    this.exec(["merge", "-q", fastForward ? "--ff-only" : "--no-ff", "-m", message, branch], this.identityEnv(author));
    return this.head();
  }

  checkout(branch: string, create = false): this {
    this.git("checkout", "-q", ...(create ? ["-b"] : []), branch);
    return this;
  }

  head(): string {
    return this.git("rev-parse", "HEAD").trim();
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  private commitStaged(message: string, author: Identity, options: { allowEmpty?: boolean; hoursLater?: number }) {
    this.exec(
      ["commit", "-q", "--no-verify", ...(options.allowEmpty ? ["--allow-empty"] : []), "-m", message],
      this.identityEnv(author, options.hoursLater),
    );
  }

  /** Advance the fixture clock and return the identity/date environment for one commit. */
  private identityEnv(author: Identity, hoursLater = 1): Record<string, string> {
    this.clock += hoursLater;
    const date = `${BASE_EPOCH_SECONDS + this.clock * ONE_HOUR} +0000`;
    return {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    };
  }

  private exec(args: readonly string[], extraEnv: Record<string, string>): string {
    return execFileSync("git", args, {
      cwd: this.dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: this.dir, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C", ...extraEnv },
      maxBuffer: 64 * 1024 * 1024,
    });
  }
}

export interface GroundTruthEntry {
  readonly kind: "file" | "executable" | "symlink" | "submodule";
  /** Line count as Git's numstat counts it; null for binary or non-text entries. */
  readonly loc: number | null;
}

/** Git's own binary heuristic: a NUL byte within the first 8000 bytes. */
const BINARY_SNIFF_BYTES = 8_000;

function countLines(content: Buffer): number | null {
  if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;
  if (content.length === 0) return 0;
  let lines = 0;
  for (const byte of content) if (byte === 0x0a) lines += 1;
  return content[content.length - 1] === 0x0a ? lines : lines + 1;
}

/** The authoritative file set at a commit, straight from Git, for verifying reconstruction. */
export function groundTruthAt(dir: string, commit: string): Map<string, GroundTruthEntry> {
  const listing = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", commit], { cwd: dir });
  const result = new Map<string, GroundTruthEntry>();
  for (const record of listing.toString("utf8").split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode, , object] = record.slice(0, tab).split(" ") as [string, string, string];
    const path = record.slice(tab + 1);
    if (mode === "160000") {
      result.set(path, { kind: "submodule", loc: null });
    } else if (mode === "120000") {
      result.set(path, { kind: "symlink", loc: null });
    } else {
      const content = execFileSync("git", ["cat-file", "blob", object], { cwd: dir });
      result.set(path, { kind: mode === "100755" ? "executable" : "file", loc: countLines(content) });
    }
  }
  return result;
}

/** Small deterministic PRNG (mulberry32) for reproducible randomized tests. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
