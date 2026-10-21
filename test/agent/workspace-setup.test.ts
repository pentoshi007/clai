import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  orientTurnWorkspace,
  resolveTurnWorkIntent,
} from "../../src/agent/turn/workspace-setup.js";
import {
  clearActiveProjectRoot,
  getActiveProjectRoot,
} from "../../src/agent/project-root.js";
import type { SessionPlan } from "../../src/store/plan.js";

const plan = (goal: string): SessionPlan => ({
  sessionId: "session-1",
  goal,
  detail: "",
  tasks: [],
  status: "active",
  kind: "coding",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("turn workspace orientation", () => {
  const temps: string[] = [];

  afterEach(() => {
    clearActiveProjectRoot();
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
    temps.length = 0;
  });

  const desktopWithProject = (name: string): { desktop: string; project: string } => {
    const root = mkdtempSync(join(tmpdir(), "clai-turn-orient-"));
    temps.push(root);
    const desktop = join(root, "Desktop");
    const project = join(desktop, name);
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "index.html"), "<html></html>");
    return { desktop, project };
  };

  it("does not adopt a lone existing project for a new-work request", () => {
    const { desktop } = desktopWithProject("watch-website");
    const orientation = orientTurnWorkspace({
      prompt: "create a watch website",
      plan: undefined,
      cwd: desktop,
    });
    expect(orientation.workIntent).toBe("new");
    expect(getActiveProjectRoot()).toBeUndefined();
    expect(orientation.instructionScanInput).toEqual({ cwd: desktop });
  });

  it("does not adopt an existing folder matching the requested name for new work", () => {
    const { desktop } = desktopWithProject("blogging-app");
    orientTurnWorkspace({
      prompt: "create a react blogging app in this directory",
      plan: undefined,
      cwd: desktop,
    });
    expect(getActiveProjectRoot()).toBeUndefined();
  });

  it("adopts the existing project when the user asks to work on it", () => {
    const { desktop, project } = desktopWithProject("watch-website");
    const orientation = orientTurnWorkspace({
      prompt: "fix the watch website header",
      plan: undefined,
      cwd: desktop,
    });
    expect(orientation.workIntent).toBe("existing");
    expect(getActiveProjectRoot()).toBe(project);
    expect(orientation.instructionScanInput).toEqual({
      cwd: desktop,
      projectRoot: project,
    });
  });

  it("falls back to the plan goal when the prompt carries no intent", () => {
    expect(resolveTurnWorkIntent("yes go ahead", plan("Create a watch website"))).toBe("new");
    expect(resolveTurnWorkIntent("yes go ahead", undefined)).toBe("unspecified");
    expect(resolveTurnWorkIntent("fix the header", plan("Create a watch website"))).toBe(
      "existing",
    );
  });
});
