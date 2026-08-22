import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import { parseFrontmatter, frontmatterList } from "../src/skills/frontmatter.js";
import { dedupeSkills, normalizeSkillName } from "../src/skills/discover.js";
import { findSkillMentions, skillMentionNames } from "../src/skills/mentions.js";
import {
  getSkillIndex,
  invalidateSkillIndex,
  loadSkill,
  skillNamesSnapshot,
} from "../src/skills/registry.js";
import {
  renderActiveSkills,
  renderSkillCatalog,
  SKILLS_CATALOG_PREFIX,
} from "../src/skills/catalog.js";
import { skillListTool, skillLoadTool } from "../src/tools/skills.js";
import { classifyToolCall } from "../src/safety/classifier.js";
import type { SkillMeta } from "../src/skills/types.js";

function meta(overrides: Partial<SkillMeta> = {}): SkillMeta {
  return {
    name: "sample",
    description: "Does a thing. Use when the task involves a thing.",
    dir: "/tmp/sample",
    file: "/tmp/sample/SKILL.md",
    scope: "project",
    tool: "clai",
    root: "/tmp",
    ...overrides,
  };
}

describe("SKILL.md frontmatter", () => {
  it("parses scalars, quoted values, block scalars, and lists", () => {
    const parsed = parseFrontmatter(
      [
        "---",
        "name: pdf-forms",
        'license: "MIT"',
        "description: >-",
        "  Extract text and tables from PDFs.",
        "  Use when the user mentions PDFs or forms.",
        "allowed-tools:",
        "  - Read",
        "  - Grep",
        "---",
        "",
        "# Body",
        "Do the thing.",
      ].join("\n"),
    );
    expect(parsed.present).toBe(true);
    expect(parsed.fields.name).toBe("pdf-forms");
    expect(parsed.fields.license).toBe("MIT");
    expect(parsed.fields.description).toBe(
      "Extract text and tables from PDFs. Use when the user mentions PDFs or forms.",
    );
    expect(frontmatterList(parsed, "allowed-tools")).toEqual(["Read", "Grep"]);
    expect(parsed.body).toContain("Do the thing.");
  });

  it("treats a file with no frontmatter as pure body", () => {
    const parsed = parseFrontmatter("# Just markdown\n\nhello");
    expect(parsed.present).toBe(false);
    expect(parsed.fields.name).toBeUndefined();
    expect(parsed.body).toContain("hello");
  });

  it("parses inline flow lists", () => {
    const parsed = parseFrontmatter('---\nallowed-tools: [Read, "Bash(git:*)"]\n---\nbody');
    expect(frontmatterList(parsed, "allowed-tools")).toEqual(["Read", "Bash(git:*)"]);
  });
});

describe("skill name normalization", () => {
  it("accepts spec-shaped names and rewrites near misses", () => {
    expect(normalizeSkillName("pdf-forms")).toBe("pdf-forms");
    expect(normalizeSkillName("PDF Forms")).toBe("pdf-forms");
    expect(normalizeSkillName("review_code")).toBe("review-code");
    expect(normalizeSkillName("  Web  Audit  ")).toBe("web-audit");
  });

  it("rejects empty and oversized names", () => {
    expect(normalizeSkillName("")).toBeUndefined();
    expect(normalizeSkillName("---")).toBeUndefined();
    expect(normalizeSkillName("a".repeat(80))).toBeUndefined();
  });
});

