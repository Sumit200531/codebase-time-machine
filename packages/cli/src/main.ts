import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { collectRepository } from "@ctm/collector";
import { isCtmError } from "@ctm/model";
import { Timeline, buildDirectoryTree } from "@ctm/temporal";
import { buildBundle } from "@ctm/export";

const USAGE = `Usage: npm run analyze -- <repository-path> [--ref <ref>] [--bundle <out.json>] [--json <out.json>] [--max-commits <n>]

  --bundle  write an exploration bundle to open in the web explorer ("Open bundle")
  --json    write the raw normalized model, steps, stats and events

Collects a local Git repository into the normalized model, builds its
temporal model, and prints a summary of how it evolved.`;

const MAX_LANGUAGES_SHOWN = 6;
const MAX_DIRECTORIES_SHOWN = 8;
const EVOLUTION_SAMPLES = 6;

const number = new Intl.NumberFormat("en-US");

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      ref: { type: "string" },
      json: { type: "string" },
      bundle: { type: "string" },
      "max-commits": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const path = positionals[0];
  if (values.help || !path) {
    console.log(USAGE);
    return path ? 0 : 1;
  }

  const started = performance.now();
  const model = await collectRepository(resolve(path), {
    ...(values.ref ? { ref: values.ref } : {}),
    ...(values["max-commits"] ? { maxCommits: Number(values["max-commits"]) } : {}),
  });
  const collected = performance.now();
  const timeline = Timeline.build(model);
  const built = performance.now();

  const last = timeline.length - 1;
  const final = timeline.stats[last]!;
  const first = timeline.steps[0]!;
  const head = timeline.steps[last]!;
  const counts = { born: 0, changed: 0, moved: 0, died: 0 };
  for (const event of timeline.events) counts[event.kind] += 1;

  console.log(`\nCODEBASE TIME MACHINE · ${model.source.label}${model.isShallow ? "  (shallow clone: early history unavailable)" : ""}`);
  console.log(`Anchor      ${model.headRefName ?? "detached"} @ ${head.commitId.slice(0, 10)}`);
  console.log(`Span        ${first.committedAt.slice(0, 10)} → ${head.committedAt.slice(0, 10)}`);
  console.log(`Commits     ${number.format(model.commits.length)} collected · ${number.format(timeline.length)} mainline steps`);
  console.log(`Refs        ${model.refs.length} (${model.refs.filter((r) => r.kind === "tag").length} tags)`);
  console.log(`Now         ${number.format(final.files)} files · ${number.format(final.loc)} lines · ${final.contributorsReachable} contributors`);
  console.log(`Lifecycle   ${number.format(counts.born)} born · ${number.format(counts.changed)} changed · ${number.format(counts.moved)} moved · ${number.format(counts.died)} died`);

  console.log("\nLanguages (by lines)");
  Object.entries(final.languages)
    .sort(([, a], [, b]) => b.loc - a.loc)
    .slice(0, MAX_LANGUAGES_SHOWN)
    .forEach(([language, { files, loc }]) =>
      console.log(`  ${language.padEnd(14)} ${number.format(loc).padStart(9)} lines  ${number.format(files).padStart(6)} files`),
    );

  console.log("\nTop-level directories");
  buildDirectoryTree(timeline.snapshotAt(last))
    .directories.slice()
    .sort((a, b) => b.loc - a.loc)
    .slice(0, MAX_DIRECTORIES_SHOWN)
    .forEach((dir) => console.log(`  ${(dir.path + "/").padEnd(24)} ${number.format(dir.loc).padStart(9)} lines  ${number.format(dir.fileCount).padStart(6)} files`));

  console.log("\nEvolution");
  for (let i = 0; i < EVOLUTION_SAMPLES; i++) {
    const step = Math.round((i / (EVOLUTION_SAMPLES - 1)) * last);
    const info = timeline.steps[step]!;
    const point = timeline.stats[step]!;
    console.log(
      `  ${info.committedAt.slice(0, 10)}  step ${String(step).padStart(6)}  ${number.format(point.files).padStart(6)} files  ${number.format(point.loc).padStart(9)} lines  ${String(point.contributorsReachable).padStart(4)} people`,
    );
  }

  console.log(`\nCollected in ${(collected - started).toFixed(0)} ms · temporal model in ${(built - collected).toFixed(0)} ms`);

  if (values.bundle) {
    const bundle = await buildBundle(resolve(path), {
      ...(values.ref ? { ref: values.ref } : {}),
      ...(values["max-commits"] ? { maxCommits: Number(values["max-commits"]) } : {}),
      onProgress: (message) => console.log(`· ${message}`),
    });
    const text = JSON.stringify(bundle);
    writeFileSync(values.bundle, text);
    console.log(`Wrote ${values.bundle} (${(text.length / 1024 / 1024).toFixed(1)} MiB). Open it in the explorer with "Open bundle".`);
  }

  if (values.json) {
    writeFileSync(values.json, JSON.stringify({ model, steps: timeline.steps, stats: timeline.stats, events: timeline.events }));
    console.log(`Wrote ${values.json}`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (isCtmError(error)) {
      console.error(`error [${error.code}]: ${error.message}`);
      return process.exit(2);
    }
    console.error(error);
    return process.exit(1);
  },
);
