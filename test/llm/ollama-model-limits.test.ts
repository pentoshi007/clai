import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OLLAMA_MAX_NUM_CTX,
  ollamaTrainedContextLength,
  registerOllamaModelLimits,
  resetOllamaModelLimitsForTesting,
} from "../../src/llm/ollama-model-limits.js";
import { resetReasoningKnowledge } from "../../src/llm/capabilities.js";
import { modelContextWindow } from "../../src/llm/context-windows.js";
import { ollamaOptions } from "../../src/llm/ollama.js";

let dataDir: string;
let originalDataDir: string | undefined;

const tags = {
  models: [
    { name: "llama3.1:8b", digest: "sha-llama" },
    { name: "phi3:mini", digest: "sha-phi" },
    { name: "mystery:latest", digest: "sha-mystery" },
  ],
};

const trained: Record<string, number> = {
  "llama3.1:8b": 131_072,
  "phi3:mini": 4_096,
};

function showFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const model = JSON.parse(String(init?.body)).model as string;
    const contextLength = trained[model];
    if (contextLength === undefined) return new Response("not found", { status: 404 });
    return new Response(
      JSON.stringify({ model_info: { "general.architecture": "llama", "llama.context_length": contextLength } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

beforeEach(() => {
  originalDataDir = process.env.CLAI_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "clai-ollama-limits-"));
  process.env.CLAI_DATA_DIR = dataDir;
  resetReasoningKnowledge();
  resetOllamaModelLimitsForTesting();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetReasoningKnowledge();
  if (originalDataDir === undefined) delete process.env.CLAI_DATA_DIR;
  else process.env.CLAI_DATA_DIR = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Ollama model limits", () => {
  it("reads the trained context length from /api/show model_info", () => {
    expect(
      ollamaTrainedContextLength({ model_info: { "qwen2.context_length": 32_768 } }),
    ).toBe(32_768);
    expect(ollamaTrainedContextLength({ model_info: {} })).toBeUndefined();
    expect(ollamaTrainedContextLength(undefined)).toBeUndefined();
  });

  it("registers the served window, capped by the num_ctx clai sends", async () => {
    const fetchMock = showFetch();
    vi.stubGlobal("fetch", fetchMock);

    await registerOllamaModelLimits("http://localhost:11434", tags);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/show",
      expect.objectContaining({ method: "POST" }),
    );
    expect(modelContextWindow("llama3.1:8b", "ollama")).toBe(OLLAMA_MAX_NUM_CTX);
    expect(modelContextWindow("phi3:mini", "ollama")).toBe(4_096);
    expect(modelContextWindow("mystery:latest", "ollama")).toBe(OLLAMA_MAX_NUM_CTX);
    expect(ollamaOptions("phi3:mini", {}).num_ctx).toBe(4_096);
  });

  it("does not ask /api/show again for an unchanged model digest", async () => {
    const fetchMock = showFetch();
    vi.stubGlobal("fetch", fetchMock);

    await registerOllamaModelLimits("http://localhost:11434", tags);
    await registerOllamaModelLimits("http://localhost:11434", tags);

    expect(fetchMock).toHaveBeenCalledTimes(tags.models.length);
  });
});
