import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  modelSupportsVision,
  preferredVisionModel,
  registerModelVisionCapability,
} from "../src/llm/capabilities.js";
import { toOpenAiMessages } from "../src/llm/http.js";
import {
  loadImageAttachments,
  expandMentions,
  imageAttachmentPaths,
  formatAttachmentReference,
} from "../src/ui/mentions.js";
import type { ChatMessage } from "../src/types.js";
import { shouldEnableImageOcr } from "../src/agent/runner.js";
import { imageView } from "../src/tools/image.js";

// 1x1 transparent PNG.
const PNG_HEX =
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082";

describe("modelSupportsVision", () => {
  it("flags vision-capable frontier models", () => {
    expect(modelSupportsVision("agentrouter", "claude-opus-4-6")).toBe(true);
    expect(modelSupportsVision("anthropic", "claude-3-5-sonnet-latest")).toBe(
      true,
    );
    expect(modelSupportsVision("openai", "gpt-4o")).toBe(true);
    expect(modelSupportsVision("gemini", "gemini-2.0-flash")).toBe(true);
    expect(
      modelSupportsVision("nvidia", "meta/llama-4-maverick-17b-128e-instruct"),
    ).toBe(true);
    expect(modelSupportsVision("ollama", "llava")).toBe(true);
  });

  it("chooses a same-provider vision fallback for text-only image prompts", () => {
    expect(preferredVisionModel("agentrouter", "deepseek-v4-pro")).toBe(
      "claude-opus-4-6",
    );
    expect(preferredVisionModel("nvidia", "openai/gpt-oss-20b")).toBe(
      "meta/llama-4-maverick-17b-128e-instruct",
    );
    expect(preferredVisionModel("agentrouter", "claude-opus-4-6")).toBe(
      "claude-opus-4-6",
    );
  });

  it("does not flag text-only models", () => {
    expect(modelSupportsVision("nvidia", "openai/gpt-oss-20b")).toBe(false);
    expect(modelSupportsVision("nvidia", "meta/llama-3.3-70b-instruct")).toBe(false);
    expect(modelSupportsVision("anthropic", "claude-2")).toBe(false);
  });

  it("resolves TokenRouter namespaced vision metadata", () => {
    expect(modelSupportsVision("tokenrouter", "moonshotai/kimi-k2.7-code")).toBe(
      true,
    );
    expect(modelSupportsVision("tokenrouter", "qwen/qwen3p5-vl")).toBe(true);
    expect(modelSupportsVision("tokenrouter", "minimax/minimax-m3")).toBe(true);
    expect(modelSupportsVision("tokenrouter", "deepseek/deepseek-v4-pro")).toBe(
      false,
    );
    expect(modelSupportsVision("tokenrouter", "openai/gpt-oss-120b")).toBe(
      false,
    );
    expect(preferredVisionModel("tokenrouter", "deepseek/deepseek-v4-pro")).toBe(
      "moonshotai/kimi-k2.7-code",
    );
  });
});

describe("vision-first image inspection", () => {
  it("disables lossy OCR when image bytes are attached", () => {
    expect(shouldEnableImageOcr("what is this screenshot?", true)).toBe(false);
  });

  it("keeps OCR available when explicitly requested or no image is attached", () => {
    expect(shouldEnableImageOcr("OCR this screenshot", true)).toBe(true);
    expect(shouldEnableImageOcr("read the image", false)).toBe(true);
  });
});

describe("toOpenAiMessages multimodal", () => {
  it("serializes images into image_url content parts", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "what is this",
        images: [{ mediaType: "image/png", dataBase64: "AAAA" }],
      },
    ];
    const out = toOpenAiMessages(messages);
    expect(Array.isArray(out[0]!.content)).toBe(true);
    const parts = out[0]!.content as Array<{
      type: string;
      image_url?: { url: string; detail?: string };
    }>;
    expect(parts.map((p) => p.type)).toEqual(["text", "image_url"]);
    expect(parts[1]!.image_url?.url).toBe("data:image/png;base64,AAAA");
    expect(parts[1]!.image_url?.detail).toBe("high");
  });

  it("keeps plain string content when there are no images", () => {
    const out = toOpenAiMessages([{ role: "user", content: "hello" }]);
    expect(out[0]!.content).toBe("hello");
  });

  it("never attaches images on non-user roles", () => {
    const out = toOpenAiMessages([
      {
        role: "assistant",
        content: "ok",
        images: [{ mediaType: "image/png", dataBase64: "AAAA" }],
      },
    ]);
    expect(out[0]!.content).toBe("ok");
  });
});

