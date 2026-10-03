import { describe, expect, it, vi } from "vitest";
import type { AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";

const wrapPagerLineCalls = vi.hoisted(() => vi.fn());
const hookHarness = vi.hoisted(() => {
  type Slot =
    | { kind: "state"; value: unknown }
    | { kind: "memo"; value: unknown; deps: readonly unknown[] | undefined }
    | { kind: "ref"; value: { current: unknown } }
    | { kind: "effect"; deps: readonly unknown[] | undefined; run: () => void | (() => void); cleanup?: (() => void) | undefined; pending: boolean };

  let cursor = 0;
  let slots: Slot[] = [];
  const sameDeps = (
    left: readonly unknown[] | undefined,
    right: readonly unknown[] | undefined,
  ): boolean =>
    left !== undefined &&
    right !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));

  return {
    reset(): void {
      for (const slot of slots) if (slot.kind === "effect") slot.cleanup?.();
      cursor = 0;
      slots = [];
    },
    beginRender(): void {
      cursor = 0;
    },
    useState(initial: unknown) {
      const index = cursor++;
      if (!slots[index]) {
        slots[index] = {
          kind: "state",
          value: typeof initial === "function" ? initial() : initial,
        };
      }
      const slot = slots[index]!;
      if (slot.kind !== "state") throw new Error("hook order changed");
      return [
        slot.value,
        (next: unknown) => {
          slot.value = typeof next === "function"
            ? (next as (value: unknown) => unknown)(slot.value)
            : next;
        },
      ];
    },
    useMemo(factory: () => unknown, deps: readonly unknown[] | undefined) {
      const index = cursor++;
      const slot = slots[index];
      if (slot?.kind === "memo" && sameDeps(slot.deps, deps)) {
        return slot.value;
      }
      const value = factory();
      slots[index] = { kind: "memo", value, deps };
      return value;
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!slots[index]) {
        slots[index] = { kind: "ref", value: { current: initial } };
      }
      const slot = slots[index]!;
      if (slot.kind !== "ref") throw new Error("hook order changed");
      return slot.value;
    },
    useEffect(run: () => void | (() => void), deps: readonly unknown[] | undefined): void {
      const index = cursor++;
      const slot = slots[index];
      if (slot?.kind === "effect" && sameDeps(slot.deps, deps)) return;
      if (slot?.kind === "effect") slot.cleanup?.();
      slots[index] = { kind: "effect", deps, run, pending: true };
    },
    flushEffects(): void {
      for (const slot of slots) {
        if (slot.kind !== "effect" || !slot.pending) continue;
        slot.pending = false;
        slot.cleanup = slot.run() || undefined;
      }
    },
    stateValues(): unknown[] {
      return slots.filter((slot) => slot.kind === "state").map((slot) => slot.value);
    },
    replaceState(current: unknown, next: unknown): boolean {
      const slot = slots.find(
        (candidate): candidate is Extract<Slot, { kind: "state" }> =>
          candidate.kind === "state" && Object.is(candidate.value, current),
      );
      if (!slot) return false;
      slot.value = next;
      return true;
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: hookHarness.useEffect,
    useMemo: hookHarness.useMemo,
    useRef: hookHarness.useRef,
    useState: hookHarness.useState,
    useContext: () => ({ width: 100, height: 30 }),
  };
});

vi.mock("@opentui/react", () => ({
  useKeyboard: vi.fn(),
  useTerminalDimensions: () => ({ width: 100, height: 30 }),
}));

vi.mock("../../src/ui-core/rendering/pager-chrome.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/ui-core/rendering/pager-chrome.js")
  >();
  return {
    ...actual,
    wrapPagerLine(line: string, width: number): string[] {
      wrapPagerLineCalls(line, width);
      return actual.wrapPagerLine(line, width);
    },
  };
});

import { Pager } from "../../src/tui-v2/components/pager/pager.js";

const services = {
  capabilities: { colorMode: "truecolor" },
} as AppServices;
const theme = themeFor("dark");

describe("OpenTUI pager scroll performance", () => {
  it("keeps live content subscribed while follow is paused", async () => {
    const { createUsagePagerSource } = await import("../../src/ui-core/rendering/usage-pager-source.js");
    let body = "initial usage";
    let emit = (): void => {};
    const source = createUsagePagerSource({
      renderBody: () => body,
      subscribe: (listener) => { emit = listener; return () => {}; },
    });
    const watch = vi.spyOn(source, "watch");
    const tail = vi.spyOn(source, "readTail");
    const read = vi.spyOn(source, "readPage");
    const props = { services, theme, title: "usage", body, source, markdown: "plain" as const };
    const render = () => {
      hookHarness.beginRender();
      Pager(props);
      hookHarness.flushEffects();
    };
    hookHarness.reset();
    try {
      render();
      await Promise.resolve();
      expect(tail).toHaveBeenCalledOnce();
      expect(hookHarness.replaceState(true, false)).toBe(true);
      render();
      await Promise.resolve();
      expect(read).toHaveBeenLastCalledWith(0);
      expect(watch).toHaveBeenCalledTimes(2);
      body = "updated while scrolled";
      emit();
      await vi.waitFor(() => expect(hookHarness.stateValues()).toContain(body));
      expect(tail).toHaveBeenCalledOnce();
      expect(hookHarness.stateValues()[8]).toBe(false);
    } finally {
      hookHarness.reset();
      source.dispose();
    }
  });
  it("does not re-wrap every body row when only the scroll hint changes", () => {
    const rowCount = 600;
    const body = Array.from(
      { length: rowCount },
      (_, index) => `pager-row-${String(index).padStart(4, "0")} short content`,
    ).join("\n");
    const props = {
      services,
      theme,
      title: "large output",
      body,
      markdown: "plain" as const,
    };
    hookHarness.reset();
    wrapPagerLineCalls.mockClear();

    hookHarness.beginRender();
    Pager(props);
    const initialWrapCalls = wrapPagerLineCalls.mock.calls.length;
    expect(initialWrapCalls).toBeGreaterThanOrEqual(rowCount);

    expect(hookHarness.replaceState("top", "50%")).toBe(true);
    hookHarness.beginRender();
    Pager(props);

    expect(wrapPagerLineCalls).toHaveBeenCalledTimes(initialWrapCalls);
  });
});
