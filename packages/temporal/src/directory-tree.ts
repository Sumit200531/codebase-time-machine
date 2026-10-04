import type { FileState } from "./types.ts";

export interface DirectoryNode {
  readonly name: string;
  /** "" for the repository root. */
  readonly path: string;
  readonly fileCount: number;
  readonly loc: number;
  readonly directories: readonly DirectoryNode[];
  readonly files: readonly FileState[];
}

interface MutableDirectory {
  name: string;
  path: string;
  fileCount: number;
  loc: number;
  directories: Map<string, MutableDirectory>;
  files: FileState[];
}

function emptyDirectory(name: string, path: string): MutableDirectory {
  return { name, path, fileCount: 0, loc: 0, directories: new Map(), files: [] };
}

function freeze(directory: MutableDirectory): DirectoryNode {
  const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {
    name: directory.name,
    path: directory.path,
    fileCount: directory.fileCount,
    loc: directory.loc,
    directories: [...directory.directories.values()].map(freeze).sort(byName),
    files: [...directory.files].sort((a, b) => byName({ name: a.path }, { name: b.path })),
  };
}

/** Aggregate a snapshot into a directory hierarchy with rolled-up file and LOC totals. */
export function buildDirectoryTree(snapshot: ReadonlyMap<string, FileState>): DirectoryNode {
  const root = emptyDirectory("", "");
  for (const file of snapshot.values()) {
    const segments = file.path.split("/");
    let directory = root;
    const visit = (dir: MutableDirectory) => {
      dir.fileCount += 1;
      dir.loc += file.loc ?? 0;
    };
    visit(directory);
    for (let i = 0; i < segments.length - 1; i++) {
      const name = segments[i]!;
      let child = directory.directories.get(name);
      if (!child) {
        child = emptyDirectory(name, segments.slice(0, i + 1).join("/"));
        directory.directories.set(name, child);
      }
      directory = child;
      visit(directory);
    }
    directory.files.push(file);
  }
  return freeze(root);
}
