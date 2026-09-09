import { afterEach, expect, it, vi } from "vitest";
import { appendAssistantWithTools, appendToolResult } from "../../src/agent/tool-history.js";
import { buildTurnHistory } from "../../src/agent/tool-call-parser.js";
import { assembleRequest } from "../../src/agent/turn/loop/request-assembly.js";
import { agentrouterProvider } from "../../src/llm/agentrouter.js";
import { resetResponsesWireStatesForTesting } from "../../src/llm/wire/responses-first.js";
import type { ChatMessage, ToolDefinition } from "../../src/types.js";
import { installTransport } from "../conformance/fake-transport.js";
import { buildWireResponse, jsonResponse } from "../conformance/wire-fixtures.js";

const tools: ToolDefinition[] = [{
  name: "fs.write",
  wireName: "fs_write",
  description: "Write a file",
  parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
}];

afterEach(() => {
  resetResponsesWireStatesForTesting();
  vi.unstubAllGlobals();
});

it("retains exact AgentRouter wire prefixes across the former rolling limit and a saved follow-up", async () => {
  const model = "glm-5.3";
  const transport = installTransport(({ url }) => url.endsWith("/responses")
    ? jsonResponse({ error: { message: "not found" } }, 404)
    : buildWireResponse("chat_completions", "complete", "answer", model));
  const messages: ChatMessage[] = [
    { role: "system", content: "Build the project." },
    { role: "user", content: "Implement the two files." },
  ];
  const dispatch = async (history: ChatMessage[]) => {
    const assembled = await assembleRequest({
      messages: history,
      provider: "agentrouter",
      model,
      dialect: "openai",
      nativeToolsActive: true,
      thinking: undefined,
      step: 1,
      contextLimitTokens: 300_000,
      estimateRequestTokens: () => 0,
      selectTools: () => tools,
      notify: () => {},
      emitContextEstimate: () => {},
      audit: async () => {},
    }, {
      freeTierConsecutiveFailures: 0,
      truncatedBudgetRounds: 0,
      continuationBudgetFloor: 0,
      retryWithoutThinking: false,
    });
    await agentrouterProvider.complete({
      model, messages: history, tools: assembled.tools, maxTokens: assembled.stepMaxTokens,
    }, { apiKey: "synthetic-key" });
  };
  const appendWrite = (id: string) => {
    appendAssistantWithTools(messages, "", [{
      id, name: "fs.write", args: { path: `${id}.ts`, content: id.repeat(70 * 1024) },
    }]);
    appendToolResult(messages, id, `${id}.ts written`, "fs.write", true);
  };
  appendWrite("aa");
  await dispatch(messages);
  appendWrite("bb");
  await dispatch(messages);
  const followUp: ChatMessage[] = [
    messages[0]!,
    ...buildTurnHistory(messages, "Both files are written."),
    { role: "user", content: "Continue verification." },
  ];
  await dispatch(followUp);

  const requests = transport.generations.filter(({ url }) => url.endsWith("/chat/completions"));
  expect(requests).toHaveLength(3);
  const bodies = requests.map(({ body }) => body as { messages: unknown[]; tools: unknown });
  expect(bodies[1]!.messages.slice(0, bodies[0]!.messages.length)).toEqual(bodies[0]!.messages);
  expect(bodies[2]!.messages.slice(0, bodies[1]!.messages.length)).toEqual(bodies[1]!.messages);
  expect(bodies.map((body) => body.tools)).toEqual([bodies[0]!.tools, bodies[0]!.tools, bodies[0]!.tools]);
  expect(JSON.stringify(bodies[1]!.messages)).toContain("aa".repeat(70 * 1024));
  expect(JSON.stringify(bodies[2]!.messages)).toContain("bb".repeat(70 * 1024));
});
