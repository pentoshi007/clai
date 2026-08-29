import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getProviderModel } from "../src/store/config.js";
import { defaultModels } from "../src/llm/provider.js";

const root = join(fileURLToPath(new URL("..", import.meta.url)));

const PAIR_SENSITIVE_FILES = [
  "src/tui-v2/composer/composer-editor.tsx",
  "src/tui-v2/components/transcript/intro-card.tsx",
  "src/app/controllers/session-controller.ts",
];

describe("provider and model always travel as one pair", () => {
  it("never falls back to the global default model beside a session provider", () => {
    for (const relative of PAIR_SENSITIVE_FILES) {
      const source = readFileSync(join(root, relative), "utf8");
      expect(source).not.toContain("?? cfg.defaultModel");
      expect(source).not.toContain("?? config.defaultModel");
    }
  });

  it("derives the displayed model from the resolved provider", () => {
    const composer = readFileSync(
      join(root, "src/tui-v2/composer/composer-editor.tsx"),
      "utf8",
    );
    expect(composer).toContain("session.provider ?? cfg.defaultProvider");
    expect(composer).toContain("getProviderModel(activeProvider)");

    const intro = readFileSync(
      join(root, "src/tui-v2/components/transcript/intro-card.tsx"),
      "utf8",
    );
    expect(intro).toContain("getProviderModel(provider)");
  });

  it("resolves each provider to its own model rather than a shared default", () => {
    expect(getProviderModel("free")).toBe(defaultModels.free);
    expect(getProviderModel("free")).not.toBe(getProviderModel("modal"));
    expect(getProviderModel("nvidia")).not.toBe(defaultModels.free);
  });

  it("keeps the free provider away from another provider's flagship model", () => {
    expect(getProviderModel("free")).toContain("free");
    expect(getProviderModel("free")).not.toContain("kimi-k3");
  });
});
