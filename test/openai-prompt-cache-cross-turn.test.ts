import { describe, expect, it } from "vitest";
import { composeTurnMessages } from "../src/agent/turn/setup/turn-messages.js";
import { buildTurnHistory } from "../src/agent/tool-call-parser.js";
import { buildChatBody } from "../src/llm/http.js";
import { buildResponsesBody } from "../src/llm/responses-request.js";
import { META_STREAM_TERMINAL } from "../src/llm/stream-terminal.js";
import { withSessionAffinity } from "../src/llm/session-affinity.js";
import type { ChatMessage } from "../src/types.js";

describe("OpenAI-compatible wire prefixes across completed revisions", () => {
  it.each(["openrouter", "fireworks", "openai", "responses"] as const)(
    "%s preserves the complete previous request after turn finalization",
    async (dialect) => {
      await withSessionAffinity("session-cross-turn-wire", async () => {
        let history: ChatMessage[] | undefined;
        let previous: unknown[] | undefined;
        let affinity: unknown;
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
            stableSystemContent: () => "SYSTEM CONSTITUTION\nStable rules",
            instructionsBlock: undefined,
            skillsBlock: undefined,
            plan: undefined,
            planApproved: false,
          });
          const id = `call-${turn}`;
          messages.push(
            { role: "assistant", content: `inspect ${turn}`, toolCalls: [{
              id, name: "fs.read", args: { path: `${turn}.ts` },
            }] },
            { role: "tool", toolCallId: id, name: "fs.read", content: `result ${turn}`, ok: true },
          );
          const before = structuredClone(messages);
          const options = { model: "gpt-5", messages, stream: true };
          const payload = JSON.parse(dialect === "responses"
            ? buildResponsesBody({
                providerId: "openai",
                baseUrl: "https://api.openai.com/v1",
                displayName: "OpenAI",
                artifactDialect: "openai-compatible",
                terminalPolicy: META_STREAM_TERMINAL,
                buildHeaders: () => ({}),
                reasoningPayload: () => undefined,
                bodyExtras: () => ({}),
              }, options)
            : buildChatBody({ ...options, providerId: dialect }));
          const input: unknown[] = payload.input ?? payload.messages;
          if (previous) expect(input.slice(0, previous.length)).toEqual(previous);
          if (dialect !== "responses") {
            const key = payload.session_id ?? payload.prompt_cache_key;
            expect(key).toMatch(/^clai-[a-f0-9]{40}$/);
            if (turn > 1) expect(key).toBe(affinity);
            affinity = key;
          }
          for (let revision = 1; revision <= turn; revision += 1) {
            expect(JSON.stringify(input)).toContain(`result ${revision}`);
            expect(JSON.stringify(input)).toContain(`revision ${revision}`);
          }
          expect(messages).toEqual(before);
          previous = input;
          history = buildTurnHistory(messages, `completed revision ${turn}`);
          await Promise.resolve();
        }
      });
    },
  );
});
