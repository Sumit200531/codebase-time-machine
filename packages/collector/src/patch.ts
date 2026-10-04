import type { ObjectId } from "@ctm/model";
import { revisionArgs, runGit } from "./git.ts";

/** Unified-diff structures for the diff viewer. */

export type PatchLineType = "context" | "add" | "del";

export interface PatchLine {
  readonly type: PatchLineType;
  readonly text: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

export interface PatchHunk {
  readonly header: string;
  readonly lines: readonly PatchLine[];
}

export interface FilePatch {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly binary: boolean;
  readonly hunks: readonly PatchHunk[];
}

export interface CommitPatch {
  readonly files: readonly FilePatch[];
  /** True when the patch exceeded the byte budget and later files were dropped. */
  readonly truncated: boolean;
}

export const DEFAULT_MAX_PATCH_BYTES = 256 * 1024;

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** Undo Git's C-style quoting of unusual path names ("a/t\\tab"). */
function unquote(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const escapes: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\" };
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
    } else if (/[0-7]/.test(body[i + 1] ?? "")) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(...Buffer.from(escapes[body[i + 1] ?? ""] ?? body[i + 1] ?? "", "utf8"));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function stripPrefix(path: string): string | null {
  const unquoted = unquote(path);
  if (unquoted === "/dev/null") return null;
  return unquoted.replace(/^[ab]\//, "");
}

/** Parse `git show -p` output. Exported for unit tests. */
export function parseUnifiedDiff(text: string): FilePatch[] {
  const files: FilePatch[] = [];
  let file: { oldPath: string | null; newPath: string | null; binary: boolean; hunks: PatchHunk[] } | null = null;
  let hunk: { header: string; lines: PatchLine[] } | null = null;
  let oldLine = 0;
  let newLine = 0;

  const flush = () => {
    if (file) files.push(file);
    file = null;
    hunk = null;
  };

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      file = { oldPath: null, newPath: null, binary: false, hunks: [] };
      continue;
    }
    if (!file) continue;
    const current: { oldPath: string | null; newPath: string | null; binary: boolean; hunks: PatchHunk[] } = file;
    if (!hunk) {
      if (line.startsWith("--- ")) current.oldPath = stripPrefix(line.slice(4));
      else if (line.startsWith("+++ ")) current.newPath = stripPrefix(line.slice(4));
      else if (line.startsWith("rename from ")) current.oldPath = unquote(line.slice(12));
      else if (line.startsWith("rename to ")) current.newPath = unquote(line.slice(10));
      else if (line.startsWith("Binary files ")) current.binary = true;
    }
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      hunk = { header: line, lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const open: { header: string; lines: PatchLine[] } = hunk;
    const marker = line[0];
    if (marker === "+") open.lines.push({ type: "add", text: line.slice(1), oldLine: null, newLine: newLine++ });
    else if (marker === "-") open.lines.push({ type: "del", text: line.slice(1), oldLine: oldLine++, newLine: null });
    else if (marker === " ") open.lines.push({ type: "context", text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
    // "\ No newline at end of file" and blank separators are ignored.
  }
  flush();
  return files;
}

/** The commit's patch against its first parent, bounded in size. */
export async function readCommitPatch(
  cwd: string,
  commitId: ObjectId,
  options: { maxBytes?: number } = {},
): Promise<CommitPatch> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PATCH_BYTES;
  const result = await runGit(
    ["show", "--format=", "-p", "-M", "--no-ext-diff", "--no-textconv", "--no-color", "--diff-merges=first-parent", ...revisionArgs([commitId])],
    { cwd, maxBufferedBytes: 64 * 1024 * 1024 },
  );
  const text = result.stdout.toString("utf8");
  if (text.length <= maxBytes) return { files: parseUnifiedDiff(text), truncated: false };
  // Cut at a file boundary so no file is shown half-parsed.
  const cut = text.lastIndexOf("\ndiff --git ", maxBytes);
  return { files: parseUnifiedDiff(cut > 0 ? text.slice(0, cut) : ""), truncated: true };
}
