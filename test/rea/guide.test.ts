import { describe, expect, it } from "vitest";
import { slashCommands } from "../../src/app/commands/catalog.js";
import { reaUserGuide, type ReaGuideView } from "../../src/rea/guide.js";
import { REA_SERVER, REA_WORKFLOW } from "../../src/rea/workflow.js";
import { renderMarkdownLines } from "../../src/ui-core/rendering/render-markdown-lines.js";
import { preparePagerDisplay } from "../../src/tui-v2/rendering/pager-markdown.js";

const installation = {
  version: "6.7.0",
  node: "/clai/tools/rea/versions/6.7.0-x/runtime/bin/node",
  entry: "/clai/tools/rea/versions/6.7.0-x/node_modules/rea-agents/scripts/rea.mjs",
  directory: "/clai/tools/rea/versions/6.7.0-x",
};
const view = (overrides: Partial<ReaGuideView> = {}): ReaGuideView => ({
  status: { state: "ready", installation },
  selected: false,
  root: "/clai/tools/rea",
  platform: "linux",
  ...overrides,
});
const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("REA user guide", () => {
  it("states the installation and connection state it was built from", () => {
    expect(reaUserGuide(view({ status: { state: "missing" } }))).toContain("**Status:** not installed");
    expect(reaUserGuide(view({ status: { state: "broken", reason: "entry missing · repair with /rea install" } })))
      .toContain("needs repair");
    expect(reaUserGuide(view())).toContain("REA 6.7.0 installed · not running");
    const connected = reaUserGuide(view({ server: { status: "ready", toolCount: 207 }, selected: true }));
    expect(connected).toContain("ready (207 tools) · selected for this session");
    expect(reaUserGuide(view({ server: { status: "error", toolCount: 0, detail: "spawn failed" }, maintenance: "update" })))
      .toMatch(/error \(0 tools\) · not selected — spawn failed · update in progress/);
  });

  it("shows installed reference paths only when an installation exists", () => {
    const ready = reaUserGuide(view());
    expect(ready).toContain("skills/reverse-engineer-anything/SKILL.md");
    expect(ready).toContain("references/native-and-artifacts.md");
    expect(reaUserGuide(view({ status: { state: "missing" } }))).not.toContain("SKILL.md");
  });

  it.each([
    ["darwin", "Hopper is started on demand"],
    ["linux", "procps-compatible"],
    ["win32", "experimental, read-only Windows support"],
  ] as const)("explains what works on %s", (platform, note) => {
    const guide = reaUserGuide(view({ platform }));
    expect(guide).toContain(`## On this system (${platform})`);
    expect(guide).toContain(note);
  });

  it("falls back to a neutral note on hosts it has no specifics for", () => {
    expect(reaUserGuide(view({ platform: "freebsd" }))).toContain("Engine support depends on the host");
  });

  it("documents every action the /rea command accepts", () => {
    const usage = slashCommands.find((command) => command.command === "/rea")!.usage!;
    const guide = reaUserGuide(view());
    for (const action of usage.replace(/[[\]]/g, "").split("|").filter((entry) => !entry.startsWith("<"))) {
      expect(guide, `/rea ${action}`).toContain(`/rea ${action}`);
    }
    expect(guide).toContain("/rea <task>");
  });

  it("explains the agent workflow with the exact names the agent uses", () => {
    const guide = reaUserGuide(view());
    for (const term of ["rea.manage", "mcp.tools", "mcp.call", `mcp.${REA_SERVER}.<tool>`, "Evidence IDs", "CLAI_REA_NODE"]) {
      expect(guide).toContain(term);
    }
    expect(guide).toContain("prompt cache");
  });

  it("covers permissions, resource use and recovery for a first-time user", () => {
    const guide = reaUserGuide(view());
    for (const heading of ["Quick start", "When to use it", "Commands", "How the agent uses it", "Example prompts", "What REA can analyse", "Permissions and safety", "Disk, memory and network", "Files and settings", "Troubleshooting"]) {
      expect(guide).toContain(`## ${heading}`);
    }
    expect(guide).toMatch(/ask mode/i);
    expect(guide).toContain("/permissions default");
  });

  it("stays a human document: bounded, and separate from the compact model workflow", () => {
    const guide = reaUserGuide(view());
    expect(guide.length).toBeLessThan(14_000);
    expect(guide).not.toContain(REA_WORKFLOW);
    expect(guide.startsWith("# REA")).toBe(true);
  });

  it.each([52, 80, 120])("renders as markdown without overflowing a %i-column pager in both interfaces", (width) => {
    const guide = reaUserGuide(view({ server: { status: "ready", toolCount: 207 }, selected: true }));
    const classic = renderMarkdownLines(guide, { width }).map(plain);
    expect(classic.some((line) => line.trim() === "Quick start")).toBe(true);
    expect(classic.some((line) => line.includes("┌"))).toBe(true);
    expect(classic.every((line) => [...line].length <= width)).toBe(true);
    expect(classic.join("\n")).not.toMatch(/^\s*#{1,3} |\*\*/m);

    const opentui = preparePagerDisplay({ body: guide, width, mode: "force" });
    expect(opentui.mode).toBe("markdown");
    expect(opentui.lines.every((line) => [...line.plain].length <= width)).toBe(true);
    expect(opentui.lines.map((line) => line.plain).join("\n")).toContain("Troubleshooting");
  });
});
