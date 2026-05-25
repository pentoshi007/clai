import { describe, expect, it } from "vitest";
import { analyzeTask } from "../src/agent/task-analyzer.js";

describe("task-analyzer", () => {
  it("classifies 'whoami' as simple shell", () => {
    const analysis = analyzeTask("whoami");
    expect(analysis.complexity).toBe("simple");
    expect(analysis.shouldPlan).toBe(false);
    expect(analysis.category).toBe("shell");
    expect(analysis.likelyTools).toContain("shell.exec");
  });

  it("classifies 'ping sweep my network' as standard network-discovery", () => {
    const analysis = analyzeTask("ping sweep my network");
    expect(analysis.complexity).toBe("standard");
    expect(analysis.shouldPlan).toBe(true);
    expect(analysis.category).toBe("network-discovery");
    expect(analysis.needsNetworkContext).toBe(true);
    expect(analysis.suggestedSteps.length).toBeGreaterThan(0);
  });

  it("classifies 'scan my network for active devices' as network-discovery", () => {
    const analysis = analyzeTask("scan my network for active devices");
    expect(analysis.complexity).toBe("standard");
    expect(analysis.category).toBe("network-discovery");
    expect(analysis.needsNetworkContext).toBe(true);
  });

  it("classifies 'who registered example.com' as simple whois", () => {
    const analysis = analyzeTask("who registered example.com");
    expect(analysis.complexity).toBe("simple");
    expect(analysis.shouldPlan).toBe(false);
    expect(analysis.category).toBe("whois");
  });

  it("classifies 'MX records for example.com' as simple dns", () => {
    const analysis = analyzeTask("MX records for example.com");
    expect(analysis.complexity).toBe("simple");
    expect(analysis.shouldPlan).toBe(false);
    expect(analysis.category).toBe("dns");
  });

  it("classifies 'full recon example.com' as complex pentest-recon", () => {
    const analysis = analyzeTask("full recon example.com");
    expect(analysis.complexity).toBe("complex");
    expect(analysis.shouldPlan).toBe(true);
    expect(analysis.category).toBe("pentest-recon");
    expect(analysis.suggestedSteps.length).toBeGreaterThan(3);
  });

  it("classifies 'edit /etc/hosts' as standard filesystem", () => {
    const analysis = analyzeTask("edit the file /etc/hosts");
    expect(analysis.complexity).toBe("standard");
    expect(analysis.category).toBe("filesystem");
  });

  it("classifies 'read this file' as simple filesystem", () => {
    const analysis = analyzeTask("read this file");
    expect(analysis.complexity).toBe("simple");
    expect(analysis.category).toBe("filesystem");
  });

  it("classifies 'scan ports on 10.0.0.1' as standard pentest-recon", () => {
    const analysis = analyzeTask("scan ports on 10.0.0.1");
    expect(analysis.complexity).toBe("standard");
    expect(analysis.category).toBe("pentest-recon");
  });

  it("classifies 'vulnerability scan on target.com' as complex", () => {
    const analysis = analyzeTask("vulnerability scan on target.com");
    expect(analysis.complexity).toBe("complex");
    expect(analysis.shouldPlan).toBe(true);
  });

  it("provides stopWhen for all analyses", () => {
    const a1 = analyzeTask("whoami");
    expect(a1.stopWhen).toBeTruthy();
    const a2 = analyzeTask("full recon example.com");
    expect(a2.stopWhen).toBeTruthy();
  });

  it("falls back to 'other' for unrecognized prompts", () => {
    const analysis = analyzeTask("tell me a joke");
    expect(analysis.complexity).toBe("standard");
    expect(analysis.category).toBe("other");
    expect(analysis.shouldPlan).toBe(false);
  });
});
