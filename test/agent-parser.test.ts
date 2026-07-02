import { describe, expect, it } from "vitest";
import {
  parseToolCall,
  requiresFreshWebSearch,
  shouldDimToolChatter,
  looksLikeTruncatedToolCall,
  recognizeBareToolJson,
  isLumpedSingleTask,
  countToolFences,
  looksLikeActionNarration,
  preprocessJson,
  groupToolCallsForExecution,
  buildTurnHistory,
  looksLikePromptLeak,
} from "../src/agent/runner.js";

describe("agent tool-call parser", () => {
  it("preprocesses JSON to escape control characters and strip trailing commas", () => {
    const rawInput = `{
      "name": "shell.exec",
      "args": {
        "command": "echo 'hello'\necho 'world'",
        "timeoutMs": 1000,
      },
    }`;
    const preprocessed = preprocessJson(rawInput);
    const parsed = JSON.parse(preprocessed);
    expect(parsed.name).toBe("shell.exec");
    expect(parsed.args.command).toBe("echo 'hello'\necho 'world'");
    expect(parsed.args.timeoutMs).toBe(1000);
  });
  it("extracts tool calls from fenced code blocks", () => {
    const text =
      'I will run the command.\n```tool\n{"name":"shell.exec","args":{"command":"ls -la"}}\n```';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe("shell.exec");
    expect(call!.args).toEqual({ command: "ls -la" });
  });

  it("extracts tool calls from XML-style tags", () => {
    const text =
      'Planning.\n<tool_call>{"name":"sysinfo","args":{}}</tool_call>';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe("sysinfo");
    expect(call!.args).toEqual({});
  });

  it("extracts tool calls from XML-style tags with name and args elements (MiMo Pro)", () => {
    const text =
      'Response:\n<tool_call>\n<name>web.search</name>\n<args>{"query":"current UK Prime Minister 2026"}</args>\n</tool_call>\n</tool_call>';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe("web.search");
    expect(call!.args).toEqual({ query: "current UK Prime Minister 2026" });
  });

  it("extracts tool calls from XML-style tags with nested tool element (MiMo Free)", () => {
    const text =
      'Response:\n<tool_call>\n<tool>\n{"name": "web.search", "args": {"query": "who is the current UK prime minister 2026", "fetchTop": 2}}\n</tool_call>';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe("web.search");
    expect(call!.args).toEqual({ query: "who is the current UK prime minister 2026", fetchTop: 2 });
  });

  it("extracts tool calls from XML-style tags with tool_name and parameters elements", () => {
    const text =
      'Response:\n<tool_call>\n<tool_name>web.fetch</tool_name>\n<parameters>\n{"url":"https://aniketpandey.website","responseMode":"readable","includeHeaders":true,"includeTls":true}\n</parameters>\n</tool_call>';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe("web.fetch");
    expect(call!.args).toEqual({ url: "https://aniketpandey.website", responseMode: "readable", includeHeaders: true, includeTls: true });
  });

  it("extracts tool calls from XML-style tags using function and parameter elements (MiMo 1c)", () => {
    const text =
      'Response:\n<tool_call>\n<function=shell.exec>\n<parameter=command>sudo lsof -i -P -n | grep LISTEN | sort -t: -k2 -n</parameter>\n<parameter=timeoutMs>15000</parameter>\n</function>\n</tool_call>';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe("shell.exec");
    expect(call!.args).toEqual({
      command: "sudo lsof -i -P -n | grep LISTEN | sort -t: -k2 -n",
      timeoutMs: 15000,
    });
  });

  it("extracts tool calls from ### heading format", () => {
    const text =
      'I will check your IP.\n### tool\n{"name":"shell.exec","args":{"command":"curl ifconfig.me"}}';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe("shell.exec");
    expect(call!.args).toEqual({ command: "curl ifconfig.me" });
  });

  it("extracts tool calls from **tool** bold format", () => {
    const text = 'Checking.\n**tool**\n{"name":"sysinfo","args":{}}';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe("sysinfo");
  });

  it("extracts from ```json fenced blocks", () => {
    const text =
      'Running:\n```json\n{"name":"http.fetch","args":{"url":"https://api.ipify.org"}}\n```';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe("http.fetch");
  });

  it("extracts trailing JSON object", () => {
    const text = 'Let me check.\n{"name":"sysinfo","args":{}}';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe("sysinfo");
  });

  it("returns undefined for plain text without tool calls", () => {
    const text = "Here is the answer: just run ls.";
    expect(parseToolCall(text)).toBeUndefined();
  });

  it("returns undefined for malformed JSON in tool block", () => {
    const text = "```tool\n{invalid json}\n```";
    expect(parseToolCall(text)).toBeUndefined();
  });

  it("returns undefined when name is missing", () => {
    const text = '```tool\n{"args":{"command":"ls"}}\n```';
    expect(parseToolCall(text)).toBeUndefined();
  });

  it("returns undefined when args is missing", () => {
    const text = '```tool\n{"name":"shell.exec"}\n```';
    expect(parseToolCall(text)).toBeUndefined();
  });

  it("parses the flattened form where args are siblings of name (dobbe.ai repro)", () => {
    // The exact shape that sent v2.0.26 into a parse-retry loop: a well-formed
    // ```tool fence whose args sit next to `name` instead of nested under it.
    const text =
      'I will check dobbe.ai for issues. Let me fetch the page first.\n' +
      '```tool\n{"name":"web.fetch","url":"https://dobbe.ai","responseMode":"raw","includeHeaders":true,"includeTls":true}\n```';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe("web.fetch");
    expect(call!.args).toEqual({
      url: "https://dobbe.ai",
      responseMode: "raw",
      includeHeaders: true,
      includeTls: true,
    });
  });

  it("parses a flattened shell.exec call", () => {
    const text = '```tool\n{"name":"shell.exec","command":"ls -la"}\n```';
    const call = parseToolCall(text);
    expect(call).toEqual({ name: "shell.exec", args: { command: "ls -la" } });
  });

  it("does not treat a plain data object carrying a name as a tool call", () => {
    // No sibling key is a known tool-arg, so this must NOT become a call.
    const text = '```tool\n{"name":"John","age":30}\n```';
    expect(parseToolCall(text)).toBeUndefined();
  });

  it("handles multiline tool JSON", () => {
    const text =
      '```tool\n{\n  "name": "fs.read",\n  "args": {\n    "path": "/tmp/test.txt"\n  }\n}\n```';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe("fs.read");
    expect(call!.args).toEqual({ path: "/tmp/test.txt" });
  });
});

