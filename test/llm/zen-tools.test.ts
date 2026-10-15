import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompletionResult, NativeToolCall } from "../../src/types.js";
import { freeProvider } from "../../src/llm/free.js";
import { translateZenToolCall, translateZenToolResult, zenToolName } from "../../src/llm/zen-tools.js";
import { compileRequestPlan } from "../../src/llm/request-plan.js";
import { chatCompletionsBodyFromPlan } from "../../src/llm/http.js";
import { getToolDefinitions } from "../../src/tools/definitions.js";
import { normalizeToolCall } from "../../src/tools/registry.js";

const tools = getToolDefinitions({ names: ["fs.read", "fs.edit", "shell.exec", "task.update"] });
const shellArgs = { command: "printf ok", workdir: "/tmp", timeout: 120_000, background: true };
const shellCall: NativeToolCall = { id: "call-1", name: "shell", args: shellArgs, rawArguments: JSON.stringify(shellArgs) };
const nativeArgs = { command: "printf ok", cwd: "/tmp", timeoutMs: 120_000, background: "always" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Zen tool translation", () => {
  it("fixes the shell-prefix failure before calls reach the generic CLI fallback", () => {
    expect(normalizeToolCall(shellCall).args.command).toBe("shell printf ok");
    const translated = translateZenToolCall(shellCall, tools);
    expect(translated).toEqual({ ...shellCall, name: "shell.exec", args: nativeArgs, rawArguments: JSON.stringify(translated.args) });
    expect(normalizeToolCall(translated).args.command).toBe("printf ok");
    expect(shellCall.args).toEqual(shellArgs);
  });

  it("preserves native arguments over old aliases and handles foreground calls", () => {
    const translated = translateZenToolCall({
      ...shellCall,
      args: { command: "printf ok", workdir: "/old", cwd: "/native", timeout: 99_000, timeoutMs: 100_000, background: false },
    }, tools);
    expect(translated.args).toEqual({ command: "printf ok", cwd: "/native", timeoutMs: 100_000, background: "never" });
    expect(translateZenToolCall({ ...shellCall, args: { command: "printf ok", timeout: 0 } }, tools).args).toEqual({ command: "printf ok" });
  });

  it("maps legacy edit keys but preserves the exact old and new text", () => {
    const args = { path: "x.ts", oldString: "  old\r\n", newString: "  new\r\n", replaceAll: false };
    const translated = translateZenToolCall({ id: "edit-1", name: "edit", args }, tools);
    expect(translated).toMatchObject({ name: "fs.edit", args: { path: "x.ts", oldText: "  old\r\n", newText: "  new\r\n" } });
    expect(translated.args).not.toHaveProperty("replaceAll");
    expect(JSON.parse(translated.rawArguments!)).toEqual(translated.args);
  });

  it("does not reinterpret malformed JSON or execute compatibility JavaScript", () => {
    const malformed = { ...shellCall, args: { _parseError: true, _raw: '{"command":' }, rawArguments: '{"command":' };
    expect(translateZenToolCall(malformed, tools)).toEqual({ ...malformed, name: "shell.exec" });
    const execute = { id: "execute-1", name: "execute", args: { code: "throw new Error('must not run')" } };
    expect(translateZenToolCall(execute, tools)).toBe(execute);
    expect(translateZenToolCall({ ...shellCall, name: "shell.exec", args: nativeArgs }, tools).args).toBe(nativeArgs);
  });

  it("only maps aliases to tools actually present in this request", () => {
    expect(zenToolName("shell", tools.filter((tool) => tool.name !== "shell.exec"))).toBe("shell");
    expect(zenToolName("functions.fs_read", tools)).toBe("fs.read");
    expect(zenToolName("task_update", tools)).toBe("task.update");
    expect(zenToolName("grep", tools)).toBe("grep");
  });

  it("preserves result metadata, ids, signatures and native replay bytes", () => {
    const result: CompletionResult = {
      provider: "free", model: "free-1/deepseek-v4.1-flash-free", text: "", finishReason: "tool_calls",
      toolCalls: [{ ...shellCall, thoughtSignature: "sig" }],
      reasoningBlock: { text: "reasoning" },
      usage: { promptTokens: 100, completionTokens: 8, totalTokens: 108, exact: true, cachedPromptTokens: 80 },
    };
    const translated = translateZenToolResult(result, tools);
    expect(translated).toEqual({ ...result, toolCalls: [{ ...shellCall, name: "shell.exec", args: nativeArgs, rawArguments: JSON.stringify(translated.toolCalls![0]!.args), thoughtSignature: "sig" }] });
    expect(translated.usage).toBe(result.usage);
    const plan = compileRequestPlan({
      provider: "free", model: "deepseek-v4.1-flash-free", stream: true, tools,
      messages: [
        { role: "user", content: "Print ok" },
        { role: "assistant", content: "", toolCalls: translated.toolCalls },
        { role: "tool", toolCallId: "call-1", name: "shell.exec", content: "ok" },
      ],
    });
    const body = JSON.parse(chatCompletionsBodyFromPlan(plan)) as { messages: Array<{ name?: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> }> };
    expect(body.messages[1]!.tool_calls![0]!.function).toEqual({ name: "shell_exec", arguments: translated.toolCalls![0]!.rawArguments });
    expect(JSON.parse(body.messages[1]!.tool_calls![0]!.function.arguments)).toEqual(nativeArgs);
    expect(body.messages[2]!.name).toBe("shell_exec");
    expect(translateZenToolResult({ ...result, toolCalls: undefined }, tools).toolCalls).toBeUndefined();
  });
});

