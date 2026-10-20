import { describe, expect, it } from "vitest";
import {
  parseAllToolCalls,
  parseToolCall,
  stripSentinelTokens,
  textBeforeToolCall,
} from "../../src/agent/tool-call-parser.js";
import { recoverMissingToolCall } from "../../src/agent/turn/loop/tool-call-recovery.js";
import type { ChatMessage } from "../../src/types.js";
import { stripToolCallSurfaces } from "../../src/ui-core/rendering/strip-tool-surfaces.js";
import { EMPTY_STRIP_STREAM, pushStripChunk } from "../../src/ui-core/rendering/incremental-strip.js";
import { liveThinkingDisplay } from "../../src/ui-core/rendering/thinking-tail.js";
import { looksLikeTranscriptReplay } from "../../src/agent/compaction-summary.js";

const reported = `<｜DSML｜ calls>
<｜DSML｜ invoke name="task_update">
<｜DSML｜ parameter name="note":" on a design constraint, not finished. Verified:
(a) a server-issued license cached in
Team ID S8EX82NJP6; (b) app-group can never be read
again; (c) the app overwrites it
app restored and
running.","state":"in_progress","taskId":"t6"}</｜DSML｜ parameter>
</｜DSML｜ invoke>
</｜DSML｜ calls>`;

