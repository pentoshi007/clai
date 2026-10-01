import { afterEach, describe, expect, it, vi } from "vitest";
import { composeTurnMessages } from "../src/agent/turn/setup/turn-messages.js";
import { buildTurnHistory } from "../src/agent/tool-call-parser.js";
import { omnirushProvider } from "../src/llm/omnirush.js";
import { sessionCacheAffinityKey } from "../src/llm/cache-affinity.js";
import { withSessionAffinity } from "../src/llm/session-affinity.js";
import type { ChatMessage, CompletionRequest, ToolDefinition } from "../src/types.js";

interface WireBody {
  instructions?: string;
  input: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  prompt_cache_key?: string;
  store: boolean;
  stream: boolean;
}

const auth = { apiKey: "omnirush-cache-test", refreshToken: "test-refresh-token" };
const constitution = "Stable constitution. Follow the latest project instructions and request context.";
const tools: ToolDefinition[] = [{
  name: "fs.read",
  wireName: "fs_read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
}];

function captureRequests(): WireBody[] {
  const bodies: WireBody[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as WireBody);
    return new Response(`data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_cache_test",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
        usage: { input_tokens: 2048, output_tokens: 1, input_tokens_details: { cached_tokens: 1920 } },
      },
    })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  }));
  return bodies;
}

async function send(messages: ChatMessage[], stream = true, purpose?: CompletionRequest["purpose"]): Promise<void> {
  const request: CompletionRequest = {
    provider: "omnirush", model: "gpt-6-astra", messages, tools, purpose,
  };
  const result = stream
    ? await omnirushProvider.stream!(request, auth, () => {})
    : await omnirushProvider.complete(request, auth);
  expect(result.text).toBe("done");
  expect(result.usage?.cachedPromptTokens).toBe(1920);
}

afterEach(() => vi.unstubAllGlobals());

describe("Omnirush prompt cache continuity", () => {
  it.each([true, false])("keeps the complete wire prefix across state updates and turns (stream=%s)", async (stream) => {
    const bodies = captureRequests();
    let history: ChatMessage[] | undefined;
    let previous: WireBody | undefined;
    await withSessionAffinity("omnirush-prefix-session", async () => {
      for (let turn = 1; turn <= 3; turn += 1) {
        const { messages } = composeTurnMessages({
          prompt: `revision ${turn}`,
          displayPrompt: undefined,
          images: undefined,
          history,
          mode: "agent",
          systemSections: [`OUTCOME CONTRACT\nComplete revision ${turn}`],
          selectedSkillNames: [],
          nativeToolsActive: true,
          inputTokenBudget: undefined,
          stableSystemContent: () => constitution,
          instructionsBlock: `PROJECT INSTRUCTIONS\nInstruction revision ${turn}`,
          skillsBlock: undefined,
          plan: undefined,
          planApproved: false,
        });
        for (let step = 1; step <= 2; step += 1) {
          const id = `call-${turn}-${step}`;
          messages.push(
            { role: "assistant", content: "inspect", toolCalls: [{ id, name: "fs.read", args: { path: "file.ts" } }] },
            { role: "tool", toolCallId: id, name: "fs.read", content: `result ${turn}/${step}`, ok: true },
            { role: "system", content: `ACTIVE PLAN\nturn ${turn} step ${step} complete` },
          );
          const snapshot = structuredClone(messages);
          await send(messages, stream);
          const current = bodies.at(-1)!;
          expect(current.instructions).toBeUndefined();
          expect(current.prompt_cache_key).toBe(sessionCacheAffinityKey("omnirush-prefix-session"));
          expect(current.store).toBe(false);
          expect(current.stream).toBe(true);
          if (previous) {
            expect(current.input.slice(0, previous.input.length)).toEqual(previous.input);
            expect(current.tools).toEqual(previous.tools);
            expect(current.instructions).toBe(previous.instructions);
          }
          expect(current.input.at(-1)).toEqual({
            type: "message", role: "developer",
            content: [{ type: "input_text", text: `ACTIVE PLAN\nturn ${turn} step ${step} complete` }],
          });
          expect(JSON.stringify(current.input)).toContain(`Instruction revision ${turn}`);
          expect(messages).toEqual(snapshot);
          previous = current;
        }
        history = buildTurnHistory(messages, `completed revision ${turn}`);
      }
    });
    expect(bodies).toHaveLength(6);
  });

  it("preserves the image, tool schema, exact tool arguments, and result order", async () => {
    const bodies = captureRequests();
    const image = { mediaType: "image/png", dataBase64: "aW1hZ2U=" };
    const messages: ChatMessage[] = [
      { role: "system", content: constitution },
      { role: "user", content: "inspect image", images: [image] },
      { role: "assistant", content: "", toolCalls: [{
        id: "call-image", name: "fs.read", args: { path: "x.ts" }, rawArguments: '{ "path" : "x.ts" }',
      }] },
      { role: "tool", toolCallId: "call-image", name: "fs.read", content: "exact result" },
      { role: "system", content: "REQUEST CONTEXT\nnew state" },
    ];
    const snapshot = structuredClone(messages);
    await send(messages);
    expect(bodies[0]?.input).toEqual([
      { type: "message", role: "developer", content: [{ type: "input_text", text: constitution }] },
      { type: "message", role: "user", content: [
        { type: "input_text", text: "inspect image" },
        { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=", detail: "high" },
      ] },
      { type: "function_call", call_id: "call-image", name: "fs_read", arguments: '{ "path" : "x.ts" }' },
      { type: "function_call_output", call_id: "call-image", output: "exact result" },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "REQUEST CONTEXT\nnew state" }] },
    ]);
    expect(bodies[0]?.tools?.[0]).toEqual({ type: "function", name: "fs_read", description: tools[0]!.description, parameters: tools[0]!.parameters });
    expect(messages).toEqual(snapshot);
  });

  it("keeps affinity stable through compaction and isolates sessions, children, and auxiliary calls", async () => {
    const bodies = captureRequests();
    const messages: ChatMessage[] = [{ role: "system", content: constitution }, { role: "user", content: "first request" }];
    await withSessionAffinity("parent", async () => {
      await send(messages);
      await send([{ role: "system", content: constitution }, { role: "user", content: "compacted summary" }], false, "compaction");
      await send(messages, false, "auxiliary");
      await withSessionAffinity("parent:subagent:child", () => send(messages));
      await send(messages);
    });
    await withSessionAffinity("other", () => send(messages));
    const keys = bodies.map((body) => body.prompt_cache_key);
    expect(keys[0]).toMatch(/^clai-[a-f0-9]{40}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[4]).toBe(keys[0]);
    expect(new Set([keys[0], keys[2], keys[3], keys[5]]).size).toBe(4);
  });

  it("derives deterministic fallback affinity without rewriting the opening message", async () => {
    const bodies = captureRequests();
    const messages: ChatMessage[] = [{ role: "system", content: constitution }, { role: "user", content: "opening" }];
    await send(messages);
    await send([...messages, { role: "assistant", content: "reply" }, { role: "user", content: "follow up" }]);
    expect(bodies[0]?.prompt_cache_key).toMatch(/^clai-[a-f0-9]{40}$/);
    expect(bodies[1]?.prompt_cache_key).toBe(bodies[0]?.prompt_cache_key);
  });

  it("does not hoist a later system message when there is no leading system message", async () => {
    const bodies = captureRequests();
    await send([{ role: "user", content: "opening" }, { role: "system", content: "later instruction" }]);
    expect(bodies[0]?.instructions).toBeUndefined();
    expect(bodies[0]?.input).toHaveLength(2);
    expect(bodies[0]?.input[1]).toMatchObject({ role: "developer", content: [{ type: "input_text", text: "later instruction" }] });
  });
});
