import { describe, expect, it } from "vitest";
import {
  pentestWorkflowDirective,
  buildWorkflowDirective,
  looksLikePentestTask,
} from "../src/agent/tool-call-parser.js";
import { renderAgentSystemPrompt } from "../src/prompts/index.js";

describe("pentestWorkflowDirective", () => {
  it("states this is a pentest / security engagement", () => {
    const directive = pentestWorkflowDirective();
    expect(directive.toLowerCase()).toContain("pentest");
    expect(directive.toLowerCase()).toContain("security");
    expect(directive).toContain("engagement");
  });

  it("calls out recon-first guidance", () => {
    const directive = pentestWorkflowDirective();
    expect(directive.toLowerCase()).toContain("recon");
  });

  it("instructs the agent to plan only after real findings", () => {
    const directive = pentestWorkflowDirective();
    expect(directive.toLowerCase()).toContain("finding");
  });

  it("allows incremental plan updates as attack surface grows", () => {
    const directive = pentestWorkflowDirective();
    expect(directive.toLowerCase()).toContain("incremental");
  });

  it("permits recon tools before a plan exists", () => {
    const directive = pentestWorkflowDirective();
    // The directive must explicitly enumerate the read-only recon tools
    // that are allowed to run before plan.create, so the model does not
    // stall waiting for an approval gate on a recon-only call.
    expect(directive).toContain("whois.lookup");
    expect(directive).toContain("dns.lookup");
    expect(directive).toContain("net.context");
    expect(directive).toContain("http.fetch");
    expect(directive).toContain("tool.batch");
    expect(directive).toContain("net.scan");
    expect(directive).toContain("pentest.recon");
  });

  it("reinforces the engagement scope boundary and out-of-scope flagging", () => {
    const directive = pentestWorkflowDirective();
    expect(directive.toLowerCase()).toContain("scope");
    expect(directive.toLowerCase()).toContain("out-of-scope");
    expect(directive.toLowerCase()).toContain("flag");
  });
});

describe("looksLikePentestTask", () => {
  it("detects an explicit pentest request against a domain", () => {
    expect(looksLikePentestTask("run a pentest against example.com")).toBe(
      true,
    );
  });

  it("still detects pentest keywords that don't end with the bare stem", () => {
    // Regression: the original regex required \bvulnerabilit\b followed by
    // a word boundary, which never matches "vulnerability" — only the
    // nonsense fragment "vulnerabilit" itself.
    expect(
      looksLikePentestTask("scan for vulnerabilities on the target"),
    ).toBe(true);
  });
});

describe("renderAgentSystemPrompt — pentest planning guidance", () => {
  it("renders the pentest-specific planning guidance for a pentest tool list", () => {
    // A tool list that includes the read-only recon tools the pentest
    // workflow permits before a plan exists.
    const toolList =
      "shell.exec, fs.read, whois.lookup, dns.lookup, net.context, http.fetch, net.scan, pentest.recon, plan.create, task.update";
    const prompt = renderAgentSystemPrompt(toolList);
    // PLANNING section now distinguishes coding builds from pentest:
    // recon-first, plan from findings, incremental task additions allowed.
    expect(prompt.toLowerCase()).toContain("recon");
    expect(prompt.toLowerCase()).toContain("finding");
    expect(prompt.toLowerCase()).toContain("incremental");
    // The PENTEST METHODOLOGY section now leads with a recon-before-plan rule.
    expect(prompt).toContain("RECON BEFORE PLAN");
  });
});

describe("buildWorkflowDirective — unchanged shape", () => {
  it("still contains both empty-directory and existing-project guidance", () => {
    const directive = buildWorkflowDirective();
    expect(directive).toContain("dir is empty");
    expect(directive).toContain("existing stack");
  });
});
