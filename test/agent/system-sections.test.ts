import { describe, expect, it, vi } from "vitest";
import type { SessionPlan } from "../../src/store/plan.js";
import {
  buildSystemSections,
  type SystemSectionInput,
} from "../../src/agent/turn/system-sections.js";

const plan = (overrides: Partial<SessionPlan> = {}): SessionPlan => ({
  sessionId: "session-1",
  goal: "ship the feature",
  detail: "detail",
  tasks: [],
  status: "active",
  kind: "coding",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const input = (
  overrides: Partial<SystemSectionInput> = {},
): SystemSectionInput => ({
  prompt: "explain the architecture",
  mode: "agent",
  plan: undefined,
  history: undefined,
  previousTurn: undefined,
  sessionId: "session-1",
  projectContext: undefined,
  destinationHint: undefined,
  isPlanMode: false,
  buildLikeTurn: false,
  informationalQuery: true,
  idleOrSocialPrompt: false,
  narrowNmapOperation: false,
  pentestLikeTurn: false,
  skillsAvailable: false,
  skillIndex: { skills: [], truncated: false },
  selectedSkillNames: [],
  inputTokenBudget: undefined,
  getMcpContext: () => undefined,
  getProjectRoot: () => undefined,
  getRunningJobs: () => [],
  getRecentJobs: () => [],
  ...overrides,
});

describe("system sections", () => {
  it("always leads with the request environment context", async () => {
    const { sections } = await buildSystemSections(input());
    expect(sections[0]).toContain("REQUEST ENVIRONMENT");
  });

  it("orders mcp context, project context, and location after the environment", async () => {
    const { sections } = await buildSystemSections(
      input({
        getMcpContext: () => "MCP TOOL CONTEXT block",
        projectContext: "repo rules",
        getProjectRoot: () => "/workspace/app",
      }),
    );

    expect(sections.slice(1, 4)).toEqual([
      "MCP TOOL CONTEXT block",
      "Project context from .clai/context.md:\nrepo rules",
      expect.stringContaining("ACTIVE PROJECT ROOT: /workspace/app"),
    ]);
  });

  it("prefers the active project root over the destination hint", async () => {
    const withRoot = await buildSystemSections(
      input({ getProjectRoot: () => "/root", destinationHint: "/hint" }),
    );
    expect(withRoot.sections.some((s) => s.startsWith("USER DESTINATION:"))).toBe(
      false,
    );

    const withHint = await buildSystemSections(
      input({ destinationHint: "/hint" }),
    );
    expect(
      withHint.sections.find((s) => s.startsWith("USER DESTINATION:")),
    ).toContain('"/hint" (parent folder)');
  });

  it("suppresses workspace, continuation, and analysis blocks for informational turns", async () => {
    const getRunningJobs = vi.fn(() => []);
    const { sections } = await buildSystemSections(
      input({ buildLikeTurn: true, informationalQuery: true, getRunningJobs }),
    );

    expect(sections.some((s) => s.startsWith("WORKSPACE STATUS"))).toBe(false);
    expect(getRunningJobs).not.toHaveBeenCalled();
    expect(sections.some((s) => s.includes("TASK ANALYSIS"))).toBe(false);
  });

  it("emits the mode directive and one workflow block for a build turn", async () => {
    const { sections } = await buildSystemSections(
      input({ buildLikeTurn: true, informationalQuery: false }),
    );

    const workflows = sections.filter((s) => s.startsWith("BUILD FOCUS"));
    expect(workflows).toHaveLength(1);
    expect(sections.some((s) => s.includes("AGENT MODE"))).toBe(true);
    expect(sections.some((s) => s.startsWith("WORKSPACE STATUS"))).toBe(true);
  });

  it("emits plan mode directive plus workflow in plan mode", async () => {
    const { sections } = await buildSystemSections(
      input({
        isPlanMode: true,
        mode: "plan",
        buildLikeTurn: true,
        informationalQuery: false,
      }),
    );

    expect(sections.filter((s) => s.startsWith("BUILD FOCUS"))).toHaveLength(1);
    expect(sections.some((s) => s.includes("AGENT MODE"))).toBe(false);
  });

  it("detects a pentest session from the plan kind or goal text", async () => {
    await expect(
      buildSystemSections(input({ plan: plan({ kind: "pentest" }) })).then(
        (r) => r.pentestSession,
      ),
    ).resolves.toBe(true);
    await expect(
      buildSystemSections(
        input({ plan: plan({ kind: "other", goal: "recon the host" }) }),
      ).then((r) => r.pentestSession),
    ).resolves.toBe(true);
    await expect(
      buildSystemSections(
        input({ plan: plan({ kind: "coding", goal: "recon the host" }) }),
      ).then((r) => r.pentestSession),
    ).resolves.toBe(false);
  });

  it("adds the nmap and pentest workflow directives under their exact gates", async () => {
    const narrow = await buildSystemSections(
      input({ narrowNmapOperation: true, informationalQuery: false }),
    );
    expect(
      narrow.sections.some((s) => s.startsWith("NARROW NMAP OPERATION")),
    ).toBe(true);

    const pentest = await buildSystemSections(
      input({ pentestLikeTurn: true, informationalQuery: false }),
    );
    expect(pentest.pentestSession).toBe(true);
    expect(
      pentest.sections.some((s) => s.startsWith("PENTEST ENGAGEMENT")) ||
        pentest.sections.some((s) => s.includes("PENTEST")),
    ).toBe(true);
  });
});
