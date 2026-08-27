import { describe, expect, it } from "vitest";
import {
  renderAgentSystemPrompt,
  renderAskSystemPrompt,
  renderCompactAgentSystemPrompt,
  toolNudge,
} from "../src/prompts/index.js";

describe("native prompts", () => {
  it("native agent prompt has no fence protocol (P2-8 dedicated template)", () => {
    const p = renderAgentSystemPrompt("fs.write", { nativeTools: true });
    expect(p).not.toContain("```tool");
    expect(p).toContain("platform tool interface");
    expect(p).not.toMatch(/HOW TO USE TOOLS/i);
    expect(p).toContain("FILE POLICY");
    expect(p).toContain("OPERATING RULES");
    expect(p).toContain("fs.write");
  });

  it("E6 full native catalog remains available when slimNative=false", () => {
    const full = renderAgentSystemPrompt("fs.write", {
      nativeTools: true,
      slimNative: false,
    });
    expect(full).toContain("FILE POLICY");
    // Full encyclopedia still documents exact tool argument shapes.
    expect(full.length).toBeGreaterThan(
      renderAgentSystemPrompt("fs.write", {
        nativeTools: true,
        slimNative: true,
      }).length,
    );
  });

  it("text agent prompt still documents fences", () => {
    const p = renderAgentSystemPrompt("fs.write");
    expect(p).toContain("```tool");
  });

  it("compact native has no fences", () => {
    const p = renderCompactAgentSystemPrompt("fs.write", { nativeTools: true });
    expect(p).not.toContain("```tool");
  });

  it("ask native removes fence teaching", () => {
    const p = renderAskSystemPrompt({ nativeTools: true });
    expect(p).not.toMatch(/emit a fenced block exactly like this/i);
    expect(p).not.toContain("```tool");
    expect(p).toContain("platform tool interface");
    expect(p).toContain("agent.handoff");
  });

  it("toolNudge dual wording", () => {
    expect(toolNudge(true)).toContain("Call the appropriate tool");
    expect(toolNudge(false)).toContain("```tool");
  });

  it("ask prompt teaches research quality / citations", () => {
    const p = renderAskSystemPrompt({ nativeTools: true });
    expect(p).toMatch(/high-trust|Prefer high-trust/i);
    expect(p).toMatch(/1–3 source URLs|1-3 source URLs|cite 1–3/i);
    expect(p).toMatch(/confirms/i);
  });

  it("keeps shell and interactive terminal selection unambiguous", () => {
    const p = renderAgentSystemPrompt(
      "shell.exec, shell.start, terminal.start, terminal.send, terminal.read",
      { nativeTools: true },
    );
    expect(p).toContain("Finite chatty work → shell.exec");
    expect(p).toContain("persistent work → shell.start");
    expect(p).toMatch(/ssh\/gpg\/passwd need a real TTY: use terminal\.start/i);
  });

  it("agent prompt requires leave server running + report URL for coding plans", () => {
    const p = renderAgentSystemPrompt("shell.start, fs.write", {
      nativeTools: true,
    });
    expect(p).toMatch(/LEAVE(?: the server)? running|leave server running/i);
    expect(p).toMatch(/http:\/\/localhost|<port>|job id|URL \+ job id/i);
    expect(p).toMatch(/Do NOT (?:call plan\.create again|re-plan) only to add/i);
  });
});