describe("DSML variants", () => {
  it("recovers the reported spaced DSML with JSON spilled into the parameter tag", () => {
    const call = parseToolCall(reported, { strict: true });
    expect(call?.name).toBe("task_update");
    expect(call?.args).toMatchObject({ state: "in_progress", taskId: "t6" });
    expect(String(call?.args.note)).toContain("running.");
    expect(parseAllToolCalls(reported)).toHaveLength(1);
  });

  it.each([
    [
      "spaces around markers",
      `< ｜ DSML ｜ tool_calls >\n< ｜ DSML ｜ invoke name="fs.read" >\n< ｜ DSML ｜ parameter name="path" string="true" >/a</ ｜ DSML ｜ parameter >\n</ ｜ DSML ｜ invoke >\n</ ｜ DSML ｜ tool_calls >`,
    ],
    [
      "function_calls container and ASCII bars",
      `<|DSML|function_calls><|DSML|invoke name="fs.read"><|DSML|parameter name="path">/a</|DSML|parameter></|DSML|invoke></|DSML|function_calls>`,
    ],
    [
      "slash-after-marker closers",
      `<｜DSML｜tool_calls><｜DSML｜invoke name="fs.read"><｜DSML｜parameter name="path">/a<｜DSML｜/parameter><｜DSML｜/invoke><｜DSML｜/tool_calls>`,
    ],
    [
      "single-quoted and unquoted attributes",
      `<｜DSML｜tool_calls><｜DSML｜invoke name=fs.read><｜DSML｜parameter name='path'>/a</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>`,
    ],
    [
      "JSON body instead of parameters",
      `<｜DSML｜tool_calls><｜DSML｜invoke name="fs.read">{"path":"/a"}</｜DSML｜invoke></｜DSML｜tool_calls>`,
    ],
    [
      "parameter missing its closer inside a closed invoke",
      `<｜DSML｜tool_calls><｜DSML｜invoke name="fs.read"><｜DSML｜parameter name="path">/a</｜DSML｜invoke></｜DSML｜tool_calls>`,
    ],
    [
      "right bar dropped",
      `<｜DSML tool_calls><｜DSML invoke name="fs.read"><｜DSML parameter name="path">/a</｜DSML parameter></｜DSML invoke></｜DSML tool_calls>`,
    ],
    [
      "parameter whose value spilled after a missing >",
      `<｜DSML｜invoke name="fs.read"><｜DSML｜parameter name="path" "/a"</｜DSML｜parameter></｜DSML｜invoke>`,
    ],
  ])("parses %s", (_label, text) => {
    expect(parseToolCall(text, { strict: true })).toEqual({ name: "fs.read", args: { path: "/a" } });
    const display = stripSentinelTokens(`Reading.\n${text}`);
    expect(display).toBe("Reading.");
    expect(stripToolCallSurfaces(`Reading.\n${text}`).trim()).toBe("Reading.");
    expect(textBeforeToolCall(`Reading.\n${text}`)).toBe("Reading.");
  });

  it("never executes a cut-off invoke", () => {
    const clipped = `<｜DSML｜ calls>\n<｜DSML｜ invoke name="shell.exec">\n<｜DSML｜ parameter name="command" string="true">rm -rf /tmp/x`;
    expect(parseToolCall(clipped, { strict: true })).toBeUndefined();
    expect(parseAllToolCalls(clipped)).toEqual([]);
    expect(stripSentinelTokens(`Cleaning.\n${clipped}`)).toBe("Cleaning.");
  });

  it("does not execute a parameter that cannot be interpreted", () => {
    const garbage = `<｜DSML｜invoke name="fs.write"><｜DSML｜parameter ::: {broken</｜DSML｜parameter></｜DSML｜invoke>`;
    expect(parseAllToolCalls(garbage)).toEqual([]);
  });

  it("hides spaced DSML while streaming and in live thinking", () => {
    let stream = EMPTY_STRIP_STREAM;
    let shown = "";
    for (const chunk of `Working.\n${reported}\nDone.`.match(/[\s\S]{1,7}/g)!) {
      const next = pushStripChunk(stream, chunk);
      stream = next.stream;
      shown = next.text;
      expect(shown).not.toMatch(/DSML/);
    }
    expect(shown).toContain("Working.");
    expect(shown).toContain("Done.");
    expect(liveThinkingDisplay(`thinking\n${reported}`)).not.toMatch(/DSML/);
    expect(looksLikeTranscriptReplay(`summary\n${reported}`)).toBe(true);
  });

  it("asks the model to retry on unparseable DSML and stops retrying after the cap", async () => {
    const messages: ChatMessage[] = [];
    const notices: string[] = [];
    const state = { bareToolJsonRetries: 0, truncatedToolRetries: 0, malformedFenceRetries: 0, sentinelToolRetries: 0 };
    const ports = {
      messages,
      toolsAttached: true,
      planModeWithoutPlan: false,
      notify: (_level: "info" | "warn", message: string) => notices.push(message),
      commitAssistantRetry: () => {},
      recoveryUserMessage: (content: string): ChatMessage => ({ role: "user", content }),
      applySalvagedWrite: async () => ({ ok: false, bytesOnDisk: 0 }),
    };
    const visible = `<｜DSML｜ invoke name="fs.write"><｜DSML｜ parameter ::: {broken</｜DSML｜ parameter></｜DSML｜ invoke>`;
    for (let i = 0; i < 3; i += 1) {
      expect(await recoverMissingToolCall(ports, state, { visible, bareArgsOnly: false })).toBe("retry");
    }
    expect(messages).toHaveLength(3);
    expect(messages[0]!.content).toMatch(/DSML/);
    expect(await recoverMissingToolCall(ports, state, { visible, bareArgsOnly: false })).toBe("proceed");
    expect(notices.at(-1)).toMatch(/hidden/);
  });

  it("recovers when the malformed call only appears in thinking", async () => {
    const messages: ChatMessage[] = [];
    const state = { bareToolJsonRetries: 0, truncatedToolRetries: 0, malformedFenceRetries: 0, sentinelToolRetries: 0 };
    const decision = await recoverMissingToolCall(
      {
        messages,
        toolsAttached: true,
        planModeWithoutPlan: false,
        notify: () => {},
        commitAssistantRetry: () => {},
        recoveryUserMessage: (content: string): ChatMessage => ({ role: "user", content }),
        applySalvagedWrite: async () => ({ ok: false, bytesOnDisk: 0 }),
      },
      state,
      { visible: "", thinking: `plan\n<｜DSML｜ invoke name="x"><｜DSML｜ parameter`, bareArgsOnly: false },
    );
    expect(decision).toBe("retry");
  });

  it("leaves ordinary prose and comparisons alone", () => {
    const prose = "Use a | b when x < y and keep <div> tags.";
    expect(stripSentinelTokens(prose)).toBe(prose);
    expect(stripToolCallSurfaces(prose)).toBe(prose);
    expect(parseAllToolCalls(prose)).toEqual([]);
  });
});
