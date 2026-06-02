import { describe, expect, it } from "vitest";
import {
  createSessionPolicy,
  isPreApprovalAllowedTool,
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
