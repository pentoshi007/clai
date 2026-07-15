import { describe, expect, it } from "vitest";
import {
  activeIndex,
  filterPickerOptions,
  type PickerOption,
} from "../../../src/tui-v2/rendering/picker-filter.js";

function models(): PickerOption[] {
  return [
    { value: "minimax-m3", label: "minimax-m3", active: true },
    { value: "gpt-4o", label: "gpt-4o" },
    { value: "claude-opus-4-7", label: "claude-opus-4-7", description: "most capable" },
  ];
}

describe("filterPickerOptions (PICK-001)", () => {
  it("returns every option unchanged for an empty query", () => {
    expect(filterPickerOptions(models(), "")).toEqual(models());
  });

  it("matches a non-contiguous subsequence across whitespace-collapsed input", () => {
    const result = filterPickerOptions(models(), "mini 3");
    expect(result[0]?.value).toBe("minimax-m3");
  });

  it("ranks a prefix match above a looser subsequence match", () => {
    const options: PickerOption[] = [
      { value: "zzzgptzzz", label: "zzzgptzzz" },
      { value: "gpt-4o", label: "gpt-4o" },
    ];
    const result = filterPickerOptions(options, "gpt");
    expect(result[0]?.value).toBe("gpt-4o");
  });

  it("excludes an option with no matching field", () => {
    const result = filterPickerOptions(models(), "zzz");
    expect(result).toEqual([]);
  });

  it("only searches description when searchDescription is enabled", () => {
    const withDescription = filterPickerOptions(models(), "capable", { searchDescription: true });
    expect(withDescription.map((o) => o.value)).toEqual(["claude-opus-4-7"]);

    const withoutDescription = filterPickerOptions(models(), "capable", { searchDescription: false });
    expect(withoutDescription).toEqual([]);
  });

  it("does not let a query borrow characters across the label/value boundary", () => {
    // "ab" only appears as a subsequence if label+value are concatenated;
    // scored per-field, neither "x-a" nor "b-y" alone contains it.
    const options: PickerOption[] = [{ value: "b-y", label: "x-a" }];
    expect(filterPickerOptions(options, "ab")).toEqual([]);
  });
});

describe("activeIndex", () => {
  it("finds the active option's index", () => {
    expect(activeIndex(models())).toBe(0);
  });

  it("defaults to 0 when nothing is active", () => {
    expect(activeIndex([{ value: "a", label: "a" }, { value: "b", label: "b" }])).toBe(0);
  });
});
