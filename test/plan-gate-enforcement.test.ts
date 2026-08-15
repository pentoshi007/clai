import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/modes/agent.js";
import { deletePlan } from "../src/store/plan.js";
import { updateConfig } from "../src/store/config.js";
import {
  clearActiveProjectRoot,
  setActiveProjectRoot,
} from "../src/agent/project-root.js";

const stream = vi.fn();
const runTool = vi.fn();

vi.mock("../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/llm/router.js")>();
  return {
    ...actual,
    streamWithProvider: (req: unknown, onToken: (t: string) => void) =>
      stream(req, onToken),
  };
});

vi.mock("../src/tools/registry.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/tools/registry.js")>();
  return {
    ...actual,
    runToolCall: (call: unknown, opts: unknown) => runTool(call, opts),
  };
});

vi.mock("../src/commands/providers.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/commands/providers.js")>();
  return { ...actual, ensureProviderConfigured: async () => {} };
});

function streamReply(text: string) {
  return (_req: unknown, onToken: (t: string) => void) => {
    onToken(text);
    return Promise.resolve({ text, provider: "nvidia", model: "test-model" });
  };
}

function session(sessionId: string) {
  return {
    sessionId,
    planApproved: { value: false },
    allow: new Set(),
    pentestAuthorized: { value: false },
  } as any;
}