describe("Kimi K2 sentinel-token tool-call format", () => {
  it("parses Kimi sentinel calls with the functions. prefix", () => {
    const text =
      "<|tool_calls_section_begin|><|tool_call_begin|>functions.sysinfo:1<|tool_call_argument_begin|>{}<|tool_call_end|><|tool_calls_section_end|>";
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe("sysinfo");
    expect(call!.args).toEqual({});
  });

  it("parses Kimi sentinel calls without the functions. prefix", () => {
    const text =
      '<|tool_call_begin|>shell.exec:0<|tool_call_argument_begin|>{"command":"uname -a"}<|tool_call_end|>';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe("shell.exec");
    expect(call!.args).toEqual({ command: "uname -a" });
  });

  it("parses Kimi sentinel calls without the trailing :index", () => {
    const text =
      '<|tool_call_begin|>fs.read<|tool_call_argument_begin|>{"path":"/etc/os-release"}<|tool_call_end|>';
    const call = parseToolCall(text);
    expect(call).toBeDefined();
    expect(call!.name).toBe("fs.read");
    expect(call!.args).toEqual({ path: "/etc/os-release" });
  });

  it("returns undefined for truncated Kimi sentinel calls so the runner can ask for a retry", () => {
    const text =
      '<|tool_calls_section_begin|><|tool_call_bhell.exec:0<|tool_call_argument_begin|>{"command":"find ..."}<|tool_call_end|><|tool_|>';
    expect(parseToolCall(text)).toBeUndefined();
  });
});

