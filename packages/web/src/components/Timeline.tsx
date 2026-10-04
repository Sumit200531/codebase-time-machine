import { useCallback, useMemo, useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { Milestone } from "@ctm/export/types";
import { formatDate, formatNumber } from "../lib/format.ts";
import type { RepoView } from "../lib/repo-view.ts";
import { SPEEDS, useExplorer, type ExplorerStore } from "../lib/store.ts";

const WIDTH = 1000;
const HEIGHT = 120;
const AXIS_Y = 70;
const CURVE_HEIGHT = 46;
const TICK_MAX = 20;
const MILESTONE_Y = 12;

const MILESTONE_LABEL: Record<Milestone["kind"], string> = {
  tag: "Tag",
  structure: "New structure",
  dependency: "New dependency",
  refactor: "Restructuring",
  merge: "Merge",
};

/**
 * The seismograph: lines of code over mainline steps, births drawn above the
 * axis and deaths below, milestones along the top. It is the main instrument
 * for reading history, and the scrubber for moving through it.
 */
export function Timeline({ view, store }: { view: RepoView; store: ExplorerStore }) {
  const step = useExplorer(store, (s) => s.step);
  const playing = useExplorer(store, (s) => s.playing);
  const speed = useExplorer(store, (s) => s.speed);
  const milestonesOnly = useExplorer(store, (s) => s.milestonesOnly);
  const svgRef = useRef<SVGSVGElement>(null);
  const { bundle, lastStep } = view;
  const x = useCallback((s: number) => (lastStep === 0 ? WIDTH / 2 : (s / lastStep) * WIDTH), [lastStep]);

  const curve = useMemo(() => {
    const maxLoc = Math.max(1, ...bundle.stats.map((p) => p.loc));
    const points = bundle.stats.map((p) => `${x(p.step).toFixed(1)},${(AXIS_Y - (p.loc / maxLoc) * CURVE_HEIGHT).toFixed(1)}`);
    return { line: `M${points.join("L")}`, area: `M${x(0)},${AXIS_Y}L${points.join("L")}L${x(lastStep)},${AXIS_Y}Z` };
  }, [bundle.stats, lastStep, x]);

  const ticks = useMemo(
    () =>
      view.eventsByStep.map((events, s) => ({
        s,
        born: Math.min(TICK_MAX, events.filter((e) => e.kind === "born").length * 3),
        died: Math.min(TICK_MAX, events.filter((e) => e.kind === "died").length * 3),
        changed: events.some((e) => e.kind === "changed" || e.kind === "moved"),
      })),
    [view],
  );

  const years = useMemo(() => {
    const marks: { s: number; year: string }[] = [];
    let previous = "";
    for (const info of bundle.steps) {
      const year = info.committedAt.slice(0, 4);
      if (year !== previous) marks.push({ s: info.step, year });
      previous = year;
    }
    return marks;
  }, [bundle.steps]);

  const stepFromPointer = (event: PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    return Math.round(ratio * lastStep);
  };
  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    svgRef.current!.setPointerCapture(event.pointerId);
    store.set({ step: stepFromPointer(event), playing: false });
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (event.buttons === 1) store.set({ step: stepFromPointer(event) });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const jump: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, PageDown: -10, PageUp: 10 };
    if (event.key in jump) store.set({ step: clamp(step + jump[event.key]!, lastStep), playing: false });
    else if (event.key === "Home") store.set({ step: 0, playing: false });
    else if (event.key === "End") store.set({ step: lastStep, playing: false });
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const info = bundle.steps[step]!;
  const stats = bundle.stats[step]!;
  const milestone = bundle.milestones.find((m) => m.step === step && m.kind !== "merge") ?? bundle.milestones.find((m) => m.step === step);

  return (
    <section className="timeline" aria-label="Timeline">
      <div className="timeline-readout">
        <span className="readout-date">{formatDate(info.committedAt)}</span>
        <button className="readout-commit" onClick={() => store.set({ selection: { kind: "commit", step } })}>
          {info.subject}
        </button>
        {milestone && <span className={`readout-milestone kind-${milestone.kind}`}>{milestone.title}</span>}
        <span className="readout-position">
          Step {formatNumber(step + 1)} of {formatNumber(lastStep + 1)} · {formatNumber(stats.loc)} lines
        </span>
      </div>
      <svg
        ref={svgRef}
        className="seismograph"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="slider"
        tabIndex={0}
        aria-label="Position in history"
        aria-valuemin={1}
        aria-valuemax={lastStep + 1}
        aria-valuenow={step + 1}
        aria-valuetext={`${formatDate(info.committedAt)}: ${info.subject}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onKeyDown={onKeyDown}
      >
        {years.map((mark) => (
          <g key={mark.year}>
            <line x1={x(mark.s)} x2={x(mark.s)} y1={0} y2={HEIGHT} className="year-rule" vectorEffect="non-scaling-stroke" />
            <text x={x(mark.s) + 4} y={HEIGHT - 4} className="year-label">
              {mark.year}
            </text>
          </g>
        ))}
        <path d={curve.area} className="loc-area" />
        <path d={curve.line} className="loc-line" vectorEffect="non-scaling-stroke" />
        <line x1={0} x2={WIDTH} y1={AXIS_Y} y2={AXIS_Y} className="axis" vectorEffect="non-scaling-stroke" />
        {ticks.map((t) => (
          <g key={t.s}>
            {t.born > 0 && <line x1={x(t.s)} x2={x(t.s)} y1={AXIS_Y} y2={AXIS_Y - t.born} className="tick-born" vectorEffect="non-scaling-stroke" />}
            {t.died > 0 && <line x1={x(t.s)} x2={x(t.s)} y1={AXIS_Y} y2={AXIS_Y + t.died} className="tick-died" vectorEffect="non-scaling-stroke" />}
            {t.changed && <line x1={x(t.s)} x2={x(t.s)} y1={AXIS_Y - 2} y2={AXIS_Y + 2} className="tick-changed" vectorEffect="non-scaling-stroke" />}
          </g>
        ))}
        {view.milestoneSteps.map((s) => (
          <circle key={s} cx={x(s)} cy={MILESTONE_Y} r={3.2} className={`milestone-dot${s === step ? " is-current" : ""}`}>
            <title>{bundle.milestones.filter((m) => m.step === s).map((m) => `${MILESTONE_LABEL[m.kind]}: ${m.title}`).join("\n")}</title>
          </circle>
        ))}
        <line x1={x(step)} x2={x(step)} y1={0} y2={HEIGHT} className="cursor" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="transport">
        <button onClick={() => store.set({ step: previousStep(view, step, milestonesOnly), playing: false })} aria-label="Previous step">
          ◀ Previous
        </button>
        <button
          className="play"
          aria-pressed={playing}
          onClick={() => store.set((s) => ({ playing: !s.playing, step: !s.playing && s.step === lastStep ? 0 : s.step }))}
        >
          {playing ? "❚❚ Pause" : "▶ Play evolution"}
        </button>
        <button onClick={() => store.set({ step: nextStep(view, step, milestonesOnly), playing: false })} aria-label="Next step">
          Next ▶
        </button>
        <label className="toggle">
          <input type="checkbox" checked={milestonesOnly} onChange={(e) => store.set({ milestonesOnly: e.target.checked })} />
          Milestones only
        </label>
        <div className="speeds" role="radiogroup" aria-label="Playback speed">
          {SPEEDS.map((value) => (
            <button key={value} role="radio" aria-checked={speed === value} className={speed === value ? "is-active" : ""} onClick={() => store.set({ speed: value })}>
              {value}×
            </button>
          ))}
        </div>
        <label className="jump">
          Jump to
          <select
            value=""
            onChange={(e) => e.target.value !== "" && store.set({ step: Number(e.target.value), playing: false })}
          >
            <option value="">milestone…</option>
            {bundle.milestones
              .filter((m) => m.kind !== "merge")
              .map((m, i) => (
                <option key={i} value={m.step}>
                  {formatDate(bundle.steps[m.step]!.committedAt)}: {m.title}
                </option>
              ))}
          </select>
        </label>
        <label className="jump">
          Date
          <input
            type="date"
            min={bundle.steps[0]!.committedAt.slice(0, 10)}
            max={bundle.steps[lastStep]!.committedAt.slice(0, 10)}
            onChange={(e) => e.target.value && store.set({ step: stepAtOrBefore(view, e.target.value), playing: false })}
          />
        </label>
      </div>
    </section>
  );
}

const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));

export function nextStep(view: RepoView, step: number, milestonesOnly: boolean): number {
  if (!milestonesOnly) return clamp(step + 1, view.lastStep);
  return view.milestoneSteps.find((s) => s > step) ?? view.lastStep;
}

export function previousStep(view: RepoView, step: number, milestonesOnly: boolean): number {
  if (!milestonesOnly) return clamp(step - 1, view.lastStep);
  return [...view.milestoneSteps].reverse().find((s) => s < step) ?? 0;
}

function stepAtOrBefore(view: RepoView, date: string): number {
  const end = Date.parse(`${date}T23:59:59Z`);
  let found = 0;
  let latest = Number.NEGATIVE_INFINITY;
  for (const info of view.bundle.steps) {
    latest = Math.max(latest, Date.parse(info.committedAt)); // tolerate clock skew
    if (latest <= end) found = info.step;
  }
  return found;
}
