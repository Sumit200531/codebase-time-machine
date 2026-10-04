import type { RepoView } from "../lib/repo-view.ts";
import { formatDate, formatNumber, shortId } from "../lib/format.ts";
import { useExplorer, type ExplorerStore } from "../lib/store.ts";
import { DiffViewer } from "./DiffViewer.tsx";

const STATUS_LETTER = { added: "A", modified: "M", deleted: "D", renamed: "R", typechanged: "T" } as const;
const KIND_TEXT = { born: "Born", changed: "Changed", moved: "Moved", died: "Died" } as const;

export function Inspector({ view, store }: { view: RepoView; store: ExplorerStore }) {
  const step = useExplorer(store, (s) => s.step);
  const selection = useExplorer(store, (s) => s.selection);
  return (
    <aside className="panel inspector" aria-label="Inspector">
      {selection?.kind === "file" ? (
        <FileLifecycle view={view} store={store} lineage={selection.lineage} />
      ) : (
        <CommitDetail view={view} store={store} step={selection?.kind === "commit" ? selection.step : step} following={selection === null} />
      )}
    </aside>
  );
}

function CommitDetail({ view, store, step, following }: { view: RepoView; store: ExplorerStore; step: number; following: boolean }) {
  const info = view.step(step);
  const detail = view.bundle.commits[info.commitId];
  const changes = detail?.changes ?? [];
  const additions = changes.reduce((sum, c) => sum + (c.additions ?? 0), 0);
  const deletions = changes.reduce((sum, c) => sum + (c.deletions ?? 0), 0);
  const events = view.eventsByStep[step]!;
  const milestones = view.bundle.milestones.filter((m) => m.step === step);
  const impact = {
    structure: events.filter((e) => e.kind !== "changed").length,
    dependencies: view.bundle.dependencies.filter((e) => e.fromStep === step || e.toStep === step).length,
  };
  return (
    <div className="commit-detail">
      <header>
        <p className="muted">
          {following ? "Commit at this point" : "Pinned commit"} · <code>{shortId(info.commitId)}</code>
          {!following && (
            <button className="link" onClick={() => store.set({ selection: null })}>
              Follow timeline
            </button>
          )}
        </p>
        <h2>{info.subject}</h2>
        <p>
          {view.author(info.authorId)} · {formatDate(info.committedAt)}
          {info.tags.length > 0 && <span className="tag-chip">{info.tags.join(", ")}</span>}
        </p>
        {info.body && <p className="commit-body">{info.body}</p>}
      </header>
      <dl className="commit-numbers">
        <div>
          <dt>Files</dt>
          <dd>{changes.length}</dd>
        </div>
        <div>
          <dt>Added</dt>
          <dd className="up">+{formatNumber(additions)}</dd>
        </div>
        <div>
          <dt>Removed</dt>
          <dd className="down">−{formatNumber(deletions)}</dd>
        </div>
        <div>
          <dt>Structural events</dt>
          <dd>{impact.structure}</dd>
        </div>
        <div>
          <dt>Dependency changes</dt>
          <dd>{impact.dependencies}</dd>
        </div>
      </dl>
      {info.isMerge && <p className="muted">Merge: brings in {info.sideCommitIds.length} branch commits. Changes are shown against the first parent.</p>}
      {milestones.length > 0 && (
        <ul className="milestone-list">
          {milestones.map((m, i) => (
            <li key={i} className={`kind-${m.kind}`}>
              {m.title}
            </li>
          ))}
        </ul>
      )}
      <h3>Files changed</h3>
      <ul className="change-rows">
        {changes.map((change, i) => (
          <li key={i} className={`status-${change.status}`}>
            <span className="status-letter" title={change.status}>
              {STATUS_LETTER[change.status]}
            </span>
            <span className="path">{change.previousPath ? `${change.previousPath} → ${change.path}` : change.path}</span>
            <span className="counts">
              {change.additions === null ? "binary" : `+${change.additions} −${change.deletions}`}
            </span>
          </li>
        ))}
      </ul>
      <h3>Diff</h3>
      {detail?.patch ? <DiffViewer key={info.commitId} files={detail.patch.files} truncated={detail.patch.truncated} /> : <p className="muted">Patches were not included in this bundle.</p>}
    </div>
  );
}

function FileLifecycle({ view, store, lineage }: { view: RepoView; store: ExplorerStore; lineage: number }) {
  const currentStep = useExplorer(store, (s) => s.step);
  const events = view.eventsByLineage.get(lineage) ?? [];
  const first = events[0];
  if (!first) return <p className="muted">Unknown file.</p>;
  const last = events[events.length - 1]!;
  const authors = new Set(events.map((e) => view.author(view.step(e.step).authorId)));
  const changes = events.filter((e) => e.kind === "changed").length;
  const step = currentStep;
  const outgoing = view.dependenciesAt(step).filter((e) => e.from === lineage);
  const incoming = view.dependenciesAt(step).filter((e) => e.to === lineage);
  const pathOf = (l: number) => view.snapshot(step).get(l)?.path ?? "(not present)";
  return (
    <div className="lifecycle">
      <header>
        <p className="muted">
          File lifecycle{" "}
          <button className="link" onClick={() => store.set({ selection: null })}>
            Back to commit
          </button>
        </p>
        <h2 className="mono">{last.path}</h2>
        <p>
          {last.kind === "died" ? "Deleted" : `${last.locAfter === null ? "binary" : `${formatNumber(last.locAfter)} lines`}`} · {changes} modifications · {authors.size} contributors
          {first.restored && " · restored path"}
        </p>
      </header>
      <ol className="lifecycle-events">
        {events.map((event, i) => (
          <li key={i} className={`event-${event.kind}`}>
            <button className="link" onClick={() => store.set({ step: event.step, playing: false })}>
              <span className="event-kind">{KIND_TEXT[event.kind]}</span>
              <span className="event-date">{formatDate(view.step(event.step).committedAt)}</span>
            </button>
            <span className="event-subject">{view.step(event.step).subject}</span>
            {event.kind === "moved" && <span className="mono small">from {event.previousPath}</span>}
            {event.additions !== null && event.kind !== "died" && (
              <span className="small">
                <span className="up">+{event.additions}</span> <span className="down">−{event.deletions}</span> · {view.author(view.step(event.step).authorId)}
              </span>
            )}
          </li>
        ))}
      </ol>
      <h3>Dependencies now</h3>
      <ul className="deps">
        {outgoing.map((e, i) => (
          <li key={`o${i}`}>imports {e.external ? <em>{e.external}</em> : <span className="mono">{pathOf(e.to!)}</span>}</li>
        ))}
        {incoming.map((e, i) => (
          <li key={`i${i}`}>imported by <span className="mono">{pathOf(e.from)}</span></li>
        ))}
        {outgoing.length + incoming.length === 0 && <li className="muted">None detected at this point.</li>}
      </ul>
    </div>
  );
}
