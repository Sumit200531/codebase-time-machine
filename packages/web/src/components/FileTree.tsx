import { useMemo } from "react";
import type { FileNow, RepoView } from "../lib/repo-view.ts";
import { formatNumber } from "../lib/format.ts";
import { useExplorer, type ExplorerStore } from "../lib/store.ts";

interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: FileNow[];
  active: boolean;
}

const KIND_LABEL = { born: "Born", changed: "Changed", moved: "Moved", died: "Died" } as const;

/** Repository tree at the current step, with this step's lifecycle events marked. */
export function FileTree({ view, store }: { view: RepoView; store: ExplorerStore }) {
  const step = useExplorer(store, (s) => s.step);
  const selection = useExplorer(store, (s) => s.selection);
  const events = view.eventsByStep[step]!;
  const eventKind = useMemo(() => new Map(events.map((e) => [e.lineage, e.kind])), [events]);

  const root = useMemo(() => {
    const top: Dir = { name: "", path: "", dirs: new Map(), files: [], active: false };
    for (const file of view.snapshot(step).values()) {
      const parts = file.path.split("/");
      let dir = top;
      parts.slice(0, -1).forEach((name, i) => {
        let child = dir.dirs.get(name);
        if (!child) {
          child = { name, path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [], active: false };
          dir.dirs.set(name, child);
        }
        dir = child;
      });
      dir.files.push(file);
    }
    const mark = (dir: Dir): boolean => {
      dir.active = dir.files.some((f) => eventKind.has(f.lineage)) || [...dir.dirs.values()].map(mark).some(Boolean);
      return dir.active;
    };
    mark(top);
    return top;
  }, [view, step, eventKind]);

  const died = events.filter((e) => e.kind === "died");
  const selectedLineage = selection?.kind === "file" ? selection.lineage : null;

  const renderDir = (dir: Dir) => (
    <ul>
      {[...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).map((child) => (
        <li key={child.path}>
          <details open>
            <summary className={child.active ? "has-activity" : undefined}>{child.name}/</summary>
            {renderDir(child)}
          </details>
        </li>
      ))}
      {dir.files.sort((a, b) => a.path.localeCompare(b.path)).map((file) => {
        const kind = eventKind.get(file.lineage);
        return (
          <li key={file.lineage}>
            <button
              className={`file-row${kind ? ` event-${kind}` : ""}${selectedLineage === file.lineage ? " is-selected" : ""}`}
              onClick={() => store.set({ selection: { kind: "file", lineage: file.lineage } })}
              aria-label={`${file.path}${kind ? `, ${KIND_LABEL[kind]} in this commit` : ""}`}
            >
              <span className="file-name">{file.path.slice(file.path.lastIndexOf("/") + 1)}</span>
              <span className="file-loc">{file.loc === null ? "—" : formatNumber(file.loc)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <section className="panel tree" aria-label="Repository files at this point">
      <h2>Repository</h2>
      <div className="legend" aria-hidden="true">
        <span className="event-born">Born</span>
        <span className="event-changed">Changed</span>
        <span className="event-moved">Moved</span>
        <span className="event-died">Died</span>
      </div>
      <nav className="tree-scroll">{renderDir(root)}</nav>
      {died.length > 0 && (
        <div className="died-list">
          <h3>Died in this commit</h3>
          <ul>
            {died.map((e) => (
              <li key={e.lineage}>
                <button className="file-row event-died" onClick={() => store.set({ selection: { kind: "file", lineage: e.lineage } })}>
                  <span className="file-name">{e.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