describe("fresh web-search guard", () => {
  it("treats fetch narration without a tool call as an action stall", () => {
    expect(
      looksLikeActionNarration(
        "Let me fetch that specific blog post to get the exact methods.",
      ),
    ).toBe(true);
  });

  it("treats current office-holder questions as volatile even without the word current", () => {
    expect(requiresFreshWebSearch("who is westbengal cm")).toBe(true);
    expect(requiresFreshWebSearch("who is the CEO of Apple")).toBe(true);
    expect(requiresFreshWebSearch("president of France")).toBe(true);
  });

  it("treats releases and explicit web lookups as fresh-search cases", () => {
    expect(requiresFreshWebSearch("latest vite version")).toBe(true);
    expect(requiresFreshWebSearch("look up the npm package status")).toBe(true);
  });

  it("does not route static abbreviation questions through web.search", () => {
    expect(requiresFreshWebSearch("what does cm stand for")).toBe(false);
    expect(requiresFreshWebSearch("define cm")).toBe(false);
  });

  it("never treats a plan-execution / build turn as a fresh-search turn", () => {
    // The /implement synthetic message contains "now" — must NOT trigger a
    // web.search for the current date instead of building the project.
    const implementMsg =
      "I approve the plan. Execute it now, task by task: mark each task in_progress before " +
      "you start it and done after it actually succeeds.";
    expect(requiresFreshWebSearch(implementMsg)).toBe(false);
    expect(requiresFreshWebSearch("create a simple blog page react app here")).toBe(
      false,
    );
    expect(requiresFreshWebSearch("build it now")).toBe(false);
  });
});

describe("web.search display styling", () => {
  it("dims web.search tool chatter but not unrelated tools", () => {
    expect(
      shouldDimToolChatter({ name: "web.search", args: { query: "x" } }),
    ).toBe(true);
    expect(shouldDimToolChatter({ name: "fs.read", args: { path: "x" } })).toBe(
      false,
    );
  });
});

describe("phase 8 — parser strict mode", () => {
  it("strict mode still accepts ```tool fences", () => {
    const text = 'plan.\n```tool\n{"name":"sysinfo","args":{}}\n```';
    const call = parseToolCall(text, { strict: true });
    expect(call?.name).toBe("sysinfo");
  });

  it("strict mode still accepts <tool_call> XML", () => {
    const text = '<tool_call>{"name":"sysinfo","args":{}}</tool_call>';
    const call = parseToolCall(text, { strict: true });
    expect(call?.name).toBe("sysinfo");
  });

  it("strict mode still accepts Kimi sentinel tokens", () => {
    const text =
      '<|tool_call_begin|>shell.exec<|tool_call_argument_begin|>{"command":"ls"}<|tool_call_end|>';
    const call = parseToolCall(text, { strict: true });
    expect(call?.name).toBe("shell.exec");
  });

  it("strict mode rejects ```json fenced blocks", () => {
    const text =
      'Example:\n```json\n{"name":"shell.exec","args":{"command":"ls"}}\n```';
    expect(parseToolCall(text, { strict: true })).toBeUndefined();
    // ...but loose mode still accepts it (compat default).
    expect(parseToolCall(text)).toBeDefined();
  });

  it("strict mode rejects ### tool heading + JSON", () => {
    const text = '### tool\n{"name":"sysinfo","args":{}}';
    expect(parseToolCall(text, { strict: true })).toBeUndefined();
  });

  it("strict mode rejects **tool** bold + JSON", () => {
    const text = '**tool**\n{"name":"sysinfo","args":{}}';
    expect(parseToolCall(text, { strict: true })).toBeUndefined();
  });

  it("strict mode rejects trailing-JSON in prose", () => {
    const text =
      'Here is an example: {"name":"shell.exec","args":{"command":"rm -rf /"}}';
    expect(parseToolCall(text, { strict: true })).toBeUndefined();
  });
});

