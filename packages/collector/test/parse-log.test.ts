import { describe, expect, it } from "vitest";
import { isCtmError, type Commit } from "@ctm/model";
import { parseGitLog } from "../src/parse-log.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const BLOB = "1".repeat(40);
const ZERO = "0".repeat(40);

function header(id: string, parents: string[], message: string): string {
  return `\x1e${id}\x1f${parents.join(" ")}\x1fAda\x1fada@example.com\x1f2024-01-01T00:00:00+00:00\x1f2024-01-01T00:00:00+00:00\x1f${message}\x1f`;
}

/** Assemble tokens exactly the way `git log -z` emits them. */
function stream(...tokens: string[]): Buffer {
  return Buffer.from(tokens.map((token) => `${token}\0`).join(""), "utf8");
}

async function* chunked(buffer: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < buffer.length; i += size) yield buffer.subarray(i, i + size);
}

async function parse(buffer: Buffer, chunkSize = 4096): Promise<Commit[]> {
  const commits: Commit[] = [];
  for await (const commit of parseGitLog(chunked(buffer, chunkSize))) commits.push(commit);
  return commits;
}

describe("GitLogParser", () => {
  it("parses a root commit that adds files", async () => {
    const [commit] = await parse(
      stream(
        header(SHA_A, [], "Initial commit\n\nLonger body.\n"),
        `\n:000000 100644 ${ZERO} ${BLOB} A`, "src/main.ts",
        `:000000 100755 ${ZERO} ${BLOB} A`, "run.sh",
        "3\t0\tsrc/main.ts",
        "1\t0\trun.sh",
      ),
    );
    expect(commit).toMatchObject({
      id: SHA_A,
      parents: [],
      author: { name: "Ada", email: "ada@example.com" },
      subject: "Initial commit",
      body: "Longer body.",
    });
    expect(commit!.changes).toEqual([
      { status: "added", path: "src/main.ts", kind: "file", blobId: BLOB, additions: 3, deletions: 0 },
      { status: "added", path: "run.sh", kind: "executable", blobId: BLOB, additions: 1, deletions: 0 },
    ]);
  });

  it("parses renames in both raw and numstat forms", async () => {
    const [commit] = await parse(
      stream(
        header(SHA_B, [SHA_A], "Move"),
        `\n:100644 100644 ${BLOB} ${BLOB} R087`, "old/name.ts", "new/name.ts",
        "2\t1\t", "old/name.ts", "new/name.ts",
      ),
    );
    expect(commit!.changes).toEqual([
      {
        status: "renamed",
        previousPath: "old/name.ts",
        path: "new/name.ts",
        similarity: 87,
        kind: "file",
        blobId: BLOB,
        additions: 2,
        deletions: 1,
      },
    ]);
  });

  it("represents binary content as null line counts and deletions with no blob", async () => {
    const [commit] = await parse(
      stream(
        header(SHA_B, [SHA_A], "Assets"),
        `\n:100644 100644 ${BLOB} ${BLOB} M`, "logo.png",
        `:100644 000000 ${BLOB} ${ZERO} D`, "gone.txt",
        "-\t-\tlogo.png",
        "0\t4\tgone.txt",
      ),
    );
    expect(commit!.changes[0]).toMatchObject({ status: "modified", additions: null, deletions: null });
    expect(commit!.changes[1]).toMatchObject({ status: "deleted", blobId: null, kind: "file", deletions: 4 });
  });

  it("handles filenames with tabs, newlines and multi-byte characters split across chunks", async () => {
    const weird = "dir/tab\there\nnewline \u00e9\u6f22\u{1F680}.ts";
    const buffer = stream(
      header(SHA_A, [], "Weird"),
      `\n:000000 100644 ${ZERO} ${BLOB} A`, weird,
      `1\t0\t${weird}`,
    );
    // One byte per chunk guarantees every multi-byte sequence is split.
    const [commit] = await parse(buffer, 1);
    expect(commit!.changes[0]!.path).toBe(weird);
  });

  it("keeps commit messages containing our separator characters intact", async () => {
    const message = "Subject \x1f with separator\n\nBody \x1e with record mark";
    const [commit] = await parse(stream(header(SHA_A, [], message)));
    expect(commit!.subject).toBe("Subject \x1f with separator");
    expect(commit!.body).toBe("Body \x1e with record mark");
  });

  it("parses commits without changes followed by more commits", async () => {
    const commits = await parse(
      stream(
        header(SHA_A, [], "Empty"),
        `\n${header(SHA_B, [SHA_A], "Next")}`,
        `\n:000000 100644 ${ZERO} ${BLOB} A`, "a.txt",
        "1\t0\ta.txt",
      ),
    );
    expect(commits.map((c) => [c.subject, c.changes.length])).toEqual([
      ["Empty", 0],
      ["Next", 1],
    ]);
  });

  it("rejects numstat entries that do not match raw entries", async () => {
    const buffer = stream(
      header(SHA_A, [], "Bad"),
      `\n:000000 100644 ${ZERO} ${BLOB} A`, "a.txt",
      "1\t0\tb.txt",
    );
    await expect(parse(buffer)).rejects.toSatisfy((error) => isCtmError(error, "MALFORMED_GIT_OUTPUT"));
  });

  it("rejects streams truncated in the middle of a record", async () => {
    const buffer = stream(header(SHA_A, [], "Cut"), `\n:000000 100644 ${ZERO} ${BLOB} A`, "a.txt");
    await expect(parse(buffer)).rejects.toSatisfy((error) => isCtmError(error, "MALFORMED_GIT_OUTPUT"));
  });

  it("rejects headers with invalid object ids", async () => {
    await expect(parse(stream(header("not-a-sha", [], "x")))).rejects.toSatisfy((error) =>
      isCtmError(error, "MALFORMED_GIT_OUTPUT"),
    );
  });
});
