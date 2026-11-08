import { describe, expect, it } from "vitest";
import {
  MAX_RETAINED_IMAGE_COUNT,
  imageRetentionLimits,
  releaseStaleImages,
} from "../src/attachments/image-retention.js";
import { imageBudgetFor } from "../src/attachments/image-content.js";
import { materializeHistoryImages } from "../src/store/history.js";
import type { ChatImage, ChatMessage } from "../src/types.js";

const KB = 1024;

const image = (path: string, bytes = 10 * KB): ChatImage => ({
  mediaType: "image/png",
  dataBase64: Buffer.alloc(bytes, 1).toString("base64"),
  path,
});

const viewed = (paths: readonly string[], bytes?: number): ChatMessage => ({
  role: "user",
  internal: true,
  content: `[image.view] attached: ${paths.join(", ")}`,
  images: paths.map((path) => image(path, bytes)),
});

const limits = { maxCount: 6, maxTotalBytes: 10_000 * KB };

const retainedImages = (messages: readonly ChatMessage[]): string[] =>
  messages.flatMap((message) => message.images?.map((entry) => entry.path ?? "") ?? []);

describe("image retention limits", () => {
  it("caps the retained count while respecting smaller provider budgets", () => {
    const anthropic = imageRetentionLimits(imageBudgetFor("anthropic"));
    expect(anthropic.maxCount).toBe(MAX_RETAINED_IMAGE_COUNT);
    expect(anthropic.maxTotalBytes).toBe(imageBudgetFor("anthropic").maxTotalBytes);
    expect(imageRetentionLimits({ maxCount: 2, maxTotalBytes: 1 }).maxCount).toBe(2);
  });
});

