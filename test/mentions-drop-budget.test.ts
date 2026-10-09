import { beforeEach, describe, expect, it, vi } from "vitest";
import { stabilizeDroppedFilesInText, stabilizeDroppedImagesInText } from "../src/ui/mentions.js";

const probes = vi.hoisted(() => ({ count: 0 }));

vi.mock("node:fs", async (importActual) => ({
  ...await importActual<typeof import("node:fs")>(),
  existsSync: () => { probes.count += 1; return false; },
  readdirSync: () => { probes.count += 1; return []; },
}));

beforeEach(() => { probes.count = 0; });

describe("automatic file-drop scanning", () => {
  it.each([stabilizeDroppedFilesInText, stabilizeDroppedImagesInText])("keeps long transcripts intact without probing embedded paths", (stabilize) => {
    const text = `Notion transcript\n${"/tmp/clai/session/output.txt prose and queries\n".repeat(3000)}`;
    expect(stabilize(text, "/project").text).toBe(text);
    expect(probes.count).toBe(0);
  });

  it("bounds filesystem probes for shorter transcripts with many ambiguous path prefixes", () => {
    const text = `/missing/path ${"word ".repeat(500)}\n`.repeat(4);
    const result = stabilizeDroppedFilesInText(text, "/project");
    expect(result).toEqual({ text, files: [], images: [] });
    expect(probes.count).toBeGreaterThan(0);
    expect(probes.count).toBeLessThanOrEqual(512);
  });
});
