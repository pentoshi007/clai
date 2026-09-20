import { describe, expect, it } from "vitest";
import { formatKeyStatus } from "../src/ui-core/rendering/format-keys.js";

describe("TUI /keys output", () => {
  it("shows provider state and only masked credentials", () => {
    const output = formatKeyStatus([
      {
        provider: "openai",
        label: "openai",
        active: true,
        configured: true,
        source: "keychain",
        maskedKey: "sk-p••••1234",
        model: "gpt-5",
      },
      {
        provider: "codex",
        label: "Chatgpt Subscription(free/go/plus/pro)",
        active: false,
        configured: true,
        source: "keychain",
        maskedKey: "codex••••1234",
        model: "gpt-5.6-luna",
      },
      {
        provider: "copilot",
        label: "Github Copilot",
        active: false,
        configured: false,
        source: "missing",
        model: "gpt-5.1",
      },
    ], [
      { provider: "duckduckgo", active: true, configured: true, source: "keyless" },
    ]);
    expect(output).toContain("LLM PROVIDERS");
    expect(output).toContain("SEARCH PROVIDERS");
    expect(output).toContain("sk-p••••1234");
    expect(output).toContain("gpt-5");
    expect(output).toContain("Chatgpt Subscription(free/go/plus/pro)");
    expect(output).toContain("Github Copilot");
    expect(output).toContain("◀");
    expect(output).not.toContain("unmasked-secret");
  });
});
