import { useState } from "react";
import type { RepoView } from "../lib/repo-view.ts";
import { formatDate, formatNumber } from "../lib/format.ts";
import { useExplorer, type ExplorerStore } from "../lib/store.ts";

interface Snapshot {
  readonly name: string;
  readonly step: number;
}

const storageKey = (view: RepoView) => `ctm:snapshots:${view.bundle.meta.anchorCommit}`;

function loadSnapshots(view: RepoView): Snapshot[] {
  try {
    const raw = localStorage.getItem(storageKey(view));
    return raw ? (JSON.parse(raw) as Snapshot[]).filter((s) => s.step <= view.lastStep) : [];
  } catch {
    return [];
  }
}

function saveSnapshots(view: RepoView, snapshots: Snapshot[]): void {
  try {
    localStorage.setItem(storageKey(view), JSON.stringify(snapshots));
  } catch {
    // Storage can be unavailable (private mode, quota); snapshots then last for this session only.
  }
}

/** "What changed?" between any two points: milestones, named snapshots, or the current position. */
export function CompareView({ view, store }: { view: RepoView; store: ExplorerStore }) {
  const step = useExplorer(store, (s) => s.step);
  const { from, to } = useExplorer(store, (s) => s.compare);
  const [snapshots, setSnapshots] = useState(() => loadSnapshots(view));
  const [name, setName] = useState("");
  const result = view.compare(from, to);
  const a = view.bundle.stats[result.from]!;
  const b = view.bundle.stats[result.to]!;

  const options = [
    { label: "Start of history", step: 0 },
    ...view.bundle.milestones.filter((m) => m.kind === "tag" || m.kind === "refactor").map((m) => ({ label: m.title, step: m.step })),
    ...snapshots.map((s) => ({ label: `Snapshot: ${s.name}`, step: s.step })),
    { label: "Current position", step },
    { label: "Latest commit", step: view.lastStep },
  ];
  const picker = (value: number, onChange: (v: number) => void, label: string) => (
    <label className="compare-picker">
      {label}
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map((o, i) => (
          <option key={i} value={o.step}>
            {o.label} ({formatDate(view.step(o.step).committedAt)})
          </option>
        ))}
        {!options.some((o) => o.step === value) && <option value={value}>Step {value + 1}</option>}
      </select>
    </label>
  );

  const metrics: [string, number, number][] = [
    ["Files", a.files, b.files],
    ["Lines of code", a.loc, b.loc],
    ["Modules", view.architecture(result.from).modules.length, view.architecture(result.to).modules.length],
    ["External packages", a.externalPackages, b.externalPackages],
    ["Internal dependencies", a.internalDependencies, b.internalDependencies],
    ["Contributors", a.contributorsReachable, b.contributorsReachable],
  ];

  const saveSnapshot = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next = [...snapshots.filter((s) => s.name !== trimmed), { name: trimmed, step }];
    setSnapshots(next);
    saveSnapshots(view, next);
    setName("");
  };

  return (
    <div className="compare">
      <div className="compare-controls">
        {picker(from, (v) => store.set((s) => ({ compare: { ...s.compare, from: v } })), "From")}
        {picker(to, (v) => store.set((s) => ({ compare: { ...s.compare, to: v } })), "To")}
        <form
          className="snapshot-form"
          onSubmit={(e) => {
            e.preventDefault();
            saveSnapshot();
          }}
        >
          <label>
            Save current position as
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Before the auth refactor" />
          </label>
          <button type="submit" disabled={!name.trim()}>
            Save snapshot
          </button>
        </form>
      </div>
      <h2 className="compare-title">
        What changed between {formatDate(view.step(result.from).committedAt)} and {formatDate(view.step(result.to).committedAt)}
      </h2>
      <table className="compare-table">
        <tbody>
          {metrics.map(([label, before, after]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{formatNumber(before)}</td>
              <td aria-hidden="true">→</td>
              <td>{formatNumber(after)}</td>
              <td className={after > before ? "up" : after < before ? "down" : ""}>{after === before ? "" : `${after > before ? "+" : ""}${formatNumber(after - before)}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="compare-columns">
        <ChangeList title="Modules introduced" items={result.modulesAdded} tone="born" />
        <ChangeList title="Modules retired" items={result.modulesRemoved} tone="died" />
        <ChangeList title="Packages adopted" items={result.packagesAdded} tone="born" />
        <ChangeList title="Packages dropped" items={result.packagesRemoved} tone="died" />
        <ChangeList title={`Files born (${result.born.length})`} items={result.born.map((e) => e.path)} tone="born" />
        <ChangeList title={`Files died (${result.died.length})`} items={result.died.map((e) => e.path)} tone="died" />
        <ChangeList title={`Files moved (${result.moved.length})`} items={result.moved.map((e) => `${e.previousPath} → ${e.path}`)} tone="moved" />
      </div>
      <p className="view-note">{formatNumber(result.commits)} commits landed in this interval.</p>
    </div>
  );
}

function ChangeList({ title, items, tone }: { title: string; items: readonly string[]; tone: string }) {
  if (items.length === 0) return null;
  return (
    <section className={`change-list tone-${tone}`}>
      <h3>{title}</h3>
      <ul>
        {items.slice(0, 40).map((item) => (
          <li key={item}>{item}</li>
        ))}
        {items.length > 40 && <li>…and {items.length - 40} more</li>}
      </ul>
    </section>
  );
}
