import { describe, expect, it } from "vitest";
import {
  analyzeTask,
  formatTaskAnalysisHint,
  isNarrowExplicitNmapOperation,
} from "../src/agent/task-analyzer.js";
import { computeStepBudget } from "../src/agent/step-budget.js";

describe("task-analyzer", () => {
  it("keeps short operations direct and proportionate", () => {
    const analysis = analyzeTask("whoami");
    expect(analysis.complexity).toBe("simple");
    expect(analysis.shouldPlan).toBe(false);
    expect(analysis.coordination).toBe("direct");
    expect(analysis.verification).toBe("observable-outcome");
  });

  it("keeps an explicit nmap request bounded instead of expanding it into a pentest plan", () => {
    const prompt = "run stealth nmap scan on aniketpandey.website";
    expect(isNarrowExplicitNmapOperation(prompt)).toBe(true);
    expect(
      isNarrowExplicitNmapOperation("sudo nmap -sS -p 80,443 example.com"),
    ).toBe(true);
    expect(
      isNarrowExplicitNmapOperation("nmap --top-ports 100 example.com"),
    ).toBe(true);
    expect(
      isNarrowExplicitNmapOperation("find open ports on aniketpandey.website"),
    ).toBe(true);

    const analysis = analyzeTask(prompt);
    expect(analysis).toMatchObject({
      shouldPlan: false,
      complexity: "standard",
      depth: "bounded",
      coordination: "direct",
    });
    expect(analysis.completionStandard).toMatch(/without expanding/i);
  });

  it("does not narrow a requested assessment or multi-operation recon", () => {
    expect(
      isNarrowExplicitNmapOperation(
        "run an nmap scan and assess vulnerabilities across the attack surface",
      ),
    ).toBe(false);
    expect(
      isNarrowExplicitNmapOperation(
        "run nmap and then perform DNS and HTTP reconnaissance",
      ),
    ).toBe(false);
  });

  it("marks pentest work deep and coverage-oriented without prescribing tools", () => {
    const analysis = analyzeTask("run a pentest against example.com");
    expect(analysis.complexity).toBe("complex");
    expect(analysis.shouldPlan).toBe(true);
    expect(analysis.coordination).toBe("tracked");
    expect(analysis.verification).toBe("coverage-and-impact");
    expect(analysis.completionStandard).toMatch(/attack surfaces|residual/i);

    const hint = formatTaskAnalysisHint(analysis);
    expect(hint).toContain("not a procedure");
    expect(hint).toContain("do not follow a canned checklist");
    expect(hint).not.toMatch(/Likely tools|dns\.lookup|net\.scan|plan\.create/);
  });

  it("marks multi-surface builds as tracked behavioral work", () => {
    const analysis = analyzeTask(
      "create a production-grade React todo app and cover all edge states",
    );
    expect(analysis.complexity).toBe("complex");
    expect(analysis.shouldPlan).toBe(true);
    expect(analysis.category).toBe("filesystem");
    expect(analysis.depth).toBe("deep");
    expect(analysis.verification).toBe("behavior-and-regression");
    expect(analysis.completionStandard).toMatch(/invariants|integration|edge/i);
  });

  it("gives debugging a root-cause and regression proof standard", () => {
    const analysis = analyzeTask("fix the typeerror in App.tsx");
    expect(["standard", "complex"]).toContain(analysis.complexity);
    expect(analysis.verification).toBe("root-cause-regression");
    expect(analysis.completionStandard).toMatch(/root cause|before\/after/i);
  });

  it("treats thorough reviews as deep analysis rather than a one-path answer", () => {
    const analysis = analyzeTask(
      "perform a comprehensive architecture review across every service and recommend improvements",
    );
    expect(analysis.complexity).toBe("complex");
    expect(analysis.depth).toBe("deep");
    expect(analysis.category).toBe("answer");
    expect(analysis.coordination).toBe("direct");
    expect(analysis.verification).toBe("source-synthesis");
  });

  it("formats a compact adaptive profile", () => {
    const hint = formatTaskAnalysisHint(
      analyzeTask("build a next.js dashboard app"),
    );
    expect(hint).toMatch(/WORK PROFILE/);
    expect(hint).toMatch(/complexity=/);
    expect(hint).toMatch(/depth=/);
    expect(hint).toMatch(/verification=/);
    expect(hint).toMatch(/durable outcome tracking may improve/i);
    expect(hint).toMatch(/Choose methods and tools from the actual system/i);
    expect(hint).not.toMatch(/Likely tools|Suggested steps/i);
  });

  it("truncates goal to 100 chars", () => {
    const long = "a ".repeat(200);
    const analysis = analyzeTask(long);
    expect(analysis.goal.length).toBeLessThanOrEqual(100);
  });
});

describe("step budget", () => {
  it("gives builds the full maxSteps ceiling", () => {
    const analysis = analyzeTask("create a react todo app");
    const budget = computeStepBudget({
      analysis,
      maxSteps: 100,
      buildLike: true,
      pentestLike: false,
      hasHistory: false,
    });
    expect(budget).toBeGreaterThanOrEqual(100);
  });

  it("keeps simple one-liners small without build flags", () => {
    const analysis = analyzeTask("whoami");
    const budget = computeStepBudget({
      analysis,
      maxSteps: 100,
      buildLike: false,
      pentestLike: false,
      hasHistory: false,
    });
    expect(budget).toBe(20);
  });
});
