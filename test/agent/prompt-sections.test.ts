import { describe, expect, it } from "vitest";
import { SKILLS_CATALOG_PREFIX } from "../../src/skills/catalog.js";
import { buildPromptSections } from "../../src/agent/turn/prompt-sections.js";

describe("prompt sections", () => {
  it("classifies kinds with prefix precedence over substring matches", () => {
    const sections = buildPromptSections({
      systemSections: [
        `${SKILLS_CATALOG_PREFIX} catalog`,
        "ACTIVE PLAN v1 with MODE and OUTCOME words",
        "ENGAGEMENT SCOPE details",
        "AGENT MODE directive",
        "OUTCOME CONTRACT custom",
        "BUILD WORKFLOW directive",
        "WORK PROFILE summary",
        "REQUEST ENVIRONMENT details",
      ],
      selectedSkillNames: [],
      prompt: "do the work",
      mode: "agent",
    });

    expect(
      sections.slice(0, 8).map((section) => [section.kind, section.mandatory]),
    ).toEqual([
      ["context", false],
      ["plan", true],
      ["scope", true],
      ["mode", true],
      ["outcome", true],
      ["focus", false],
      ["focus", false],
      ["context", true],
    ]);
  });

  it("marks the skills catalog mandatory only when a skill was selected", () => {
    const withSkill = buildPromptSections({
      systemSections: [`${SKILLS_CATALOG_PREFIX} catalog`],
      selectedSkillNames: ["review"],
      prompt: "p",
      mode: "agent",
    });
    expect(withSkill[0]).toMatchObject({ kind: "context", mandatory: true });
  });

  it("appends outcome, plan, and scope defaults then the task state", () => {
    const sections = buildPromptSections({
      systemSections: [],
      selectedSkillNames: [],
      prompt: "explain this",
      mode: "ask",
    });

    expect(sections.map((section) => section.kind)).toEqual([
      "outcome",
      "plan",
      "scope",
      "context",
    ]);
    expect(sections[0]!.content).toContain("OUTCOME CONTRACT\nGoal: explain this");
    expect(sections[1]!.content).toContain("PLAN PROTOCOL");
    expect(sections[2]!.content).toContain(
      "No active remote-security scope applies to this turn.",
    );
    expect(sections.at(-1)!.content).toBe(
      "TASK STATE\nMode: ask. Current request: explain this",
    );
    expect(sections.every((section) => section.mandatory)).toBe(true);
  });

  it("omits a default when an equivalent kind is already present", () => {
    const sections = buildPromptSections({
      systemSections: [
        "OUTCOME CONTRACT existing",
        "ACTIVE PLAN existing",
        "ENGAGEMENT SCOPE existing",
      ],
      selectedSkillNames: [],
      prompt: "p",
      mode: "plan",
    });

    expect(sections).toHaveLength(4);
    expect(sections.at(-1)!.kind).toBe("context");
  });
});
