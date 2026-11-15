import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentTurn } from "../../src/agent/runner.js";
import { createSessionPolicy } from "../../src/agent/session-policy.js";
import { agentrouterProvider } from "../../src/llm/agentrouter.js";
import { buildCustomProvider, type CustomProviderDef } from "../../src/llm/custom-providers.js";
import { resetResponsesWireStatesForTesting } from "../../src/llm/wire/responses-first.js";
import { getConfig, updateConfig } from "../../src/store/config.js";
import type { ChatMessage, CompletionRequest, ProviderId } from "../../src/types.js";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("../../src/llm/router.js", async (importActual) => ({
  ...await importActual<typeof import("../../src/llm/router.js")>(),
  streamWithProvider: (request: CompletionRequest, onToken: (token: string) => void) => dispatch(request, onToken),
}));
vi.mock("../../src/commands/providers.js", async (importActual) => ({
  ...await importActual<typeof import("../../src/commands/providers.js")>(),
  ensureProviderConfigured: async () => undefined,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  resetResponsesWireStatesForTesting();
});

describe("compatible provider revisions through the agent runner", () => {
  it.each([
    ["agentrouter", "ask"],
    ["agentrouter-responses", "ask"],
    ["custom:chat", "ask"],
    ["custom:responses", "ask"],
    ["custom:auto", "ask"],
    ["custom:auto-none", "ask"],
    ["custom:auto-default", "ask"],
    ["agentrouter", "agent"],
    ["custom:chat", "agent"],
  ] as const)("%s in %s mode keeps sent history across revisions separated by four-minute pauses", async (id, mode) => {
    const providerId = id.startsWith("agentrouter") ? "agentrouter" : id;
    const model = id === "agentrouter-responses" ? "gpt-5.1" : "claude-opus-4-6";
    const cwd = process.cwd();
    const root = mkdtempSync(join(tmpdir(), "clai-cache-revision-"));
    mkdirSync(join(root, ".clai"));
    process.chdir(root);
    const customProviders = getConfig().customProviders;
    const definition: CustomProviderDef = {
      id, displayName: "Future gateway", baseUrl: "https://gateway.invalid/v1",
      defaultModel: "claude-opus-4-6",
      ...(id === "custom:responses" ? { api: "responses" as const } : id === "custom:chat" ? { api: "chat-completions" as const } : {}),
      ...(id === "custom:auto-default" ? {} : {
        profile: { cache: id === "custom:auto-none"
          ? { kind: "none-documented" as const }
          : { kind: "affinity-key" as const, affinityField: "conversation_key", isolationField: "isolation_key" } },
      }),
    };
    if (providerId !== "agentrouter") updateConfig({ customProviders: [definition] });
    const provider = providerId === "agentrouter" ? agentrouterProvider : buildCustomProvider(definition);
    const bodies: Array<{ messages?: unknown[]; input?: unknown[]; tools: unknown[]; conversation_key?: string; isolation_key?: string; prompt_cache_key?: string }> = [];
    const affinities: string[] = [];
    const probes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const responses = String(url).endsWith("/responses");
      if (responses && id === "agentrouter") return new Response('{"error":{"message":"not found"}}', { status: 404 });
      if (body.stream) {
        const headers = new Headers(init.headers);
        const affinity = headers.get("x-session-affinity") ?? "";
        if (headers.get("x-clai-session") === `cache-${id}`) {
          bodies.push(body);
          affinities.push(affinity);
        } else {
          probes.push(affinity);
        }
      }
      if (responses) {
        const response = { id: "resp-test", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Here is the explanation." }] }] };
        if (!body.stream) return Response.json(response);
        const events = [{ type: "response.output_text.delta", delta: "Here is the explanation." }, { type: "response.completed", response }];
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      }
      const delta = { choices: [{ index: 0, delta: { content: "Here is the explanation." }, finish_reason: "stop" }] };
      return new Response(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }));
    dispatch.mockImplementation((request: CompletionRequest, onToken: (token: string) => void) =>
      provider.stream(request, { apiKey: "sk-test-key-only" }, onToken));
    const realNow = Date.now.bind(Date);
    let pauseOffset = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + pauseOffset);
    try {
      const session = createSessionPolicy(`cache-${id}`);
      let history: ChatMessage[] = [];
      for (let turn = 1; turn <= 3; turn += 1) {
        writeFileSync(join(root, ".clai", "CLAI.md"), `Instruction revision ${turn}: explain clearly.\n`);
        const prompt = mode === "agent"
          ? `Revise the TCP explanation, revision ${turn}. Return the revised prose without using tools.`
          : `Explain TCP revision ${turn}`;
        const result = await runAgentTurn(prompt, {
          session, history, provider: providerId as ProviderId, model,
          mode, maxSteps: 2, toolCalling: "native",
          onMessages: (messages) => { history = messages; },
        });
        expect(result.answer).toBe("Here is the explanation.");
        expect(history.at(-1)).toMatchObject({ role: "assistant", content: result.answer });
        if (turn < 3) pauseOffset += 4 * 60 * 1_000;
      }
      expect(bodies).toHaveLength(3);
      const timeline = (body: typeof bodies[number]) => body.messages ?? body.input!;
      for (let i = 1; i < bodies.length; i += 1) {
        expect(Boolean(bodies[i]!.input)).toBe(Boolean(bodies[i - 1]!.input));
        expect(timeline(bodies[i]!).slice(0, timeline(bodies[i - 1]!).length)).toEqual(timeline(bodies[i - 1]!));
        expect(bodies[i]!.tools).toEqual(bodies[i - 1]!.tools);
      }
      expect(affinities[0]).toMatch(/^clai-[a-f0-9]{40}$/);
      expect(new Set(affinities).size).toBe(1);
      if (id.startsWith("custom:auto") || id === "agentrouter-responses") {
        expect(probes).toHaveLength(1);
        expect(probes[0]).not.toBe(affinities[0]);
      }
      if (providerId !== "agentrouter") for (const body of bodies) {
        if (id === "custom:auto-none" || id === "custom:auto-default") {
          expect(body).not.toHaveProperty("conversation_key");
          expect(body).not.toHaveProperty("isolation_key");
        } else {
          expect(body.conversation_key).toBe(affinities[0]);
          expect(body.isolation_key).toBe(body.conversation_key);
        }
        if (id === "custom:auto-default") expect(body.prompt_cache_key).toBe(affinities[0]);
        else expect(body).not.toHaveProperty("prompt_cache_key");
      }
      if (id === "agentrouter-responses") for (const body of bodies) {
        expect(body.prompt_cache_key).toBe(affinities[0]);
      }
      expect(JSON.stringify(bodies[2])).toContain("Instruction revision 1");
      expect(JSON.stringify(bodies[2])).toContain("Instruction revision 3");
    } finally {
      nowSpy.mockRestore();
      updateConfig({ customProviders });
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
