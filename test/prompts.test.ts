import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  renderAskSystemPrompt,
  renderAgentSystemPrompt,
  agentModeDirective,
  planModeDirective,
  _ASK_TEMPLATE,
  _AGENT_TEMPLATE,
  currentDateTimeContext,
  renderRequestEnvironmentContext,
  renderPentestMethodologyContext,
} from "../src/prompts/index.js";

describe("prompt rendering", () => {
  it("ask prompt contains ask-mode, no-system-changes instruction", () => {
    const prompt = renderAskSystemPrompt();
    expect(prompt).toContain("ask mode");
    expect(prompt).toContain("do NOT modify the system");
  });

  it("ask prompt enables read-only web research", () => {
    const prompt = renderAskSystemPrompt();
    expect(prompt).toContain("web.search");
    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain("CANNOT run shell commands");
  });

  it("ask prompt includes OS info and current date/time", () => {
    const prompt = renderAskSystemPrompt();
    // Should have replaced the {{os}} template
    expect(prompt).not.toContain("{{os}}");
    expect(prompt).not.toContain("{{shell}}");
    expect(prompt).not.toContain("{{datetime}}");
    expect(prompt).toMatch(/\(ISO hour:/);
  });

  it("agent prompt includes tool list", () => {
    const prompt = renderAgentSystemPrompt("shell.exec, fs.read, sysinfo");
    expect(prompt).toContain("shell.exec");
    expect(prompt).toContain("fs.read");
    expect(prompt).toContain("sysinfo");
  });

  it("agent prompt has no unresolved template variables", () => {
    const prompt = renderAgentSystemPrompt("shell.exec");
    expect(prompt).not.toContain("{{os}}");
    expect(prompt).not.toContain("{{cwd}}");
    expect(prompt).not.toContain("{{tool_list}}");
    expect(prompt).not.toContain("{{shell}}");
    expect(prompt).not.toContain("{{datetime}}");
  });

  it("agent prompt contains pentesting authorization reminder", () => {
    const prompt = renderAgentSystemPrompt("net.scan");
    expect(prompt).toContain("responsible for authorization");
  });

  it("agent prompt enforces honesty and current-info behavior", () => {
    const prompt = renderAgentSystemPrompt("shell.exec");
    // Anti-fabrication is the headline rule of the rewritten prompt.
    expect(prompt).toContain("HONESTY");
    expect(prompt).toContain("fabricated success");
    expect(prompt).toContain("report ONLY what the tool output actually showed");
    // Still steers to live data and concrete summaries.
    expect(prompt).toContain("web.search");
    expect(prompt).toContain("current/volatile facts");
    expect(prompt).toContain("summarize the concrete findings");
  });

  it("applies an adaptive professional execution method to every task domain", () => {
    const prompt = renderAgentSystemPrompt("shell.exec, fs.read, fs.edit");
    expect(prompt).toContain("Professional execution method — applies to every domain");
    expect(prompt).toContain("Frame the outcome");
    expect(prompt).toContain("Model the system");
    expect(prompt).toContain("Map material coverage");
    expect(prompt).toContain("Tools and techniques are options, not a ritual sequence");
    expect(prompt).toContain("Verify independently");
    expect(prompt).toContain("Reconcile before stopping");
    expect(prompt).toMatch(/production-grade[\s\S]*evidence-backed saturation/i);
    expect(prompt).toMatch(/remaining uncertainty[\s\S]*explicitly disclosed/i);
  });

  it("gives ask mode an evidence-calibrated professional analysis method", () => {
    const prompt = renderAskSystemPrompt();
    expect(prompt).toContain("# PROFESSIONAL ANALYSIS");
    expect(prompt).toContain("decision or question");
    expect(prompt).toContain("observed fact from inference");
    expect(prompt).toContain("material dimensions inside the requested boundary");
    expect(prompt).toContain("decision-ready answer");
  });

  it("formats date/time context with an hour-stable ISO stamp", () => {
    const when = new Date("2026-05-29T12:34:56.000Z");
    const text = currentDateTimeContext(when);
    // Hour-stable: seconds must not appear in the ISO hour marker.
    expect(text).toMatch(/ISO hour:/);
    expect(text).toMatch(/T\d{2}:00:00\.000Z/);
    expect(text).not.toContain("12:34:56");
  });

  it("keeps system datetime stable within the same local hour", () => {
    const a = new Date("2026-05-29T15:01:02.000");
    const b = new Date("2026-05-29T15:59:58.000");
    expect(currentDateTimeContext(a)).toBe(currentDateTimeContext(b));
  });

  it("agent prompt reserves tasks for substantial work while preserving verify-before-done", () => {
    const prompt = renderAgentSystemPrompt("task.update, plan.create, shell.exec");
    expect(prompt).toMatch(/AGENT-MODE TASKS vs PLAN-MODE TASKS/i);
    expect(prompt).toMatch(/working memory, not a permission gate/i);
    expect(prompt).toMatch(/Create a small outcome-titled task list[\s\S]*for substantial work/i);
    expect(prompt).toMatch(/Do NOT create tasks for easy-to-medium work, even when it takes several steps/i);
    expect(prompt).toMatch(/read\/analyze results|read tool results|READ results|read the results/i);
    expect(prompt).toMatch(/typecheck|automated checks/i);
    expect(prompt).toMatch(/Never mark done before evidence|done only when|Never mark done because/i);
  });

  it("agent prompt preserves explicit whole-program and phase-only boundaries", () => {
    const prompt = renderAgentSystemPrompt("task.add, task.update, fs.read");
    expect(prompt).toMatch(/entire roadmap\/folder\/program|whole roadmap\/program/i);
    expect(prompt).toMatch(/do not stop for a progress summary between phases/i);
    expect(prompt).toMatch(/explicitly limits the request to a phase/i);
    expect(prompt).toMatch(/complete one coherent phase.*ask whether to continue/is);
    expect(prompt).toMatch(/append the next phase.*instead of replacing completed work/is);
  });

  it("agentModeDirective requires adaptive evidence-driven execution and proportionate task tracking", () => {
    const d = agentModeDirective();
    expect(d).toMatch(/working memory, not permission gates/i);
    expect(d).toMatch(/substantial multi-phase work benefits from coordination/i);
    expect(d).toMatch(/execute easy-to-medium work directly/i);
    expect(d).toMatch(/entire roadmap\/folder\/program/i);
    expect(d).toMatch(/FRAME:[\s\S]*MODEL:[\s\S]*COVER:[\s\S]*DECIDE:/i);
    expect(d).toMatch(/Methods and tools are options, not a fixed sequence/i);
    expect(d).toMatch(/Never mark done on hope/i);
    expect(d).toMatch(/task\.add[\s\S]*preempt[\s\S]*pending/i);
    expect(d).toMatch(/positive, negative, boundary, integration, and regression paths/i);
    expect(d).toMatch(/automated checks|runtime\/integration proof/i);
    expect(d).toMatch(/RECONCILE:[\s\S]*original request/i);
  });

  it("planModeDirective is decision-ready planning with coverage and branch conditions", () => {
    const d = planModeDirective();
    expect(d).toMatch(/NOT agent-mode task execution/i);
    expect(d).toMatch(/plan\.create/i);
    expect(d).toMatch(/Do not implement/i);
    expect(d).toMatch(/decision-critical unknowns/i);
    expect(d).toMatch(/coverage map of material surfaces/i);
    expect(d).toMatch(/whole-program\/all-phase requests/i);
    expect(d).toMatch(/phase-only requests must not expand beyond it/i);
    expect(d).toMatch(/tasks as checkable outcomes/i);
    expect(d).toMatch(/not as vague activity labels or hardcoded commands/i);
    expect(d).toMatch(/acceptanceCriteria/i);
    expect(d).toMatch(/branch conditions/i);
  });

  it("renderRequestEnvironmentContext includes NO PLAN EXISTS when plan is omitted", () => {
    const envStr = renderRequestEnvironmentContext();
    expect(envStr).toContain("Plan status: NO PLAN EXISTS");
  });

  it("renderRequestEnvironmentContext includes ACTIVE PLAN EXISTS details when plan is passed", () => {
    const mockPlan: any = {
      id: "p1",
      goal: "Build web app",
      status: "in_progress",
      tasks: [
        { id: "t1", state: "done", title: "scaffold" },
        { id: "t2", state: "pending", title: "implement" },
      ],
    };
    const envStr = renderRequestEnvironmentContext({ plan: mockPlan });
    expect(envStr).toContain("Plan status: ACTIVE PLAN EXISTS");
    expect(envStr).toContain('goal: "Build web app"');
    expect(envStr).toContain("tasks: 2 total [1 finished]");
    expect(envStr).toContain("use task.add to append new tasks");
  });
});

describe("phase 11 — prompt template ↔ markdown drift", () => {
  it("system.ask.md content matches the inline ask template", () => {
    const md = readFileSync(
      resolve(__dirname, "../src/prompts/system.ask.md"),
      "utf8",
    )
      .replace(/\r\n/g, "\n")
      .trimEnd();
    const inline = _ASK_TEMPLATE.replace(/\r\n/g, "\n").trimEnd();
    expect(md).toBe(inline);
  });

  it("system.agent.md content matches the inline agent template", () => {
    const md = readFileSync(
      resolve(__dirname, "../src/prompts/system.agent.md"),
      "utf8",
    )
      .replace(/\r\n/g, "\n")
      .trimEnd();
    const inline = _AGENT_TEMPLATE.replace(/\r\n/g, "\n").trimEnd();
    expect(md).toBe(inline);
  });

  it("embedded prompts match on-disk markdown (brew/bun binary source)", () => {
    // embed-prompts.mjs must be re-run whenever .md changes; this catches drift.
    for (const name of ["system.ask.md", "system.agent.md"] as const) {
      const md = readFileSync(
        resolve(__dirname, `../src/prompts/${name}`),
        "utf8",
      ).replace(/\r\n/g, "\n");
      const embedded =
        name === "system.ask.md" ? _ASK_TEMPLATE : _AGENT_TEMPLATE;
      expect(embedded.replace(/\r\n/g, "\n")).toBe(md);
    }
  });
});

describe("renderPentestMethodologyContext — dynamic request context", () => {
  it("renders the full methodology as a standalone request-context block", () => {
    const full = renderPentestMethodologyContext();
    expect(full).toContain("# PENTEST METHODOLOGY");
    expect(full).toContain(
      "Choose each next action by expected information or access gain",
    );
    expect(full).toContain("**Attack-surface ledger:**");
    expect(full).toContain("candidate dimensions—not a compulsory sequence");
    expect(full).toContain("REPORTING");
    expect(full).not.toContain("# CROSS-OS AWARENESS");
    expect(full).not.toMatch(/\{\{[a-z_]+\}\}/);
  });

  it("keeps the always-on core loop in the sliced form and drops technique detail", () => {
    const sliced = renderPentestMethodologyContext({ full: false });
    const full = renderPentestMethodologyContext({ full: true });
    expect(sliced).toContain("# PENTEST METHODOLOGY");
    expect(sliced).toContain(
      "Continue while a realistic in-scope action can materially improve the result",
    );
    expect(sliced).toContain("**Attack-surface ledger:**");
    expect(sliced).not.toContain("**TECH STACK FINGERPRINTING:**");
    expect(sliced).not.toContain("candidate dimensions—not a compulsory sequence");
    expect(sliced.length).toBeLessThan(full.length);
  });

  it("does not leak into the cached coding constitution", () => {
    const coding = renderAgentSystemPrompt("shell.exec, fs.read");
    expect(coding).not.toContain("**Attack-surface ledger:**");
    expect(coding).not.toContain("# PENTEST METHODOLOGY");
  });
});
