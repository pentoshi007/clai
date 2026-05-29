import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  modelSupportsVision,
  preferredVisionModel,
} from "../src/llm/capabilities.js";
import { toOpenAiMessages } from "../src/llm/http.js";
import {
  loadImageAttachments,
  expandMentions,
  imageAttachmentPaths,
} from "../src/ui/mentions.js";
import type { ChatMessage } from "../src/types.js";

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
      "claude-haiku-4-5-20251001",
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
    expect(modelSupportsVision("groq", "llama-3.3-70b-versatile")).toBe(false);
    expect(modelSupportsVision("anthropic", "claude-2")).toBe(false);
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

    const imgs = loadImageAttachments(`${png} what is this`, dir);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.mediaType).toBe("image/png");
    expect(imgs[0]!.dataBase64.length).toBeGreaterThan(0);
  });

  it("notes images as viewable when vision is enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-vis-"));
    dirs.push(dir);
    const png = join(dir, "shot.png");
    writeFileSync(png, Buffer.from(PNG_HEX, "hex"));
    const exp = expandMentions(`${png} hi`, dir, true);
    expect(exp.attachments[0]!.note).toMatch(/attached as multimodal input/i);
    expect(exp.attachments[0]!.note).toMatch(/colors, layout, spacing/i);
  });

  it("notes OCR fallback when vision is disabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-vis-"));
    dirs.push(dir);
    const png = join(dir, "shot.png");
    writeFileSync(png, Buffer.from(PNG_HEX, "hex"));
    const exp = expandMentions(`${png} hi`, dir, false);
    expect(exp.attachments[0]!.note).toMatch(/can't view images/i);
  });

  it("imageAttachmentPaths finds image paths regardless of vision support", () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-vis-"));
    dirs.push(dir);
    const png = join(dir, "shot.png");
    writeFileSync(png, Buffer.from(PNG_HEX, "hex"));
    const txt = join(dir, "notes.txt");
    writeFileSync(txt, "hello");
    const paths = imageAttachmentPaths(`${png} and ${txt} what is this`, dir);
    expect(paths).toEqual([png]);
  });

  it("imageAttachmentPaths returns empty when no images are referenced", () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-vis-"));
    dirs.push(dir);
    expect(imageAttachmentPaths("just a question", dir)).toEqual([]);
  });
});
