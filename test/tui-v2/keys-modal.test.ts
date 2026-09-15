import { describe, expect, it } from "vitest";
import { buildKeysPickerAnswer } from "../../src/tui-v2/components/modal/keys-modal-pick.js";

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
});
