import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import {
  saveScope,
  clearScope,
  loadScope,
  isScopeActive,
  targetInScope,
  resetScopeCache,
  getScopePath,
  type EngagementScope,
} from "../src/store/scope.js";
import { classifyToolCall } from "../src/safety/classifier.js";

// The scope file path is computed at module-load time from the real
// $HOME, so the persistence round-trip below uses the real
// ~/.clai/scope.json. To avoid clobbering an active engagement on the
// dev machine, back the file up before the test and restore it after.
const scopePath = getScopePath();
const backupPath = `${scopePath}.scope-test-backup`;

beforeAll(async () => {
  if (existsSync(scopePath)) {
    await copyFile(scopePath, backupPath);
  }
});

afterAll(async () => {
  if (existsSync(backupPath)) {
    await copyFile(backupPath, scopePath);
    await rm(backupPath, { force: true });
  } else if (existsSync(scopePath)) {
    await rm(scopePath, { force: true });
  }
  resetScopeCache();
});

describe("phase 10 — scope helpers", () => {
  it("isScopeActive returns false for missing or empty scope", () => {
    expect(isScopeActive(undefined)).toBe(false);
    expect(isScopeActive({ authorizedTargets: [] })).toBe(false);
  });

  it("isScopeActive returns false when expiresAt is past", () => {
    const scope: EngagementScope = {
      authorizedTargets: ["example.com"],
      expiresAt: "2000-01-01T00:00:00Z",
    };
    expect(isScopeActive(scope)).toBe(false);
  });

  it("targetInScope matches exact, subdomain, and CIDR entries", () => {
    const scope: EngagementScope = {
      authorizedTargets: ["example.com", "10.0.0.0/24"],
    };
    expect(targetInScope("example.com", scope)).toBe(true);
    expect(targetInScope("api.example.com", scope)).toBe(true);
    expect(targetInScope("EXAMPLE.com", scope)).toBe(true);
    expect(targetInScope("10.0.0.5", scope)).toBe(true);
    expect(targetInScope("10.0.1.5", scope)).toBe(false);
    expect(targetInScope("evil.com", scope)).toBe(false);
  });

  it("targetInScope respects excludedTargets", () => {
    const scope: EngagementScope = {
      authorizedTargets: ["example.com"],
      excludedTargets: ["billing.example.com"],
    };
    expect(targetInScope("api.example.com", scope)).toBe(true);
    expect(targetInScope("billing.example.com", scope)).toBe(false);
  });
});

describe("phase 10 — classifier scope gating", () => {
  it("blocks public net.scan without a scope", () => {
    const result = classifyToolCall({
      name: "net.scan",
      args: { target: "example.com" },
    });
    expect(result.level).toBe("block");
    expect(result.reason).toMatch(/scope/i);
  });

  it("permits public net.scan when scope covers the target", () => {
    const scope: EngagementScope = {
      authorizedTargets: ["example.com"],
    };
    const result = classifyToolCall(
      { name: "net.scan", args: { target: "api.example.com" } },
      { scope },
    );
    expect(result.level).toBe("confirm");
  });

  it("blocks pentest.recon when target is out of scope", () => {
    const scope: EngagementScope = {
      authorizedTargets: ["myco.com"],
    };
    const result = classifyToolCall(
      { name: "pentest.recon", args: { target: "evil.com" } },
      { scope },
    );
    expect(result.level).toBe("block");
  });

  it("does not bypass scope when shell.exec contains legacy --i-own-this", () => {
    const result = classifyToolCall({
      name: "shell.exec",
      args: { command: "nmap --i-own-this 8.8.8.8" },
    });
    expect(result.level).toBe("block");
    expect(result.reason).toMatch(/scope/i);
  });

  it("permits shell.exec public scan when the trailing target is in scope", () => {
    const scope: EngagementScope = {
      authorizedTargets: ["8.8.8.8"],
    };
    const result = classifyToolCall(
      { name: "shell.exec", args: { command: "nmap 8.8.8.8" } },
      { scope },
    );
    expect(result.level).toBe("confirm");
  });

  it("private targets do not need a scope", () => {
    const result = classifyToolCall({
      name: "net.scan",
      args: { target: "192.168.1.1" },
    });
    expect(result.level).toBe("confirm");
  });
});

describe("phase 10 — scope persistence round-trip", () => {
  it("saveScope + loadScope returns the saved value", async () => {
    await saveScope({
      name: "test-engagement",
      authorizedTargets: ["example.com", "10.0.0.0/24"],
      excludedTargets: ["billing.example.com"],
      authorizationNote: "test",
    });
    resetScopeCache();
    const loaded = await loadScope();
    expect(loaded?.name).toBe("test-engagement");
    expect(loaded?.authorizedTargets).toEqual(["example.com", "10.0.0.0/24"]);
    expect(loaded?.excludedTargets).toEqual(["billing.example.com"]);
  });

  it("clearScope wipes the cached scope", async () => {
    await saveScope({ authorizedTargets: ["example.com"] });
    await clearScope();
    resetScopeCache();
    const loaded = await loadScope();
    expect(loaded).toBeUndefined();
  });
});
