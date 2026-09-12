import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CompletionRequest, CompletionResult, NativeToolCall, ToolResult } from "../../src/types.js";
import type { SubagentCheckpoint, SubagentRun, SubagentWorkerInput } from "../../src/agent/subagents/types.js";

vi.mock("../../src/llm/router.js", () => ({ streamWithProvider: vi.fn() }));
vi.mock("../../src/tools/registry.js", () => ({ runToolCall: vi.fn() }));
vi.mock("../../src/llm/capability/tool-dialect.js", () => ({ resolveToolDialect: vi.fn(() => "openai") }));
vi.mock("../../src/llm/context-windows.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/llm/context-windows.js")>(),
  modelContextWindow: vi.fn(() => 128_000), modelMaxOutputTokens: vi.fn(() => 4096),
}));

import { streamWithProvider } from "../../src/llm/router.js";
import { runToolCall } from "../../src/tools/registry.js";
import { resolveToolDialect } from "../../src/llm/capability/tool-dialect.js";
import { modelContextWindow, modelMaxOutputTokens } from "../../src/llm/context-windows.js";
import { currentSessionAffinity, withSessionAffinity } from "../../src/llm/session-affinity.js";
import { createReasoningArtifact } from "../../src/llm/reasoning-artifacts.js";
import { runReadOnlySubagent } from "../../src/agent/subagents/worker.js";
import { estimateMessagesTokens, estimateToolSchemaTokens } from "../../src/agent/request-accounting.js";
import { cachePolicyFields } from "../../src/llm/cache-policy-fields.js";

const REPORT = `Status: complete
## Findings
Verified: src/example.ts exports the answer constant. Hypothesis: its consumer uses it as a default; no consumer was examined.
## Evidence
src/example.ts:1 exports answer = 42. The read result proves this export contract; no further call flow was established.
## Next steps
Inspect the importing module before modifying the answer contract.
## Coverage gaps
No tests were run and consumers were not examined.`;

function completion(text = REPORT, toolCalls?: NativeToolCall[]): CompletionResult {
  return { provider: "openai", model: "gpt-4.1", text, toolCalls, finishReason: toolCalls ? "tool_calls" : "stop" };
}

function call(name: string, args: Record<string, unknown> = {}, id = "call-1"): NativeToolCall {
  return { id, name, args };
}

function isCompacting(request: CompletionRequest): boolean {
  return request.messages.some((message) => message.role === "user" && message.content.startsWith("Compact the evidence:"));
}

