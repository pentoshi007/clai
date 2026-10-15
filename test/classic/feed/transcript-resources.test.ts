import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputSpool } from "../../../src/app/events/event-buffer.js";
import { TranscriptResources } from "../../../src/classic/feed/transcript-resources.js";
import { blockContextFor } from "../../../src/classic/feed/feed-blocks.js";
import { buildToolLines } from "../../../src/classic/blocks/tool-lines.js";
import { buildDiffLines } from "../../../src/classic/blocks/diff-lines.js";
import { buildFileChange } from "../../../src/tools/file-diff.js";
import { transcriptItems, type ToolItem } from "../../../src/ui-core/state/transcript-types.js";
import { stripAnsi } from "../../../src/classic/render/measure.js";
import { feedView, scriptedTurn } from "./fixture.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function fixture(output = "FIRST\nSECOND\nTHIRD\nLAST") {
  const dir = await mkdtemp(join(tmpdir(), "clai-disclosure-test-"));
  dirs.push(dir);
  const path = join(dir, "output.txt");
  await writeFile(path, output);
  const turn = scriptedTurn();
  const original = transcriptItems(turn.state).find((item): item is ToolItem => item.kind === "tool" && item.name === "shell.exec")!;
  const item = { ...original, artifactPath: path, outputBytes: Buffer.byteLength(output) };
  const spool = new OutputSpool(12);
  spool.replace(item.toolCallId, output);
  const resources = new TranscriptResources(spool);
  const state = { ...turn.state, order: [item.id], byId: new Map([[item.id, item]]), expandOutputGlobal: true };
  return { dir, path, item, spool, resources, state, turn };
}

