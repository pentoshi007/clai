import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentTurn } from "../../src/agent/runner.js";
import { createSessionPolicy } from "../../src/agent/session-policy.js";
import { renderUserCredentials } from "../../src/agent/context/user-credentials.js";
import { InteractiveSessionManager } from "../../src/interactive-session/manager.js";
import { RecoveryJournal } from "../../src/interactive-session/recovery-journal.js";
import { SessionTelemetry } from "../../src/interactive-session/telemetry.js";
import { createInteractiveSessionHandlers } from "../../src/tools/interactive-session-tools.js";
import { toolRegistry } from "../../src/tools/registry.js";
import { FakeTransportFactory } from "../interactive-session/helpers.js";
import type { ChatMessage, CompletionRequest, CompletionResult, ToolCall, ToolResult } from "../../src/types.js";

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
  vi.restoreAllMocks();
  dispatch.mockReset();
});

describe("agent utilization of user-provided terminal secrets", () => {
  it.each(["native", "text"] as const)("carries user history through the real %s dispatch without asking again", async (toolCalling) => {
    const previousCwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "clai-secret-dispatch-"));
    mkdirSync(join(dir, ".clai"));
    const factory = new FakeTransportFactory({ ptyAvailable: true });
    const manager = new InteractiveSessionManager({
      artifactBaseDir: join(dir, "artifacts"), transports: factory,
      journal: new RecoveryJournal(join(dir, "journal")), telemetry: new SessionTelemetry(async () => undefined),
    });
    const ownerId = `secret-dispatch-${toolCalling}`;
    try {
      process.chdir(dir);
      const started = await manager.start({ ownerId, command: "repl", confirm: async () => true });
      const handler = createInteractiveSessionHandlers(manager)["terminal.send"];
      vi.spyOn(toolRegistry, "terminal.send").mockImplementation(handler);
      const calls: ToolCall[] = [];
      const results: ToolResult[] = [];
      const requests: CompletionRequest[] = [];
      const value = "retained-agent-fixture";
      const history: ChatMessage[] = toolCalling === "native" ? [
        { role: "user", content: `host: localhost\npassword: ${value}` },
        { role: "assistant", content: "The owned session is awaiting authentication." },
      ] : [
        { role: "system", content: ["DURABLE WORK ENVELOPE (canonical)", ...renderUserCredentials([`password: ${value}`])].join("\n") },
      ];
      dispatch.mockImplementation(async (request: CompletionRequest, onToken: (token: string) => void): Promise<CompletionResult> => {
        requests.push(request);
        if (requests.length === 1) {
          const call = { name: "terminal.send", args: { id: started.sessionId, kind: "secret", secretSource: "user", quietMs: 25 } };
          if (toolCalling === "native") return {
            text: "", provider: "openai", model: "gpt-4o-mini", finishReason: "tool_calls",
            toolCalls: [{ id: "send-password", ...call }],
          };
          const text = `\`\`\`tool\n${JSON.stringify(call)}\n\`\`\``;
          onToken(text);
          return { text, provider: "openai", model: "gpt-4o-mini", finishReason: "stop" };
        }
        onToken("Secret delivery verified.");
        return { text: "Secret delivery verified.", provider: "openai", model: "gpt-4o-mini", finishReason: "stop" };
      });
      const requestSecret = vi.fn(async () => { throw new Error("Unexpected masked input request"); });
      await runAgentTurn("Use the supplied password in the owned terminal session once.", {
        session: createSessionPolicy(ownerId), history, provider: "openai", model: "gpt-4o-mini",
        mode: "agent", toolCalling, autoConfirm: true, maxSteps: 3, requestSecret,
        onToolStart: (call) => calls.push(call), onToolResult: (_call, result) => results.push(result),
      });
      expect(requestSecret).not.toHaveBeenCalled();
      expect(factory.last().writes).toEqual([`${value}\r`]);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args.secretSource).toBe("user");
      expect(results[0]?.ok).toBe(true);
      expect(results[0]?.output).toContain("delivery=delivered");
      expect(JSON.stringify({ calls, results })).not.toContain(value);
      if (toolCalling === "native") {
        const send = requests[0]?.tools?.find((tool) => tool.name === "terminal.send");
        expect(send?.parameters.properties).toHaveProperty("secretSource");
      } else {
        expect(requests[0]?.messages[0]?.content).toContain('"secretSource":"<auto|user|prompt>"');
      }
    } finally {
      await manager.closeAll();
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