describe("skill precedence", () => {
  it("prefers the nearer scope and records what it shadowed", () => {
    const deduped = dedupeSkills([
      meta({ scope: "user", file: "/home/u/.claude/skills/sample/SKILL.md" }),
      meta({ scope: "project", file: "/repo/.clai/skills/sample/SKILL.md" }),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.scope).toBe("project");
    expect(deduped[0]!.shadowed).toEqual([
      "/home/u/.claude/skills/sample/SKILL.md",
    ]);
  });

  it("lets an explicit extra root win over project and user", () => {
    const deduped = dedupeSkills([
      meta({ scope: "project" }),
      meta({ scope: "extra", file: "/opt/skills/sample/SKILL.md" }),
    ]);
    expect(deduped[0]!.scope).toBe("extra");
  });
});

describe("skill mentions", () => {
  const known = new Set(["pdf-forms", "code-review"]);

  it("finds known tokens and ignores unknown ones", () => {
    expect(skillMentionNames("use skill:pdf-forms on this", known)).toEqual([
      "pdf-forms",
    ]);
    expect(skillMentionNames("skill:not-installed please", known)).toEqual([]);
  });

  it("reports ranges that cover exactly the token", () => {
    const text = "run skill:code-review now";
    const [range] = findSkillMentions(text, known);
    expect(range).toBeDefined();
    expect(text.slice(range!.start, range!.end)).toBe("skill:code-review");
  });

  it("does not match inside urls or paths", () => {
    expect(skillMentionNames("https://x.dev/skill:pdf-forms", known)).toEqual([]);
    expect(skillMentionNames("./a/skill:pdf-forms", known)).toEqual([]);
  });

  it("normalizes case and underscores, and de-duplicates", () => {
    expect(
      skillMentionNames("skill:PDF_FORMS and again skill:pdf-forms", known),
    ).toEqual(["pdf-forms"]);
  });

  it("is a no-op when nothing is installed", () => {
    expect(skillMentionNames("skill:pdf-forms", new Set())).toEqual([]);
  });
});

describe("prompt blocks", () => {
  it("ranks the prompt-relevant skill first and stays inside the token budget", () => {
    const skills = [
      meta({ name: "zzz-unrelated", description: "Formats spreadsheets." }),
      meta({ name: "pdf-forms", description: "Fills PDF forms and extracts tables." }),
    ];
    const block = renderSkillCatalog({ skills, prompt: "fill this pdf form" });
    expect(block).toBeDefined();
    expect(block!.startsWith(SKILLS_CATALOG_PREFIX)).toBe(true);
    const lines = block!.split("\n").filter((line) => line.startsWith("- "));
    expect(lines[0]).toContain("pdf-forms");
    expect(block).toContain("skill.load");
  });

  it("returns nothing when no skills exist", () => {
    expect(renderSkillCatalog({ skills: [], prompt: "anything" })).toBeUndefined();
    expect(renderActiveSkills([])).toBeUndefined();
  });

  it("inlines a pinned skill body and says not to re-load it", () => {
    const block = renderActiveSkills([
      {
        meta: meta({ name: "pdf-forms" }),
        body: "Step 1. Open the PDF.",
        resources: ["scripts/fill.py"],
        truncated: false,
      },
    ]);
    expect(block).toContain("Step 1. Open the PDF.");
    expect(block).toContain("scripts/fill.py");
    expect(block).toContain("do not call skill.load");
  });
});

describe("skill discovery and tools", () => {
  let root: string;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.CLAI_SKILLS_PATH;
    root = mkdtempSync(join(tmpdir(), "clai-skills-"));
    const write = (name: string, body: string): void => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), body, "utf8");
    };
    write(
      "pdf-forms",
      [
        "---",
        "name: pdf-forms",
        "description: Fill PDF forms and extract tables. Use for PDF documents.",
        "---",
        "",
        "Open the PDF, then fill each field.",
      ].join("\n"),
    );
    write(
      "no-description",
      "---\nname: no-description\n---\n\nx",
    );
    mkdirSync(join(root, "nested", "deep-skill"), { recursive: true });
    writeFileSync(
      join(root, "nested", "deep-skill", "SKILL.md"),
      "---\nname: deep-skill\ndescription: A nested skill for category folders.\n---\n\nbody",
      "utf8",
    );
    process.env.CLAI_SKILLS_PATH = root;
    invalidateSkillIndex();
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.CLAI_SKILLS_PATH;
    else process.env.CLAI_SKILLS_PATH = previous;
    invalidateSkillIndex();
    await rm(root, { recursive: true, force: true });
  });

  it("discovers skills from CLAI_SKILLS_PATH including nested category folders", async () => {
    const index = await getSkillIndex({ cwd: root });
    const names = index.skills.map((skill) => skill.name);
    expect(names).toContain("pdf-forms");
    expect(names).toContain("deep-skill");
  });

  it("skips a SKILL.md with neither description nor usable body", async () => {
    const index = await getSkillIndex({ cwd: root });
    expect(index.skills.map((skill) => skill.name)).not.toContain(
      "no-description",
    );
  });

  it("exposes the names synchronously once scanned", async () => {
    await getSkillIndex({ cwd: root });
    expect(skillNamesSnapshot().has("pdf-forms")).toBe(true);
  });

  it("loads the body without the frontmatter", async () => {
    const loaded = await loadSkill("pdf-forms", { cwd: root });
    expect(loaded).toBeDefined();
    expect(loaded!.body).toContain("Open the PDF");
    expect(loaded!.body).not.toContain("description:");
  });

  it("skill.load returns the instructions, skill.list enumerates", async () => {
    const loadResult = await skillLoadTool({ name: "pdf-forms" });
    expect(loadResult.ok).toBe(true);
    expect(loadResult.output).toContain("Open the PDF");

    const listResult = await skillListTool({});
    expect(listResult.ok).toBe(true);
    expect(listResult.output).toContain("pdf-forms");
  });

  it("skill.load fails helpfully on an unknown name", async () => {
    const result = await skillLoadTool({ name: "does-not-exist" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("pdf-forms");
  });

  it("re-scans additional roots when CLAI_SKILLS_PATH grows", async () => {
    const extra = mkdtempSync(join(tmpdir(), "clai-skills-extra-"));
    mkdirSync(join(extra, "second"), { recursive: true });
    writeFileSync(
      join(extra, "second", "SKILL.md"),
      "---\nname: second\ndescription: Another discoverable skill for tests.\n---\n\nbody",
      "utf8",
    );
    process.env.CLAI_SKILLS_PATH = `${root}${delimiter}${extra}`;
    invalidateSkillIndex();
    const index = await getSkillIndex({ cwd: root });
    expect(index.skills.map((skill) => skill.name)).toContain("second");
    await rm(extra, { recursive: true, force: true });
  });
});

describe("skill tool safety", () => {
  it("classifies the skill tools as safe reads", () => {
    expect(classifyToolCall({ name: "skill.load", args: { name: "x" } }).level).toBe(
      "safe",
    );
    expect(classifyToolCall({ name: "skill.list", args: {} }).level).toBe("safe");
  });
});
