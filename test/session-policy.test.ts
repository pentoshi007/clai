import { describe, expect, it } from "vitest";
import {
  createSessionPolicy,
  isPreApprovalAllowedTool,
  isPlanApprovedByStatus,
  planHasOpenWork,
} from "../src/agent/runner.js";
import { getConfig } from "../src/store/config.js";

describe("phase 1 — session policy", () => {
  it("createSessionPolicy returns an empty session", () => {
    const policy = createSessionPolicy();
    expect(policy.allow.size).toBe(0);
    expect(policy.pentestAuthorized.value).toBe(false);
  });

  it("config.pentestAuthorized is not silently flipped by creating a policy", () => {
    // Snapshot config; -y must not have ever touched it.
    const before = getConfig().pentestAuthorized;
    createSessionPolicy();
    const after = getConfig().pentestAuthorized;
    expect(after).toBe(before);
  });

  it("session allow is independent across instances", () => {
    const a = createSessionPolicy();
    const b = createSessionPolicy();
    a.allow.add("shell.exec");
    expect(b.allow.has("shell.exec")).toBe(false);
  });

  it("session pentestAuthorized is independent across instances", () => {
    const a = createSessionPolicy();
    const b = createSessionPolicy();
    a.pentestAuthorized.value = true;
    expect(b.pentestAuthorized.value).toBe(false);
  });

});

describe("plan-awaiting-approval gate — allowed tools", () => {
  it("permits only plan + read-only exploration before /implement", () => {
    // These let the agent (re)plan and gather context to refine a plan.
    for (const tool of [
      "plan.create",
      "task.update",
      "fs.read",
      "fs.list",
      "fs.search",
      "sysinfo",
      "tool.batch",
      "net.context",
    ]) {
      expect(isPreApprovalAllowedTool(tool)).toBe(true);
    }
  });

  it("blocks execution/mutation tools until the plan is approved", () => {
    // A free-text message after a plan is a REVISION, not a 'go' signal, so
    // none of these may run before /implement.
    for (const tool of [
      "shell.exec",
      "shell.start",
      "pkg.install",
      "fs.write",
      "fs.writeMany",
      "fs.edit",
      "fs.delete",
      "net.scan",
      "pentest.recon",
      "tool.check",
      "http.fetch",
      "web.fetch",
      "net.pingSweep",
    ]) {
      expect(isPreApprovalAllowedTool(tool)).toBe(false);
    }
  });
});

describe("isPlanApprovedByStatus — resumed-session plan gate", () => {
  it("treats any non-draft status as approved (the plan already ran /implement)", () => {
    // Regression: session.planApproved is in-memory only and resets to false
    // on every fresh SessionPolicy (a /history resume, or a new policy after
    // context compaction). The gate must instead trust the plan's own
    // persisted status, which survives a resume.
    expect(isPlanApprovedByStatus("approved")).toBe(true);
    expect(isPlanApprovedByStatus("in_progress")).toBe(true);
    expect(isPlanApprovedByStatus("completed")).toBe(true);
    expect(isPlanApprovedByStatus("abandoned")).toBe(true);
  });

  it("treats a draft plan as NOT approved", () => {
    expect(isPlanApprovedByStatus("draft")).toBe(false);
  });
});

describe("planHasOpenWork — act-don't-narrate nudge scoping", () => {
  it("is false once the plan's own status is completed", () => {
    // Regression: after a pentest/build plan finished, a plain follow-up
    // question (e.g. "what do you know so far") kept getting force-nudged
    // into emitting another tool call instead of being answered, because
    // the nudge treated ANY approved plan as still needing action.
    expect(planHasOpenWork("completed")).toBe(false);
  });

  it("is true for a plan still in progress or only approved", () => {
    expect(planHasOpenWork("approved")).toBe(true);
    expect(planHasOpenWork("in_progress")).toBe(true);
    expect(planHasOpenWork("draft")).toBe(true);
  });

  it("is false when there is no active plan at all", () => {
    expect(planHasOpenWork(undefined)).toBe(false);
  });
});
