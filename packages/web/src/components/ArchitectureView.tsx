import { useMemo } from "react";
import type { RepoView } from "../lib/repo-view.ts";
import { formatNumber } from "../lib/format.ts";
import { useExplorer, type ExplorerStore } from "../lib/store.ts";

const WIDTH = 1000;
const ROW_HEIGHT = 110;
const BOX_WIDTH = 150;
const BOX_HEIGHT = 46;
const TOP = 30;

/**
 * Architecture mode: modules (inferred from directories) layered by their
 * import relationships, importers above what they import. Boxes are keyed by
 * module, so moving through time morphs the diagram rather than redrawing it.
 */
export function ArchitectureView({ view, store }: { view: RepoView; store: ExplorerStore }) {
  const step = useExplorer(store, (s) => s.step);
  const arch = view.architecture(step);
  const previous = useMemo(() => new Set(view.architecture(Math.max(0, step - 1)).modules.map((m) => m.id)), [view, step]);

  const positions = useMemo(() => {
    const rows = new Map<number, string[]>();
    for (const m of arch.modules) rows.set(m.rank, [...(rows.get(m.rank) ?? []), m.id]);
    const placed = new Map<string, { x: number; y: number }>();
    for (const [rank, ids] of rows) {
      ids.forEach((id, i) => placed.set(id, { x: ((i + 1) / (ids.length + 1)) * WIDTH, y: TOP + rank * ROW_HEIGHT }));
    }
    return placed;
  }, [arch]);

  const rowCount = Math.max(1, ...arch.modules.map((m) => m.rank + 1));
  const height = TOP + rowCount * ROW_HEIGHT + 40;

  return (
    <div className="architecture">
      <p className="view-note">
        Modules are inferred from directory structure; arrows are measured import relationships. Modules that call each other over the network (for example a frontend and its API) show no arrow.
      </p>
      <svg viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label={`Architecture with ${arch.modules.length} modules: ${arch.modules.map((m) => m.id).join(", ")}`}>
        <defs>
          <marker id="arch-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0L8,4L0,8Z" className="arch-arrow" />
          </marker>
        </defs>
        {arch.edges.map((edge) => {
          const a = positions.get(edge.from);
          const b = positions.get(edge.to);
          if (!a || !b) return null;
          const y1 = a.y + BOX_HEIGHT / 2;
          const y2 = b.y - BOX_HEIGHT / 2 - 2;
          const sameRow = Math.abs(a.y - b.y) < 1;
          const d = sameRow
            ? `M${a.x},${a.y + BOX_HEIGHT / 2}C${a.x},${a.y + 80} ${b.x},${b.y + 80} ${b.x},${b.y + BOX_HEIGHT / 2 + 2}`
            : `M${a.x},${y1}C${a.x},${(y1 + y2) / 2} ${b.x},${(y1 + y2) / 2} ${b.x},${y2}`;
          return <path key={`${edge.from}>${edge.to}`} d={d} className="arch-edge" strokeWidth={Math.min(4, 1 + edge.weight * 0.6)} markerEnd="url(#arch-arrow)" />;
        })}
        {arch.modules.map((module) => {
          const p = positions.get(module.id)!;
          const isNew = step > 0 && !previous.has(module.id);
          return (
            <g key={module.id} className={`arch-node${isNew ? " is-new" : ""}`} style={{ transform: `translate(${p.x}px, ${p.y}px)` }}>
              <rect x={-BOX_WIDTH / 2} y={-BOX_HEIGHT / 2} width={BOX_WIDTH} height={BOX_HEIGHT} rx={6} />
              <text y={-3} textAnchor="middle" className="arch-name">
                {module.id}
              </text>
              <text y={14} textAnchor="middle" className="arch-meta">
                {module.files} files · {formatNumber(module.loc)} lines
              </text>
            </g>
          );
        })}
      </svg>
      {arch.packages.length > 0 && (
        <div className="packages">
          <h3>External packages in use</h3>
          <ul>
            {arch.packages.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
