/**
 * Path-based language classification. Content is never inspected or executed;
 * Milestone 2 refines this with tree-sitter grammars for supported languages.
 */

export type Language = string;
export const UNKNOWN_LANGUAGE: Language = "Other";

const BY_EXTENSION: Readonly<Record<string, Language>> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", pyi: "Python",
  go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", kts: "Kotlin", scala: "Scala",
  rb: "Ruby", php: "PHP", cs: "C#", fs: "F#", swift: "Swift", dart: "Dart",
  c: "C", h: "C", cc: "C++", cpp: "C++", cxx: "C++", hpp: "C++", hh: "C++",
  m: "Objective-C", mm: "Objective-C",
  ex: "Elixir", exs: "Elixir", erl: "Erlang", hs: "Haskell", clj: "Clojure",
  lua: "Lua", r: "R", jl: "Julia", zig: "Zig", nim: "Nim", ml: "OCaml",
  sh: "Shell", bash: "Shell", zsh: "Shell", ps1: "PowerShell",
  sql: "SQL", graphql: "GraphQL", gql: "GraphQL", proto: "Protocol Buffers",
  html: "HTML", htm: "HTML", vue: "Vue", svelte: "Svelte", astro: "Astro",
  css: "CSS", scss: "SCSS", sass: "SCSS", less: "Less",
  json: "JSON", jsonc: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", xml: "XML",
  md: "Markdown", mdx: "Markdown", rst: "reStructuredText", tf: "HCL", hcl: "HCL",
};

const BY_FILENAME: Readonly<Record<string, Language>> = {
  Dockerfile: "Dockerfile", Makefile: "Makefile", "CMakeLists.txt": "CMake",
  Gemfile: "Ruby", Rakefile: "Ruby", Jenkinsfile: "Groovy",
};

export function languageOf(path: string): Language {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const exact = BY_FILENAME[name];
  if (exact) return exact;
  if (name.startsWith("Dockerfile.")) return "Dockerfile";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return UNKNOWN_LANGUAGE; // no extension, or dotfile like ".gitignore"
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? UNKNOWN_LANGUAGE;
}
