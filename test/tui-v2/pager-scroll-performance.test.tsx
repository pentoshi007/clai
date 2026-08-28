import { describe, expect, it, vi } from "vitest";
import type { AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";

const wrapPagerLineCalls = vi.hoisted(() => vi.fn());
const hookHarness = vi.hoisted(() => {
  type Slot =
    | { kind: "state"; value: unknown }
    | { kind: "memo"; value: unknown; deps: readonly unknown[] | undefined }
    | { kind: "ref"; value: { current: unknown } }
    | { kind: "effect" };

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
    useEffect(): void {
      const index = cursor++;
      slots[index] = { kind: "effect" };
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

const services = {} as AppServices;
const theme = themeFor("dark");

describe("OpenTUI pager scroll performance", () => {
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
