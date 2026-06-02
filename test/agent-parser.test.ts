import { describe, expect, it } from "vitest";
import {
  parseToolCall,
  requiresFreshWebSearch,
  shouldDimToolChatter,
  looksLikeTruncatedToolCall,
  recognizeBareToolJson,
  isLumpedSingleTask,
} from "../src/agent/runner.js";

describe("agent tool-call parser", () => {
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
