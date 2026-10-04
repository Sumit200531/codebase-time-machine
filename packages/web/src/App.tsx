import { useEffect, useMemo, useRef, useState } from "react";
import { DEMO_BUNDLE, parseBundle, type Bundle } from "./lib/bundle.ts";
import { RepoView } from "./lib/repo-view.ts";
import { computeStableLayout } from "./lib/layout.ts";
import { createExplorerStore, useExplorer, type ExplorerStore, type ViewId } from "./lib/store.ts";
import { Timeline, nextStep } from "./components/Timeline.tsx";
import { StatsPanel } from "./components/StatsPanel.tsx";
import { FileTree } from "./components/FileTree.tsx";
import { CodebaseMap } from "./components/CodebaseMap.tsx";
import { FileTable } from "./components/FileTable.tsx";
import { Galaxy } from "./components/Galaxy.tsx";
import { ArchitectureView } from "./components/ArchitectureView.tsx";
import { CompareView } from "./components/CompareView.tsx";
import { PeopleView } from "./components/PeopleView.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { SearchBox } from "./components/SearchBox.tsx";
import { About } from "./components/About.tsx";

const BASE_STEP_MS = 1_100;
const VIEWS: { id: ViewId; label: string }[] = [
  { id: "map", label: "Map" },
  { id: "galaxy", label: "Galaxy" },
  { id: "architecture", label: "Architecture" },
  { id: "compare", label: "Compare" },
  { id: "people", label: "People" },
];

function initialStore(view: RepoView): ExplorerStore {
  const firstTag = view.bundle.milestones.find((m) => m.kind === "tag")?.step ?? 0;
  return createExplorerStore({
    step: 0,
    playing: false,
    speed: 1,
    milestonesOnly: false,
    view: "map",
    selection: null,
    compare: { from: firstTag, to: view.lastStep },
    listMode: false,
  });
}

export function App() {
  const [bundle, setBundle] = useState<Bundle>(DEMO_BUNDLE);
  const [error, setError] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const view = useMemo(() => new RepoView(bundle), [bundle]);
  const layout = useMemo(() => computeStableLayout(view.allPaths(), view.peakLoc()), [view]);
  const store = useMemo(() => initialStore(view), [view]);
  const fileInput = useRef<HTMLInputElement>(null);

  const openBundle = async (file: File) => {
    try {
      setBundle(parseBundle(await file.text()));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The bundle could not be read.");
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Codebase Time Machine</h1>
          <span className="repo-label">{bundle.meta.label}</span>
          {bundle.meta.demoNotice && (
            <span className="demo-badge" title={bundle.meta.demoNotice} tabIndex={0}>
              Demo data
            </span>
          )}
        </div>
        <ViewTabs store={store} />
        <SearchBox view={view} store={store} />
        <div className="topbar-actions">
          <button onClick={() => fileInput.current?.click()}>Open bundle</button>
          <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && openBundle(e.target.files[0])} />
          {bundle !== DEMO_BUNDLE && <button onClick={() => setBundle(DEMO_BUNDLE)}>Back to demo</button>}
          <button onClick={() => setAboutOpen(true)}>About</button>
        </div>
      </header>
      {error && (
        <p className="error-banner" role="alert">
          {error} <button onClick={() => setError(null)}>Dismiss</button>
        </p>
      )}
      <Playback view={view} store={store} />
      <main className="workspace" key={bundle.meta.anchorCommit}>
        <div className="left">
          <StatsPanel view={view} store={store} />
          <FileTree view={view} store={store} />
        </div>
        <section className="stage" aria-label="Visualization">
          <Stage view={view} store={store} layout={layout} />
        </section>
        <Inspector view={view} store={store} />
      </main>
      <Timeline view={view} store={store} />
      {aboutOpen && <About onClose={() => setAboutOpen(false)} />}
    </div>
  );
}

function ViewTabs({ store }: { store: ExplorerStore }) {
  const current = useExplorer(store, (s) => s.view);
  return (
    <nav className="view-tabs" aria-label="Views">
      {VIEWS.map((v) => (
        <button key={v.id} aria-current={current === v.id ? "page" : undefined} onClick={() => store.set({ view: v.id })}>
          {v.label}
        </button>
      ))}
    </nav>
  );
}

function Stage({ view, store, layout }: { view: RepoView; store: ExplorerStore; layout: ReturnType<typeof computeStableLayout> }) {
  const current = useExplorer(store, (s) => s.view);
  const listMode = useExplorer(store, (s) => s.listMode);
  const mapLike = current === "map" || current === "galaxy";
  return (
    <>
      {mapLike && (
        <div className="stage-toolbar">
          <label className="toggle">
            <input type="checkbox" checked={listMode} onChange={(e) => store.set({ listMode: e.target.checked })} />
            Show as table
          </label>
          {current === "map" && !listMode && <span className="muted">Circles are folders; dots are files sized by lines; arrows are imports.</span>}
          {current === "galaxy" && !listMode && <span className="muted">Stars are files, coloured by top-level folder, brighter when changed more often.</span>}
        </div>
      )}
      {mapLike && listMode && <FileTable view={view} store={store} />}
      {current === "map" && !listMode && <CodebaseMap view={view} store={store} layout={layout} />}
      {current === "galaxy" && !listMode && <Galaxy view={view} store={store} layout={layout} />}
      {current === "architecture" && <ArchitectureView view={view} store={store} />}
      {current === "compare" && <CompareView view={view} store={store} />}
      {current === "people" && <PeopleView view={view} store={store} />}
    </>
  );
}

/** Drives playback and global keyboard shortcuts; renders nothing. */
function Playback({ view, store }: { view: RepoView; store: ExplorerStore }) {
  const playing = useExplorer(store, (s) => s.playing);
  const speed = useExplorer(store, (s) => s.speed);
  const step = useExplorer(store, (s) => s.step);
  useEffect(() => {
    if (!playing) return;
    if (step >= view.lastStep) {
      store.set({ playing: false });
      return;
    }
    const timer = setTimeout(() => store.set((s) => ({ step: nextStep(view, s.step, s.milestonesOnly), selection: null })), BASE_STEP_MS / speed);
    return () => clearTimeout(timer);
  }, [playing, speed, step, view, store]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input, select, textarea, [role=slider], dialog")) return;
      const s = store.get();
      if (event.key === " ") store.set({ playing: !s.playing });
      else if (event.key === "ArrowRight") store.set({ step: nextStep(view, s.step, s.milestonesOnly), playing: false });
      else if (event.key === "ArrowLeft") store.set({ step: Math.max(0, s.step - 1), playing: false });
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, store]);
  return null;
}
