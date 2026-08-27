import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createArtifactPagerSource,
  createTextPagerSource,
} from "../../src/ui-core/rendering/artifact-pager-source.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function artifact(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clai-pager-test-"));
  dirs.push(dir);
  const path = join(dir, "artifact.log");
  await writeFile(path, body);
  return path;
}

describe("disk-backed artifact pager", () => {
  it("keeps each resident page bounded while making first, middle, and last pages accessible", async () => {
    const body = Array.from({ length: 5000 }, (_, i) => `line-${String(i).padStart(5, "0")} ${"x".repeat(20)}`).join("\n");
    const source = createArtifactPagerSource(await artifact(body), 4096);
    const first = await source.readPage(0);
    const middle = await source.readPage(Math.floor(first.totalBytes / 2));
    const last = await source.readPage(first.totalBytes - 1);
    expect(Buffer.byteLength(first.body)).toBeLessThanOrEqual(4100);
    expect(Buffer.byteLength(middle.body)).toBeLessThanOrEqual(4100);
    expect(Buffer.byteLength(last.body)).toBeLessThanOrEqual(4100);
    expect(first.pageNumber).toBe(1);
    expect(middle.pageNumber).toBeGreaterThan(1);
    expect(last.pageNumber).toBe(last.pageCount);
    expect(await source.readAll()).toBe(body);
  });

  it("searches incrementally across page and chunk boundaries", async () => {
    const body = `${"a".repeat(70_000)}BOUNDARY-NEEDLE${"b".repeat(70_000)}`;
    const source = createArtifactPagerSource(await artifact(body), 4096);
    const hit = await source.search("BOUNDARY-NEEDLE");
    expect(hit?.body).toContain("BOUNDARY-NEEDLE");
    expect(Buffer.byteLength(hit?.body ?? "")).toBeLessThanOrEqual(4100);
  });

  it("reconstructs multibyte text exactly across adjacent pages", async () => {
    const body = `${"🙂é漢字".repeat(4_000)}tail`;
    const source = createArtifactPagerSource(await artifact(body), 4097);
    const chunks: string[] = [];
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    while (offset < total) {
      const page = await source.readPage(offset);
      chunks.push(page.body);
      total = page.totalBytes;
      if (page.nextOffset <= offset) break;
      offset = page.nextOffset;
    }
    expect(chunks.join("")).toBe(body);
  });

  it("pages large in-memory bodies without truncating search or export", async () => {
    const body = `${"head\n".repeat(20_000)}UNIQUE-TAIL`;
    const source = createTextPagerSource(body, "memory://large", 4096);
    const first = await source.readPage(0);
    const hit = await source.search("UNIQUE-TAIL");
    const reverseHit = await source.search("UNIQUE-TAIL", 0, true);
    expect(Buffer.byteLength(first.body)).toBeLessThanOrEqual(4100);
    expect(hit?.body).toContain("UNIQUE-TAIL");
    expect(reverseHit?.body).toContain("UNIQUE-TAIL");
    expect(await source.readAll()).toBe(body);
  });

  it("rejects reads after lifecycle disposal", async () => {
    const source = createArtifactPagerSource(await artifact("content"), 4096);
    source.dispose();
    await expect(source.readPage(0)).rejects.toThrow("disposed");
  });
});
