import { describe, expect, it } from "vitest";
import { formatToolContext, fsPassthroughCapChars } from "../src/agent/tool-output-formatting.js";
import {
  renderAgentSystemPrompt,
  renderCompactAgentSystemPrompt,
} from "../src/prompts/index.js";
import {
  DEFAULT_FS_PASSTHROUGH_CAP_CHARS,
  getReliabilityPolicy,
} from "../src/agent/reliability-policy.js";
import { composeAgentSystemPrompt } from "../src/agent/prompt-composer.js";

describe("reliability experiment integration", () => {
  it("E2: formatToolContext respects fs passthrough cap and keeps artifact pointer", () => {
    const cap = fsPassthroughCapChars();
    expect(cap).toBe(DEFAULT_FS_PASSTHROUGH_CAP_CHARS);
    const huge = "L".repeat(cap + 5_000);
    const formatted = formatToolContext(
      { name: "fs.read", args: { path: "/tmp/big.ts" } },
      {
        ok: true,
        output: huge,
        outputPath: "/tmp/clai-artifact-big.txt",
      },
    );
    expect(formatted.length).toBeLessThan(huge.length);
    expect(formatted).toMatch(/Full artifact:/i);
    expect(formatted).toContain("/tmp/clai-artifact-big.txt");
    expect(formatted).toMatch(/offset\/limit|pattern/i);
  });

  it("E6: slim native prompt is smaller than full catalog native prompt", () => {
    const tools =
      "shell.exec, fs.read, fs.write, plan.create, task.update, web.search";
    const slim = renderAgentSystemPrompt(tools, {
      nativeTools: true,
      slimNative: true,
    });
    const full = renderAgentSystemPrompt(tools, {
      nativeTools: true,
      slimNative: false,
    });
    expect(slim.length).toBeLessThan(full.length);
    // Slim keeps policy; drops long fence-era encyclopedia.
    expect(slim).toContain("FILE POLICY");
    expect(slim).toContain("platform tool interface");
    expect(slim).toContain("OPERATING RULES");
    expect(slim).toContain("fs.read");
    // Full catalog documents exact arg JSON shapes more verbosely.
    expect(full.length - slim.length).toBeGreaterThan(2_000);
  });

  it("E6 default native render is slim (schemas carry args)", () => {
    const p = renderAgentSystemPrompt("fs.read, shell.exec", {
      nativeTools: true,
    });
    expect(p).toContain("Available tool names:");
    expect(p).toContain("FILE POLICY");
    // Fence protocol teaching stays out of native.
    expect(p).not.toContain("```tool");
  });

  it("compact + native still works under slim policy flag", () => {
    const p = renderCompactAgentSystemPrompt("fs.read", { nativeTools: true });
    expect(p.length).toBeLessThan(5_000);
    expect(p).not.toContain("```tool");
  });

  it("composed system still includes mandatory plan/scope/outcome with slim constitution", () => {
    const constitution = renderAgentSystemPrompt("fs.read", {
      nativeTools: true,
      slimNative: true,
    });
    const composed = composeAgentSystemPrompt({
      mode: "agent",
      nativeToolsActive: true,
      sections: [
        { kind: "constitution", content: constitution, mandatory: true },
        {
          kind: "outcome",
          content: "OUTCOME CONTRACT\nGoal: test",
          mandatory: true,
        },
        {
          kind: "plan",
          content: "ACTIVE PLAN\nNo plan",
          mandatory: true,
        },
        {
          kind: "scope",
          content: "ENGAGEMENT SCOPE\nNone",
          mandatory: true,
        },
      ],
    });
    expect(composed.included).toContain("constitution");
    expect(composed.included).toContain("plan");
    expect(composed.content).toContain("CURRENT MODE: AGENT");
    expect(getReliabilityPolicy().slimNativePrompt).toBe(true);
  });
});