describe("truncated tool-call detection", () => {
  const bigCall = JSON.stringify({
    name: "fs.writeMany",
    args: { files: [{ path: "package.json", content: "{}" }] },
  });

  it("flags an opened ```tool fence with no closing fence", () => {
    const text = "Plan\n\n```tool\n" + bigCall.slice(0, 40);
    expect(looksLikeTruncatedToolCall(text)).toBe(true);
    // And it does NOT parse, which is what triggers the recovery path.
    expect(parseToolCall(text)).toBeUndefined();
  });

  it("flags a tool JSON whose braces never balanced", () => {
    const text = '{"name":"fs.writeMany","args":{"files":[{"path":"a.txt"';
    expect(looksLikeTruncatedToolCall(text)).toBe(true);
  });

  it("does not flag a complete fenced tool call", () => {
    const text = "Plan\n\n```tool\n" + bigCall + "\n```";
    expect(looksLikeTruncatedToolCall(text)).toBe(false);
    expect(parseToolCall(text)?.name).toBe("fs.writeMany");
  });

  it("does not flag ordinary prose with no tool markers", () => {
    expect(looksLikeTruncatedToolCall("Here is your answer, all done.")).toBe(false);
  });
});

describe("bare-JSON tool-call recovery", () => {
  it("recovers a complete {name,args} object that the strict matchers missed", () => {
    const text = '{"name":"pdf.read","args":{"path":"/abs/file.pdf"}}';
    const result = recognizeBareToolJson(text);
    expect(result?.call?.name).toBe("pdf.read");
    expect(result?.call?.args).toEqual({ path: "/abs/file.pdf" });
  });

  it("recovers a complete call wrapped in a lone ```json fence", () => {
    const text = '```json\n{"name":"sysinfo","args":{}}\n```';
    const result = recognizeBareToolJson(text);
    expect(result?.call?.name).toBe("sysinfo");
  });

  it("flags a bare args object (no name/fence) as argsOnly", () => {
    const text = '{"path":"/Users/x/signed-cert.pdf"}';
    const result = recognizeBareToolJson(text);
    expect(result?.argsOnly).toBe(true);
    expect(result?.call).toBeUndefined();
  });

  it("infers shell.exec from an unambiguous bare command args object", () => {
    // A bare {"command":"…"} unambiguously means shell.exec, so it should be
    // recovered and run directly instead of nudging the user to type "run".
    const result = recognizeBareToolJson('{"command":"ls -la"}');
    expect(result?.call?.name).toBe("shell.exec");
    expect(result?.call?.args).toEqual({ command: "ls -la" });
    expect(result?.argsOnly).toBeUndefined();
  });

  it("infers shell.exec even with an extra timeout key", () => {
    const result = recognizeBareToolJson(
      '{"command":"find / -iname rockyou*","timeoutMs":300000}',
    );
    expect(result?.call?.name).toBe("shell.exec");
  });

  it("still flags a lone ambiguous path object as argsOnly", () => {
    // A lone `path` could be fs.read / fs.list / pdf.read / image.ocr — too
    // ambiguous to infer, so we still nudge for a properly named tool call.
    const result = recognizeBareToolJson('{"path":"/Users/x/notes.txt"}');
    expect(result?.argsOnly).toBe(true);
    expect(result?.call).toBeUndefined();
  });

  it("ignores ordinary JSON answers that are not tool args", () => {
    expect(
      recognizeBareToolJson('{"answer":42,"explanation":"because"}'),
    ).toBeUndefined();
    expect(recognizeBareToolJson("just some prose")).toBeUndefined();
    expect(recognizeBareToolJson('{"path":"x","extra":1,"more":2,"a":3,"b":4,"c":5,"d":6}')).toBeUndefined();
  });
});

describe("plan quality — lumped single-task detection", () => {
  it("flags a single task that crams many files/actions into one step", () => {
    expect(
      isLumpedSingleTask([
        "Create package.json, vite.config.js, index.html, src/main.jsx, src/App.jsx, src/Post.jsx, src/posts.json, src/styles.css",
      ]),
    ).toBe(true);
    expect(isLumpedSingleTask(["scaffold the app and install deps and run it"])).toBe(
      true,
    );
  });

  it("accepts a focused single task and any multi-task plan", () => {
    expect(isLumpedSingleTask(["scaffold package.json"])).toBe(false);
    expect(
      isLumpedSingleTask([
        "scaffold package.json + vite config",
        "create index.html and entry",
        "build App + Post components",
      ]),
    ).toBe(false);
    expect(isLumpedSingleTask([])).toBe(false);
  });
});

