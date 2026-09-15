import { describe, expect, it } from "vitest";
import { buildKeysPickerAnswer, keysAddAtCapacity } from "../../src/tui-v2/components/modal/keys-modal-pick.js";

describe("tui-v2 model keys modal", () => {
  it("carries catalogue labels and row state through pick answers", () => {
    expect(buildKeysPickerAnswer([
      { id: 1, slotId: "openai\u001fgpt-4.1", placeholder: "openai / gpt-4.1", text: "", disabled: false },
      { id: 2, slotId: "anthropic\u001fclaude", placeholder: "anthropic / claude", text: "", disabled: true },
    ], 1)).toEqual({
      action: "pick",
      rows: [
        { slotId: "openai\u001fgpt-4.1", value: "openai / gpt-4.1", disabled: false },
        { slotId: "anthropic\u001fclaude", value: "anthropic / claude", disabled: true },
      ],
      activeIndex: 1,
    });
  });

  it("blocks the eleventh picker addition instead of dropping it on save", () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      slotId: `free\u001fmodel-${index}`,
      placeholder: `free / model-${index}`,
      text: "",
      disabled: false,
    }));
    expect(keysAddAtCapacity(rows, 10)).toBe(true);
    expect(keysAddAtCapacity(rows.slice(0, 9), 10)).toBe(false);
    expect(keysAddAtCapacity([
      ...rows.slice(0, 9),
      { id: 10, slotId: undefined, placeholder: "paste model", text: "typed", disabled: false },
    ], 10)).toBe(true);
    expect(keysAddAtCapacity([
      ...rows.slice(0, 9),
      { id: 10, slotId: undefined, placeholder: "paste model", text: "  ", disabled: false },
    ], 10)).toBe(false);
  });
});