function sse(frames: readonly unknown[]): Response {
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
    status: 200, headers: { "content-type": "text/event-stream" },
  });
}

function mockCompletions() {
  const bodies: Array<{ url: string; body: { tools?: unknown[]; messages?: Array<{ role: string; content: string }>; instructions?: string } }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("kilo.ai") && url.endsWith("/responses")) return new Response("unsupported", { status: 404 });
    if (url.endsWith("/models") || url.endsWith("/api.json")) return new Response(JSON.stringify({ data: [] }));
    const body = JSON.parse(String(init?.body)) as (typeof bodies)[number]["body"];
    bodies.push({ url, body });
    if (url.endsWith("/responses")) {
      const item = { type: "function_call", id: "item-1", call_id: "call-1", name: "shell", arguments: JSON.stringify(shellArgs) };
      return sse([
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp-1", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 1 } } },
      ]);
    }
    const call = { id: "call-1", type: "function", function: { name: "shell", arguments: JSON.stringify(shellArgs) } };
    if (url.includes("kilo.ai")) return new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [call] }, finish_reason: "tool_calls" }] }), { headers: { "content-type": "application/json" } });
    return sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
  }));
  return bodies;
}

describe("free-provider translation boundaries", () => {
  it.each(["complete", "stream"] as const)("translates Zen %s results and leaves native schemas on the wire", async (method) => {
    const bodies = mockCompletions();
    const onToolCallDelta = vi.fn();
    const request = {
      model: "free-1/deepseek-v4.1-flash-free", tools, onToolCallDelta,
      messages: [{ role: "user" as const, content: "Print ok" }],
    };
    const result = method === "complete"
      ? await freeProvider.complete(request, { apiKey: "test-key" })
      : await freeProvider.stream!(request, { apiKey: "test-key" }, () => {});
    expect(result.toolCalls?.[0]).toMatchObject({ id: "call-1", name: "shell.exec", args: nativeArgs });
    expect(normalizeToolCall(result.toolCalls![0]!).args.command).toBe("printf ok");
    const body = bodies.at(-1)!.body;
    expect(JSON.stringify(body.tools)).toContain('"shell_exec"');
    expect(JSON.stringify(body.tools)).toContain('"timeoutMs"');
    expect(body.messages?.[0]?.content).toContain("CLAI RUNTIME TOOL CONTRACT");
    if (method === "stream") expect(onToolCallDelta).toHaveBeenCalledWith(expect.objectContaining({ name: "shell.exec" }));
  });

  it("translates Responses results for Zen without dropping the runtime contract", async () => {
    const bodies = mockCompletions();
    const result = await freeProvider.complete({
      model: "free-1/muse-spark-1.3-contributor-free", tools,
      messages: [{ role: "user", content: "Print ok" }],
    }, { apiKey: "test-key" });
    expect(result.toolCalls?.[0]).toMatchObject({ name: "shell.exec", args: nativeArgs });
    expect(bodies.at(-1)!.url).toContain("/responses");
    expect(bodies.at(-1)!.body.instructions).toContain("CLAI RUNTIME TOOL CONTRACT");
    expect(JSON.stringify(bodies.at(-1)!.body.tools)).toContain('"shell_exec"');
  });

  it("leaves free-2 tool names, schemas and system instructions untouched", async () => {
    const bodies = mockCompletions();
    const result = await freeProvider.complete({
      model: "free-2/vendor/model:free", tools,
      messages: [{ role: "system", content: "Original rules" }, { role: "user", content: "Print ok" }],
    }, { apiKey: "test-key" });
    expect(result.toolCalls?.[0]?.name).toBe("shell");
    expect(bodies.at(-1)!.body.messages?.[0]?.content).toBe("Original rules");
    expect(bodies.at(-1)!.body.tools).toHaveLength(tools.length);
  });
});