describe("multi-tool-block detection (countToolFences)", () => {
  it("counts a single tool block", () => {
    const text =
      '```tool\n{"name":"shell.exec","args":{"command":"ls"}}\n```';
    expect(countToolFences(text)).toBe(1);
  });

  it("counts multiple tool blocks crammed into one message", () => {
    const text =
      'Doing it all:\n' +
      '```tool\n{"name":"fs.writeMany","args":{"files":[]}}\n```\n' +
      '```tool\n{"name":"shell.exec","args":{"command":"npm install"}}\n```\n' +
      '```tool\n{"name":"shell.exec","args":{"command":"npm run dev"}}\n```';
    expect(countToolFences(text)).toBe(3);
  });

  it("returns 0 when there is no tool block", () => {
    expect(countToolFences("just prose, no tools here")).toBe(0);
    expect(countToolFences('```js\nconst x = 1;\n```')).toBe(0);
  });
});

describe("malformed fenced tool block detection", () => {
  it("a ```tool block with bad braces fails to parse but is detected as a fence", () => {
    // The exact shape Claude-opus emitted: extra `}` after each file object
    // and a trailing ` }` after the closing brace.
    const malformed =
      '```tool\n{"name":"fs.writeMany","args":{"files":[{"path":"a","content":"x"}},' +
      '{"path":"b","content":"y"}]} }\n```';
    expect(parseToolCall(malformed, {})).toBeUndefined();
    // Not simple truncation (braces are present, just unbalanced/extra).
    expect(looksLikeTruncatedToolCall(malformed)).toBe(false);
    // But it IS a tool fence, so the runner can nudge a re-emit instead of
    // leaking it as the final answer.
    expect(countToolFences(malformed)).toBe(1);
  });

  it("a valid ```tool block still parses (no false retry)", () => {
    const good = '```tool\n{"name":"fs.read","args":{"path":"a"}}\n```';
    expect(parseToolCall(good, {})).toEqual({
      name: "fs.read",
      args: { path: "a" },
    });
  });
});

describe("scoped-parallel batch grouping (groupToolCallsForExecution)", () => {
  // Read-only lookups are parallel-safe; task.update and writes/commands are
  // barriers. Mirrors the runner's real predicate at the shape level.
  const READ_ONLY = new Set([
    "fs.read",
    "fs.list",
    "fs.search",
    "dns.lookup",
    "whois.lookup",
    "http.fetch",
    "web.fetch",
    "web.search",
    "sysinfo",
  ]);
  const safe = (c: { name: string }) => READ_ONLY.has(c.name);
  const call = (name: string) => ({ name, args: {} });

  it("groups consecutive read-only calls to run in parallel", () => {
    const groups = groupToolCallsForExecution(
      [call("dns.lookup"), call("whois.lookup"), call("http.fetch")],
      safe,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((c) => c.name)).toEqual([
      "dns.lookup",
      "whois.lookup",
      "http.fetch",
    ]);
  });

  it("keeps task.update as a sequential barrier around the work it gates", () => {
    // in_progress → parallel recon → done must be 3 ordered groups: the
    // task.update calls never merge with the work, so plan state can't race.
    const groups = groupToolCallsForExecution(
      [
        call("task.update"),
        call("dns.lookup"),
        call("whois.lookup"),
        call("task.update"),
      ],
      safe,
    );
    expect(groups.map((g) => g.map((c) => c.name))).toEqual([
      ["task.update"],
      ["dns.lookup", "whois.lookup"],
      ["task.update"],
    ]);
  });

  it("never parallelizes writes/commands — each is its own barrier", () => {
    const groups = groupToolCallsForExecution(
      [call("fs.write"), call("shell.exec"), call("pkg.install")],
      safe,
    );
    expect(groups.map((g) => g.length)).toEqual([1, 1, 1]);
  });

  it("caps a parallel group at maxGroupSize (spilling into a second group)", () => {
    const groups = groupToolCallsForExecution(
      [
        call("dns.lookup"),
        call("dns.lookup"),
        call("dns.lookup"),
        call("dns.lookup"),
        call("dns.lookup"),
      ],
      safe,
      4,
    );
    expect(groups.map((g) => g.length)).toEqual([4, 1]);
  });

  it("splits a read-only run when a write appears mid-batch", () => {
    const groups = groupToolCallsForExecution(
      [call("fs.read"), call("fs.read"), call("fs.write"), call("fs.read")],
      safe,
    );
    expect(groups.map((g) => g.map((c) => c.name))).toEqual([
      ["fs.read", "fs.read"],
      ["fs.write"],
      ["fs.read"],
    ]);
  });
});

