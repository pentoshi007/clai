import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleClear, handleNew } from "../src/ui-core/commands/session-commands.js";
import { handlePrompts } from "../src/ui-core/commands/prompt-commands.js";
import { createSavedPromptReader, SessionPromptStore } from "../src/store/session-prompts.js";
import * as sessionNaming from "../src/app/controllers/session-naming.js";
import { PromptHistory } from "../src/ui-core/composer/prompt-history.js";
import { bindSavedPromptHistory } from "../src/ui-core/composer/saved-prompt-history.js";
import {
  compactMessagesWithSummary,
  isCompactionMemoryMessage,
} from "../src/agent/context-manager.js";
import {
  createCompositionRoot,
  type AppServices,
} from "../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../src/ui-core/bootstrap/capabilities.js";
import { getSession, listSessions, upsertSession } from "../src/store/history.js";
import {
  bindSessionWorkspace,
  clearActiveSessionWorkspace,
  getActiveSessionWorkspace,
  mintSessionWorkspace,
  sessionWorkspaceRoot,
} from "../src/store/session-workspace.js";
import { createTurnOutcome, type TurnOutcome } from "../src/agent/turn-outcome.js";
import type {
  AgentPort,
  RunTurnHandlers,
  RunTurnRequest,
} from "../src/app/ports/agent-port.js";
import type { PersistencePort } from "../src/app/ports/persistence-port.js";
import type { SessionPlan } from "../src/types.js";

class SilentAgent implements AgentPort {
  async runTurn(_request: RunTurnRequest, _handlers: RunTurnHandlers): Promise<TurnOutcome> {
    return createTurnOutcome({
      status: "succeeded",
      answer: "",
      steps: 0,
      remainingCriteria: [],
    });
  }
}

const savedPlans = new Map<string, SessionPlan>();

const persistence: PersistencePort = {
  async saveSession() {},
  async loadPlan(sessionId: string) {
    return savedPlans.get(sessionId);
  },
  async savePlan(plan: SessionPlan) {
    savedPlans.set(plan.sessionId, plan);
  },
  async deletePlan(sessionId: string) {
    savedPlans.delete(sessionId);
  },
};

function makeServices(): AppServices {
  return createCompositionRoot({
    agent: new SilentAgent(),
    persistence,
    capabilities: detectCapabilities({
      env: {},
      stdoutIsTTY: true,
      stdinIsTTY: true,
      columns: 100,
      rows: 30,
    }),
  });
}

let services: AppServices;

beforeEach(() => {
  savedPlans.clear();
  vi.spyOn(sessionNaming, "completeForSessionNaming").mockResolvedValue("TITLE: Test session");
  services = makeServices();
});

afterEach(() => {
  services.dispose();
  clearActiveSessionWorkspace();
  vi.restoreAllMocks();
});

