import type { Bundle } from "@ctm/export/types";
import demo from "../data/taskflow.json";

export type { Bundle } from "@ctm/export/types";

export const DEMO_BUNDLE = demo as unknown as Bundle;
const SUPPORTED_SCHEMA = 1;

/** Validate a bundle produced by `npm run analyze -- <repo> --bundle out.json`. */
export function parseBundle(text: string): Bundle {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("This file is not valid JSON. Choose a bundle created by the analyze command.");
  }
  const candidate = data as Partial<Bundle> | null;
  if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.steps) || !Array.isArray(candidate.events)) {
    throw new Error("This JSON file is not a Codebase Time Machine bundle.");
  }
  if (candidate.schemaVersion !== SUPPORTED_SCHEMA) {
    throw new Error(`Bundle schema ${String(candidate.schemaVersion)} is not supported; rebuild it with this version.`);
  }
  if (candidate.steps.length === 0) throw new Error("The bundle contains no commits.");
  return candidate as Bundle;
}
