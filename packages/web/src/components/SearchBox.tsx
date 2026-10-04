import { useState } from "react";
import type { RepoView } from "../lib/repo-view.ts";
import { formatDate } from "../lib/format.ts";
import { useExplorer, type ExplorerStore } from "../lib/store.ts";

/**
 * History search: keyword matching over commit messages and changed paths.
 * It is deliberately not presented as AI; the grounded AI Historian is on the roadmap.
 */
export function SearchBox({ view, store }: { view: RepoView; store: ExplorerStore }) {
  const step = useExplorer(store, (s) => s.step);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const result = query.trim().length > 1 ? view.search(query, step) : null;
  const go = (s: number) => {
    store.set({ step: s, playing: false, selection: null });
    setOpen(false);
  };
  return (
    <div className="search" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <label className="visually-hidden" htmlFor="history-search">
        Search history
      </label>
      <input
        id="history-search"
        type="search"
        placeholder="Search history: auth, redis, tasks…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
      />
      {open && result && (
        <div className="search-results" role="region" aria-label="Search results" tabIndex={-1}>
          {result.steps.length === 0 && result.currentFiles.length === 0 ? (
            <p className="muted">No commits or files mention “{result.query}”.</p>
          ) : (
            <>
              {result.firstStep !== null && (
                <p>
                  First mentioned{" "}
                  <button className="link" onClick={() => go(result.firstStep!)}>
                    {formatDate(view.step(result.firstStep).committedAt)}: {view.step(result.firstStep).subject}
                  </button>
                </p>
              )}
              <p className="muted">
                {result.steps.length} related commits · {result.currentFiles.length} matching files at this point · {result.contributors.length} contributors
              </p>
              <ul>
                {result.steps.slice(0, 12).map((s) => (
                  <li key={s}>
                    <button className="link" onClick={() => go(s)}>
                      <span className="search-date">{formatDate(view.step(s).committedAt)}</span> {view.step(s).subject}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="search-note">Keyword match on commit messages and paths.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
