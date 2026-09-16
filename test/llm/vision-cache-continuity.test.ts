import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearLearnedVisionCapabilities,
  clearModelVisionCapabilities,
  isKnownPatternVisionModel,
  learnModelVisionCapability,
  modelAcceptsImages,
  modelSupportsVision,
  modelVisionSupport,
  preferredVisionModel,
  registerModelVisionCapability,
} from "../../src/llm/capabilities.js";
import { resolveTurnInput } from "../../src/attachments/service.js";
import { requestForRoute } from "../../src/llm/routing/attempt-request.js";
import { compileRequestPlan } from "../../src/llm/request-plan.js";
import type { CompletionRequest } from "../../src/types.js";

const TEST_DIR = join(tmpdir(), `clai-vision-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  clearModelVisionCapabilities();
  clearLearnedVisionCapabilities();
});

afterEach(() => {
  clearModelVisionCapabilities();
  clearLearnedVisionCapabilities();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("vision model pattern recognition and prefix normalization", () => {
  it.each([
    ["free", "free-1/muse-spark-1.3-contributor-free"],
    ["free", "free-2/muse-spark-1.2-preview"],
    ["free", "muse-spark-1.3"],
    ["openai", "gpt-6"],
    ["openai", "gpt-6-mini"],
    ["openai", "gpt-7.1"],
    ["anthropic", "claude-fable-vision"],
    ["tokenrouter", "MiniMax-M3"],
    ["tokenrouter", "step-3-vision"],
    ["tokenrouter", "step-3.5"],
    ["tokenrouter", "mimo-v3"],
    ["qwen-cloud", "qwen3.5-plus"],
    ["qwen-cloud", "qwen3.5-max"],
    ["nvidia", "nvidia/vila-1.5"],
    ["nvidia", "nvidia/neva-22b"],
  ] as const)("recognizes %s/%s as a vision-capable model", (provider, model) => {
    expect(isKnownPatternVisionModel(provider, model)).toBe(true);
    expect(modelSupportsVision(provider, model)).toBe(true);
    expect(modelVisionSupport(provider, model)).toBe("yes");
    expect(modelAcceptsImages(provider, model)).toBe(true);
    expect(preferredVisionModel(provider, model)).toBe(model);
  });
});

describe("learned capability poisoning protection", () => {
  it("ignores learnModelVisionCapability false for known vision models", () => {
    const provider = "free";
    const model = "free-1/muse-spark-1.3-contributor-free";
    expect(modelSupportsVision(provider, model)).toBe(true);
    learnModelVisionCapability(provider, model, false);
    expect(modelSupportsVision(provider, model)).toBe(true);
    expect(modelVisionSupport(provider, model)).toBe("yes");
  });

  it("does not allow provider-observed negative capabilities to override known vision patterns", () => {
    const provider = "free";
    const model = "free-1/muse-spark-1.3-contributor-free";
    registerModelVisionCapability({
      provider,
      model,
      vision: false,
      source: "provider",
    });
    expect(modelSupportsVision(provider, model)).toBe(true);
    expect(modelVisionSupport(provider, model)).toBe("yes");
  });

  it("still honors user-declared negative overrides", () => {
    const provider = "free";
    const model = "free-1/muse-spark-1.3-contributor-free";
    registerModelVisionCapability({
      provider,
      model,
      vision: false,
      source: "user",
    });
    expect(modelSupportsVision(provider, model)).toBe(false);
    expect(modelVisionSupport(provider, model)).toBe("no");
  });
});

describe("turn input resolution with image attachments", () => {
  it("does not substitute free-1/muse-spark-1.3-contributor-free when images are attached", () => {
    const imagePath = join(TEST_DIR, "sample.png");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(imagePath, png);

    const resolved = resolveTurnInput({
      prompt: `Inspect @${imagePath}`,
      mode: "ask",
      provider: "free",
      model: "free-1/muse-spark-1.3-contributor-free",
      baseDir: TEST_DIR,
    });

    expect(resolved.model).toBe("free-1/muse-spark-1.3-contributor-free");
    expect(resolved.fallbackReason).toBeUndefined();
    expect(resolved.capability.vision).toBe(true);
    expect(resolved.capability.support).toBe("yes");
    expect(resolved.images.length).toBeGreaterThan(0);
  });
});

describe("cache prefix stability and continuity across turns", () => {
  const model = "free-1/muse-spark-1.3-contributor-free";
  const systemPrompt = "You are clai.\nAvailable tools: image.view, fs.read";
  const tools = [
    {
      name: "image.view",
      wireName: "image_view",
      description: "View image",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "fs.read",
      wireName: "fs_read",
      description: "Read file",
      parameters: { type: "object", properties: {} },
    },
  ];

  it("preserves system prompt and tool definitions byte-for-byte across image and text turns", () => {
    const turn1Request: CompletionRequest = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: "Look at this screenshot",
          images: [{ mediaType: "image/png", dataBase64: "aGVsbG8=" }],
        },
      ],
      tools,
    };

    const turn2Request: CompletionRequest = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: "Look at this screenshot",
          images: [{ mediaType: "image/png", dataBase64: "aGVsbG8=" }],
        },
        { role: "assistant", content: "I see a button in the screenshot." },
        { role: "user", content: "continue" },
      ],
      tools,
    };

    const routedTurn1 = requestForRoute(turn1Request, "free", model);
    const routedTurn2 = requestForRoute(turn2Request, "free", model);

    expect(routedTurn1.tools).toEqual(tools);
    expect(routedTurn2.tools).toEqual(tools);
    expect(routedTurn1.messages[0]?.content).toBe(systemPrompt);
    expect(routedTurn2.messages[0]?.content).toBe(systemPrompt);

    const plan1 = compileRequestPlan({
      provider: "free",
      model,
      messages: routedTurn1.messages,
      tools: routedTurn1.tools,
      stream: true,
    });

    const plan2 = compileRequestPlan({
      provider: "free",
      model,
      messages: routedTurn2.messages,
      tools: routedTurn2.tools,
      stream: true,
    });

    expect(plan1.cache.fingerprint.sections[0]?.sha256).toBe(
      plan2.cache.fingerprint.sections[0]?.sha256,
    );
    expect(plan1.cache.fingerprint.sections[1]?.sha256).toBe(
      plan2.cache.fingerprint.sections[1]?.sha256,
    );
    expect(plan1.images.visionAccepted).toBe(true);
    expect(plan2.images.visionAccepted).toBe(true);
  });
});
