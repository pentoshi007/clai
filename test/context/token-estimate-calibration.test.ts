import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("request token calibration persistence", () => {
  let dataDir: string;

  beforeEach(() => {
    vi.resetModules();
    dataDir = mkdtempSync(join(tmpdir(), "clai-token-calibration-"));
    vi.stubEnv("CLAI_DATA_DIR", dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("preserves the learned request scale across a process restart", async () => {
    const first = await import("../../src/llm/token-estimate-calibration.js");
    first.resetRequestTokenCalibration({ removePersisted: true });
    first.recordRequestTokenObservation({
      provider: "openai",
      model: "gpt-5.4",
      estimatedRequestTokens: 366_021,
      actualPromptTokens: 128_271,
    });
    first.recordRequestTokenObservation({
      provider: "openai",
      model: "gpt-5.4",
      estimatedRequestTokens: 366_021,
      actualPromptTokens: 128_271,
    });

    expect(first.calibratedRequestTokens("openai", "gpt-5.4", 366_021)).toBe(
      128_271,
    );

    vi.resetModules();
    const restored = await import("../../src/llm/token-estimate-calibration.js");

    expect(restored.requestTokenCalibration("openai", "gpt-5.4")).toEqual({
      ratio: 128_271 / 366_021,
      samples: 2,
    });
    expect(restored.calibratedRequestTokens("openai", "gpt-5.4", 366_021)).toBe(
      128_271,
    );
  });
});
