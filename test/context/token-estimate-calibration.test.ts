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

  it("trusts a single exact downward correction immediately", async () => {
    const calibration = await import(
      "../../src/llm/token-estimate-calibration.js"
    );
    calibration.resetRequestTokenCalibration({ removePersisted: true });
    calibration.recordRequestTokenObservation({
      provider: "openai",
      model: "gpt-5.4",
      estimatedRequestTokens: 300_000,
      actualPromptTokens: 140_000,
    });

    expect(calibration.requestTokenCalibration("openai", "gpt-5.4")).toEqual({
      ratio: 140_000 / 300_000,
      samples: 1,
    });
    expect(
      calibration.calibratedRequestTokens("openai", "gpt-5.4", 300_000),
    ).toBe(140_000);
  });

  it("waits for a second observation before scaling an estimate upward", async () => {
    const calibration = await import(
      "../../src/llm/token-estimate-calibration.js"
    );
    calibration.resetRequestTokenCalibration({ removePersisted: true });
    const observation = {
      provider: "openai" as const,
      model: "gpt-5.4",
      estimatedRequestTokens: 100_000,
      actualPromptTokens: 120_000,
    };

    calibration.recordRequestTokenObservation(observation);
    expect(
      calibration.requestTokenCalibration("openai", "gpt-5.4"),
    ).toBeUndefined();
    expect(
      calibration.calibratedRequestTokens("openai", "gpt-5.4", 100_000),
    ).toBe(100_000);

    calibration.recordRequestTokenObservation(observation);
    expect(calibration.requestTokenCalibration("openai", "gpt-5.4")).toEqual({
      ratio: 1.2,
      samples: 2,
    });
    expect(
      calibration.calibratedRequestTokens("openai", "gpt-5.4", 100_000),
    ).toBe(120_000);
  });

  it("keeps calibration separate per provider and model route", async () => {
    const calibration = await import(
      "../../src/llm/token-estimate-calibration.js"
    );
    calibration.resetRequestTokenCalibration({ removePersisted: true });
    calibration.recordRequestTokenObservation({
      provider: "openai",
      model: "gpt-5.4",
      estimatedRequestTokens: 300_000,
      actualPromptTokens: 150_000,
    });

    expect(
      calibration.requestTokenCalibration("openai", "gpt-5.4")?.ratio,
    ).toBeCloseTo(0.5, 10);
    expect(
      calibration.requestTokenCalibration("openai", "gpt-5.5"),
    ).toBeUndefined();
    expect(
      calibration.requestTokenCalibration("nvidia", "gpt-5.4"),
    ).toBeUndefined();
    expect(
      calibration.calibratedRequestTokens("nvidia", "gpt-5.4", 300_000),
    ).toBe(300_000);
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
