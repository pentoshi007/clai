import { describe, expect, it } from "vitest";
import type { ReaAvailability, ReaEngine } from "../../src/rea/availability.js";
import { describeEngines } from "../../src/rea/engine-report.js";
import type { EngineReport } from "../../src/rea/engine-status.js";
import { reaUserGuide } from "../../src/rea/guide.js";
import { renderMarkdownLines } from "../../src/ui-core/rendering/render-markdown-lines.js";
import { ENGINE_HELP, parseEngineCommand } from "../../src/ui-core/commands/rea-engines-commands.js";

const engine = (id: string): ReaEngine => ({ id, name: id, ready: false, code: "not_configured", reason: undefined, failed: [], java: undefined });
const availability: ReaAvailability = { engines: ["ghidra", "hopper", "ida", "kuna"].map(engine), open: new Set(), deep: new Set(), blocked: new Set(), blockedGroups: [] };
const report = (platform: NodeJS.Platform, arch: string): EngineReport => ({
  rea: { state: "ready", installation: { version: "6.7.0", node: "/n", entry: "/e", directory: "/d" } },
  settings: {}, found: [], failure: undefined, host: { platform, arch }, availability,
});

const shown = (text: string): string => renderMarkdownLines(text, { width: 200 }).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
const placeholders = (text: string): string[] => [...new Set(text.match(/<[A-Za-z][A-Za-z| .]*>/g) ?? [])];

describe("engine texts shown in the markdown pager", () => {
  const texts: Array<[string, string]> = [
    ["report on macOS", describeEngines(report("darwin", "arm64"))],
    ["report on Linux", describeEngines(report("linux", "x64"))],
    ["help", ENGINE_HELP],
    ["usage mistake", `${parseEngineCommand("engines use ghidra").error}\n\n${ENGINE_HELP}`],
    ["unsupported engine", parseEngineCommand("engines install hopper").error ?? ""],
    ["guide", reaUserGuide({ status: { state: "ready", installation: { version: "6.7.0", node: "/n", entry: "/e", directory: "/d" } }, selected: false, root: "/clai/tools/rea", platform: "darwin" })],
  ];

  for (const [name, text] of texts) {
    it(`keeps every <placeholder> visible in the ${name}`, () => {
      const rendered = shown(text);
      expect(placeholders(text).length).toBeGreaterThan(0);
      for (const placeholder of placeholders(text)) expect(rendered).toContain(placeholder);
    });
  }

  it("avoids placeholder names that the pager would swallow as paragraph tags", () => {
    for (const [, text] of texts) expect(text).not.toMatch(/<p[a-z]*[ >]/i);
  });
});