describe("isolated read-only subagent worker", () => {
  let temporary: string;
  let cwd: string;
  let input: SubagentWorkerInput;
  let checkpoint: SubagentCheckpoint | undefined;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.mocked(resolveToolDialect).mockReturnValue("openai");
    vi.mocked(modelContextWindow).mockReturnValue(128_000);
    vi.mocked(runToolCall).mockResolvedValue({ ok: true, output: "src/example.ts:1: export const answer = 42;" });
    temporary = await mkdtemp(join(tmpdir(), "subagent-worker-"));
    cwd = join(temporary, "workspace");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src/example.ts"), "export const answer = 42;\n");
    await writeFile(join(temporary, "outside.txt"), "private outside data");
    const run: SubagentRun = {
      id: "child-1", parentSessionId: "parent", attempt: 1, title: "Inspect export",
      prompt: "Inspect the answer contract", context: "Research only", cwd,
      provider: "openai", model: "gpt-4.1", status: "running", createdAt: 1, updatedAt: 1, events: [],
    };
    checkpoint = undefined;
    input = {
      run, signal: new AbortController().signal, emit: vi.fn(),
      saveCheckpoint: (value) => { checkpoint = structuredClone(value); },
    };
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(temporary, { recursive: true, force: true });
  });

  it("keeps its system, tools, and sent history stable, preserving native ids and reasoning", async () => {
    const requests: CompletionRequest[] = [];
    const snapshots: CompletionRequest["messages"][] = [];
    const reasoningBlock = { text: "child-only reasoning" };
    const reasoningArtifacts = [createReasoningArtifact({
      kind: "plaintext", raw: "child-only",
      provenance: { provider: "openai", model: "gpt-4.1", dialect: "openai-compatible" },
      replay: { scope: "tool-turn", persistence: "tool-turn" },
    })];
    vi.mocked(streamWithProvider).mockImplementation(async (request, onToken, options) => {
      requests.push(request);
      snapshots.push(structuredClone(request.messages));
      expect(options).toMatchObject({ allowProviderFallback: false, adoptFallback: false, maxRetries: 0, retryRateLimits: false });
      expect(options?.singleDispatch).not.toBe(true);
      expect(request).toMatchObject({ thinking: { enabled: false, effort: "none" }, toolChoice: "auto", parallelToolCalls: true });
      onToken(requests.length === 1 ? "Inspecting export" : REPORT);
      return requests.length === 1
        ? { ...completion("Inspecting export", [call("fs.read", { path: "src/example.ts" }, "native-42")]), reasoningBlock, reasoningArtifacts }
        : completion();
    });
    await expect(runReadOnlySubagent(input)).resolves.toBe(REPORT);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.messages).toEqual(snapshots[0]);
    expect(requests[1]!.messages.slice(0, 2)).toEqual(snapshots[0]);
    expect(requests[0]!.tools).toBe(requests[1]!.tools);
    expect(requests[0]!.tools!.map((tool) => tool.name).sort()).toEqual(["fs.list", "fs.read", "fs.search", "web.fetch", "web.search"]);
    expect(requests[0]!.messages[0]!.content).not.toContain(input.run.prompt);
    expect(requests[0]!.messages[0]!.content).not.toContain(cwd);
    expect(requests[0]!.messages[0]!.content.length).toBeLessThan(1800);
    expect(requests[0]!.messages[0]!.content).not.toMatch(/Available tool schemas|```tool/);
    expect(requests[0]!.messages[0]!.content).toContain("goal, deliverable, scope and requested technical depth");
    expect(requests[0]!.messages[1]!.content).toContain(input.run.prompt);
    expect(requests[1]!.messages[2]).toMatchObject({ role: "assistant", toolCalls: [{ id: "native-42" }], reasoningBlock, reasoningArtifacts });
    expect(requests[1]!.messages[3]).toMatchObject({ role: "tool", toolCallId: "native-42", ok: true });
    expect(runToolCall).toHaveBeenCalledWith(expect.objectContaining({ name: "fs.read", args: expect.objectContaining({ path: join(cwd, "src/example.ts"), maxBytes: 12_000 }) }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(input.emit).toHaveBeenCalledWith({ kind: "assistant", text: "Inspecting export", append: false });
    expect(input.emit).toHaveBeenCalledWith({ kind: "assistant", text: REPORT, append: false });
    expect(vi.mocked(input.emit).mock.calls.filter(([event]) => event.kind === "assistant")).toHaveLength(2);
    expect(await readFile(join(cwd, "src/example.ts"), "utf8")).toBe("export const answer = 42;\n");
  });

  it.each([
    call("shell.exec", { command: "rm -rf ." }),
    call("fs.write", { path: "src/example.ts", content: "overwrite" }),
    call("http.fetch", { url: "https://example.com", method: "POST" }),
    call("tool.batch", { calls: [{ name: "tool.batch", args: { calls: [{ name: "fs.read", args: { path: "src/example.ts" } }] } }] }),
    call("mcp.remote.write", {}),
    call("subagent.spawn", { prompt: "delegate again" }),
    call("fs_read", { path: "src/example.ts" }),
    call("functions.fs.read", { path: "src/example.ts" }),
  ])("denies $name before any registry execution", async (malicious) => {
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion("", [malicious])).mockResolvedValueOnce(completion());
    await runReadOnlySubagent(input);
    expect(runToolCall).not.toHaveBeenCalled();
    expect(input.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "tool", text: expect.stringContaining("Tool denied") }));
  });

  it.each([
    call("fs.read", { path: "../outside.txt" }),
    call("fs.search", { path: ".", pattern: "private", fileList: ["../outside.txt"] }),
    call("fs.search", { path: ".", pattern: "private", followSymlinks: true }),
    call("fs.search", { path: ".", pattern: "private", symlinks: true }),
  ])("blocks traversal and unvalidated search options: $args", async (malicious) => {
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion("", [malicious])).mockResolvedValueOnce(completion());
    await runReadOnlySubagent(input);
    expect(runToolCall).not.toHaveBeenCalled();
  });

  it("blocks absolute outside paths and escaping symlinks, including recursive search", async () => {
    await symlink(join(temporary, "outside.txt"), join(cwd, "src/escape"));
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion("", [
      call("fs.read", { path: join(temporary, "outside.txt") }, "a"),
      call("fs.read", { path: "src/escape" }, "b"),
      call("fs.search", { path: "src", pattern: "private" }, "c"),
    ])).mockResolvedValueOnce(completion());
    await runReadOnlySubagent(input);
    expect(runToolCall).not.toHaveBeenCalled();
  });

  it("supports fenced tools with stable schemas in text mode", async () => {
    vi.mocked(resolveToolDialect).mockReturnValue("none");
    vi.mocked(streamWithProvider)
      .mockResolvedValueOnce(completion('```tool\n{"name":"fs.search","args":{"path":"src","pattern":"answer"}}\n```'))
      .mockResolvedValueOnce(completion());
    await expect(runReadOnlySubagent(input)).resolves.toBe(REPORT);
    const first = vi.mocked(streamWithProvider).mock.calls[0]![0];
    const second = vi.mocked(streamWithProvider).mock.calls[1]![0];
    expect(first.tools).toBeUndefined();
    expect(first.messages[0]!.content).toContain("Available tool schemas");
    expect(second.messages.slice(0, 2)).toEqual(first.messages);
    expect(second.messages[3]).toMatchObject({ role: "user", content: expect.stringContaining("Untrusted tool result") });
    expect(runToolCall).toHaveBeenCalledOnce();
  });

  it("does not let the fenced parser canonicalize an alias into authority", async () => {
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion('```tool\n{"name":"functions.fs.read","args":{"path":"src/example.ts"}}\n```'));
    await expect(runReadOnlySubagent(input)).rejects.toThrow("aliases");
    expect(runToolCall).not.toHaveBeenCalled();
  });

  it("uses independent child affinity without inheriting parent messages", async () => {
    const affinities: string[] = [];
    vi.mocked(streamWithProvider).mockImplementation(async (request) => {
      affinities.push(currentSessionAffinity()!);
      await Promise.resolve();
      expect(currentSessionAffinity()).toBe(affinities.find((affinity) => affinity.includes(JSON.parse(request.messages[1]!.content).context)));
      expect(request.messages).toHaveLength(2);
      return completion();
    });
    await withSessionAffinity("parent-affinity", async () => {
      await Promise.all(["child-a", "child-b"].map((id) => runReadOnlySubagent({ ...input, run: { ...input.run, id, context: id } })));
      expect(currentSessionAffinity()).toBe("parent-affinity");
    });
    expect(new Set(affinities).size).toBe(2);
    expect(affinities.every((affinity) => affinity.includes("parent") && affinity !== "parent-affinity")).toBe(true);
  });

  it("keeps parent and child wire cache keys isolated across child restarts", async () => {
    const fields = () => cachePolicyFields({
      provider: "openai", model: "gpt-4.1", messages: [],
      policy: { kind: "affinity-key", affinityField: "prompt_cache_key" },
    });
    const childKeys = new Map<string, string[]>();
    vi.mocked(streamWithProvider).mockImplementation(async () => {
      const affinity = currentSessionAffinity()!;
      childKeys.set(affinity, [...(childKeys.get(affinity) ?? []), fields().prompt_cache_key!]);
      await Promise.resolve();
      return completion();
    });
    await withSessionAffinity("parent", async () => {
      const parent = fields();
      await runReadOnlySubagent(input);
      const retained = structuredClone(checkpoint!);
      await Promise.all([
        runReadOnlySubagent({ ...input, checkpoint: retained, run: { ...input.run, attempt: 2 } }),
        runReadOnlySubagent({ ...input, run: { ...input.run, id: "child-2" } }),
      ]);
      expect(fields()).toEqual(parent);
      expect([...childKeys.values()].flat()).not.toContain(parent.prompt_cache_key);
    });
    const original = childKeys.get("parent:subagent:child-1")!;
    expect(original).toHaveLength(2);
    expect(original[0]).toBe(original[1]);
    expect(childKeys.get("parent:subagent:child-2")![0]).not.toBe(original[0]);
  });

  it("allows intentional repeat reads while bounding every tool result", async () => {
    const repeated = call("fs.read", { path: "src/example.ts" });
    vi.mocked(runToolCall).mockResolvedValue({ ok: true, output: "x".repeat(50_000) });
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion("", [repeated])).mockResolvedValueOnce(completion("", [repeated])).mockResolvedValueOnce(completion());
    await runReadOnlySubagent(input);
    expect(runToolCall).toHaveBeenCalledTimes(2);
    const messages = vi.mocked(streamWithProvider).mock.calls[2]![0].messages;
    expect(messages.filter((message) => message.role === "tool").every((message) => message.content.length <= 12_000)).toBe(true);
    expect(messages.filter((message) => message.role === "tool").every((message) => message.ok)).toBe(true);
  });

  it.each([true, false])("finishes its scoped investigation beyond the former round cap: native=%s", async (native) => {
    vi.mocked(resolveToolDialect).mockReturnValue(native ? "openai" : "none");
    let round = 0;
    vi.mocked(streamWithProvider).mockImplementation(async () => {
      if (++round > 40) return completion();
      const tool = call("web.search", { query: `query ${round}` }, `call-${round}`);
      return native ? completion("", [tool]) : completion(`\`\`\`tool\n${JSON.stringify({ name: tool.name, args: tool.args })}\n\`\`\``);
    });
    await expect(runReadOnlySubagent(input)).resolves.toBe(REPORT);
    expect(runToolCall).toHaveBeenCalledTimes(40);
    expect(streamWithProvider).toHaveBeenCalledTimes(41);
    const requests = vi.mocked(streamWithProvider).mock.calls.map(([request]) => request);
    expect(requests.at(-1)?.toolChoice).toBe(native ? "auto" : undefined);
    expect(requests.at(-1)?.tools).toBe(requests[0]?.tools);
    expect(requests.at(-1)?.messages.slice(0, 2)).toEqual(requests[0]?.messages);
  });

  it("allows a response with more than eight read-only calls", async () => {
    const calls = Array.from({ length: 12 }, (_, index) => call("web.search", { query: `query ${index}` }, `call-${index}`));
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion("", calls)).mockResolvedValueOnce(completion());
    await expect(runReadOnlySubagent(input)).resolves.toBe(REPORT);
    expect(runToolCall).toHaveBeenCalledTimes(12);
    expect(vi.mocked(streamWithProvider).mock.calls[1]![0].messages.filter((message) => message.role === "tool").map((message) => message.toolCallId)).toEqual(calls.map((tool) => tool.id));
  });

  it("refuses additional tools when report context is all that remains", async () => {
    vi.mocked(modelContextWindow).mockReturnValue(8192);
    vi.mocked(runToolCall).mockResolvedValue({ ok: true, output: "x".repeat(12_000) });
    let round = 0;
    vi.mocked(streamWithProvider).mockImplementation(async () => completion("", [call("web.search", { query: `query ${++round}` }, `call-${round}`)]));
    await expect(runReadOnlySubagent(input)).rejects.toThrow("request context budget exhausted");
    const requests = vi.mocked(streamWithProvider).mock.calls.map(([request]) => request);
    expect(requests.every((request) => request.toolChoice === "auto")).toBe(true);
    const reportRequest = requests.find(isCompacting)!;
    expect(reportRequest).toBeDefined();
    expect(vi.mocked(runToolCall).mock.calls.length).toBe(reportRequest.messages.filter((message) => message.role === "tool" && message.ok).length);
    expect(input.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "notice", text: expect.stringContaining("did not complete") }));
  });

  it.each([undefined, { prompt: "Verify the consumer only" }])("compacts and continues unfinished research with follow-up %j", async (followup) => {
    let round = 0;
    let compacted = false;
    vi.mocked(runToolCall).mockResolvedValue({ ok: true, output: "x".repeat(12_000) });
    vi.mocked(streamWithProvider).mockImplementation(async (request) => {
      if (isCompacting(request)) {
        compacted = true;
        return completion(REPORT.replace("Status: complete", "Status: partial"));
      }
      if (compacted) return completion();
      return completion("", [call("web.search", { query: `query ${++round}` }, `call-${round}`)]);
    });
    const report = await runReadOnlySubagent({ ...input, run: { ...input.run, followup } });
    expect(report).toBe(REPORT);
    expect(compacted).toBe(true);
    expect(round).toBeGreaterThan(1);
    const requests = vi.mocked(streamWithProvider).mock.calls.map(([request]) => request);
    const resumed = requests.at(-1)!;
    expect(resumed.messages.slice(0, 2)).toEqual(requests[0]!.messages.slice(0, 2));
    expect(resumed.messages[2]!.content).toContain("src/example.ts:1");
    expect(resumed.messages).toHaveLength(followup ? 5 : 4);
    if (followup) expect(resumed.messages[3]!.content).toContain(followup.prompt);
    expect(resumed.tools).toBe(requests[0]!.tools);
    expect(requests.every((request) => request.toolChoice === "auto")).toBe(true);
    for (const [request] of vi.mocked(streamWithProvider).mock.calls) {
      expect(estimateMessagesTokens(request.messages) + estimateToolSchemaTokens(request.tools) + request.maxTokens!).toBeLessThan(128_000);
    }
  });

  it.each([8192, 16_384])("admits an initial file read with a %i-token context window", async (contextLimit) => {
    vi.mocked(modelContextWindow).mockReturnValue(contextLimit);
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion("", [call("fs.read", { path: "src/example.ts" })])).mockResolvedValueOnce(completion());
    expect(await runReadOnlySubagent(input)).toMatch(/^Status: (?:complete|partial)\n## Findings/);
    expect(runToolCall).toHaveBeenCalledOnce();
    expect(vi.mocked(runToolCall).mock.calls[0]?.[0].name).toBe("fs.read");
    expect(vi.mocked(streamWithProvider).mock.calls[0]?.[0].toolChoice).toBe("auto");
    for (const [request] of vi.mocked(streamWithProvider).mock.calls) {
      expect(estimateMessagesTokens(request.messages) + estimateToolSchemaTokens(request.tools) + request.maxTokens!).toBeLessThan(contextLimit);
    }
  });

  it("enforces the model context limit before dispatch", async () => {
    vi.mocked(modelContextWindow).mockReturnValue(10_000);
    await expect(runReadOnlySubagent({ ...input, run: { ...input.run, context: "x".repeat(40_000) } })).rejects.toThrow("context budget");
    expect(streamWithProvider).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"])("waits for the stopped provider to %s before releasing the worker", async (outcome) => {
    const stop = new AbortController();
    let dispatch!: () => void;
    let resolveProvider!: (result: CompletionResult) => void;
    let rejectProvider!: (error: Error) => void;
    let lateDelta!: (text: string) => void;
    const started = new Promise<void>((resolve) => { dispatch = resolve; });
    const provider = new Promise<CompletionResult>((resolve, reject) => {
      resolveProvider = resolve;
      rejectProvider = reject;
    });
    vi.mocked(streamWithProvider).mockImplementation(async (_request, onToken) => {
      lateDelta = onToken;
      dispatch();
      return provider;
    });
    const pending = runReadOnlySubagent({ ...input, signal: stop.signal });
    const settled = vi.fn();
    void pending.then(settled, settled);
    const assertion = expect(pending).rejects.toThrow("stop requested");
    await started;
    stop.abort(new Error("stop requested"));
    lateDelta("late provider output");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    expect(input.emit).not.toHaveBeenCalled();
    if (outcome === "resolve") resolveProvider(completion("", [call("fs.read", { path: "src/example.ts" })]));
    else rejectProvider(new Error("provider stopped"));
    await assertion;
    expect(settled).toHaveBeenCalledOnce();
    expect(runToolCall).not.toHaveBeenCalled();
    expect(streamWithProvider).toHaveBeenCalledOnce();
    expect(input.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "notice", text: expect.stringContaining("stop requested") }));
  });

  it("does not abort a provider after an arbitrary assignment deadline", async () => {
    vi.useFakeTimers();
    let dispatch!: () => void;
    let resolveProvider!: (result: CompletionResult) => void;
    let requestSignal!: AbortSignal;
    const started = new Promise<void>((resolve) => { dispatch = resolve; });
    const provider = new Promise<CompletionResult>((resolve) => { resolveProvider = resolve; });
    vi.mocked(streamWithProvider).mockImplementation(async (request) => {
      requestSignal = request.signal!;
      dispatch();
      return provider;
    });
    const pending = runReadOnlySubagent(input);
    const settled = vi.fn();
    void pending.then(settled, settled);
    const assertion = expect(pending).resolves.toBe(REPORT);
    await started;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(requestSignal.aborted).toBe(false);
    expect(settled).not.toHaveBeenCalled();
    resolveProvider(completion());
    await assertion;
    expect(runToolCall).not.toHaveBeenCalled();
  });

  it("continues research beyond the former time limit", async () => {
    vi.useFakeTimers();
    let round = 0;
    vi.mocked(streamWithProvider).mockImplementation(async () => {
      if (++round > 1) return completion();
      await vi.advanceTimersByTimeAsync(3_600_000);
      return completion("", [call("fs.read", { path: "src/example.ts" })]);
    });
    const report = await runReadOnlySubagent(input);
    expect(report).toBe(REPORT);
    expect(streamWithProvider).toHaveBeenCalledTimes(2);
    expect(runToolCall).toHaveBeenCalledOnce();
    expect(vi.mocked(streamWithProvider).mock.calls[1]![0].toolChoice).toBe("auto");
  });

  it("waits for a stopped registry call and suppresses its result and subsequent tools", async () => {
    const stop = new AbortController();
    let dispatch!: () => void;
    let resolveTool!: (result: ToolResult) => void;
    const started = new Promise<void>((resolve) => { dispatch = resolve; });
    const tool = new Promise<ToolResult>((resolve) => { resolveTool = resolve; });
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion("", [
      call("fs.read", { path: "src/example.ts" }, "first"),
      call("fs.list", { path: "src" }, "second"),
    ]));
    vi.mocked(runToolCall).mockImplementation(async () => {
      dispatch();
      return tool;
    });
    const pending = runReadOnlySubagent({ ...input, signal: stop.signal });
    const settled = vi.fn();
    void pending.then(settled, settled);
    const assertion = expect(pending).rejects.toThrow("stop requested");
    await started;
    vi.mocked(input.emit).mockClear();
    stop.abort(new Error("stop requested"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    expect(input.emit).not.toHaveBeenCalled();
    resolveTool({ ok: true, output: "late tool result" });
    await assertion;
    expect(runToolCall).toHaveBeenCalledOnce();
    expect(streamWithProvider).toHaveBeenCalledOnce();
    expect(input.emit).toHaveBeenCalledOnce();
    expect(input.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "notice", text: expect.stringContaining("stop requested") }));
  });

  it.each(["Done", "I will investigate next"])("repairs a non-final response: %s", async (text) => {
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion(text)).mockResolvedValueOnce(completion());
    await expect(runReadOnlySubagent(input)).resolves.toBe(REPORT);
    expect(streamWithProvider).toHaveBeenCalledTimes(2);
    expect(vi.mocked(streamWithProvider).mock.calls[1]?.[0]).toMatchObject({ toolChoice: "auto" });
  });

  it("allows more than three report repairs and further evidence gathering", async () => {
    for (let index = 0; index < 5; index++) vi.mocked(streamWithProvider).mockResolvedValueOnce(completion("I still need evidence"));
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion("", [call("fs.read", { path: "src/example.ts" })])).mockResolvedValueOnce(completion());
    await expect(runReadOnlySubagent(input)).resolves.toBe(REPORT);
    expect(streamWithProvider).toHaveBeenCalledTimes(7);
    expect(runToolCall).toHaveBeenCalledOnce();
    expect(vi.mocked(streamWithProvider).mock.calls.every(([request]) => request.toolChoice === "auto")).toBe(true);
  });

  it("continues an evidence-backed partial report until the assignment is complete", async () => {
    const partial = REPORT.replace("Status: complete", "Status: partial");
    const saveSummary = vi.fn();
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion(partial))
      .mockResolvedValueOnce(completion("", [call("fs.read", { path: "src/example.ts" })]))
      .mockResolvedValueOnce(completion());
    await expect(runReadOnlySubagent({ ...input, saveSummary })).resolves.toBe(REPORT);
    expect(saveSummary).toHaveBeenCalledExactlyOnceWith(partial);
    expect(streamWithProvider).toHaveBeenCalledTimes(3);
    expect(vi.mocked(streamWithProvider).mock.calls[1]![0].messages.at(-1)!.content).toContain("not finished");
    expect(runToolCall).toHaveBeenCalledOnce();
  });

  it.each([
    "I will investigate next",
    REPORT.replace(/src\/example.ts:1/g, "the source file"),
    REPORT.slice(0, REPORT.indexOf("## Coverage gaps")) + "## Coverage gaps!",
  ])("fails closed when context runs out without a valid report", async (text) => {
    vi.mocked(modelContextWindow).mockReturnValue(8192);
    vi.mocked(streamWithProvider).mockResolvedValue(completion(text));
    await expect(runReadOnlySubagent(input)).rejects.toThrow("context budget exhausted");
    expect(checkpoint?.finished).not.toBe(true);
  });

  it("repairs truncated output without executing incomplete tool calls", async () => {
    vi.mocked(streamWithProvider).mockResolvedValueOnce({
      ...completion("Incomplete tool response", [call("fs.read", { path: "src/example.ts" })]), finishReason: "length",
    }).mockResolvedValueOnce(completion());
    await expect(runReadOnlySubagent(input)).resolves.toBe(REPORT);
    expect(runToolCall).not.toHaveBeenCalled();
    const request = vi.mocked(streamWithProvider).mock.calls[1]![0];
    expect(request.toolChoice).toBe("auto");
    expect(request.messages.some((message) => message.toolCalls?.length)).toBe(false);
  });

  it("does not retry router errors or accept fallback routes", async () => {
    vi.mocked(streamWithProvider).mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(runReadOnlySubagent(input)).rejects.toThrow("provider unavailable");
    expect(streamWithProvider).toHaveBeenCalledOnce();
    vi.mocked(streamWithProvider).mockResolvedValueOnce({ ...completion(), provider: "anthropic" });
    await expect(runReadOnlySubagent(input)).rejects.toThrow("route changed");
  });

  it("resumes provider errors from exact completed messages, native reasoning and stable affinity", async () => {
    const reasoningBlock = { text: "private replay-only reasoning" };
    const reasoningArtifacts = [createReasoningArtifact({
      kind: "plaintext", raw: "private replay artifact",
      provenance: { provider: "openai", model: "gpt-4.1", dialect: "openai-compatible" },
      replay: { scope: "tool-turn", persistence: "tool-turn" },
    })];
    const repeated = call("fs.read", { path: "src/example.ts" }, "native-evidence");
    const affinities: (string | undefined)[] = [];
    let round = 0;
    vi.mocked(streamWithProvider).mockImplementation(async (_request, onToken) => {
      affinities.push(currentSessionAffinity());
      round += 1;
      if (round === 1) return { ...completion("Inspecting", [repeated]), reasoningBlock, reasoningArtifacts };
      if (round === 2) {
        onToken("interrupted provider delta");
        throw new Error("Temporary provider outage");
      }
      return round === 3 ? completion("", [repeated]) : completion();
    });
    await expect(runReadOnlySubagent(input)).rejects.toThrow("Temporary provider outage");
    expect(streamWithProvider).toHaveBeenCalledTimes(2);
    const failedRequest = structuredClone(vi.mocked(streamWithProvider).mock.calls[1]![0]);
    expect(checkpoint?.messages).toEqual(failedRequest.messages);
    expect(checkpoint?.messages.filter((message) => message.role === "tool")).toHaveLength(1);
    expect(checkpoint?.messages[2]).toMatchObject({ reasoningBlock, reasoningArtifacts });
    expect(JSON.stringify(checkpoint)).not.toContain("interrupted provider delta");
    await expect(runReadOnlySubagent({ ...input, checkpoint, run: { ...input.run, attempt: 2 } })).resolves.toBe(REPORT);
    const resumed = vi.mocked(streamWithProvider).mock.calls[2]![0];
    expect(resumed.messages).toEqual(failedRequest.messages);
    expect(resumed.tools).toEqual(failedRequest.tools);
    expect(new Set(affinities).size).toBe(1);
    expect(runToolCall).toHaveBeenCalledTimes(2);
    expect(checkpoint?.finished).toBe(true);
  });

  it("resumes an interrupted batch at the first unsettled tool, without replaying completed evidence", async () => {
    const stop = new AbortController();
    let dispatch!: () => void;
    let release!: (result: ToolResult) => void;
    const started = new Promise<void>((resolve) => { dispatch = resolve; });
    const tool = new Promise<ToolResult>((resolve) => { release = resolve; });
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion("", [
      call("fs.read", { path: "src/example.ts" }, "first"),
      call("fs.list", { path: "src" }, "second"),
      call("web.search", { query: "public documentation" }, "third"),
    ])).mockResolvedValueOnce(completion());
    vi.mocked(runToolCall).mockResolvedValueOnce({ ok: true, output: "completed first evidence" }).mockImplementationOnce(async () => {
      dispatch();
      return tool;
    });
    const pending = runReadOnlySubagent({ ...input, signal: stop.signal });
    const assertion = expect(pending).rejects.toThrow("stop requested");
    await started;
    expect(checkpoint?.pending?.next).toBe(1);
    const beforeStop = structuredClone(checkpoint!);
    stop.abort(new Error("stop requested"));
    release({ ok: true, output: "unsettled second evidence" });
    await assertion;
    expect(checkpoint).toEqual(beforeStop);
    vi.mocked(runToolCall).mockResolvedValue({ ok: true, output: "resumed evidence" });
    await expect(runReadOnlySubagent({ ...input, checkpoint, run: { ...input.run, attempt: 2 } })).resolves.toBe(REPORT);
    expect(vi.mocked(runToolCall).mock.calls.map(([call]) => call.name)).toEqual(["fs.read", "fs.list", "fs.list", "web.search"]);
    const resumed = vi.mocked(streamWithProvider).mock.calls[1]![0];
    expect(resumed.messages.slice(0, beforeStop.messages.length)).toEqual(beforeStop.messages);
    expect(resumed.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId)).toEqual(["first", "second", "third"]);
    expect(JSON.stringify(resumed.messages)).not.toContain("unsettled second evidence");
    expect(checkpoint?.pending).toBeUndefined();
  });

  it.each([true, false])("pins the original tool protocol during exact recovery: native=%s", async (native) => {
    vi.mocked(resolveToolDialect).mockReturnValue(native ? "openai" : "none");
    vi.mocked(streamWithProvider).mockResolvedValueOnce(native
      ? completion("", [call("fs.read", { path: "src/example.ts" })])
      : completion('```tool\n{"name":"fs.read","args":{"path":"src/example.ts"}}\n```'))
      .mockRejectedValueOnce(new Error("Temporary provider outage"))
      .mockResolvedValueOnce(completion());
    await expect(runReadOnlySubagent(input)).rejects.toThrow("Temporary provider outage");
    const original = structuredClone(vi.mocked(streamWithProvider).mock.calls[1]![0]);
    vi.mocked(resolveToolDialect).mockReturnValue(native ? "none" : "openai");
    await expect(runReadOnlySubagent({ ...input, checkpoint, run: { ...input.run, attempt: 2 } })).resolves.toBe(REPORT);
    const resumed = vi.mocked(streamWithProvider).mock.calls[2]![0];
    expect(resumed.messages).toEqual(original.messages);
    expect(resumed.tools).toEqual(original.tools);
    expect(resumed.toolChoice).toBe(original.toolChoice);
    expect(runToolCall).toHaveBeenCalledOnce();
  });

  it("retains context-triggered synthesis across a transient provider error", async () => {
    vi.mocked(modelContextWindow).mockReturnValue(8192);
    vi.mocked(runToolCall).mockResolvedValue({ ok: true, output: "x".repeat(12_000) });
    let synthesis = 0;
    vi.mocked(streamWithProvider).mockImplementation(async (request) => {
      if (!isCompacting(request)) return completion("", [call("fs.read", { path: "src/example.ts" })]);
      if (++synthesis === 1) return completion("Still investigating");
      throw new Error("Temporary provider outage");
    });
    await expect(runReadOnlySubagent(input)).rejects.toThrow("Temporary provider outage");
    const previous = structuredClone(checkpoint!);
    expect(previous.reportReason).toBe("model context window requires compaction");
    vi.mocked(streamWithProvider).mockResolvedValue(completion());
    const report = await runReadOnlySubagent({ ...input, checkpoint, run: { ...input.run, attempt: 2 } });
    expect(report).toBe(REPORT);
    expect(vi.mocked(streamWithProvider).mock.calls.at(-1)![0].messages).toEqual(previous.messages);
    expect(vi.mocked(streamWithProvider).mock.calls.at(-1)![0].toolChoice).toBe("auto");
  });

  it("continues an explicitly restarted completed report from its retained evidence", async () => {
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion()).mockResolvedValueOnce(completion());
    await runReadOnlySubagent(input);
    const previous = structuredClone(checkpoint!);
    await expect(runReadOnlySubagent({ ...input, checkpoint, run: { ...input.run, attempt: 2 } })).resolves.toBe(REPORT);
    const resumed = vi.mocked(streamWithProvider).mock.calls[1]![0];
    expect(resumed.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
    expect(resumed.messages.at(-1)?.content).toContain("parent explicitly restarted");
    expect(resumed.toolChoice).toBe("auto");
    expect(checkpoint?.finished).toBe(true);
  });

  it("appends a completed child's follow-up without changing its cached prefix", async () => {
    vi.mocked(streamWithProvider).mockResolvedValue(completion());
    await runReadOnlySubagent(input);
    const previous = structuredClone(checkpoint!);
    const followup = { prompt: "Inspect only the answer consumer", context: "Do not repeat the export investigation" };
    await runReadOnlySubagent({ ...input, checkpoint: previous, followup, run: { ...input.run, attempt: 2, followup } });
    const resumed = vi.mocked(streamWithProvider).mock.calls[1]![0];
    expect(resumed.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
    expect(resumed.messages.at(-1)!.content).toContain(JSON.stringify(followup));
    expect(checkpoint?.pendingFollowup).toBeUndefined();
  });

  it("retains pending follow-ups across cancellation and inserts them after native tool results", async () => {
    const stop = new AbortController();
    const followup = { prompt: "Check the documented answer contract next" };
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion());
    await runReadOnlySubagent(input);
    const pendingCall = call("fs.read", { path: "src/example.ts" });
    const previous: SubagentCheckpoint = {
      messages: [...checkpoint!.messages.slice(0, 2), { role: "assistant", content: "", toolCalls: [pendingCall] }],
      nativeTools: true, pending: { calls: [pendingCall], native: true, next: 0 },
      pendingFollowup: followup,
    };
    vi.mocked(runToolCall).mockImplementationOnce(async () => {
      stop.abort(new Error("Interrupted follow-up"));
      return { ok: true, output: "discarded" };
    });
    await expect(runReadOnlySubagent({ ...input, checkpoint: previous, signal: stop.signal })).rejects.toThrow("Interrupted follow-up");
    expect(checkpoint?.pendingFollowup).toEqual(followup);
    expect(checkpoint?.pending?.next).toBe(0);
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion());
    await runReadOnlySubagent({ ...input, checkpoint, run: { ...input.run, attempt: 2, followup } });
    const resumed = vi.mocked(streamWithProvider).mock.calls.at(-1)![0];
    expect(resumed.messages[3]).toMatchObject({ role: "tool", toolCallId: pendingCall.id });
    expect(resumed.messages[4]).toMatchObject({ role: "user", content: expect.stringContaining(followup.prompt) });
    expect(checkpoint?.pendingFollowup).toBeUndefined();
  });

  it("restores durable follow-up instructions separately from untrusted history", async () => {
    const followup = { prompt: "Verify the consumer", context: "Use the previous export findings" };
    vi.mocked(streamWithProvider).mockResolvedValue(completion());
    await runReadOnlySubagent({ ...input, run: { ...input.run, attempt: 3, followup, events: [
      { kind: "tool", text: "prior evidence", sequence: 1, timestamp: 1 },
    ] } });
    const messages = vi.mocked(streamWithProvider).mock.calls[0]![0].messages;
    expect(messages[2]!.content).toContain("untrusted prior-attempt history");
    expect(messages[3]!.content).toContain(JSON.stringify(followup));
  });

  it("keeps the queued follow-up goal when a later attempt only updates context", async () => {
    vi.mocked(streamWithProvider).mockResolvedValue(completion());
    await runReadOnlySubagent(input);
    const followup = { prompt: "Inspect the consumer", context: "The consumer moved to routes.ts" };
    await runReadOnlySubagent({
      ...input,
      checkpoint: { ...checkpoint!, pendingFollowup: { context: followup.context } },
      run: { ...input.run, attempt: 4, followup },
    });
    const messages = vi.mocked(streamWithProvider).mock.calls.at(-1)![0].messages;
    expect(messages.at(-1)!.content).toContain(JSON.stringify(followup));
  });

  it("does not splice interrupted provider output into an exact stopped-attempt resume", async () => {
    const stop = new AbortController();
    let dispatch!: () => void;
    let release!: (result: CompletionResult) => void;
    const started = new Promise<void>((resolve) => { dispatch = resolve; });
    const provider = new Promise<CompletionResult>((resolve) => { release = resolve; });
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion("", [call("fs.read", { path: "src/example.ts" })]))
      .mockImplementationOnce(async (_request, onToken) => {
        onToken("unfinished provider response");
        dispatch();
        return provider;
      }).mockResolvedValueOnce(completion());
    const pending = runReadOnlySubagent({ ...input, signal: stop.signal });
    const assertion = expect(pending).rejects.toThrow("stop requested");
    await started;
    const previous = structuredClone(checkpoint!);
    stop.abort(new Error("stop requested"));
    release(completion());
    await assertion;
    expect(checkpoint).toEqual(previous);
    expect(checkpoint?.finished).not.toBe(true);
    await expect(runReadOnlySubagent({ ...input, checkpoint, run: { ...input.run, attempt: 2 } })).resolves.toBe(REPORT);
    expect(vi.mocked(streamWithProvider).mock.calls[2]![0].messages).toEqual(previous.messages);
    expect(JSON.stringify(previous.messages)).not.toContain("unfinished provider response");
    expect(runToolCall).toHaveBeenCalledOnce();
  });

  it("resumes from stored summary metadata when activity history is unavailable", async () => {
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion());
    await runReadOnlySubagent({ ...input, run: { ...input.run, attempt: 2, events: [],
      lastKnownSummary: { attempt: 1, status: "completed", report: REPORT } } });
    const messages = vi.mocked(streamWithProvider).mock.calls[0]![0].messages;
    expect(messages[2]!.content).toContain("Stored summary from attempt 1 (completed)");
    expect(messages[2]!.content).toContain("src/example.ts:1");
    expect(runToolCall).not.toHaveBeenCalled();
  });

  it("retains available untrusted history within the provider context when an exact checkpoint is unavailable", async () => {
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion()).mockResolvedValueOnce(completion());
    await runReadOnlySubagent(input);
    const initial = vi.mocked(streamWithProvider).mock.calls[0]![0];
    const events = Array.from({ length: 12 }, (_, index) => ({
      sequence: index, kind: "tool" as const, timestamp: 1, text: `prior evidence ${index} ${"x".repeat(4000)}`,
    }));
    await runReadOnlySubagent({ ...input, run: { ...input.run, attempt: 2, recovery: "history", events } });
    const resumed = vi.mocked(streamWithProvider).mock.calls[1]![0];
    expect(resumed.messages.slice(0, 2)).toEqual(initial.messages);
    const history = resumed.messages[2]!.content;
    expect(history).toContain("untrusted prior-attempt history");
    expect(history).toContain("not an exact execution checkpoint");
    expect(history).toContain("prior evidence 11");
    expect(history).toContain("prior evidence 0 ");
    expect(history.length).toBeGreaterThan(24_000);
    expect(estimateMessagesTokens(resumed.messages) + estimateToolSchemaTokens(resumed.tools) + resumed.maxTokens!).toBeLessThan(128_000);
    expect(resumed.tools).toEqual(initial.tools);
  });

  it("ignores assistant deltas arriving after the response settled", async () => {
    let lateDelta!: (text: string) => void;
    let lateStatus!: (text: string) => void;
    vi.mocked(streamWithProvider).mockImplementation(async (_request, onToken, options) => {
      lateDelta = onToken;
      lateStatus = options!.onStatus!;
      return completion();
    });
    await runReadOnlySubagent(input);
    vi.mocked(input.emit).mockClear();
    lateDelta("late provider progress");
    lateStatus("late provider status");
    expect(input.emit).not.toHaveBeenCalled();
  });

  it("uses the provider context window beyond the former research cap", async () => {
    vi.mocked(modelContextWindow).mockReturnValue(1_048_576);
    vi.mocked(modelMaxOutputTokens).mockReturnValue(32_768);
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion());
    await expect(runReadOnlySubagent({
      ...input,
      checkpoint: { nativeTools: true, messages: [
        { role: "system", content: "Research the assigned export contract." },
        { role: "user", content: input.run.prompt },
        { role: "user", content: `Retained evidence: ${"x".repeat(300_000)}` },
      ] },
    })).resolves.toBe(REPORT);
    const request = vi.mocked(streamWithProvider).mock.calls[0]![0];
    expect(estimateMessagesTokens(request.messages)).toBeGreaterThan(65_536);
    expect(isCompacting(request)).toBe(false);
    expect(request.maxTokens).toBe(32_768);
    expect(request.messages.at(-1)!.content).toContain("Retained evidence:");
  });

  it.each([2048, 32_768, undefined])("respects provider output limits without a 4096-token cap: %s", async (outputLimit) => {
    vi.mocked(modelMaxOutputTokens).mockReturnValue(outputLimit);
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion());
    await runReadOnlySubagent(input);
    const request = vi.mocked(streamWithProvider).mock.calls[0]![0];
    expect(request.maxTokens).toBe(outputLimit ?? 24_576);
    expect(estimateMessagesTokens(request.messages) + estimateToolSchemaTokens(request.tools) + request.maxTokens!).toBeLessThan(128_000);
  });

  it.each(["stop", "length", "tool_calls"] as const)("admits compaction after a response consumes its output allowance: %s", async (finishReason) => {
    const contextLimit = 16_384;
    vi.mocked(modelContextWindow).mockReturnValue(contextLimit);
    vi.mocked(modelMaxOutputTokens).mockReturnValue(32_768);
    const partial = REPORT.replace("Status: complete", "Status: partial");
    vi.mocked(streamWithProvider).mockImplementationOnce(async (request) => ({
      ...completion("x".repeat(Math.floor(request.maxTokens! * 3.3)), finishReason === "tool_calls" ? [call("fs.read", { path: "src/example.ts" })] : undefined),
      finishReason,
    })).mockResolvedValueOnce(completion(partial)).mockResolvedValueOnce(completion());
    await expect(runReadOnlySubagent(input)).resolves.toBe(REPORT);
    const requests = vi.mocked(streamWithProvider).mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(3);
    expect(isCompacting(requests[0]!)).toBe(false);
    expect(isCompacting(requests[1]!)).toBe(true);
    expect(isCompacting(requests[2]!)).toBe(false);
    expect(requests[2]!.messages[2]!.content).toContain(partial);
    expect(checkpoint?.finished).toBe(true);
    for (const request of requests) {
      expect(request.maxTokens).toBeGreaterThan(0);
      expect(estimateMessagesTokens(request.messages) + estimateToolSchemaTokens(request.tools) + request.maxTokens!).toBeLessThan(contextLimit);
    }
  });

  it("keeps streamed compaction and spontaneous partial reports internal", async () => {
    vi.mocked(modelContextWindow).mockReturnValue(16_384);
    vi.mocked(runToolCall).mockResolvedValue({ ok: true, output: "x".repeat(12_000) });
    const partial = REPORT.replace("Status: complete", "Status: partial");
    let compacted = false;
    let round = 0;
    vi.mocked(streamWithProvider).mockImplementation(async (request, onToken) => {
      if (isCompacting(request)) {
        compacted = true;
        onToken(partial.slice(0, 10));
        onToken(partial.slice(10));
        return completion(partial);
      }
      if (compacted) {
        onToken(REPORT);
        return completion();
      }
      if (++round === 1) {
        onToken(partial);
        return completion(partial);
      }
      return completion("", [call("web.search", { query: `query ${round}` })]);
    });
    await expect(runReadOnlySubagent(input)).resolves.toBe(REPORT);
    expect(compacted).toBe(true);
    expect(vi.mocked(input.emit).mock.calls.filter(([event]) => event.kind === "assistant")).toEqual([
      [{ kind: "assistant", text: REPORT, append: false }],
    ]);
    const resumed = vi.mocked(streamWithProvider).mock.calls.at(-1)![0];
    expect(resumed.messages[2]!.content).toContain(partial);
    expect(input.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "notice", text: expect.stringContaining("continuing the assignment") }));
  });

  it("keeps checkpoint-shaped text internal even when the response also calls tools", async () => {
    const partial = REPORT.replace("Status: complete", "Status: partial");
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion(partial, [call("fs.read", { path: "src/example.ts" })]))
      .mockResolvedValueOnce(completion());
    await expect(runReadOnlySubagent(input)).resolves.toBe(REPORT);
    expect(runToolCall).toHaveBeenCalledOnce();
    expect(vi.mocked(input.emit).mock.calls.filter(([event]) => event.kind === "assistant")).toEqual([
      [{ kind: "assistant", text: REPORT, append: false }],
    ]);
  });

  it("recompacts an oversized checkpoint without retaining the context it replaces", async () => {
    vi.mocked(modelContextWindow).mockReturnValue(8192);
    const partial = REPORT.replace("Status: complete", "Status: partial");
    const oversized = `${partial}\n${"Retained finding. ".repeat(800)}`;
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion(oversized))
      .mockResolvedValueOnce(completion(partial)).mockResolvedValueOnce(completion());
    await expect(runReadOnlySubagent({ ...input, checkpoint: {
      nativeTools: true,
      messages: [
        { role: "system", content: "Complete the assigned research." },
        { role: "user", content: input.run.prompt },
        { role: "user", content: `Original research: ${"x".repeat(12_500)}` },
      ],
    } })).resolves.toBe(REPORT);
    const requests = vi.mocked(streamWithProvider).mock.calls.map(([request]) => request);
    expect(requests).toHaveLength(3);
    expect(isCompacting(requests[0]!)).toBe(true);
    expect(isCompacting(requests[1]!)).toBe(true);
    expect(requests[1]!.messages[2]!.content).toContain(oversized);
    expect(requests[1]!.messages.some((message) => message.content.includes("Original research:"))).toBe(false);
    expect(requests[2]!.messages[2]!.content).toContain(partial);
    for (const request of requests) {
      expect(estimateMessagesTokens(request.messages) + estimateToolSchemaTokens(request.tools) + request.maxTokens!).toBeLessThan(8192);
    }
  });

  it("fits serialized recovery history into a small provider window", async () => {
    vi.mocked(modelContextWindow).mockReturnValue(8192);
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion());
    const events = Array.from({ length: 12 }, (_, index) => ({
      sequence: index, kind: "tool" as const, timestamp: 1, text: `prior evidence ${index} ${'"\\\n'.repeat(10_000)}`,
    }));
    await expect(runReadOnlySubagent({ ...input, run: { ...input.run, attempt: 2, recovery: "history", events } })).resolves.toBe(REPORT);
    const request = vi.mocked(streamWithProvider).mock.calls[0]![0];
    expect(request.messages[2]!.content).toContain("prior evidence 11");
    expect(request.messages[2]!.content).not.toContain("prior evidence 0 ");
    expect(isCompacting(request)).toBe(false);
    expect(estimateMessagesTokens(request.messages) + estimateToolSchemaTokens(request.tools) + request.maxTokens!).toBeLessThan(8192);
  });

  it("accepts provider responses beyond the former text and artifact caps", async () => {
    const text = "Research progress. ".repeat(2000);
    const reasoningBlock = { text: "evidence ".repeat(10_000) };
    vi.mocked(streamWithProvider).mockImplementationOnce(async (_request, onToken) => {
      onToken(text);
      return { ...completion(text, [call("fs.read", { path: "src/example.ts" })]), reasoningBlock };
    }).mockResolvedValueOnce(completion());
    await expect(runReadOnlySubagent(input)).resolves.toBe(REPORT);
    expect(runToolCall).toHaveBeenCalledOnce();
    const request = vi.mocked(streamWithProvider).mock.calls[1]![0];
    expect(request.messages[2]).toMatchObject({ content: text, reasoningBlock });
  });

  it("returns a complete report beyond the former storage cap without forcing a rewrite", async () => {
    vi.mocked(modelMaxOutputTokens).mockReturnValue(32_768);
    const report = `${REPORT}\n${"Verified evidence. ".repeat(5000)}`;
    vi.mocked(streamWithProvider).mockResolvedValueOnce(completion(report));
    await expect(runReadOnlySubagent(input)).resolves.toBe(report);
    expect(streamWithProvider).toHaveBeenCalledOnce();
    expect(checkpoint?.finished).toBe(true);
    expect(input.emit).toHaveBeenCalledWith({ kind: "assistant", text: report, append: false });
  });

  it.each([true, false])("bounds unsafe provider output without publishing it: streamed=%s", async (streamed) => {
    const text = "x".repeat(4 * 1024 * 1024 + 1);
    vi.mocked(streamWithProvider).mockImplementation(async (_request, onToken) => {
      if (streamed) onToken(text);
      return completion(text);
    });
    await expect(runReadOnlySubagent(input)).rejects.toThrow("transport safety limit");
    expect(checkpoint?.finished).not.toBe(true);
    expect(checkpoint?.messages).toHaveLength(2);
    expect(vi.mocked(input.emit).mock.calls.filter(([event]) => event.kind === "assistant")).toHaveLength(0);
  });

  it("preserves report text at the inclusive byte-safety boundary", async () => {
    const text = REPORT + "x".repeat(4 * 1024 * 1024 - Buffer.byteLength(REPORT));
    vi.mocked(streamWithProvider).mockImplementationOnce(async (_request, onToken) => {
      onToken(text);
      return completion(text);
    });
    await expect(runReadOnlySubagent(input)).resolves.toBe(text);
    expect(input.emit).toHaveBeenCalledWith({ kind: "assistant", text, append: false });
    expect(checkpoint?.finished).toBe(true);
  });

});
