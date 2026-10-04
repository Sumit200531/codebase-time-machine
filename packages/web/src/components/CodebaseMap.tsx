import { useMemo } from "react";
import type { RepoView } from "../lib/repo-view.ts";
import type { StableLayout } from "../lib/layout.ts";
import { formatNumber } from "../lib/format.ts";
import { useExplorer, type ExplorerStore } from "../lib/store.ts";

const MIN_FILE_RADIUS = 2.5;
const LABEL_MIN_RADIUS = 34;

/**
 * Engineering view: folders as regions, files as nodes sized by current
 * lines, dependency edges as lines. Positions come from the stable layout so
 * files appear, disappear and (when moved) glide in place across time.
 */
export function CodebaseMap({ view, store, layout }: { view: RepoView; store: ExplorerStore; layout: StableLayout }) {
  const step = useExplorer(store, (s) => s.step);
  const selection = useExplorer(store, (s) => s.selection);
  const files = view.snapshot(step);
  const events = view.eventsByStep[step]!;
  const eventKind = new Map(events.map((e) => [e.lineage, e.kind]));
  const peak = view.peakLoc();
  const selected = selection?.kind === "file" ? selection.lineage : null;

  const activeDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const file of files.values()) {
      const parts = file.path.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    return [...dirs].sort((a, b) => a.split("/").length - b.split("/").length);
  }, [files]);

  const edges = view.dependenciesAt(step).flatMap((edge) => {
    const from = files.get(edge.from);
    const to = edge.to === null ? undefined : files.get(edge.to);
    const a = from && layout.files.get(from.path);
    const b = to && layout.files.get(to.path);
    return a && b ? [{ key: `${edge.from}-${edge.to}`, a, b, highlighted: selected === edge.from || selected === edge.to }] : [];
  });

  return (
    <svg className="codebase-map" viewBox={`0 0 ${layout.size} ${layout.size}`} role="img" aria-label={`Map of ${files.size} files and ${edges.length} internal dependencies. Use the list view for an accessible table.`}>
      <defs>
        <marker id="arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0,0L6,3L0,6Z" className="edge-arrow" />
        </marker>
      </defs>
      {activeDirs.map((path) => {
        const p = layout.directories.get(path);
        if (!p) return null;
        const name = path.slice(path.lastIndexOf("/") + 1);
        return (
          <g key={path} className="dir-node">
            <circle cx={p.x} cy={p.y} r={p.r} />
            {p.r > LABEL_MIN_RADIUS && (
              <text x={p.x} y={p.y - p.r + 14} textAnchor="middle">
                {name}/
              </text>
            )}
          </g>
        );
      })}
      {edges.map(({ key, a, b, highlighted }) => {
        const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.15;
        const my = (a.y + b.y) / 2 - (b.x - a.x) * 0.15;
        return <path key={key} d={`M${a.x},${a.y}Q${mx},${my} ${b.x},${b.y}`} className={`dep-edge${highlighted ? " is-highlighted" : ""}`} markerEnd="url(#arrow)" />;
      })}
      {[...files.values()].map((file) => {
        const p = layout.files.get(file.path);
        if (!p) return null;
        const ratio = Math.sqrt(Math.max(1, file.loc ?? 1) / Math.max(1, peak.get(file.path) ?? 1));
        const r = Math.max(MIN_FILE_RADIUS, p.r * Math.min(1, ratio));
        const kind = eventKind.get(file.lineage);
        return (
          <g
            key={file.lineage}
            className={`file-node${kind ? ` event-${kind}` : ""}${selected === file.lineage ? " is-selected" : ""}`}
            style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
            onClick={() => store.set({ selection: { kind: "file", lineage: file.lineage } })}
          >
            <circle r={r} />
            {kind && <circle r={r + 5} className="pulse" />}
            <title>{`${file.path}\n${file.loc === null ? "binary" : `${formatNumber(file.loc)} lines`}`}</title>
          </g>
        );
      })}
    </svg>
  );
}
