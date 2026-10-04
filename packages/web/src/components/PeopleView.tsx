import { useState } from "react";
import type { RepoView } from "../lib/repo-view.ts";
import { formatDate, formatNumber } from "../lib/format.ts";
import { useExplorer, type ExplorerStore } from "../lib/store.ts";

/** "Who built this?": contribution activity up to the current point in time. */
export function PeopleView({ view, store }: { view: RepoView; store: ExplorerStore }) {
  const step = useExplorer(store, (s) => s.step);
  const people = view.contributors(step);
  const [open, setOpen] = useState<number | null>(null);
  const total = Math.max(1, people.reduce((sum, p) => sum + p.commits, 0));
  return (
    <div className="people">
      <p className="view-note">
        Share of non-merge commits up to this point. Commit counts describe activity, not the value or quality of anyone's work. Merge commits are counted separately; the lines they bring in are credited to the branch authors.
      </p>
      <ul className="people-list">
        {people.map((person) => {
          const share = person.commits / total;
          const expanded = open === person.id;
          return (
            <li key={person.id}>
              <button className="person-row" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : person.id)}>
                <span className="person-name">{person.name}</span>
                <span className="person-bar" aria-hidden="true">
                  <span style={{ width: `${(share * 100).toFixed(1)}%` }} />
                </span>
                <span className="person-share">{Math.round(share * 100)}%</span>
              </button>
              {expanded && (
                <dl className="person-detail">
                  <dt>Commits</dt>
                  <dd>
                    {formatNumber(person.commits)}
                    {person.merges > 0 && ` (+${person.merges} merges)`}
                  </dd>
                  <dt>Lines</dt>
                  <dd>
                    <span className="up">+{formatNumber(person.additions)}</span> <span className="down">−{formatNumber(person.deletions)}</span>
                  </dd>
                  <dt>Main areas</dt>
                  <dd>{person.areas.map((a) => `${a.module} (${a.touches})`).join(", ") || "—"}</dd>
                  <dt>First contribution</dt>
                  <dd>
                    <button className="link" onClick={() => store.set({ step: person.firstStep })}>
                      {formatDate(view.step(person.firstStep).committedAt)}
                    </button>
                  </dd>
                  <dt>Latest contribution</dt>
                  <dd>
                    <button className="link" onClick={() => store.set({ step: person.lastStep })}>
                      {formatDate(view.step(person.lastStep).committedAt)}
                    </button>
                  </dd>
                </dl>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
