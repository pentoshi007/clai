import { describe, expect, it } from "vitest";
import {
  pentestWorkflowDirective,
  narrowNmapOperationDirective,
  buildWorkflowDirective,
  looksLikePentestTask,
} from "../src/agent/tool-call-parser.js";
import { renderAgentSystemPrompt } from "../src/prompts/index.js";

describe("pentestWorkflowDirective", () => {
  it("frames security work as an objective- and evidence-driven specialization", () => {
    const directive = pentestWorkflowDirective();
    expect(directive.toLowerCase()).toContain("pentest");
    expect(directive.toLowerCase()).toContain("security");
    expect(directive).toContain("soft classification");
    expect(directive).toContain("attacker objective");
    expect(directive).toContain("current evidence");
    expect(directive).toContain("expected impact");
  });

  it("uses an attack-surface ledger and branches discoveries without a fixed sequence", () => {
    const directive = pentestWorkflowDirective();
    expect(directive).toContain("attack-surface ledger");
    expect(directive).toContain("tested/untested");
    expect(directive).toContain("task.add/reprioritization");
    expect(directive).toContain("options—not a mandatory checklist or sequence");
    expect(directive).toContain("hypotheses");
  });

  it("requires validated impact, saturation, and explicit residual coverage", () => {
    const directive = pentestWorkflowDirective();
    expect(directive).toContain("reproducible PoC");
    expect(directive).toContain("first finding or clean scanner run is not completion");
    expect(directive).toContain("materially improve coverage, confidence, or impact");
    expect(directive).toContain("reconcile the ledger with scope and objective");
    expect(directive).toContain("residual/untested surface");
    expect(directive.toLowerCase()).toMatch(/flag.*out-of-scope/);
  });

  it("bases durable plans on evidence instead of a recon gate", () => {
    const directive = pentestWorkflowDirective();
    expect(directive).toContain("plan.create");
    expect(directive).toContain("base it on evidence rather than a fixed recon gate");
    expect(directive).toContain("preserve completed evidence");
  });
});

describe("narrowNmapOperationDirective", () => {
  it("requires one scan and forbids automatic pentest expansion", () => {
    const directive = narrowNmapOperationDirective();
    expect(directive).toMatch(/net\.scan exactly once/i);
    expect(directive).toMatch(/Do NOT call plan\.create/i);
    expect(directive).toMatch(/WHOIS, DNS, HTTP/i);
    expect(directive).toMatch(/backgroundJob\.id/i);
    expect(directive).toMatch(/Stop after reporting/i);
  });
});

describe("looksLikePentestTask", () => {
  it("detects an explicit pentest request against a domain", () => {
    expect(looksLikePentestTask("run a pentest against example.com")).toBe(
      true,
    );
  });

  it("still detects pentest keywords that don't end with the bare stem", () => {
    expect(
      looksLikePentestTask("scan for vulnerabilities on the target"),
    ).toBe(true);
  });
});

describe("renderAgentSystemPrompt — pentest planning guidance", () => {
  const toolList =
    "shell.exec, fs.read, whois.lookup, dns.lookup, net.context, http.fetch, net.scan, pentest.recon, plan.create, task.update";

  it("renders evidence-driven pentest guidance without a fixed tool sequence", () => {
    const prompt = renderAgentSystemPrompt(toolList, { pentest: true });
    expect(prompt).toContain("Choose each next action by expected information or access gain");
    expect(prompt).toContain("candidate dimensions—not a compulsory sequence");
    expect(prompt).toContain("optional techniques");
    expect(prompt).toContain("Use plan.create when a durable roadmap adds value");
    expect(prompt).toContain("Continue while a realistic in-scope action can materially improve the result");
  });

  it("keeps the methodology out of a non-pentest turn", () => {
    const coding = renderAgentSystemPrompt(toolList);
    expect(coding).not.toContain("# PENTEST METHODOLOGY");
    expect(coding).not.toContain("**Attack-surface ledger:**");
    expect(coding).toContain("Professional execution method — applies to every domain");
    expect(coding).toContain("# OPERATING RULES");
    expect(coding).toContain("# CROSS-OS AWARENESS");
    expect(coding.length).toBeLessThan(
      renderAgentSystemPrompt(toolList, { pentest: true }).length,
    );
  });

  it("attaches the methodology on the native-tool pentest path too", () => {
    const native = renderAgentSystemPrompt(toolList, {
      nativeTools: true,
      pentest: true,
    });
    expect(native).toContain("# PENTEST METHODOLOGY");
    expect(
      renderAgentSystemPrompt(toolList, { nativeTools: true }),
    ).not.toContain("# PENTEST METHODOLOGY");
  });
});

describe("buildWorkflowDirective — adaptive software specialization", () => {
  it("orients once, models contracts, and verifies the complete behavior", () => {
    const directive = buildWorkflowDirective();
    expect(directive).toMatch(/soft classification/i);
    expect(directive).toMatch(/ORIENT once/i);
    expect(directive).toMatch(/non-empty destination means continue/i);
    expect(directive).toMatch(/MODEL before edit/i);
    expect(directive).toMatch(/contracts, callers, schemas, data\/control flow/i);
    expect(directive).toMatch(/scaffold[\s\S]*does not prove the requested feature/i);
    expect(directive).toMatch(/positive, negative, boundary, regression, and integration paths/i);
    expect(directive).toMatch(/Libraries and non-server artifacts use their own observable proof/i);
    expect(directive).toMatch(/reconcile changed files and affected surfaces/i);
  });
});
