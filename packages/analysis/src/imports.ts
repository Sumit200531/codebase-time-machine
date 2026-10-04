import { builtinModules } from "node:module";
import { languageOf } from "./language.ts";

/**
 * Lexical import extraction for JavaScript/TypeScript and Python.
 *
 * This is pattern matching over comment-stripped source, not parsing. It
 * recognises the import forms real projects use overwhelmingly, and its
 * output is labelled as lexical in the UI. tree-sitter replaces it for exact
 * results (see ARCHITECTURE.md §3).
 */

export const IMPORT_ANALYZER_VERSION = 1;

const JS_LANGUAGES = new Set(["TypeScript", "JavaScript", "Vue", "Svelte"]);
const JS_IMPORT_PATTERNS: readonly RegExp[] = [
  /\bimport\s+(?:type\s+)?[\w*{}\s,$]+?\s+from\s+["']([^"'\n]+)["']/g,
  /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s+from\s+["']([^"'\n]+)["']/g,
  /\bimport\s+["']([^"'\n]+)["']/g,
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
];
const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"];
const NODE_BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

function stripJsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function stripPythonComments(source: string): string {
  return source.replace(/(^|\s)#.*$/gm, "$1");
}

export function extractImports(path: string, source: string): string[] {
  const language = languageOf(path);
  const found = new Set<string>();
  if (JS_LANGUAGES.has(language)) {
    const code = stripJsComments(source);
    for (const pattern of JS_IMPORT_PATTERNS) {
      for (const match of code.matchAll(pattern)) found.add(match[1]!);
    }
  } else if (language === "Python") {
    const code = stripPythonComments(source);
    for (const match of code.matchAll(/^\s*from\s+(\.+[\w.]*|[\w.]+)\s+import\b/gm)) found.add(match[1]!);
    for (const match of code.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) {
      for (const name of match[1]!.split(",")) found.add(name.trim());
    }
  }
  return [...found];
}

export type ResolvedImport =
  | { readonly kind: "internal"; readonly path: string }
  | { readonly kind: "external"; readonly name: string };

function normalize(parts: string[]): string | null {
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null; // escapes the repository root
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

function directoryOf(path: string): string[] {
  return path.split("/").slice(0, -1);
}

function resolveJs(from: string, specifier: string, exists: (path: string) => boolean): ResolvedImport | null {
  if (specifier.startsWith(".")) {
    const base = normalize([...directoryOf(from), ...specifier.split("/")]);
    if (base === null) return null;
    const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, ""); // TS "./x.js" may point at x.ts
    const candidates = [
      base,
      ...JS_EXTENSIONS.map((ext) => stem + ext),
      ...JS_EXTENSIONS.map((ext) => `${base}/index${ext}`),
    ];
    const hit = candidates.find(exists);
    return hit ? { kind: "internal", path: hit } : null;
  }
  const bare = specifier.replace(/^node:/, "");
  if (specifier.startsWith("node:") || NODE_BUILTINS.has(bare.split("/")[0]!)) return null;
  const segments = specifier.split("/");
  const name = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!;
  return { kind: "external", name };
}

function resolvePython(from: string, specifier: string, exists: (path: string) => boolean): ResolvedImport | null {
  const dots = specifier.match(/^\.*/)![0].length;
  const modulePath = specifier.slice(dots).split(".").filter(Boolean);
  const roots: string[][] =
    dots > 0
      ? [directoryOf(from).slice(0, directoryOf(from).length - (dots - 1))]
      : [[], [directoryOf(from)[0] ?? ""], ["src"]];
  for (const root of roots) {
    const base = normalize([...root, ...modulePath]);
    if (base === null) continue;
    for (const candidate of [`${base}.py`, `${base}/__init__.py`]) {
      if (exists(candidate)) return { kind: "internal", path: candidate };
    }
  }
  if (dots > 0) return null;
  return { kind: "external", name: modulePath[0]! };
}

/** Resolve a specifier from `from` against the files that exist at the same point in time. */
export function resolveImport(from: string, specifier: string, exists: (path: string) => boolean): ResolvedImport | null {
  return languageOf(from) === "Python" ? resolvePython(from, specifier, exists) : resolveJs(from, specifier, exists);
}

export function supportsImports(path: string): boolean {
  const language = languageOf(path);
  return JS_LANGUAGES.has(language) || language === "Python";
}