describe("/clear resets the session while retaining user prompts", () => {
  it("deletes the saved history record for the session it abandons", async () => {
    services.session.loadHistory([
      { role: "user", content: "remember this" },
      { role: "assistant", content: "noted" },
    ]);
    const abandoned = services.session.sessionId;
    await upsertSession(abandoned, [...services.session.messages], "clear purge subject");
    expect(await getSession(abandoned)).toBeDefined();

    await handleClear(services);

    expect(await getSession(abandoned)).toBeUndefined();
    expect(services.session.sessionId).not.toBe(abandoned);
    expect(services.session.messages).toHaveLength(0);
  });

  it("leaves no trace of the session in the history listing", async () => {
    services.session.loadHistory([{ role: "user", content: "listed once" }]);
    const abandoned = services.session.sessionId;
    await upsertSession(abandoned, [...services.session.messages], "clear purge listing");

    await handleClear(services);

    const remaining = await listSessions();
    expect(remaining.map((entry) => entry.id)).not.toContain(abandoned);
  });

  it("removes the session's artifact workspace", async () => {
    const workspace = bindSessionWorkspace(mintSessionWorkspace());
    mkdirSync(workspace.tempDir, { recursive: true });
    writeFileSync(join(workspace.tempDir, "output.txt"), "tool output");
    expect(existsSync(sessionWorkspaceRoot(workspace.folderName))).toBe(true);

    await handleClear(services);

    expect(existsSync(sessionWorkspaceRoot(workspace.folderName))).toBe(false);
  });

  it("binds a fresh workspace so the new session cannot write into the purged one", async () => {
    const before = bindSessionWorkspace(mintSessionWorkspace());

    await handleClear(services);

    const after = getActiveSessionWorkspace();
    expect(after?.folderName).toBeDefined();
    expect(after?.folderName).not.toBe(before.folderName);
  });

  it("drops the plan and its approval along with the session", async () => {
    const abandoned = services.session.sessionId;
    await persistence.savePlan({
      sessionId: abandoned,
      goal: "purge me",
      detail: "",
      tasks: [{ id: "t1", title: "step", state: "pending" }],
      status: "in_progress",
      kind: "testing",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    services.session.setPlanApproved(true);

    await handleClear(services);

    expect(services.session.isPlanApproved()).toBe(false);
    expect(services.plan.current()).toBeUndefined();
  });

  it("succeeds on a session that was never saved, without reporting a failure", async () => {
    const abandoned = services.session.sessionId;
    expect(await getSession(abandoned)).toBeUndefined();

    await handleClear(services);

    expect(services.session.sessionId).not.toBe(abandoned);
    const warnings = services.transcript
      .getState()
      .order.map((id) => services.transcript.getState().items[id])
      .filter((item) => item?.kind === "notice");
    expect(warnings).toHaveLength(0);
  });

  it("reports the clear immediately rather than after the delete finishes", async () => {
    services.session.loadHistory([{ role: "user", content: "hi" }]);
    const clearing = handleClear(services);
    expect(
      services.toast.getToasts().some((toast) => toast.message.includes("Session cleared")),
    ).toBe(true);
    await clearing;
  });

  it("retains the saved prompt journal and route metadata when the old session is purged", async () => {
    const oldStore = services.session.promptHistory;
    const content = `Original request 日本語\n\n> A quotation\n${"Detailed requirements ".repeat(1000)}`;
    await oldStore.append({ content, timestamp: 1791110400000, provider: "river", model: "deepseek", effort: "max" });
    services.session.loadHistory([{ role: "user", content: "Conversation state to clear" }]);
    const abandoned = services.session.sessionId;
    await upsertSession(abandoned, [...services.session.messages], "clear journal subject");
    const body = await readFile(oldStore.path, "utf8");

    await handleClear(services);

    expect(await getSession(abandoned)).toBeUndefined();
    expect(await oldStore.count()).toBe(0);
    expect(services.session.sessionId).not.toBe(abandoned);
    expect(services.session.messages).toEqual([]);
    expect(await readFile(services.session.promptHistory.path, "utf8")).toBe(body);
    const restored = new SessionPromptStore(services.session.sessionId);
    expect(await createSavedPromptReader(restored).readOlder()).toBe(content);
    await handlePrompts(services);
    const overlay = services.overlay.getState();
    expect(overlay.kind).toBe("pager");
    if (overlay.kind !== "pager") throw new Error("prompts pager did not open");
    expect((await overlay.source!.readPage(0)).body).toContain("Original request 日本語");
  });

  it("preserves pending writes and numbering across repeated clears without restoring agent context", async () => {
    const run = vi.spyOn(SilentAgent.prototype, "runTurn");
    const written = services.session.promptHistory.append({ content: "First saved prompt" });
    const cleared = handleClear(services);
    const appended = services.session.promptHistory.append({ content: "Prompt submitted during clear" });
    await Promise.all([written, cleared, appended]);
    await handleClear(services);
    services.session.setProvider("codex");
    services.session.setModel("test-model");
    await services.session.submit("Only this new request reaches the agent");
    await services.session.ensurePromptHistory();

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].history ?? []).toEqual([]);
    expect(JSON.stringify(run.mock.calls[0]![0])).not.toContain("First saved prompt");
    const restored = new SessionPromptStore(services.session.sessionId);
    expect((await restored.namingWindow()).prompts).toEqual([
      { number: 1, preview: "First saved prompt" },
      { number: 2, preview: "Prompt submitted during clear" },
      { number: 3, preview: "Only this new request reaches the agent" },
    ]);
  });

  it("keeps the previous saved copy and warns when prompt preservation fails", async () => {
    const oldStore = services.session.promptHistory;
    await oldStore.append({ content: "Keep this recoverable prompt" });
    const abandoned = services.session.sessionId;
    await upsertSession(abandoned, [{ role: "user", content: "Keep this recoverable prompt" }], "recoverable");
    vi.spyOn(oldStore, "flush").mockRejectedValue(new Error("journal unavailable"));

    await handleClear(services);

    expect(services.session.messages).toEqual([]);
    expect(await getSession(abandoned)).toBeDefined();
    expect(await oldStore.count()).toBe(1);
    expect(await readFile(oldStore.path, "utf8")).toContain("Keep this recoverable prompt");
    expect(services.toast.getToasts()).toContainEqual(
      expect.objectContaining({ level: "warn", message: expect.stringContaining("prompt history") }),
    );
  });

  it("keeps /new isolated from the journal retained by /clear", async () => {
    await services.session.promptHistory.append({ content: "Keep across clear, not new" });
    await handleClear(services);
    const oldStore = services.session.promptHistory;

    await handleNew(services);

    expect(await oldStore.count()).toBe(1);
    expect(await services.session.promptHistory.count()).toBe(0);
    expect(existsSync(services.session.promptHistory.path)).toBe(false);
  });

  it("recalls retained prompts with up/down after /clear", async () => {
    const history = new PromptHistory();
    const dispose = bindSavedPromptHistory(history, services.session);
    try {
      await services.session.promptHistory.append({ content: "First cleared prompt" });
      await services.session.promptHistory.append({ content: "Second cleared prompt" });

      await handleClear(services);

      expect(await history.prevWithSaved("draft")).toBe("Second cleared prompt");
      expect(await history.prevWithSaved("draft")).toBe("First cleared prompt");
      expect(await history.nextWithSaved()).toBe("Second cleared prompt");
      expect(await history.nextWithSaved()).toBe("draft");
    } finally {
      dispose();
    }
  });

  it("does not recall a journal retained by /clear in a /new session", async () => {
    const history = new PromptHistory();
    const dispose = bindSavedPromptHistory(history, services.session);
    try {
      await services.session.promptHistory.append({ content: "Only for the cleared session" });
      await handleClear(services);
      expect(await history.prevWithSaved("draft")).toBe("Only for the cleared session");

      await handleNew(services);

      expect(await history.prevWithSaved("draft")).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("keeps pre-clear prompts out of the next compaction's recent-prompt memory", async () => {
    await services.session.promptHistory.append({ content: "Pre-clear journal prompt" });
    services.session.loadHistory([
      { role: "user", content: "Pre-clear task alpha" },
      { role: "assistant", content: "alpha answered" },
      { role: "user", content: "Pre-clear task beta" },
      { role: "assistant", content: "beta answered" },
    ]);
    await upsertSession(services.session.sessionId, [...services.session.messages], "pre-clear work");

    await handleClear(services);
    services.session.loadHistory([
      { role: "user", content: "Post-clear task one" },
      { role: "assistant", content: "one answered" },
      { role: "user", content: "Post-clear task two" },
      { role: "assistant", content: "two answered" },
    ]);

    const result = await compactMessagesWithSummary(
      [...services.session.messages],
      async () => [
        "ORIENTATION: Post-clear questions are answered; no implementation is pending.",
        "## Latest conversation",
        "- The user asked two new questions after clearing the session; both were answered.",
        "## Work completed",
        "- Both post-clear questions were answered.",
        "## Remaining work",
        "- None requested.",
      ].join("\n"),
      { budgetTokens: 0, singlePassInputBudgetTokens: 200_000 },
    );

    const memory = result.messages.find(isCompactionMemoryMessage);
    expect(memory).toBeDefined();
    expect(memory!.compaction?.recentUserPrompts.map((prompt) => prompt.content)).toEqual([
      "Post-clear task one",
      "Post-clear task two",
    ]);
    expect(memory!.content).toContain("## Last 3 user prompts");
    expect(memory!.content).toContain("Post-clear task one");
    expect(memory!.content).not.toContain("Pre-clear");
  });

  it("keeps a different session untouched", async () => {
    services.session.loadHistory([{ role: "user", content: "keep me" }]);
    const survivor = services.session.sessionId;
    await upsertSession(survivor, [...services.session.messages], "survivor");

    const other = makeServices();
    try {
      other.session.loadHistory([{ role: "user", content: "clear me" }]);
      const victim = other.session.sessionId;
      await upsertSession(victim, [...other.session.messages], "victim");
      await handleClear(other);
      expect(await getSession(victim)).toBeUndefined();
    } finally {
      other.dispose();
    }

    expect(await getSession(survivor)).toBeDefined();
  });
});
