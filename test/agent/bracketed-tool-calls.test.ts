import { describe, expect, it } from "vitest";
import {
  accumulateOpenAiToolCallDelta,
  finalizeOpenAiToolCalls,
} from "../../src/llm/tool-protocol.js";
import {
  parseAllToolCalls,
  parseToolCall,
  looksLikeTruncatedToolCall,
  textBeforeToolCall,
  stripSentinelTokens,
} from "../../src/agent/tool-call-parser.js";
import { stripToolCallSurfaces } from "../../src/ui-core/rendering/strip-tool-surfaces.js";

const TRANSCRIPT_PROSE =
  "Good — opencode binary is at ~/.opencode/bin/opencode, and clai source is here. Let me dig into both sides in parallel.\n\n";

const TRANSCRIPT_CALLS = `[Tool call: shell_exec]
{"command":"cd /home/ubuntu/projects/clai && ls src/ && echo '--- grep free1 ---' && grep -rn 'free1' src/ --include='.ts'
--include='.js' | head -60","timeoutMs":60000}
 
[Tool call: shell_exec]
{"command":"ls -lat ~/.local/share/opencode/log/ | head -20; echo '--- opencode.jsonc ---'; cat ~/.config/opencode/opencode.jsonc;
echo; echo '--- service.json ---'; cat ~/.config/opencode/service.json 2>/dev/null | head -c 400; echo; echo '--- version ---';
~/.opencode/bin/opencode --version 2>&1 | head -5","timeoutMs":60000}
 
[Tool call: tool_check]
{"tools":["mitmdump","mitmproxy","curl","tcpdump","openssl","node","bun","strings","jq","sqlite3","strace","bpftrace"]}
 
[Tool call: shell_exec]
{"command":"ls -lat ~/projects/clai/src/providers/ 2>/dev/null | head -30; echo '--- find files mentioning zen ---'; grep -rln 'zen'
/home/ubuntu/projects/clai/src/ | head -30","timeoutMs":60000}`;

describe("tool.batch streaming arguments accumulation", () => {
  it("accumulates incremental nested object and array chunks without corrupting to snapshots", () => {
    const state = new Map();
    const chunks = [
      '{"calls":',
      " [",
      '{"name":',
      ' "shell.exec",',
      ' "args":',
      ' {"command": "ls"}',
      "}]",
      "}",
    ];

    for (const chunk of chunks) {
      accumulateOpenAiToolCallDelta(state, {
        index: 0,
        function: { name: "tool_batch", arguments: chunk },
      });
    }

    const [call] = finalizeOpenAiToolCalls(state);
    expect(call).toBeDefined();
    expect(call!.name).toBe("tool.batch");
    expect(call!.args._parseError).toBeUndefined();
    expect(call!.args).toEqual({
      calls: [{ name: "shell.exec", args: { command: "ls" } }],
    });
  });

  it("accumulates when the second chunk starts with an opening brace and quote", () => {
    const state = new Map();
    const chunks = [
      '{"calls": [',
      '{"name": "fs.list", "args": {"path": "/home"}}',
      "]}",
    ];

    for (const chunk of chunks) {
      accumulateOpenAiToolCallDelta(state, {
        index: 0,
        function: { name: "tool_batch", arguments: chunk },
      });
    }

    const [call] = finalizeOpenAiToolCalls(state);
    expect(call).toBeDefined();
    expect(call!.args._parseError).toBeUndefined();
    expect(call!.args).toEqual({
      calls: [{ name: "fs.list", args: { path: "/home" } }],
    });
  });
});

describe("bracketed tool-call parsing", () => {
  it("parses single bracketed tool call with wire name normalization", () => {
    const text = '[Tool call: shell_exec]\n{"command":"ls -la"}';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe("shell.exec");
    expect(call!.args).toEqual({ command: "ls -la" });
  });

  it("parses all bracketed calls from the live transcript snippet", () => {
    const text = TRANSCRIPT_PROSE + TRANSCRIPT_CALLS;
    const calls = parseAllToolCalls(text);
    expect(calls).toHaveLength(4);
    expect(calls[0]!.name).toBe("shell.exec");
    expect(calls[0]!.args.command).toContain("grep -rn 'free1' src/");
    expect(calls[0]!.args.timeoutMs).toBe(60000);
    expect(calls[1]!.name).toBe("shell.exec");
    expect(calls[1]!.args.command).toContain("opencode.jsonc");
    expect(calls[2]!.name).toBe("tool.check");
    expect(calls[2]!.args.tools).toContain("mitmdump");
    expect(calls[3]!.name).toBe("shell.exec");
    expect(calls[3]!.args.command).toContain("find files mentioning zen");
  });

  it("parses bracketed tool calls with alternative case and format spellings", () => {
    const c1 = parseToolCall('[tool_call: fs_list]\n{"path":"."}');
    expect(c1?.name).toBe("fs.list");
    expect(c1?.args).toEqual({ path: "." });

    const c2 = parseToolCall('[TOOL CALL: web_search]\n{"query":"vitest"}');
    expect(c2?.name).toBe("web.search");
    expect(c2?.args).toEqual({ query: "vitest" });

    const c3 = parseToolCall('[Tool: shell.exec]\n{"command":"pwd"}');
    expect(c3?.name).toBe("shell.exec");
    expect(c3?.args).toEqual({ command: "pwd" });
  });

  it("parses bracketed tool call wrapped in markdown json fences", () => {
    const text = '[Tool call: shell_exec]\n```json\n{"command":"id"}\n```';
    const call = parseToolCall(text);
    expect(call?.name).toBe("shell.exec");
    expect(call?.args).toEqual({ command: "id" });
  });
});

describe("bracketed tool-call surface stripping", () => {
  it("strips all bracketed calls from text leaving only preceding prose", () => {
    const text = TRANSCRIPT_PROSE + TRANSCRIPT_CALLS;
    expect(stripToolCallSurfaces(text).trim()).toBe(TRANSCRIPT_PROSE.trim());
    expect(stripSentinelTokens(text).trim()).toBe(TRANSCRIPT_PROSE.trim());
    expect(textBeforeToolCall(text)).toBe(TRANSCRIPT_PROSE.trim());
  });

  it("detects truncated bracketed tool call during streaming", () => {
    const partial = TRANSCRIPT_PROSE + '[Tool call: shell_exec]\n{"command":"cd /';
    expect(looksLikeTruncatedToolCall(partial)).toBe(true);
  });
});
