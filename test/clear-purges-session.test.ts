import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleClear } from "../src/ui-core/commands/session-commands.js";
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
  services = makeServices();
});

afterEach(() => {
  services.dispose();
  clearActiveSessionWorkspace();
});

describe("/clear purges the whole session", () => {
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

  it("reports the clear immediately rather than after the delete finishes", () => {
    services.session.loadHistory([{ role: "user", content: "hi" }]);
    void handleClear(services);
    expect(
      services.toast.getToasts().some((toast) => toast.message.includes("Session cleared")),
    ).toBe(true);
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
