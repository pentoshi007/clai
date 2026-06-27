import { describe, expect, it } from "vitest";
import { formatKeyStatus } from "../src/tui/format-keys.js";

describe("TUI /keys output", () => {
  it("shows provider state and only masked credentials", () => {
    const output = formatKeyStatus([
      {
        provider: "openai",
        label: "openai",
        active: true,
        configured: true,
        source: "keychain",
        maskedKey: "sk-…1234",
        model: "gpt-5",
      },
    ], [
      { provider: "duckduckgo", active: true, configured: true, source: "keyless" },
    ]);
    expect(output).toContain("LLM PROVIDERS");
    expect(output).toContain("SEARCH PROVIDERS");
    expect(output).toContain("sk-…1234");
    expect(output).toContain("model=gpt-5");
    expect(output).not.toContain("unmasked-secret");
  });
});
