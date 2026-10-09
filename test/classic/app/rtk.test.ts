import { createElement } from "react";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassicApp } from "../../../src/classic/app/ClassicApp.js";
import { createRtkExecutionRecorder } from "../../../src/store/rtk-usage.js";
import { updateConfig } from "../../../src/store/config.js";
import { detectRtk, readRtkGain, type RtkGain } from "../../../src/tools/rtk/binary.js";
import { ServicesProvider } from "../../../src/ui-core/react/providers.js";
import { createHarness, type Harness } from "./harness.js";

vi.mock("../../../src/tools/rtk/binary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/tools/rtk/binary.js")>()),
  detectRtk: vi.fn(),
  readRtkGain: vi.fn(),
}));

let harness: Harness | undefined;
let view: ReturnType<typeof render> | undefined;
const frame = (): string => view?.lastFrame()?.replace(/[│║]/g, "").replace(/\s+/g, " ") ?? "";

async function mount(columns: number): Promise<Harness> {
  vi.mocked(detectRtk).mockReset().mockResolvedValue({ state: "ready", path: "/opt/bin/rtk", version: "0.51.0" });
  vi.mocked(readRtkGain).mockReset().mockResolvedValue({ commands: 800, savedTokens: 1_486_906, savingsPct: 82.54 });
  updateConfig({ rtk: true });
  harness = createHarness({ columns, rows: 35, commands: true });
  createRtkExecutionRecorder(harness.services.session.sessionId)();
  view = render(createElement(ServicesProvider, {
    services: harness.services,
    children: createElement(ClassicApp, { wiring: harness.wiring }),
  }));
  await expect.poll(frame).toContain("clai");
  harness.wiring.composer.setText("/rtk");
  harness.wiring.handleData("\r");
  await expect.poll(frame).toContain("rtk 0.51.0");
  return harness;
}

afterEach(() => {
  view?.unmount();
  harness?.dispose();
  harness = undefined;
  view = undefined;
});

describe("Classic /rtk interaction", () => {
  it.each([120, 80])("opens, refreshes, reports failure, and recovers at %s columns", async (columns) => {
    const h = await mount(columns);
    expect(frame()).toContain("1 automatic RTK run this session");
    expect(frame()).toContain("1.5M estimated tokens saved this session (83%)");
    expect(readRtkGain).toHaveBeenCalledWith("/opt/bin/rtk", h.services.session.sessionId);
    let resolve!: (gain: RtkGain | undefined) => void;
    vi.mocked(readRtkGain).mockReturnValueOnce(new Promise((settle) => { resolve = settle; }));
    h.wiring.handleData("\x1b[B");
    h.wiring.handleData("\x1b[B");
    h.wiring.handleData("\r");
    await expect.poll(frame).toContain("Detecting rtk…");
    await expect.poll(() => vi.mocked(readRtkGain).mock.calls.length).toBe(2);
    resolve(undefined);
    await expect.poll(frame).toContain("RTK savings unavailable");
    expect(h.services.focus.activeContext()).toBe("picker");
    vi.mocked(readRtkGain).mockResolvedValue({ commands: 0, savedTokens: 0, savingsPct: 0 });
    h.wiring.handleData("\r");
    await expect.poll(frame).toContain("no RTK savings recorded for this session yet");
    h.wiring.handleData("\x1b");
    await expect.poll(() => h.services.overlay.getState().kind).toBe("none");
    expect(h.services.focus.activeContext()).toBe("composer");
    h.wiring.composer.setText("still usable");
    await expect.poll(frame).toContain("still usable");
  });
});
