import { useEffect, useRef } from "react";
import type { RepoView } from "../lib/repo-view.ts";
import type { StableLayout } from "../lib/layout.ts";
import { useExplorer, type ExplorerStore } from "../lib/store.ts";
import { usePrefersReducedMotion } from "./hooks.ts";

const PULSE_MS = 900;
/** Muted region hues; folders are regions, coloured by top-level directory. */
const REGION_HUES = [205, 160, 265, 30, 340, 95, 185, 290];
const EVENT_COLOR = { born: "91, 212, 154", changed: "106, 168, 247", moved: "167, 139, 250", died: "242, 112, 107" } as const;

function hueOf(path: string): number {
  const top = path.split("/")[0]!;
  let hash = 0;
  for (const ch of top) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return REGION_HUES[hash % REGION_HUES.length]!;
}

/**
 * Galaxy view: the same stable layout as the engineering map, drawn as light.
 * Brightness is churn (how often a file changed so far); this commit's
 * lifecycle events pulse. Every pixel corresponds to repository data.
 */
export function Galaxy({ view, store, layout }: { view: RepoView; store: ExplorerStore; layout: StableLayout }) {
  const step = useExplorer(store, (s) => s.step);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current!;
    const context = canvas.getContext("2d");
    if (!context) return;
    const files = view.snapshot(step);
    const churn = view.churn(step);
    const maxChurn = Math.max(1, ...churn.values());
    const events = view.eventsByStep[step]!;
    const edges = view.dependenciesAt(step);
    let frame = 0;
    const start = performance.now();

    const draw = (now: number) => {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      if (canvas.width !== Math.round(width * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      const scale = (Math.min(width, height) / layout.size) * dpr;
      const ox = ((width * dpr) - layout.size * scale) / 2;
      const oy = ((height * dpr) - layout.size * scale) / 2;
      const at = (x: number, y: number) => [ox + x * scale, oy + y * scale] as const;
      context.clearRect(0, 0, canvas.width, canvas.height);

      context.lineWidth = 1 * dpr;
      for (const edge of edges) {
        const a = files.get(edge.from);
        const b = edge.to === null ? undefined : files.get(edge.to);
        const pa = a && layout.files.get(a.path);
        const pb = b && layout.files.get(b.path);
        if (!pa || !pb) continue;
        const [x1, y1] = at(pa.x, pa.y);
        const [x2, y2] = at(pb.x, pb.y);
        context.strokeStyle = "rgba(167, 139, 250, 0.16)";
        context.beginPath();
        context.moveTo(x1, y1);
        context.quadraticCurveTo((x1 + x2) / 2 + (y2 - y1) * 0.2, (y1 + y2) / 2 - (x2 - x1) * 0.2, x2, y2);
        context.stroke();
      }

      for (const file of files.values()) {
        const p = layout.files.get(file.path);
        if (!p) continue;
        const [x, y] = at(p.x, p.y);
        const intensity = 0.35 + 0.65 * ((churn.get(file.lineage) ?? 0) / maxChurn);
        const radius = Math.max(1.5, Math.sqrt(Math.max(1, file.loc ?? 1)) * 0.9) * scale;
        const glow = context.createRadialGradient(x, y, 0, x, y, radius * 3);
        const hue = hueOf(file.path);
        glow.addColorStop(0, `hsla(${hue}, 80%, 78%, ${intensity})`);
        glow.addColorStop(1, `hsla(${hue}, 80%, 60%, 0)`);
        context.fillStyle = glow;
        context.beginPath();
        context.arc(x, y, radius * 3, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = `hsla(${hue}, 60%, 92%, ${0.5 + intensity / 2})`;
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
      }

      const t = reduced ? 1 : Math.min(1, (now - start) / PULSE_MS);
      for (const event of events) {
        const p = layout.files.get(event.path);
        if (!p) continue;
        const [x, y] = at(p.x, p.y);
        context.strokeStyle = `rgba(${EVENT_COLOR[event.kind]}, ${reduced ? 0.9 : 1 - t * 0.7})`;
        context.lineWidth = 2 * dpr;
        context.beginPath();
        context.arc(x, y, (6 + (reduced ? 6 : t * 18)) * dpr, 0, Math.PI * 2);
        context.stroke();
      }
      if (t < 1) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    const observer = new ResizeObserver(() => requestAnimationFrame(draw));
    observer.observe(canvas);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [view, layout, step, reduced]);

  return (
    <canvas
      ref={canvasRef}
      className="galaxy"
      role="img"
      aria-label="Galaxy view: files as stars, brighter for files changed more often; rings mark files born, changed, moved or died in this commit."
    />
  );
}