describe("classic full transcript resources", () => {
  it("expands saved output beyond the memory spool without mutating that spool", async () => {
    const f = await fixture();
    const retained = f.spool.tail(f.item.toolCallId);
    await f.resources.prepare(f.state);
    expect(f.resources.tail(f.item.toolCallId)).toBe("FIRST\nSECOND\nTHIRD\nLAST");
    expect(f.resources.state(f.item.toolCallId)?.truncated).toBe(false);
    expect(f.spool.tail(f.item.toolCallId)).toBe(retained);
    const ctx = blockContextFor(f.state, { ...feedView(f.turn, { columns: 80 }), spool: f.resources });
    expect(buildToolLines(ctx, f.item).map(stripAnsi).join("\n")).toContain("FIRST");
  });

  it("previews the beginning of a clipped artifact even below the default spool limit", async () => {
    const f = await fixture();
    const state = { ...f.state, expandOutputGlobal: false };
    await f.resources.prepare(state);
    const ctx = blockContextFor(state, { ...feedView(f.turn, { columns: 80 }), spool: f.resources });
    const rows = buildToolLines(ctx, f.item).map(stripAnsi);
    expect(rows.slice(1, 4)).toEqual(["  └ FIRST", "    SECOND", "    THIRD"]);
    expect(f.spool.state(f.item.toolCallId)?.truncated).toBe(true);
  });

  it("loads the head rather than the tail of large collapsed artifacts", async () => {
    const f = await fixture(`FIRST\nSECOND\nTHIRD\n${"body\n".repeat(60_000)}LAST`);
    await f.resources.prepare({ ...f.state, expandOutputGlobal: false });
    expect(f.resources.tail(f.item.toolCallId).startsWith("FIRST\nSECOND\nTHIRD")).toBe(true);
    expect(f.resources.tail(f.item.toolCallId)).not.toContain("LAST");
    await f.resources.prepare(f.state);
    expect(f.resources.tail(f.item.toolCallId)).toContain("LAST");
  });

  it("releases full resources on collapse and does not reuse stale running output", async () => {
    const f = await fixture(`FIRST\nSECOND\nTHIRD\n${"body\n".repeat(20_000)}LAST`);
    await f.resources.prepare(f.state);
    expect(f.resources.tail(f.item.toolCallId)).toContain("LAST");
    await f.resources.prepare({ ...f.state, expandOutputGlobal: false });
    expect(f.resources.tail(f.item.toolCallId).startsWith("FIRST\nSECOND\nTHIRD")).toBe(true);
    expect(f.resources.tail(f.item.toolCallId)).not.toContain("LAST");
    await f.resources.prepare(f.state);
    const running = { ...f.item, status: "running" as const };
    f.spool.replace(f.item.toolCallId, "LIVE");
    await f.resources.prepare({ ...f.state, byId: new Map([[running.id, running]]) });
    expect(f.resources.tail(f.item.toolCallId)).toBe("LIVE");
  });

  it("handles missing artifacts without throwing or falsely claiming full output", async () => {
    const f = await fixture();
    await rm(f.path);
    await f.resources.prepare(f.state);
    expect(f.resources.tail(f.item.toolCallId)).toBe(f.spool.tail(f.item.toolCallId));
    expect(f.resources.notice(f.item.toolCallId)).toContain("unavailable");
    expect(f.resources.state(f.item.toolCallId)?.truncated).toBe(true);
  });

  it("uses a bounded preview and portable full-output viewer for very large artifacts", async () => {
    const f = await fixture("HEAD\n");
    const file = await open(f.path, "a");
    await file.truncate(33 * 1024 * 1024);
    await file.close();
    await f.resources.prepare(f.state);
    expect(f.resources.tail(f.item.toolCallId).length).toBeLessThanOrEqual(64 * 1024);
    expect(f.resources.notice(f.item.toolCallId)).toContain("Large output");
    const ctx = blockContextFor(f.state, { ...feedView(f.turn, { columns: 80 }), spool: f.resources });
    expect(buildToolLines(ctx, f.item).map(stripAnsi).join("\n")).toContain("+ full output");
  });

  it("loads saved diff snapshots and expands all stored lines", async () => {
    const f = await fixture();
    const after = Array.from({ length: 80 }, (_, i) => `const LINE_${i} = ${i};`).join("\n");
    const snapshotPath = join(f.dir, "diff.txt");
    await writeFile(snapshotPath, after);
    const change = buildFileChange({ path: "app.ts", kind: "create", before: "", after, snapshotPath });
    const item = { ...f.item, name: "fs.write", fileChanges: [change] };
    const state = { ...f.state, byId: new Map([[item.id, item]]) };
    await f.resources.prepare(state);
    const ctx = blockContextFor(state, { ...feedView(f.turn, { columns: 80 }), spool: f.resources });
    expect(buildDiffLines(ctx, item).map(stripAnsi).join("\n")).toContain("LINE_79");
    expect(change.afterText).toBeUndefined();
  });

  it.each([
    { mode: "missing", notice: "Saved diff snapshot unavailable" },
    { mode: "oversized", notice: "Large diff snapshot" },
    { mode: "absent", notice: "Full diff unavailable" },
  ])("keeps $mode diff snapshots honest without losing the retained preview", async ({ mode, notice }) => {
    const f = await fixture();
    const after = Array.from({ length: 80 }, (_, i) => `const LINE_${i} = ${i};`).join("\n");
    const snapshotPath = join(f.dir, "diff.txt");
    if (mode === "oversized") {
      await writeFile(snapshotPath, after);
      const file = await open(snapshotPath, "a");
      await file.truncate(33 * 1024 * 1024);
      await file.close();
    }
    const change = {
      ...buildFileChange({ path: "app.ts", kind: "create", before: "", after, snapshotPath }),
      ...(mode === "absent" ? { snapshotPath: undefined } : {}),
    };
    const item = { ...f.item, name: "fs.write", fileChanges: [change] };
    const state = { ...f.state, byId: new Map([[item.id, item]]) };
    await f.resources.prepare(state);
    const ctx = blockContextFor(state, { ...feedView(f.turn, { columns: 80 }), spool: f.resources });
    const text = buildDiffLines(ctx, item).map(stripAnsi).join("\n");
    expect(text).toContain(notice);
    expect(text).toContain("retained preview shown");
    expect(text).toContain("LINE_0");
    expect(text).not.toContain("LINE_79");
    expect(text).toContain("- click to collapse");
  });

  it("keeps every line of a fully added file marked as an addition beyond the stored marker cap", async () => {
    const f = await fixture();
    const after = Array.from({ length: 2100 }, (_, i) => `const LINE_${i} = ${i};`).join("\n");
    const snapshotPath = join(f.dir, "diff.txt");
    await writeFile(snapshotPath, after);
    const change = buildFileChange({ path: "app.ts", kind: "create", before: "", after, snapshotPath });
    expect(change.addedNewLines).toHaveLength(2000);
    const item = { ...f.item, name: "fs.write", fileChanges: [change] };
    const state = { ...f.state, byId: new Map([[item.id, item]]) };
    await f.resources.prepare(state);
    const ctx = blockContextFor(state, { ...feedView(f.turn, { columns: 80 }), spool: f.resources });
    const text = buildDiffLines(ctx, item).map(stripAnsi).join("\n");
    expect(text).toContain("2100 + const LINE_2099 = 2099;");
    expect(text).not.toContain("unavailable");
  });

  it("discloses removed diff details that were not retained in historical data", async () => {
    const f = await fixture();
    const change = buildFileChange({ path: "app.ts", kind: "edit", before: "removed".repeat(5000), after: "AFTER" });
    expect(change.deletedAt).toHaveLength(0);
    const item = { ...f.item, name: "fs.edit", fileChanges: [change] };
    const state = { ...f.state, byId: new Map([[item.id, item]]) };
    const ctx = blockContextFor(state, feedView(f.turn, { columns: 80 }));
    const text = buildDiffLines(ctx, item).map(stripAnsi).join("\n");
    expect(text).toContain("AFTER");
    expect(text).toContain("Some diff details were not retained");
  });
});
