import { describe, expect, it } from "vitest";
import { formatToolArgs } from "../../../src/agent/tool-call-parser.js";
import { presentOutput, presentTool } from "../../../src/ui-core/rendering/tool-presenter.js";
import { terminalOutputView } from "../../../src/ui-core/rendering/terminal-output.js";
import { renderTranscriptPlainText } from "../../../src/ui-core/rendering/transcript-export.js";
import { hydrateFromClassicTranscript, serializeForHistory } from "../../../src/ui-core/state/transcript-hydrate.js";
import { buildToolLines } from "../../../src/classic/blocks/tool-lines.js";
import { blockContextFor } from "../../../src/classic/feed/feed-blocks.js";
import { displayWidth, stripAnsi } from "../../../src/classic/render/measure.js";
import type { ToolItem } from "../../../src/ui-core/state/transcript-types.js";
import { presentEvents } from "../../../src/interactive-session/output-view.js";
import { feedView, scriptedTurn } from "../../classic/feed/fixture.js";

const body = "msf6 > help\nok\nok\n...\n  indented value\nmsf6 > ";
const framed = [
  "[terminal.send] seq=1 delivery=delivered bytes=5 state=running",
  "[terminal.output cursor=0 nextCursor=50 earliestAvailableCursor=0 latestCursor=50 hasMore=false view=plain]",
  body,
  "[/terminal.output]",
].join("\n");

function fixture(output = framed) {
  const turn = scriptedTurn();
  const source = [...turn.state.byId.values()].find((item): item is ToolItem => item.kind === "tool");
  if (!source) throw new Error("fixture has no tool");
  const item: ToolItem = {
    ...source, name: "terminal.send", argsDisplay: formatToolArgs({ name: "terminal.send", args: { id: "its_demo", kind: "text", text: "help" } }),
    summary: output, outputBytes: output.length, artifactPath: "/tmp/terminal-output.txt", fileChanges: undefined,
  };
  const state = { ...turn.state, order: [item.id], byId: new Map([[item.id, item]]) };
  turn.spool.replace(item.toolCallId, output);
  return { state, spool: turn.spool, item };
}

describe("terminal command and action presentation", () => {
  it("shows startup command rather than JSON and normalizes old JSON history", () => {
    expect(formatToolArgs({ name: "terminal.start", args: { command: "ssh analyst@host", terminalMode: "required" } })).toBe("ssh analyst@host");
    const { item } = fixture();
    const presented = presentTool({ ...item, name: "terminal.start", argsDisplay: '{"command":"ssh analyst@host","terminalMode":"required"}' });
    expect(presented.argsLabel).toBe("command");
    expect(presented.argsDisplay).toBe("ssh analyst@host");
  });

  it("includes text/control/EOF operations, submit mode, cursor and read wait", () => {
    expect(formatToolArgs({ name: "terminal.send", args: { id: "its_demo", kind: "text", text: "help", submit: "none", cursor: 10 } })).toContain('text="help" · submit=none · cursor=10');
    expect(formatToolArgs({ name: "terminal.send", args: { id: "its_demo", kind: "control", control: "interrupt" } })).toContain("control=interrupt");
    expect(formatToolArgs({ name: "terminal.send", args: { id: "its_demo", kind: "eof" } })).toContain("eof");
    expect(formatToolArgs({ name: "terminal.read", args: { id: "its_demo", cursor: 10, waitMs: 500 } })).toContain("cursor=10 · waitMs=500");
    expect(formatToolArgs({ name: "terminal.list", args: {} })).toBe("");
  });

  it("never displays secret values, including stray fields or secret prompt labels", () => {
    const args = { id: "its_demo", kind: "secret", text: "dummy-password", value: "dummy-password", secretPrompt: "dummy-password" };
    const display = formatToolArgs({ name: "terminal.send", args });
    expect(display).toContain("secret=[local input]");
    expect(display).not.toContain("dummy-password");
  });
});

