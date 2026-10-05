import { describe, expect, it } from "vitest";
import { formatToolArgs } from "../../../src/agent/tool-call-parser.js";
import { presentFsReadArgs } from "../../../src/ui-core/rendering/tool-presenter.js";
import { parseBatchSections, presentBatchSection } from "../../../src/ui-core/rendering/batch-sections.js";
import { pathFromArgsDisplay, openToolOutputPager } from "../../../src/ui-core/rendering/open-tool-output.js";
import { extractFsReadFileBody } from "../../../src/ui-core/rendering/pager-source.js";
import { defaultPagerMarkdownMode } from "../../../src/ui-core/rendering/pager-view-policy.js";
import { formatSubagentRun } from "../../../src/ui-core/rendering/subagent-source.js";
import { formatFsReadSection } from "../../../src/tools/fs/read-sections.js";
import { blockContextFor } from "../../../src/classic/feed/feed-blocks.js";
import { buildToolLines } from "../../../src/classic/blocks/tool-lines.js";
import { buildBatchLines } from "../../../src/classic/blocks/batch-lines.js";
import { displayWidth, stripAnsi } from "../../../src/classic/render/measure.js";
import { middleClipText } from "../../../src/ui-core/rendering/text-width.js";
import { transcriptItems, type ToolItem } from "../../../src/ui-core/state/transcript-types.js";
import { feedView, scriptedTurn } from "../../classic/feed/fixture.js";
import type { SubagentRun } from "../../../src/agent/subagents/types.js";

const files = Array.from({ length: 6 }, (_, index) => ({ path: `src/file-${index + 1}.ts`, offset: index + 1, limit: 8 }));
const args = { files };
const argsDisplay = formatToolArgs({ name: "fs.read", args });
const output = files.map((file, index) => formatFsReadSection({
  index: index + 1, total: 6, path: file.path, ok: index !== 2,
  body: index === 2 ? "ENOENT: missing file" : `# fs.read path=/repo/${file.path} lines=${file.offset}-${file.offset + 7} of 100 bytes=800\n1: PRIVATE_FILE_BODY\n# hasMore=true next={"offset":9,"limit":8}`,
})).join("\n\n");

describe("multi-file read presentation", () => {
  it("keeps every path and its filters together in one shared presentation", () => {
    const presented = presentFsReadArgs(argsDisplay);
    expect(presented.path).toBe("6 files");
    expect(presented.files?.map((file) => file.path)).toEqual(files.map((file) => file.path));
    expect(presented.files?.[3]?.options).toBe("offset=4 · limit=8");
    expect(pathFromArgsDisplay(argsDisplay)).toBeUndefined();
    expect(presentFsReadArgs(JSON.stringify({ files: [files[0]] })).files).toHaveLength(1);
  });

  it.each([40, 80, 120])("shows all six paths and statuses in compact Classic cards at %i columns", (columns) => {
    const turn = scriptedTurn();
    const source = transcriptItems(turn.state).find((item): item is ToolItem => item.kind === "tool")!;
    const item = { ...source, name: "fs.read", argsDisplay, status: "failed" as const };
    turn.spool.replace(item.toolCallId, output);
    const ctx = blockContextFor(turn.state, feedView(turn, { columns }));
    const lines = buildToolLines(ctx, item).map(stripAnsi);
    const text = lines.join("\n");
    for (let index = 0; index < files.length; index += 1) {
      expect(text).toContain(`file ${index + 1}/6: ${index === 2 ? "✗" : "✓"} ${files[index]!.path}`);
      expect(text).toContain(`offset=${index + 1}`);
    }
    expect(lines.every((line) => displayWidth(line) <= ctx.width)).toBe(true);
    expect(text).not.toContain('"files"');
  });

  it.each([40, 80, 120])("keeps all nested paths visible in compact historical tool.batch cards at %i columns", (columns) => {
    const turn = scriptedTurn();
    const source = transcriptItems(turn.state).find((item): item is ToolItem => item.kind === "tool")!;
    const item = { ...source, name: "tool.batch", argsDisplay: "1 call: fs.read" };
    const batch = `── #1 fs.read [fail exit=1]\n${output}`;
    turn.spool.replace(item.toolCallId, batch);
    const sections = parseBatchSections(batch);
    expect(sections).toHaveLength(1);
    const presented = presentBatchSection(sections[0]!, false);
    for (const file of files) expect(presented.lines.join("\n")).toContain(file.path);
    expect(presented.lines.join("\n")).toContain("ENOENT");
    expect(presented.lines.join("\n")).not.toContain("PRIVATE_FILE_BODY");
    const ctx = blockContextFor(turn.state, feedView(turn, { columns }));
    const lines = buildBatchLines(ctx, item).map(stripAnsi);
    for (const file of files) expect(lines.join("\n")).toContain(file.path);
    expect(lines.every((line) => displayWidth(line) <= ctx.width)).toBe(true);
  });

  it("opens the combined output with boundaries and original line numbers preserved", async () => {
    let opened: { title: string; body: string; path: unknown; mode: unknown } | undefined;
    const services = {
      overlay: { openPager(title: string, body: string, _source: unknown, path: unknown, mode: unknown) { opened = { title, body, path, mode }; return true; } },
      session: { spool: { tail: () => output }, notice() {} },
    } as never;
    await openToolOutputPager(services, { toolCallId: "multi", name: "fs.read", argsDisplay, artifactPath: undefined } as never);
    expect(opened?.title).toBe("fs.read · 6 files");
    expect(opened?.body).toContain(output);
    expect(opened?.path).toBeUndefined();
    expect(opened?.mode).toBe("plain");
    expect(extractFsReadFileBody(output)).toBe(output);
    expect(defaultPagerMarkdownMode({ kind: "tool", toolName: "fs.read", body: output.replace("PRIVATE_FILE_BODY", "# Markdown heading") })).toBe("plain");
  });

  it("shows per-file child tool options and outcomes without repeating file contents", () => {
    const run: SubagentRun = {
      id: "child", parentSessionId: "parent", title: "Read evidence", prompt: "Read relevant files", cwd: "/repo",
      provider: "openai", model: "test", status: "running", attempt: 1, createdAt: 1, updatedAt: 1,
      events: [
        { sequence: 0, timestamp: 1, kind: "tool", text: `Calling fs.read: ${JSON.stringify(args)}` },
        { sequence: 1, timestamp: 2, kind: "tool", text: `Error:\n${output}` },
      ],
    };
    const text = formatSubagentRun(run);
    for (let index = 0; index < files.length; index += 1) expect(text).toContain(`file ${index + 1}/6: ${index === 2 ? "✗" : "✓"} ${files[index]!.path}`);
    expect(text).toContain("options: offset=4 · limit=8");
    expect(text).toContain("ENOENT");
    expect(text).not.toMatch(/PRIVATE_FILE_BODY|hasMore|"files"/);
  });

  it("clips long paths in the middle without losing their filename or exceeding terminal width", () => {
    const clipped = middleClipText(`/root/${"λ界-directory/".repeat(20)}important.ts`, 40);
    expect(clipped).toContain("…");
    expect(clipped).toContain("important.ts");
    expect(displayWidth(clipped)).toBeLessThanOrEqual(40);
  });
});
