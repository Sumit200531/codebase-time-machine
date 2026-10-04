// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { DEMO_BUNDLE } from "../src/lib/bundle.ts";
import { RepoView } from "../src/lib/repo-view.ts";

// jsdom lacks these browser APIs; the components handle their absence gracefully.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false; };
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function click(element: Element | null | undefined) {
  if (!element) throw new Error("element not found");
  act(() => (element as HTMLElement).click());
}
const button = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

describe("Explorer smoke test", () => {
  it("renders every view at every step of the demo without errors", () => {
    const errors = vi.spyOn(console, "error");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<App />));

    expect(container.querySelector(".demo-badge")?.textContent).toBe("Demo data");
    const slider = container.querySelector<SVGElement>("[role=slider]")!;
    const steps = DEMO_BUNDLE.steps.length;

    for (const view of ["Map", "Galaxy", "Architecture", "Compare", "People"]) {
      click(button(container, view));
      act(() => slider.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
      for (let i = 1; i < steps; i++) {
        act(() => slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
      }
      expect(slider.getAttribute("aria-valuenow")).toBe(String(steps));
    }

    // Map with the accessible table, file lifecycle, commit diff in split mode.
    click(button(container, "Map"));
    act(() => (container.querySelector("input[type=checkbox]:not(.transport input)") as HTMLInputElement).click());
    const firstFileRow = container.querySelector(".file-row");
    click(firstFileRow);
    expect(container.querySelector(".lifecycle-events")).not.toBeNull();
    click(button(container, "Back to commit"));
    click(button(container, "Split"));
    expect(container.querySelector(".diff-table.mode-split")).not.toBeNull();

    // History search.
    const search = container.querySelector<HTMLInputElement>("#history-search")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(search, "redis");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector(".search-results")?.textContent).toContain("Improve API caching with Redis");

    click(button(container, "About"));
    expect(container.querySelector("dialog[open]")).not.toBeNull();

    expect(errors).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("derives architecture that matches the demo's history", () => {
    const view = new RepoView(DEMO_BUNDLE);
    const final = view.architecture(view.lastStep);
    const ids = final.modules.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["gateway", "services/auth", "services/tasks", "services/cache", "database", "workers", "frontend"]));
    expect(final.edges).toContainEqual(expect.objectContaining({ from: "services/tasks", to: "services/cache" }));
    expect(final.packages).toEqual(expect.arrayContaining(["express", "ioredis", "bullmq", "pg"]));
    // Importers sit above what they import.
    const rank = new Map(final.modules.map((m) => [m.id, m.rank]));
    for (const edge of final.edges) expect(rank.get(edge.from)!).toBeLessThan(rank.get(edge.to)!);
    // Before the refactor there was no gateway.
    const beforeRefactor = DEMO_BUNDLE.milestones.find((m) => m.kind === "refactor")!.step - 1;
    expect(view.architecture(beforeRefactor).modules.map((m) => m.id)).not.toContain("gateway");
  });
});
