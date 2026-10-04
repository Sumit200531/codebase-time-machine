/**
 * Verify the temporal reconstruction of any local repository against Git itself
 * at a spread of mainline steps (including both sides of keyframe boundaries).
 *
 *   npm run verify -- /path/to/repo
 */
import { execFileSync } from "node:child_process";
import { collectRepository } from "@ctm/collector";
import { KEYFRAME_INTERVAL, Timeline } from "@ctm/temporal";
import { groundTruthAt } from "../test-support/fixture-repo.ts";

const dir = process.argv[2]!;
const timeline = Timeline.build(await collectRepository(dir));
const n = timeline.length;
const spread = Array.from({ length: 8 }, (_, i) => Math.round((i / 7) * (n - 1)));
const keyframeEdges = [KEYFRAME_INTERVAL - 1, KEYFRAME_INTERVAL, KEYFRAME_INTERVAL + 1];
const samples = [...new Set([0, 1, ...keyframeEdges, ...spread, n - 2])].filter((s) => s >= 0 && s < n).sort((a, b) => a - b);
let failures = 0;
for (const step of samples) {
  const info = timeline.steps[step]!;
  const truth = groundTruthAt(dir, info.commitId);
  const snap = timeline.snapshotAt(step);
  const pathsOk = snap.size === truth.size && [...truth.keys()].every((p) => snap.has(p));
  const locMismatch = [...truth].filter(([p, t]) => snap.get(p)?.loc !== t.loc);
  const reach = Number(execFileSync("git", ["rev-list", "--count", info.commitId], { cwd: dir, encoding: "utf8" }));
  const ok = pathsOk && locMismatch.length === 0 && reach === timeline.stats[step]!.commitsReachable;
  if (!ok) failures++;
  console.log(`step ${String(step).padStart(5)} ${info.committedAt.slice(0,10)} files=${truth.size} paths=${pathsOk ? "ok" : "MISMATCH"} loc=${locMismatch.length === 0 ? "ok" : locMismatch.length + " off " + JSON.stringify(locMismatch.slice(0,2))} reachable=${reach === timeline.stats[step]!.commitsReachable ? "ok" : "MISMATCH"}`);
}
console.log(failures === 0 ? "ALL SAMPLES MATCH GIT" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
