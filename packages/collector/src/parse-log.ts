import { CtmError, type ChangeStatus, type Commit, type EntryKind, type FileChange } from "@ctm/model";

/**
 * Parser for:
 *
 *   git log -z --raw --numstat -M --no-abbrev --format=LOG_FORMAT
 *
 * Why this exact shape: with -z, Git emits NUL-separated tokens and never
 * quotes paths, so filenames containing tabs, newlines or quotes are
 * unambiguous. Each `--raw` entry states its status (and therefore how many
 * path tokens follow), and `--numstat` emits exactly one entry per raw entry,
 * in the same order. That lets us consume the stream with a deterministic
 * state machine instead of guessing where one record ends.
 *
 * Token stream for one commit:
 *
 *   HEADER                        "\x1e" fields joined by "\x1f", ending "\x1f"
 *   RAW  x N                      "[\n]:<srcmode> <dstmode> <srcsha> <dstsha> <status>"
 *                                 then 1 path token, or 2 for renames/copies
 *   NUMSTAT x N                   "<add>\t<del>\t<path>"  or
 *                                 "<add>\t<del>\t" then 2 path tokens (renames)
 */

const RECORD_START = "\x1e";
const FIELD_SEP = "\x1f";
/** Field order must match `parseHeader`. %aN/%aE apply the repository's .mailmap. */
export const LOG_FORMAT = `${RECORD_START}%H${FIELD_SEP}%P${FIELD_SEP}%aN${FIELD_SEP}%aE${FIELD_SEP}%aI${FIELD_SEP}%cI${FIELD_SEP}%B${FIELD_SEP}`;
const FIXED_HEADER_FIELDS = 6;

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const NULL_OBJECT_ID = /^0+$/;
const RAW_ENTRY = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d{0,3})$/;

interface PendingRaw {
  status: ChangeStatus;
  path: string;
  previousPath?: string;
  similarity?: number;
  kind: EntryKind;
  blobId: string | null;
}

type ParserState =
  | { kind: "expect-header" }
  | { kind: "expect-raw-or-next"; commit: CommitDraft }
  | { kind: "expect-raw-paths"; commit: CommitDraft; meta: RawMeta; paths: string[] }
  | { kind: "expect-numstat"; commit: CommitDraft; index: number }
  | { kind: "expect-numstat-paths"; commit: CommitDraft; index: number; counts: LineCounts; paths: number };

interface CommitDraft {
  header: Omit<Commit, "changes">;
  raw: PendingRaw[];
  changes: FileChange[];
}

interface RawMeta {
  status: ChangeStatus;
  pathCount: 1 | 2;
  similarity?: number;
  kind: EntryKind;
  blobId: string | null;
}

interface LineCounts {
  additions: number | null;
  deletions: number | null;
}

function malformed(message: string, token: string): never {
  throw new CtmError("MALFORMED_GIT_OUTPUT", message, { token: token.slice(0, 200) });
}

function kindFromMode(mode: string): EntryKind {
  switch (mode) {
    case "120000":
      return "symlink";
    case "160000":
      return "submodule";
    case "100755":
      return "executable";
    default:
      return "file";
  }
}

function parseHeader(token: string): Omit<Commit, "changes"> {
  // Messages cannot contain NUL, but may contain our field separator, so the
  // message is everything between the fixed fields and the trailing separator.
  const fields = token.slice(RECORD_START.length).split(FIELD_SEP);
  if (fields.length < FIXED_HEADER_FIELDS + 2 || fields[fields.length - 1] !== "") {
    malformed("Commit header has an unexpected shape", token);
  }
  const [id, parentList, authorName, authorEmail, authoredAt, committedAt] = fields as [
    string, string, string, string, string, string,
  ];
  if (!OBJECT_ID.test(id)) malformed("Commit header has an invalid object id", token);
  const parents = parentList === "" ? [] : parentList.split(" ");
  if (!parents.every((parent) => OBJECT_ID.test(parent))) {
    malformed("Commit header has an invalid parent id", token);
  }
  const message = fields.slice(FIXED_HEADER_FIELDS, -1).join(FIELD_SEP).replace(/\n+$/, "");
  const newline = message.indexOf("\n");
  const subject = newline === -1 ? message : message.slice(0, newline);
  const body = newline === -1 ? "" : message.slice(newline + 1).replace(/^\n+/, "");
  return {
    id,
    parents,
    author: { name: authorName, email: authorEmail },
    authoredAt,
    committedAt,
    subject,
    body,
  };
}

function parseRawMeta(token: string): RawMeta {
  const match = RAW_ENTRY.exec(token);
  if (!match) malformed("Unrecognised raw diff entry", token);
  const [, srcMode, dstMode, , dstSha, letter, score] = match as unknown as [
    string, string, string, string, string, string, string,
  ];
  const blobId = NULL_OBJECT_ID.test(dstSha) ? null : dstSha;
  switch (letter) {
    case "A":
      return { status: "added", pathCount: 1, kind: kindFromMode(dstMode), blobId };
    case "M":
      return { status: "modified", pathCount: 1, kind: kindFromMode(dstMode), blobId };
    case "T":
      return { status: "typechanged", pathCount: 1, kind: kindFromMode(dstMode), blobId };
    case "D":
      return { status: "deleted", pathCount: 1, kind: kindFromMode(srcMode), blobId: null };
    case "R":
      return {
        status: "renamed",
        pathCount: 2,
        similarity: Number(score),
        kind: kindFromMode(dstMode),
        blobId,
      };
    default:
      // C (copy) is never requested; U/X cannot occur in committed history.
      return malformed(`Unsupported change status "${letter}"`, token);
  }
}

function parseCount(value: string, token: string): number | null {
  if (value === "-") return null; // binary
  if (!/^\d+$/.test(value)) malformed("Invalid numstat count", token);
  return Number(value);
}

