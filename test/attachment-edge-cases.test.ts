import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatAttachmentReference, expandMentions, loadImageAttachments } from "../src/ui/mentions.js";
import { PasteRegistry } from "../src/ui-core/composer/paste-placeholder.js";
import { attachmentDisplayText } from "../src/attachments/labels.js";
import * as imageContent from "../src/attachments/image-content.js";
import { clearImagePreparationCache, prepareImageForModel } from "../src/attachments/image-prepare.js";
import { buildTurnRequest } from "../src/app/controllers/session-turn-request.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  clearImagePreparationCache();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function image(name = "shot.png"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clai-attachment-edge-"));
  directories.push(dir);
  const path = join(dir, name);
  await writeFile(path, png);
  return path;
}

describe("attachment reference edge cases", () => {
  it.each(["screenshot (1).png", "a[b]{c}>.png"])("round-trips punctuation in %s through labels and model bytes", async (name) => {
    const path = await image(name);
    const reference = formatAttachmentReference(path);
    expect(fileURLToPath(reference)).toBe(path);
    const registry = new PasteRegistry();
    expect(registry.compactAttachments(reference)).toBe("[Image 1]");
    expect(registry.expand("[Image 1]")).toBe(reference);
    expect(attachmentDisplayText(reference)).toBe("[Image 1]");
    const expansion = await expandMentions(reference, undefined, true);
    expect(expansion.attachments).toMatchObject([{ path, kind: "image", sendable: true }]);
    expect((await loadImageAttachments(reference))[0]?.dataBase64).toBe(png.toString("base64"));
  });

  it("invalidates cached preparation when a source changes", async () => {
    const path = await image();
    const budget = imageContent.imageBudgetFor("openai");
    expect(await prepareImageForModel(path, budget)).toMatchObject({ dimensions: { width: 1, height: 1 } });
    const updated = Buffer.from(png);
    updated.writeUInt32BE(2, 16);
    await writeFile(path, updated);
    const modified = new Date(Date.now() + 1_000);
    await utimes(path, modified, modified);
    expect(await prepareImageForModel(path, budget)).toMatchObject({ dimensions: { width: 2, height: 1 } });
  });
});

describe("whole-request image budgets", () => {
  it.each(["count", "bytes"] as const)("shares the %s budget between the current prompt and restored history", async (kind) => {
    const path = await image();
    const budget = {
      ...imageContent.imageBudgetFor("openai"),
      maxCount: kind === "count" ? 2 : 10,
      maxTotalBytes: kind === "bytes" ? png.length * 2 : 15_000_000,
    };
    vi.spyOn(imageContent, "imageBudgetFor").mockReturnValue(budget);
    const built = await buildTurnRequest({
      prompt: formatAttachmentReference(path), mode: "agent", provider: "openai", model: "gpt-4o",
      materializeImages: true,
      history: [{ role: "user", content: "previous images", images: [
        { mediaType: "image/png", dataBase64: "", path },
        { mediaType: "image/png", dataBase64: "", path },
      ] }],
    });
    const images = [...(built.request.images ?? []), ...(built.request.history ?? []).flatMap((message) => message.images ?? [])];
    expect(built.request.images).toHaveLength(1);
    expect(images.length).toBeLessThanOrEqual(budget.maxCount);
    expect(images.reduce((total, next) => total + Buffer.byteLength(next.dataBase64, "base64"), 0)).toBeLessThanOrEqual(budget.maxTotalBytes);
    expect(built.request.history?.[0]?.content).toBe("previous images");
  });
});
