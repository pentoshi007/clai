import { expect, it, vi } from "vitest";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import { createPromptProfiles } from "../../src/prompts/profile-state.js";
import { createToolRouting } from "../../src/agent/turn/tool-routing.js";
import type { SaveSessionOptions } from "../../src/app/ports/persistence-port.js";

vi.mock("../../src/llm/catalog-prefetch.js", () => ({ prefetchProviderCatalog: async () => {} }));

it("restores, persists and resets only profile metadata while corrupt loads preserve the active history", async () => {
  const saved: SaveSessionOptions[] = [];
  const controller = new SessionController({ sessionId: "profile-controller", emit: () => {}, agent: { runTurn: async () => { throw new Error("Network must not be called"); } },
    persistence: { saveSession: async (_messages, options) => { if (options) saved.push(options); }, loadPlan: async () => undefined, savePlan: async () => {}, deletePlan: async () => {} } });
  try {
    const state = createPromptProfiles();
    createToolRouting({ mode: "agent", mcpPresent: false, toolCalling: "native", useCompactSystemPrompt: () => false, promptProfiles: state }).buildStableSystemContent(true, "nvidia", "synthetic");
    const messages = [{ role: "user" as const, content: "Retain my full roadmap" }];
    controller.loadHistory(messages, { sessionId: "bound-profile", promptProfiles: state });
    expect(controller.promptProfiles).toEqual(state);
    await controller.persistNow();
    expect(saved.at(-1)?.promptProfiles).toEqual(state);
    expect(() => controller.loadHistory([{ role: "user", content: "Do not replace history" }], { promptProfiles: createPromptProfiles("unknown") })).toThrow("No replacement profile");
    expect(controller.messages).toEqual(messages);
    controller.loadHistory(messages, { sessionId: "ordinary-old-session" });
    expect(controller.promptProfiles).toBeUndefined();
  } finally { controller.dispose(); }
});