/**
 * Incremental parser. Feed it NUL-delimited tokens; it returns each commit as
 * soon as the commit is complete. Call `finish()` after the last token.
 */
export class GitLogParser {
  private state: ParserState = { kind: "expect-header" };

  /** Returns a completed commit when `token` terminates one, otherwise null. */
  push(rawToken: string): Commit | null {
    const state = this.state;
    switch (state.kind) {
      case "expect-header":
        return this.startCommit(rawToken);

      case "expect-raw-or-next": {
        const token = rawToken.startsWith("\n") ? rawToken.slice(1) : rawToken;
        if (token.startsWith(":")) {
          const meta = parseRawMeta(token);
          this.state = { kind: "expect-raw-paths", commit: state.commit, meta, paths: [] };
          return null;
        }
        if (state.commit.raw.length > 0) {
          // Raw section is over; this token is the first numstat entry.
          this.state = { kind: "expect-numstat", commit: state.commit, index: 0 };
          return this.push(rawToken);
        }
        // A commit with no changes (e.g. empty commit): next header starts here.
        const done = this.complete(state.commit);
        this.startCommit(rawToken);
        return done;
      }

      case "expect-raw-paths": {
        state.paths.push(rawToken);
        if (state.paths.length < state.meta.pathCount) return null;
        const { meta } = state;
        const pending: PendingRaw =
          meta.pathCount === 2
            ? {
                status: meta.status,
                previousPath: state.paths[0]!,
                path: state.paths[1]!,
                kind: meta.kind,
                blobId: meta.blobId,
                ...(meta.similarity !== undefined ? { similarity: meta.similarity } : {}),
              }
            : { status: meta.status, path: state.paths[0]!, kind: meta.kind, blobId: meta.blobId };
        state.commit.raw.push(pending);
        this.state = { kind: "expect-raw-or-next", commit: state.commit };
        return null;
      }

      case "expect-numstat": {
        const parts = rawToken.split("\t");
        if (parts.length < 3) malformed("Invalid numstat entry", rawToken);
        const counts: LineCounts = {
          additions: parseCount(parts[0]!, rawToken),
          deletions: parseCount(parts[1]!, rawToken),
        };
        const pathPart = parts.slice(2).join("\t");
        if (pathPart === "") {
          // Rename form: two path tokens follow.
          this.state = { kind: "expect-numstat-paths", commit: state.commit, index: state.index, counts, paths: 0 };
          return null;
        }
        return this.recordNumstat(state.commit, state.index, counts, pathPart, rawToken);
      }

      case "expect-numstat-paths": {
        state.paths += 1;
        if (state.paths < 2) return null;
        return this.recordNumstat(state.commit, state.index, state.counts, rawToken, rawToken);
      }
    }
  }

  /** Flush the final commit. Throws if the stream ended mid-record. */
  finish(): Commit | null {
    const state = this.state;
    this.state = { kind: "expect-header" };
    switch (state.kind) {
      case "expect-header":
        return null;
      case "expect-raw-or-next":
        if (state.commit.raw.length === 0) return this.complete(state.commit);
        return malformed("Stream ended before numstat section", "");
      default:
        return malformed(`Stream ended unexpectedly (state: ${state.kind})`, "");
    }
  }

  private startCommit(rawToken: string): null {
    const token = rawToken.startsWith("\n") ? rawToken.slice(1) : rawToken;
    if (!token.startsWith(RECORD_START)) malformed("Expected a commit header", token);
    this.state = {
      kind: "expect-raw-or-next",
      commit: { header: parseHeader(token), raw: [], changes: [] },
    };
    return null;
  }

  private recordNumstat(
    commit: CommitDraft,
    index: number,
    counts: LineCounts,
    path: string,
    token: string,
  ): Commit | null {
    const raw = commit.raw[index];
    if (!raw) malformed("More numstat entries than raw entries", token);
    if (raw.path !== path) {
      throw new CtmError("MALFORMED_GIT_OUTPUT", "numstat entry does not match raw entry", {
        expected: raw.path,
        actual: path,
        commit: commit.header.id,
      });
    }
    commit.changes.push({ ...raw, ...counts });
    if (index + 1 < commit.raw.length) {
      this.state = { kind: "expect-numstat", commit, index: index + 1 };
      return null;
    }
    this.state = { kind: "expect-header" };
    return this.complete(commit);
  }

  private complete(commit: CommitDraft): Commit {
    return { ...commit.header, changes: commit.changes };
  }
}

/**
 * Split a byte stream on NUL and decode each token as UTF-8. Splitting happens
 * on bytes before decoding, so multi-byte characters spanning chunk boundaries
 * are handled correctly.
 */
export async function* nulTokens(chunks: AsyncIterable<Buffer>): AsyncGenerator<string> {
  let carry: Buffer = Buffer.alloc(0);
  for await (const chunk of chunks) {
    let buffer = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    let start = 0;
    let nul = buffer.indexOf(0, start);
    while (nul !== -1) {
      yield buffer.toString("utf8", start, nul);
      start = nul + 1;
      nul = buffer.indexOf(0, start);
    }
    carry = buffer.subarray(start);
    buffer = carry;
  }
  // Git terminates the last numstat token with NUL; a trailing newline-only
  // remainder is harmless. Anything else is a real token without terminator.
  const rest = carry.toString("utf8");
  if (rest.trim() !== "") yield rest;
}

export async function* parseGitLog(chunks: AsyncIterable<Buffer>): AsyncGenerator<Commit> {
  const parser = new GitLogParser();
  for await (const token of nulTokens(chunks)) {
    const commit = parser.push(token);
    if (commit) yield commit;
  }
  const last = parser.finish();
  if (last) yield last;
}
