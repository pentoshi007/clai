import { afterEach, describe, expect, it } from "vitest";
import {
  countRender,
  isRenderCountersEnabled,
  readRenderCounts,
  resetRenderCounts,
  setRenderCountersEnabled,
} from "../../../src/tui-v2/perf/render-counters.js";

afterEach(() => {
  resetRenderCounts();
  setRenderCountersEnabled(false);
});

describe("render counters", () => {
  it("records per-component counts while enabled", () => {
    setRenderCountersEnabled(true);
    expect(isRenderCountersEnabled()).toBe(true);
    countRender("App");
    countRender("App");
    countRender("ComposerEditor");
    expect(Object.fromEntries(readRenderCounts())).toEqual({
      App: 2,
      ComposerEditor: 1,
    });
  });

  it("ignores renders while disabled", () => {
    setRenderCountersEnabled(false);
    countRender("App");
    expect(readRenderCounts().size).toBe(0);
  });
});
