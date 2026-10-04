import { CtmError, type ObjectId } from "@ctm/model";
import { runGit, streamGit } from "./git.ts";

/**
 * Content access for blobs, via `git cat-file --batch`. Content is only ever
 * counted or tokenized as text, never interpreted or executed.
 */

export const MAX_MEASURED_BLOB_BYTES = 4 * 1024 * 1024;
/** Git's binary heuristic: a NUL byte within the first 8000 bytes (xdiff FIRST_FEW_BYTES). */
const BINARY_SNIFF_BYTES = 8_000;
const NEWLINE = 0x0a;

export function isBinaryContent(content: Buffer): boolean {
  return content.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** Lines as Git's numstat counts them: a final line without "\n" still counts. null for binary. */
export function countLines(content: Buffer): number | null {
  if (isBinaryContent(content)) return null;
  if (content.length === 0) return 0;
  let lines = 0;
  for (let i = content.indexOf(NEWLINE); i !== -1; i = content.indexOf(NEWLINE, i + 1)) lines += 1;
  return content[content.length - 1] === NEWLINE ? lines : lines + 1;
}

/** Ids of objects that are blobs no larger than `maxBytes`. */
async function filterBlobsBySize(cwd: string, ids: readonly ObjectId[], maxBytes: number): Promise<Set<ObjectId>> {
  const wanted = new Set(ids);
  const check = await runGit(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    cwd,
    input: ids.join("\n") + "\n",
  });
  const accepted = new Set<ObjectId>();
  for (const line of check.stdout.toString("utf8").split("\n")) {
    const [id, type, size] = line.split(" ");
    if (id && wanted.has(id) && type === "blob" && Number(size) <= maxBytes) accepted.add(id);
  }
  return accepted;
}

/**
 * Stream `(id, content)` for each requested blob that exists and is within
 * `maxBytes`. Buffering per object is bounded by `maxBytes`.
 */
export async function* readBlobs(
  cwd: string,
  ids: Iterable<ObjectId>,
  options: { maxBytes?: number; timeoutMs?: number } = {},
): AsyncGenerator<{ id: ObjectId; content: Buffer }> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const accepted = [...(await filterBlobsBySize(cwd, unique, options.maxBytes ?? MAX_MEASURED_BLOB_BYTES))];
  if (accepted.length === 0) return;

  // Output per object: "<id> blob <size>\n" <size bytes> "\n".
  let pending: Buffer = Buffer.alloc(0);
  let current: { id: ObjectId; size: number } | null = null;
  const chunks = streamGit(["cat-file", "--batch"], {
    cwd,
    input: accepted.join("\n") + "\n",
    timeoutMs: options.timeoutMs ?? 600_000,
  });
  for await (const chunk of chunks) {
    pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    for (;;) {
      if (!current) {
        const end = pending.indexOf(NEWLINE);
        if (end === -1) break;
        const [id = "", type, size] = pending.subarray(0, end).toString("utf8").split(" ");
        pending = pending.subarray(end + 1);
        if (type !== "blob" || size === undefined) continue; // "<id> missing"
        current = { id, size: Number(size) };
      }
      if (pending.length < current.size + 1) break;
      if (pending[current.size] !== NEWLINE) {
        throw new CtmError("MALFORMED_GIT_OUTPUT", "cat-file object not newline-terminated");
      }
      yield { id: current.id, content: Buffer.from(pending.subarray(0, current.size)) };
      pending = pending.subarray(current.size + 1);
      current = null;
    }
  }
  if (current || pending.length > 0) throw new CtmError("MALFORMED_GIT_OUTPUT", "cat-file output ended mid-object");
}

/**
 * Line counts per blob: a number for text, null for binary, oversized or
 * missing objects. Used where numstat could not report a delta.
 */
export async function measureBlobs(
  cwd: string,
  blobIds: ReadonlySet<ObjectId>,
  options: { timeoutMs?: number } = {},
): Promise<Map<ObjectId, number | null>> {
  const results = new Map<ObjectId, number | null>([...blobIds].map((id) => [id, null]));
  for await (const { id, content } of readBlobs(cwd, blobIds, options)) results.set(id, countLines(content));
  return results;
}