describe("releaseStaleImages", () => {
  it("leaves history untouched while it fits the limits", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "rules" },
      { role: "user", content: "ocr the pdf" },
      viewed(["p1.png", "p2.png", "p3.png", "p4.png"]),
      viewed(["p5.png", "p6.png"]),
    ];
    const before = [...messages];
    expect(releaseStaleImages(messages, limits)).toBe(0);
    messages.forEach((message, index) => expect(message).toBe(before[index]));
  });

  it("releases the oldest images, keeps the newest batch and notes what was released", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "rules" },
      { role: "user", content: "ocr the pdf" },
      viewed(["p1.png", "p2.png", "p3.png", "p4.png"]),
      viewed(["p5.png", "p6.png", "p7.png", "p8.png"]),
    ];
    expect(releaseStaleImages(messages, limits)).toBe(4);
    expect(retainedImages(messages)).toEqual(["p5.png", "p6.png", "p7.png", "p8.png"]);
    expect(messages[2]?.images).toBeUndefined();
    expect(messages[2]?.content).toContain("[image.view] attached: p1.png");
    expect(messages[2]?.content).toContain("4 images no longer attached to this message (p1.png, p2.png, p3.png, p4.png)");
    expect(messages[2]?.content).toContain("image.view");
    expect(messages[2]?.internal).toBe(true);
  });

  it("is idempotent once the history is back within limits", () => {
    const messages: ChatMessage[] = [
      viewed(["a.png", "b.png", "c.png", "d.png"]),
      viewed(["e.png", "f.png", "g.png", "h.png"]),
    ];
    releaseStaleImages(messages, limits);
    const snapshot = JSON.stringify(messages);
    expect(releaseStaleImages(messages, limits)).toBe(0);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it("releases by payload bytes as well as by count", () => {
    const messages: ChatMessage[] = [
      viewed(["big-1.png"], 600 * KB),
      viewed(["big-2.png"], 600 * KB),
    ];
    expect(releaseStaleImages(messages, { maxCount: 6, maxTotalBytes: 1_000 * KB })).toBe(1);
    expect(retainedImages(messages)).toEqual(["big-2.png"]);
  });

  it("keeps the images the user attached to the current prompt", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "match this mockup", images: [image("mockup.png")] },
      viewed(["s1.png", "s2.png", "s3.png", "s4.png"]),
      viewed(["s5.png", "s6.png", "s7.png", "s8.png"]),
    ];
    releaseStaleImages(messages, limits);
    expect(retainedImages(messages)).toEqual(["mockup.png", "s5.png", "s6.png", "s7.png", "s8.png"]);
    expect(messages[0]?.content).toBe("match this mockup");
  });

  it("bounds a long page-by-page OCR run and only rewrites history in batches", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "rules" },
      { role: "user", content: "ocr all 64 pages" },
    ];
    let rewrites = 0;
    let maxRequestImages = 0;
    for (let batch = 0; batch < 16; batch += 1) {
      messages.push({ role: "assistant", content: `viewing batch ${batch}` });
      messages.push(viewed(Array.from({ length: 4 }, (_, page) => `page-${batch * 4 + page + 1}.png`)));
      const before = messages.map((message) => JSON.stringify(message));
      const released = releaseStaleImages(messages, limits);
      const changed = messages.flatMap((message, index) =>
        JSON.stringify(message) === before[index] ? [] : [index],
      );
      if (released > 0) rewrites += 1;
      expect(changed.length > 0).toBe(released > 0);
      expect(changed.every((index) => index < messages.length - 1)).toBe(true);
      maxRequestImages = Math.max(maxRequestImages, retainedImages(messages).length);
    }
    expect(maxRequestImages).toBeLessThanOrEqual(limits.maxCount);
    expect(retainedImages(messages)).toEqual(["page-61.png", "page-62.png", "page-63.png", "page-64.png"]);
    expect(rewrites).toBe(15);
  });

  it("amortizes rewrites across smaller batches", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "inspect each screenshot" }];
    let rewrites = 0;
    for (let shot = 1; shot <= 30; shot += 1) {
      messages.push(viewed([`shot-${shot}.png`]));
      if (releaseStaleImages(messages, limits) > 0) rewrites += 1;
      expect(retainedImages(messages).length).toBeLessThanOrEqual(limits.maxCount);
    }
    expect(rewrites).toBeLessThanOrEqual(8);
  });

  it("never touches a released message again", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const frozen = new Map<number, string>();
    for (let shot = 1; shot <= 20; shot += 1) {
      messages.push(viewed([`shot-${shot}.png`]));
      releaseStaleImages(messages, limits);
      for (const [index, serialized] of frozen) {
        expect(JSON.stringify(messages[index])).toBe(serialized);
      }
      messages.forEach((message, index) => {
        if (index > 0 && !message.images && !frozen.has(index)) {
          frozen.set(index, JSON.stringify(message));
        }
      });
    }
    expect(frozen.size).toBeGreaterThan(0);
  });
});

describe("materializeHistoryImages", () => {
  it("restores the newest images first without rewriting message text", async () => {
    const history: ChatMessage[] = [
      { role: "user", content: "ocr the pdf" },
      viewed(["p1.png", "p2.png", "p3.png", "p4.png"]),
      viewed(["p5.png", "p6.png", "p7.png", "p8.png"]),
    ];
    const restored = await materializeHistoryImages(history, {
      ...imageBudgetFor("anthropic"),
      maxCount: 6,
    });
    expect(retainedImages(restored)).toEqual(["p3.png", "p4.png", "p5.png", "p6.png", "p7.png", "p8.png"]);
    expect(restored.map((message) => message.content)).toEqual(history.map((message) => message.content));
    expect(history[1]?.images).toHaveLength(4);
  });

  it("restores history that fits without changing it", async () => {
    const history: ChatMessage[] = [
      { role: "user", content: "look", images: [image("one.png")] },
      { role: "assistant", content: "seen" },
    ];
    const restored = await materializeHistoryImages(history, imageBudgetFor("anthropic"));
    expect(JSON.stringify(restored)).toBe(JSON.stringify(history));
  });
});