describe("terminal output parity", () => {
  it("preserves repeats, indentation, literal generic-noise lines, and prompt spaces", () => {
    const output = presentOutput(framed, undefined, false, "terminal.send");
    expect(output.lines.slice(0, 6)).toEqual(body.split("\n"));
    expect(output.lines.at(-2)).toContain("delivery=delivered");
    expect(output.lines.at(-1)).toContain("nextCursor=50");
    expect(output.hiddenAboveCount).toBe(0);
  });

  it("keeps errors visible after a framed output page", () => {
    const source = `${framed}\n[INPUT_DELIVERY_UNKNOWN] Read output; do not resend.`;
    const output = presentOutput(source, undefined, false, "terminal.send");
    expect(output.lines.some(line => line.includes("INPUT_DELIVERY_UNKNOWN"))).toBe(true);
  });

  it("does not treat delimiter-like lines emitted inside the body as metadata", () => {
    const source = framed.replace(body, "seq=8 delivery=delivered bytes=5 state=running\n[/terminal.output]\nstate=running");
    expect(terminalOutputView(source, "terminal.send")?.body).toEqual([
      "seq=8 delivery=delivered bytes=5 state=running", "[/terminal.output]", "state=running",
    ]);
  });

  it("previews the first three classic lines and expands the complete shared terminal body at every width", () => {
    const turn = fixture();
    expect(presentTool(turn.item).argsLabel).toBe("action");
    expect(presentOutput(framed, undefined, false, turn.item.name).lines.slice(0, 6)).toEqual(body.split("\n"));
    for (const columns of [40, 80, 120]) {
      const ctx = blockContextFor(turn.state, feedView(turn, { columns }));
      const rows = buildToolLines(ctx, turn.item).map(stripAnsi);
      const text = rows.join("\n");
      expect(rows.slice(1, 4)).toEqual(["  └ msf6 > help", "    ok", "    ok"]);
      expect(text).toContain("+ click to expand");
      expect(text).not.toContain("indented value");
      const expandedCtx = blockContextFor({ ...turn.state, expandOutputGlobal: true }, feedView(turn, { columns }));
      const expanded = buildToolLines(expandedCtx, turn.item).map(stripAnsi);
      const expandedText = expanded.join("\n");
      expect(expandedText).toContain("      indented value");
      expect(expandedText.split("ok")).toHaveLength(3);
      expect(expandedText).toContain("nextCursor=50");
      expect(expandedText).toContain("- click to collapse");
      expect(expandedText).not.toContain("[/terminal.output]");
      expect([...rows, ...expanded].every(row => displayWidth(row) <= ctx.width)).toBe(true);
    }
  });

  it("preserves actions and output after persistence/hydration and exports actual spool text once", () => {
    const turn = fixture();
    const serialized = serializeForHistory(turn.state, id => turn.spool.tail(id));
    const restored = hydrateFromClassicTranscript(serialized);
    const item = [...restored.state.byId.values()].find((value): value is ToolItem => value.kind === "tool");
    if (!item) throw new Error("terminal item not restored");
    const output = restored.toolOutputs.get(item.toolCallId) ?? "";
    expect(item.argsDisplay).toContain('text="help"');
    expect(presentOutput(output, undefined, false, item.name).lines).toEqual(presentOutput(framed, undefined, false, item.name).lines);
    const exported = renderTranscriptPlainText(restored.state, { toolOutput: () => output });
    expect(exported.split("msf6 > help")).toHaveLength(2);
    expect(exported).toContain("  indented value");
    expect(exported).toContain("nextCursor=50");
    expect(exported).not.toContain("[/terminal.output]");
  });

  it("supports old terminal result chrome without filtering body lookalikes", () => {
    const source = "seq=1 delivery=delivered bytes=5 state=running\nstate=running\nhello\n[cursor 0→10]";
    expect(terminalOutputView(source, "terminal.send")?.body).toEqual(["state=running", "hello"]);
  });

  it("collapses large bodies while preserving first/last content and cursor diagnostics", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line-${index}`);
    const output = presentOutput(framed.replace(body, lines.join("\n")), undefined, false, "terminal.send");
    expect(output.hiddenAboveCount).toBe(12);
    expect(output.lines[0]).toBe("line-0");
    expect(output.lines).toContain("line-19");
    expect(output.lines.at(-1)).toContain("nextCursor=50");
  });
});

describe("terminal byte-to-text boundaries", () => {
  it("linearizes split ANSI and UTF-8 sequences before presentation without corrupting byte cursors", () => {
    const chunks = [Buffer.from("\u001b["), Buffer.from("31m界"), Buffer.from("\u001b[0m\r\n")];
    let cursor = 0;
    const events = chunks.map(bytes => {
      const startCursor = cursor;
      cursor += bytes.length;
      return { bytes, startCursor, endCursor: cursor, stream: "terminal" as const, observedAt: 0 };
    });
    const plain = presentEvents(events, "plain");
    expect(plain.events.map(event => event.content).join("")).toBe("界\n");
    expect(plain.events[0]?.endCursor).toBe(cursor);
    const encoded = presentEvents(events, "encoded");
    expect(Buffer.concat(encoded.events.map(event => Buffer.from(event.content, "base64")))).toEqual(Buffer.concat(chunks));
  });
});