describe("resumable turn history (buildTurnHistory)", () => {
  const sys = { role: "system" as const, content: "you are clai" };
  const user = { role: "user" as const, content: "find issues on example.com" };
  const toolCall = {
    role: "assistant" as const,
    content: '```tool\n{"name":"dns.lookup","args":{"target":"example.com"}}\n```',
  };
  const toolResult = {
    role: "tool" as const,
    content: "Tool dns.lookup result (exit=0, ok=true):\nA 93.184.216.34",
  };

  it("drops system prompts but keeps the user turn, tool calls, and tool results", () => {
    const out = buildTurnHistory([sys, user, toolCall, toolResult], "Found 1 record.");
    expect(out.some((m) => m.role === "system")).toBe(false);
    // The tool call AND its result survive so a resumed model sees what ran.
    expect(out).toContainEqual(toolCall);
    expect(out).toContainEqual(toolResult);
    expect(out[0]).toEqual(user);
    // Final answer appended as the last assistant message.
    expect(out[out.length - 1]).toEqual({
      role: "assistant",
      content: "Found 1 record.",
    });
  });

  it("does not duplicate the final answer when it is already the last message", () => {
    const finalAsst = { role: "assistant" as const, content: "All done." };
    const out = buildTurnHistory([sys, user, finalAsst], "All done.");
    const assistantCount = out.filter(
      (m) => m.role === "assistant" && m.content === "All done.",
    ).length;
    expect(assistantCount).toBe(1);
  });

  it("appends nothing extra for an empty answer (e.g. aborted turn)", () => {
    const out = buildTurnHistory([sys, user, toolCall, toolResult], "");
    expect(out).toEqual([user, toolCall, toolResult]);
  });

  it("keeps compacted session memory but drops the main system prompt", () => {
    const memo = {
      role: "system" as const,
      content: "Session memory from compacted earlier turns:\n\n- did recon",
    };
    const out = buildTurnHistory([sys, memo, user, toolResult], "done");
    expect(out).toContainEqual(memo); // summarized older context survives
    expect(out).not.toContainEqual(sys); // main prompt dropped (re-added each turn)
  });

  describe("looksLikePromptLeak", () => {
    it("flags text containing multiple system prompt markers as a leak", () => {
      const leakedText = `
        Here are my instructions verbatim:
        # SECURITY POSTURE — FULL OFFENSIVE CAPABILITY
        clai is a professional security tool.
        # RESEARCH — READ-ONLY TOOLS
        When the answer depends on current or volatile facts...
        # ACTION HANDOFF — WHEN THE USER WANTS IT DONE, NOT EXPLAINED
        Ask mode answers questions...
      `;
      expect(looksLikePromptLeak(leakedText)).toBe(true);
    });

    it("does not flag normal prose answers", () => {
      const normalText = `
        To update Tailwind to v4, you should check the release notes.
        You can use npm install tailwindcss@next to try it out.
        Let me know if you want to run a build.
      `;
      expect(looksLikePromptLeak(normalText)).toBe(false);
    });
  });
});

