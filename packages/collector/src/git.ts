import { spawn } from "node:child_process";
import { CtmError } from "@ctm/model";

/**
 * The only place in the codebase that spawns Git.
 *
 * Imported repositories are untrusted. A repository's own config can name
 * programs Git will execute (fsmonitor, pagers, external diff drivers,
 * textconv filters), and user-supplied strings could be mistaken for options.
 * This module neutralises both:
 *
 *  - processes are spawned with an argument array, never through a shell;
 *  - config that can launch programs is overridden on every invocation;
 *  - system/global config and credential prompts are disabled;
 *  - callers must place user-supplied revisions after `--end-of-options`
 *    (see `revisionArgs`), so they can never be parsed as flags.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

const HARDENING_CONFIG: readonly string[] = [
  "core.fsmonitor=false",
  "core.pager=cat",
  "core.hooksPath=/dev/null",
  "diff.external=",
  "log.showSignature=false",
  "safe.directory=*",
].flatMap((setting) => ["-c", setting]);

const HARDENED_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  LC_ALL: "C",
};

export interface GitRunOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** Buffered runs only: abort if stdout exceeds this many bytes. */
  readonly maxBufferedBytes?: number;
  /** Treat these exit codes as success (e.g. `rev-parse --verify -q` exits 1 for "missing"). */
  readonly allowedExitCodes?: readonly number[];
  /** Written to stdin, which is then closed. Without it stdin is closed immediately. */
  readonly input?: string;
}

export interface GitResult {
  readonly stdout: Buffer;
  readonly exitCode: number;
}

function spawnGit(args: readonly string[], options: GitRunOptions) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const child = spawn("git", [...HARDENING_CONFIG, ...args], {
    cwd: options.cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...HARDENED_ENV },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    // Keep only the tail; stderr is diagnostic, not data.
    stderr = (stderr + chunk).slice(-8_192);
  });

  // Git may exit before consuming all input (e.g. on error); that surfaces via the exit code.
  child.stdin.on("error", () => undefined);
  child.stdin.end(options.input);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  const exit = new Promise<number>((resolve, reject) => {
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(new CtmError("GIT_NOT_INSTALLED", "The git executable was not found on PATH."));
      } else {
        reject(new CtmError("GIT_COMMAND_FAILED", `Failed to start git: ${error.message}`));
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new CtmError("GIT_TIMEOUT", `git ${args[0]} exceeded ${timeoutMs}ms`, { args }));
        return;
      }
      const exitCode = code ?? -1;
      const allowed = options.allowedExitCodes ?? [0];
      if (!allowed.includes(exitCode)) {
        reject(
          new CtmError("GIT_COMMAND_FAILED", `git ${args[0]} exited with ${exitCode}`, {
            args,
            stderr: stderr.trim(),
          }),
        );
        return;
      }
      resolve(exitCode);
    });
  });

  return { child, exit };
}

/** Run Git and buffer stdout. For small outputs (refs, rev-parse, counts). */
export async function runGit(args: readonly string[], options: GitRunOptions): Promise<GitResult> {
  const { child, exit } = spawnGit(args, options);
  const limit = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const chunks: Buffer[] = [];
  let size = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > limit) {
      child.kill("SIGKILL");
      return;
    }
    chunks.push(chunk);
  });
  const exitCode = await exit;
  if (size > limit) {
    throw new CtmError("REPOSITORY_TOO_LARGE", `git ${args[0]} output exceeded ${limit} bytes`);
  }
  return { stdout: Buffer.concat(chunks), exitCode };
}

/**
 * Run Git and stream stdout. Used for `git log`, whose output is proportional
 * to repository history and must never be buffered whole.
 */
export async function* streamGit(
  args: readonly string[],
  options: GitRunOptions,
): AsyncGenerator<Buffer, void, undefined> {
  const { child, exit } = spawnGit(args, options);
  // Surface spawn/exit errors even if the consumer stops early.
  const settled = exit.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    for await (const chunk of child.stdout) {
      yield chunk as Buffer;
    }
    const failure = await settled;
    if (failure !== undefined) throw failure;
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

/** Revision arguments that cannot be interpreted as options, whatever their content. */
export function revisionArgs(revisions: readonly string[]): string[] {
  return ["--end-of-options", ...revisions];
}
