import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/index.ts";

describe("parseUnifiedDiff", () => {
  it("parses modifications, renames, additions and binary files with line numbers", () => {
    const text = [
      "diff --git a/src/api.ts b/src/api.ts",
      "index 1..2 100644",
      "--- a/src/api.ts",
      "+++ b/src/api.ts",
      "@@ -10,3 +10,4 @@ export function users() {",
      " const a = 1;",
      "-const users = await db.users.findAll();",
      "+const users = await cache.get(\"users\");",
      "+if (!users) refresh();",
      " return users;",
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
      "diff --git a/added.txt b/added.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/added.txt",
      "@@ -0,0 +1 @@",
      "+hello",
      "\\ No newline at end of file",
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n");
    const [modified, renamed, added, binary] = parseUnifiedDiff(text);
    expect(modified!.hunks[0]!.lines.map((l) => [l.type, l.oldLine, l.newLine])).toEqual([
      ["context", 10, 10],
      ["del", 11, null],
      ["add", null, 11],
      ["add", null, 12],
      ["context", 12, 13],
    ]);
    expect(renamed).toMatchObject({ oldPath: "old.ts", newPath: "new.ts", hunks: [] });
    expect(added).toMatchObject({ oldPath: null, newPath: "added.txt" });
    expect(added!.hunks[0]!.lines).toHaveLength(1);
    expect(binary!.binary).toBe(true);
  });
});
