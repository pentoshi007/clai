import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, getConfigPath, updateConfig } from "../../../src/store/config.js";
import { PASTE_START, PASTE_END, PASTE_BURST_SETTLE_MS } from "../../../src/classic/input/terminal-sequences.js";
import { createHarness, type Harness } from "./harness.js";

let harness: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  updateConfig({ saveToolOutputs: false, privateMode: false });
  harness = createHarness({ commands: true });
});

afterEach(() => {
  harness.dispose();
  vi.useRealTimers();
});

async function openSettings(): Promise<void> {
  harness.wiring.handleData(`${PASTE_START}/settings${PASTE_END}`);
  await vi.advanceTimersByTimeAsync(PASTE_BURST_SETTLE_MS + 50);
  harness.wiring.handleData("\r");
  await vi.advanceTimersByTimeAsync(PASTE_BURST_SETTLE_MS + 50);
}

function settingLabel(): string | undefined {
  const overlay = harness.services.overlay.getState();
  expect(overlay.kind).toBe("picker");
  return overlay.kind === "picker" ? overlay.request.options[0]?.label : undefined;
}

describe("Classic settings", () => {
  it("opens locally, adjusts with arrows, toggles without closing, and persists", async () => {
    await openSettings();
    expect(settingLabel()).toBe("Save command outputs · Off");
    for (const key of ["\x1b[A", "\x1b[B", "\t", "\x1b[Z"]) {
      harness.wiring.handleData(key);
      expect(settingLabel()).toBe("Save command outputs · Off");
    }
    harness.wiring.handleData("\x1b[C");
    expect(getConfig().saveToolOutputs).toBe(true);
    expect(settingLabel()).toBe("Save command outputs · On");
    expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).saveToolOutputs).toBe(true);
    harness.wiring.handleData("\x1b[D");
    expect(getConfig().saveToolOutputs).toBe(false);
    harness.wiring.handleData(" ");
    expect(getConfig().saveToolOutputs).toBe(true);
    harness.wiring.handleData("\r");
    await vi.advanceTimersByTimeAsync(PASTE_BURST_SETTLE_MS + 50);
    expect(getConfig().saveToolOutputs).toBe(false);
    harness.wiring.handleData("\x1b");
    await vi.advanceTimersByTimeAsync(150);
    expect(harness.services.overlay.isOpen()).toBe(false);
    expect(harness.wiring.composer.text).toBe("");
    await openSettings();
    expect(settingLabel()).toBe("Save command outputs · Off");
  });

  it("keeps filters and focus while changing a setting and ignores empty results", async () => {
    await openSettings();
    harness.wiring.handleData("save");
    harness.wiring.handleData("\x1b[C");
    expect(harness.wiring.panels.getSnapshot().picker.query).toBe("save");
    expect(getConfig().saveToolOutputs).toBe(true);
    harness.wiring.handleData("zzzz");
    harness.wiring.handleData("\x1b[D\r");
    expect(getConfig().saveToolOutputs).toBe(true);
    expect(harness.services.overlay.isOpen()).toBe(true);
    expect(harness.wiring.composer.text).toBe("");
  });
});
