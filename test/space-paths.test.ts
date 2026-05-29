import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractExistingPathsFs,
  loadImageAttachments,
  expandMentions,
} from "../src/ui/mentions.js";

const PNG_HEX =
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082";

describe("extractExistingPathsFs — filenames with spaces", () => {
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

  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), "clai-sp-"));
    dirs.push(d);
    return d;
  }

  it("resolves a fully-unescaped space path followed by a question", () => {
    const dir = tmp();
    const file = join(dir, "my shot.png");
    writeFileSync(file, "x");
    const out = extractExistingPathsFs(`${file} what is this`, dir);
    expect(out).toEqual([file]);
  });

  it("resolves a partially-escaped path (trailing space unescaped)", () => {
    const dir = tmp();
    const file = join(dir, "Screenshot 2026 at 11.42 PM.png");
    writeFileSync(file, "x");
    const dragged = file.replace(/ /g, "\\ ").replace("\\ PM.png", " PM.png");
    const out = extractExistingPathsFs(`${dragged} what do u see`, dir);
    expect(out).toEqual([file]);
  });

  it("excludes trailing prompt words of any length", () => {
    const dir = tmp();
    const file = join(dir, "a b.png");
    writeFileSync(file, "x");
    const out = extractExistingPathsFs(
      `${file} please describe the image in detail`,
      dir,
    );
    expect(out).toEqual([file]);
  });

  it("returns nothing for a non-existent path", () => {
    const dir = tmp();
    expect(extractExistingPathsFs("/no/such file.png what", dir)).toEqual([]);
  });

  it("matches a filename that uses a Unicode space variant (macOS screenshots)", () => {
    const dir = tmp();
    // Real on-disk name uses NARROW NO-BREAK SPACE (U+202F) before "PM",
    // like macOS screenshot filenames.
    const realName = "Screenshot 2026-05-28 at 11.36.38\u202fPM.png";
    const file = join(dir, realName);
    writeFileSync(file, "x");
    // The user types/drags a REGULAR space before PM.
    const typed = join(dir, "Screenshot 2026-05-28 at 11.36.38 PM.png");
    const out = extractExistingPathsFs(`${typed} what is this`, dir);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(file);
  });

  it("loadImageAttachments picks up a space-containing image path", () => {
    const dir = tmp();
    const file = join(dir, "my screenshot.png");
    writeFileSync(file, Buffer.from(PNG_HEX, "hex"));
    const imgs = loadImageAttachments(`${file} what is this`, dir);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.mediaType).toBe("image/png");
  });

  it("expandMentions attaches a space-containing image as viewable for vision models", () => {
    const dir = tmp();
    const file = join(dir, "my screenshot.png");
    writeFileSync(file, Buffer.from(PNG_HEX, "hex"));
    const exp = expandMentions(`${file} what is this`, dir, true);
    const img = exp.attachments.find((a) => a.kind === "image");
    expect(img).toBeDefined();
    expect(img!.note).toMatch(/attached as multimodal input/i);
  });
});
