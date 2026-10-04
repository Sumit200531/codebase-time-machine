import { afterAll, describe, expect, it } from "vitest";
import { collectRepository, readBlobs } from "@ctm/collector";
import { extractImports } from "@ctm/analysis";
import { Timeline, buildDependencyIntervals, edgesAt } from "../src/index.ts";
import { FixtureRepo } from "../../../test-support/fixture-repo.ts";

const repo = FixtureRepo.create();
afterAll(() => repo.dispose());

describe("buildDependencyIntervals", () => {
  it("opens, keeps across renames, and closes edges at the right steps", async () => {
    repo.write("src/main.js", 'import u from "./utils.js";\n').commit("0: main imports missing utils");
    repo.write("src/utils.js", 'import x from "lodash";\n').commit("1: utils appears, resolving the import");
    repo.move("src/utils.js", "lib/utils.js");
    repo.write("src/main.js", 'import u from "../lib/utils.js";\n').commit("2: utils moves, import updated");
    repo.write("src/main.js", "export {};\n").commit("3: import removed");

    const model = await collectRepository(repo.dir);
    const timeline = Timeline.build(model);
    const imports = new Map<string, string[]>();
    const blobs = model.commits.flatMap((c) => c.changes.flatMap((ch) => (ch.blobId ? [[ch.blobId, ch.path] as const] : [])));
    const pathOf = new Map(blobs);
    for await (const { id, content } of readBlobs(repo.dir, pathOf.keys())) {
      imports.set(id, extractImports(pathOf.get(id)!, content.toString("utf8")));
    }
    const edges = buildDependencyIntervals(timeline, (blob) => imports.get(blob));

    const internal = edges.filter((e) => e.to !== null);
    expect(internal).toHaveLength(1); // one edge, preserved through the rename
    expect(internal[0]).toMatchObject({ fromStep: 1, toStep: 3 });
    expect(edges.find((e) => e.external === "lodash")).toMatchObject({ fromStep: 1, toStep: null });
    expect(edgesAt(edges, 0)).toHaveLength(0);
    expect(edgesAt(edges, 2)).toHaveLength(2);
    expect(edgesAt(edges, 3)).toHaveLength(1);
  });
});