describe("agent plan gate enforcement", () => {
  beforeEach(async () => {
    stream.mockReset();
    runTool.mockReset();
    await deletePlan("session-123").catch(() => {});
  });

  afterEach(() => {
    clearActiveProjectRoot();
    updateConfig({ permissions: "allow-all" });
    vi.restoreAllMocks();
  });

  it("allows freestyle scaffold on coding builds in agent mode without plan.create", async () => {
    stream
      .mockImplementationOnce(
        streamReply(
          '```tool\n{"name":"shell.exec","args":{"command":"npm create vite@latest brand-new-todo-xyz -- --template react"}}\n```',
        ),
      )
      .mockImplementationOnce(streamReply("Scaffold started."));

    runTool.mockResolvedValue({ ok: true, output: "Scaffolding project..." });

    await runAgent("create a todo app on desktop", {
      session: {
        sessionId: "session-123",
        planApproved: { value: false },
        allow: new Set(),
        pentestAuthorized: { value: false },
      } as any,
      maxSteps: 3,
      autoConfirm: true,
      mode: "agent",
    });

    const shellCalls = runTool.mock.calls.filter(
      (c) => (c[0] as { name?: string })?.name === "shell.exec",
    );
    expect(shellCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("blocks scaffold in plan mode until the user accepts a plan", async () => {
    stream
      .mockImplementationOnce(
        streamReply(
          '```tool\n{"name":"shell.exec","args":{"command":"npm create vite@latest todo-app"}}\n```',
        ),
      )
      .mockImplementationOnce(
        streamReply(
          '```tool\n{"name":"plan.create","args":{"goal":"todo app","detail":"vite react on Desktop","tasks":["Scaffold project","Implement feature UI","Install deps","Run and verify"],"kind":"coding"}}\n```',
        ),
      )
      .mockImplementation(streamReply("Plan is ready for acceptance."));

    runTool.mockResolvedValue({ ok: true, output: "ok" });

    await runAgent("create a todo app on desktop", {
      session: {
        sessionId: "session-123",
        planApproved: { value: false },
        allow: new Set(),
        pentestAuthorized: { value: false },
      } as any,
      maxSteps: 5,
      autoConfirm: true,
      mode: "plan",
    });

    const shellCalls = runTool.mock.calls.filter(
      (c) => (c[0] as { name?: string })?.name === "shell.exec",
    );
    expect(shellCalls.length).toBe(0);
  });

  it("blocks interactive terminal starts and sends before plan approval", async () => {
    stream
      .mockImplementationOnce(
        streamReply(
          '```tool\n{"name":"terminal.start","args":{"command":"python3 -i"}}\n```',
        ),
      )
      .mockImplementationOnce(
        streamReply(
          '```tool\n{"name":"terminal.send","args":{"id":"its_1","kind":"text","text":"import os"}}\n```',
        ),
      )
      .mockImplementation(streamReply("Plan is ready for acceptance."));

    await runAgent("prepare an interactive workflow", {
      session: session("terminal-plan-gate"),
      maxSteps: 4,
      autoConfirm: true,
      mode: "plan",
    });

    expect(runTool).not.toHaveBeenCalled();
  });

  it("allows safe read-only tool calls when no active plan exists", async () => {
    stream
      .mockImplementationOnce(
        streamReply('```tool\n{"name":"fs.list","args":{"path":"/test"}}\n```')
      )
      .mockImplementationOnce(
        streamReply('I see the files. Now I will stop.')
      );

    runTool.mockResolvedValueOnce({ ok: true, output: "file1, file2" });

    await runAgent("inspect files", {
      session: { sessionId: "session-123", planApproved: { value: false }, allow: new Set(), pentestAuthorized: { value: false } } as any,
      maxSteps: 2,
    });

    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0]![0]).toMatchObject({ name: "fs.list" });
  });

  it("honors auto-confirm for writes inside the pinned project root", async () => {
    const project = join(homedir(), "Desktop", "bloging-app");
    setActiveProjectRoot(project);
    const confirmTool = vi.fn(async () => true);
    stream
      .mockImplementationOnce(
        streamReply(
          `\`\`\`tool\n{"name":"fs.write","args":{"path":"${project}/src/App.tsx","content":"ok"}}\n\`\`\``,
        ),
      )
      .mockImplementationOnce(streamReply("Done."));
    runTool.mockResolvedValue({ ok: true, output: "written" });

    await runAgent("perform the requested operation", {
      session: session("confirm-in-root"),
      autoConfirm: true,
      maxSteps: 3,
      confirm: { confirmTool, confirmPentest: async () => true },
    });

    expect(confirmTool).not.toHaveBeenCalled();
    expect(runTool).toHaveBeenCalledTimes(1);
  });

  it("auto-approves an allow-all write outside the pinned project root", async () => {
    const project = join(homedir(), "Desktop", "bloging-app");
    setActiveProjectRoot(project);
    const confirmTool = vi.fn(async () => true);
    const sibling = join(homedir(), "Desktop", "unrelated-app", "App.tsx");
    stream
      .mockImplementationOnce(
        streamReply(
          `\`\`\`tool\n{"name":"fs.write","args":{"path":"${sibling}","content":"ok"}}\n\`\`\``,
        ),
      )
      .mockImplementationOnce(streamReply("Done."));
    runTool.mockResolvedValue({ ok: true, output: "written" });

    await runAgent("perform the requested operation", {
      session: session("confirm-sibling"),
      autoConfirm: true,
      maxSteps: 3,
      confirm: { confirmTool, confirmPentest: async () => true },
    });

    expect(confirmTool).not.toHaveBeenCalled();
    expect(runTool).toHaveBeenCalledTimes(1);
  });

  it("still prompts for an out-of-cwd write under default permissions", async () => {
    updateConfig({ permissions: "default" });
    const project = join(homedir(), "Desktop", "bloging-app");
    setActiveProjectRoot(project);
    const confirmTool = vi.fn(async () => true);
    const sibling = join(homedir(), "Desktop", "unrelated-app", "App.tsx");
    stream
      .mockImplementationOnce(
        streamReply(
          `\`\`\`tool\n{"name":"fs.write","args":{"path":"${sibling}","content":"ok"}}\n\`\`\``,
        ),
      )
      .mockImplementationOnce(streamReply("Done."));
    runTool.mockResolvedValue({ ok: true, output: "written" });

    await runAgent("perform the requested operation", {
      session: session("confirm-sibling-default"),
      autoConfirm: true,
      maxSteps: 3,
      confirm: { confirmTool, confirmPentest: async () => true },
    });

    expect(confirmTool).toHaveBeenCalledTimes(1);
  });

  it("still prompts for deletes inside the pinned project root", async () => {
    const project = join(homedir(), "Desktop", "bloging-app");
    setActiveProjectRoot(project);
    const confirmTool = vi.fn(async () => true);
    stream
      .mockImplementationOnce(
        streamReply(
          `\`\`\`tool\n{"name":"fs.delete","args":{"path":"${project}/src/old.ts"}}\n\`\`\``,
        ),
      )
      .mockImplementationOnce(streamReply("Done."));
    runTool.mockResolvedValue({ ok: true, output: "deleted" });

    await runAgent("perform the requested operation", {
      session: session("confirm-delete"),
      autoConfirm: true,
      maxSteps: 3,
      confirm: { confirmTool, confirmPentest: async () => true },
    });

    expect(confirmTool).toHaveBeenCalledTimes(1);
  });

  it("compares then suppresses repeated successful reads without reporting a failure", async () => {
    const repeated =
      '```tool\n{"name":"fs.list","args":{"path":"/test"}}\n```';
    stream
      .mockImplementationOnce(streamReply(repeated))
      .mockImplementationOnce(streamReply(repeated))
      .mockImplementationOnce(streamReply(repeated))
      .mockImplementationOnce(streamReply(repeated))
      .mockImplementationOnce(streamReply("Inspection complete."));
    runTool.mockResolvedValue({ ok: true, output: "file1, file2" });

    const answer = await runAgent("inspect files", {
      session: {
        sessionId: "loop-guard-non-terminal",
        planApproved: { value: false },
        allow: new Set(),
        pentestAuthorized: { value: false },
      } as any,
      maxSteps: 8,
    });

    expect(runTool).toHaveBeenCalledTimes(3);
    expect(answer).toContain("Inspection complete.");
    expect(answer).not.toMatch(/Blocked or Cancelled|Status: blocked/i);
    expect(answer).not.toMatch(/already been called|results you already have/i);
  });
});


describe("plan.clear runner dispatch", () => {
  beforeEach(async () => {
    stream.mockReset();
    runTool.mockReset();
    await deletePlan("plan-clear-runner").catch(() => undefined);
  });

  afterEach(async () => {
    await deletePlan("plan-clear-runner").catch(() => undefined);
    clearActiveProjectRoot();
    vi.restoreAllMocks();
  });

  it("routes plan.clear through the runner-owned plan handler", async () => {
    const { createPlan, loadPlan, savePlan } = await import("../src/store/plan.js");
    const plan = createPlan({
      sessionId: "plan-clear-runner",
      goal: "temporary plan",
      detail: "d",
      kind: "coding",
      taskTitles: ["First"],
    });
    plan.status = "in_progress";
    await savePlan(plan);
    const activeSession = session("plan-clear-runner");
    activeSession.planApproved.value = true;
    stream
      .mockImplementationOnce(
        streamReply('```tool\n{"name":"plan.clear","args":{}}\n```'),
      )
      .mockImplementationOnce(streamReply("Plan cleared."));

    await runAgent("discard the active plan", {
      session: activeSession,
      maxSteps: 2,
      autoConfirm: true,
      mode: "agent",
    });

    expect(await loadPlan("plan-clear-runner")).toBeUndefined();
    expect(activeSession.planApproved.value).toBe(false);
    expect(runTool).not.toHaveBeenCalled();
  });
});