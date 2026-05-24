import { describe, expect, it } from "vitest";
import { createSessionPolicy } from "../src/agent/runner.js";
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
