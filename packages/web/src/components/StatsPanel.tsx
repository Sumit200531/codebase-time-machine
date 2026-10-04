import type { RepoView } from "../lib/repo-view.ts";
import { formatNumber, signed } from "../lib/format.ts";
import { useExplorer, type ExplorerStore } from "../lib/store.ts";
import { usePrefersReducedMotion, useTweenedNumber } from "./hooks.ts";

function Stat({ label, value, previous, reduced }: { label: string; value: number; previous: number; reduced: boolean }) {
  const shown = useTweenedNumber(value, reduced);
  const delta = value - previous;
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>
        <span className="stat-value">{formatNumber(shown)}</span>
        {delta !== 0 && <span className={`stat-delta ${delta > 0 ? "up" : "down"}`}>{signed(delta)}</span>}
      </dd>
    </div>
  );
}

export function StatsPanel({ view, store }: { view: RepoView; store: ExplorerStore }) {
  const step = useExplorer(store, (s) => s.step);
  const reduced = usePrefersReducedMotion();
  const now = view.bundle.stats[step]!;
  const before = view.bundle.stats[Math.max(0, step - 1)]!;
  const languages = (p: typeof now) => Object.keys(p.languages).filter((l) => l !== "Other").length;
  const rows: [string, (p: typeof now) => number][] = [
    ["Files", (p) => p.files],
    ["Lines of code", (p) => p.loc],
    ["Languages", languages],
    ["Contributors", (p) => p.contributorsReachable],
    ["Commits", (p) => p.commitsReachable],
    ["Internal dependencies", (p) => p.internalDependencies],
    ["External packages", (p) => p.externalPackages],
  ];
  const topLanguages = Object.entries(now.languages).sort(([, a], [, b]) => b.loc - a.loc).slice(0, 4);
  return (
    <section className="panel stats" aria-label="Codebase statistics at this point">
      <h2>Codebase at this point</h2>
      <dl>
        {rows.map(([label, read]) => (
          <Stat key={label} label={label} value={read(now)} previous={read(before)} reduced={reduced} />
        ))}
      </dl>
      <div className="language-bar" role="img" aria-label={topLanguages.map(([l, s]) => `${l} ${s.loc} lines`).join(", ")}>
        {topLanguages.map(([language, s]) => (
          <span key={language} style={{ flexGrow: Math.max(1, s.loc) }} title={`${language}: ${formatNumber(s.loc)} lines`}>
            {language}
          </span>
        ))}
      </div>
    </section>
  );
}