describe("image.view direct vision", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("returns the exact prepared pixels for a vision-capable model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-view-"));
    dirs.push(dir);
    const png = join(dir, "shot.png");
    const expected = Buffer.from(PNG_HEX, "hex");
    writeFileSync(png, expected);

    const result = await imageView(
      { path: png },
      { llmProvider: "openai", llmModel: "gpt-4o-mini" },
    );

    expect(result.ok).toBe(true);
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0]).toMatchObject({
      mediaType: "image/png",
      path: png,
    });
    expect(Buffer.from(result.images![0]!.dataBase64, "base64")).toEqual(expected);
    expect(result.output).toMatch(/actual|pixels|look at it directly/i);
  });

  it("refuses a model observed to be text-only instead of pretending it can see", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-view-"));
    dirs.push(dir);
    const png = join(dir, "shot.png");
    writeFileSync(png, Buffer.from(PNG_HEX, "hex"));
    const textOnlyModel = "observed-text-only-for-image-view-test";
    registerModelVisionCapability({
      provider: "openai",
      model: textOnlyModel,
      vision: false,
    });

    const result = await imageView(
      { path: png },
      { llmProvider: "openai", llmModel: textOnlyModel },
    );

    expect(result.ok).toBe(false);
    expect(result.images).toBeUndefined();
    expect(result.output).toMatch(/cannot accept image input|vision model/i);
  });
});

describe("loadImageAttachments", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
  });

  it("reads an image file into a base64 ChatImage", () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-vis-"));
    dirs.push(dir);
    const png = join(dir, "shot.png");
    writeFileSync(png, Buffer.from(PNG_HEX, "hex"));

    const imgs = loadImageAttachments(`${formatAttachmentReference(png, dir)} what is this`, dir);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.mediaType).toBe("image/png");
    expect(imgs[0]!.dataBase64.length).toBeGreaterThan(0);
  });

  it("notes images as viewable when vision is enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-vis-"));
    dirs.push(dir);
    const png = join(dir, "shot.png");
    writeFileSync(png, Buffer.from(PNG_HEX, "hex"));
    const exp = expandMentions(`${formatAttachmentReference(png, dir)} hi`, dir, true);
    expect(exp.attachments[0]!.note).toMatch(/attached as multimodal input/i);
    expect(exp.attachments[0]!.note).toMatch(/inspect it directly/i);
  });

  it("notes OCR fallback when vision is disabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-vis-"));
    dirs.push(dir);
    const png = join(dir, "shot.png");
    writeFileSync(png, Buffer.from(PNG_HEX, "hex"));
    const exp = expandMentions(`${formatAttachmentReference(png, dir)} hi`, dir, false);
    expect(exp.attachments[0]!.note).toMatch(/not viewable/i);
  });

  it("imageAttachmentPaths finds image paths regardless of vision support", () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-vis-"));
    dirs.push(dir);
    const png = join(dir, "shot.png");
    writeFileSync(png, Buffer.from(PNG_HEX, "hex"));
    const txt = join(dir, "notes.txt");
    writeFileSync(txt, "hello");
    const paths = imageAttachmentPaths(`${formatAttachmentReference(png, dir)} and ${txt} what is this`, dir);
    // Paths are stabilized into scratch/attachments for vision reliability.
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/shot\.png$/);
    expect(paths[0]).toContain("attachments");
  });

  it("imageAttachmentPaths returns empty when no images are referenced", () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-vis-"));
    dirs.push(dir);
    expect(imageAttachmentPaths("just a question", dir)).toEqual([]);
  });
});
