import { describe, expect, it } from "vitest";
import { analyzeTask } from "../src/agent/task-analyzer.js";

describe("task-analyzer", () => {
  it("returns simple complexity for short prompts", () => {
    const analysis = analyzeTask("whoami");
    expect(analysis.complexity).toBe("simple");
    expect(analysis.shouldPlan).toBe(false);
    expect(analysis.category).toBe("other");
    expect(analysis.suggestedSteps).toEqual([]);
    expect(analysis.likelyTools).toEqual([]);
  });

  it("returns standard complexity for medium prompts", () => {
    const analysis = analyzeTask("scan my network for active devices and report");
    expect(analysis.complexity).toBe("standard");
    expect(analysis.shouldPlan).toBe(false);
    expect(analysis.suggestedSteps).toEqual([]);
  });

  it("returns complex complexity for long prompts", () => {
    const analysis = analyzeTask(
      "perform a full reconnaissance on example.com including whois dns enumeration port scanning service detection vulnerability assessment and subdomain enumeration then provide a detailed report of all findings with recommendations for remediation",
    );
    expect(analysis.complexity).toBe("complex");
    expect(analysis.shouldPlan).toBe(false);
    expect(analysis.suggestedSteps).toEqual([]);
  });

  it("never injects hardcoded plans", () => {
    const prompts = [
      "whoami",
      "ping sweep my network",
      "full recon example.com",
      "vulnerability scan on target.com",
      "edit the file /etc/hosts",
      "scan ports on 10.0.0.1",
    ];
    for (const prompt of prompts) {
      const analysis = analyzeTask(prompt);
      expect(analysis.shouldPlan).toBe(false);
      expect(analysis.suggestedSteps).toEqual([]);
      expect(analysis.likelyTools).toEqual([]);
    }
  });

  it("always returns category 'other' (AI decides)", () => {
    const analysis = analyzeTask("who registered example.com");
    expect(analysis.category).toBe("other");
  });

  it("truncates goal to 100 chars", () => {
    const long = "a ".repeat(200);
    const analysis = analyzeTask(long);
    expect(analysis.goal.length).toBeLessThanOrEqual(100);
  });
});
