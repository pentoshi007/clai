import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { PanelHost } from "../../../src/classic/panels/panel-host.js";
import { OVERLAY_MIN_ROWS } from "../../../src/classic/chrome/row-budget.js";
import { EMPTY_TRANSCRIPT_STATE } from "../../../src/ui-core/state/transcript-types.js";
import { createHarness, ink, job } from "./harness.js";

const PICKER = {
  title: "Select model",
  options: [{ value: "a", label: "alpha" }, { value: "b", label: "beta" }],
};

function mount(harness: ReturnType<typeof createHarness>, rows = 7) {
  return render(
    <PanelHost
      controller={harness.panels}
      ink={ink}
      columns={80}
      rows={rows}
      jobs={harness.jobs}
      transcript={harness.transcript}
      now={0}
    />,
  );
}

describe("panel host", () => {
  it("renders nothing while no overlay is open", () => {
    const harness = createHarness();
    expect(mount(harness).lastFrame()).toBe("");
  });

  it("renders nothing when the allocator granted no rows", () => {
    const harness = createHarness();
    harness.overlay.openPicker(PICKER, vi.fn());
    expect(mount(harness, 0).lastFrame()).toBe("");
  });

  it("dispatches each overlay kind to its panel", () => {
    const cases: readonly (readonly [() => void, string])[] = [
      [() => harness.overlay.openPicker(PICKER, vi.fn()), "Select model"],
      [() => harness.overlay.openPager("output", "body"), "output"],
      [() => harness.overlay.openJobs(), "Background jobs"],
      [() => void harness.overlay.openConfirm({ kind: "tool", prompt: "Run?" }), "Approve tool"],
      [() => void harness.overlay.openSecret({ title: "sudo", prompt: "pw" }), "sudo"],
      [() => void harness.overlay.openScopeEditor({ initialTargets: [] }), "Engagement scope"],
      [
        () => void harness.overlay.openKeysEditor({ provider: "nvidia", initialKeys: [] }),
        "nvidia",
      ],
      [
        () => harness.overlay.openPromptActions({ prompt: "hello", onResend: vi.fn() }),
        "Prompt",
      ],
    ];
    let harness = createHarness();
    for (const [open, expected] of cases) {
      harness = createHarness();
      open();
      const frame = mount(harness).lastFrame() ?? "";
      expect(frame, expected).toContain(expected);
      expect(frame.split("\n")).toHaveLength(7);
    }
  });

  it("renders the search panel when no overlay owns the slot", () => {
    const harness = createHarness();
    harness.transcript = EMPTY_TRANSCRIPT_STATE;
    harness.panels.openSearch();
    expect(mount(harness).lastFrame()).toContain("Find in transcript");
  });

  it("re-renders when the panel controller publishes", async () => {
    const harness = createHarness();
    harness.overlay.openPicker(PICKER, vi.fn());
    const view = mount(harness);
    expect(view.lastFrame()).toContain("❯ alpha");
    harness.press("down");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.lastFrame()).toContain("❯ beta");
  });

  it("keeps every panel exactly as tall as the rows it was granted", () => {
    const harness = createHarness();
    harness.jobs = [job()];
    harness.overlay.openJobs();
    for (const rows of [OVERLAY_MIN_ROWS, 8, 14]) {
      expect((mount(harness, rows).lastFrame() ?? "").split("\n")).toHaveLength(rows);
    }
  });
});
