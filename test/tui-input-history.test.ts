import { describe, expect, it } from "vitest";
import { shouldStoreInPromptHistory } from "../src/tui/input-history.js";

describe("TUI prompt history", () => {
  it("stores user prompts but excludes recognized slash commands", () => {
    expect(shouldStoreInPromptHistory("find open ports")).toBe(true);
    expect(shouldStoreInPromptHistory("/help")).toBe(false);
    expect(shouldStoreInPromptHistory("/provider openai")).toBe(false);
  });

  it("keeps absolute paths because they are prompts or dropped files", () => {
    expect(shouldStoreInPromptHistory("/Users/me/screenshot.png what is this")).toBe(true);
  });
});
