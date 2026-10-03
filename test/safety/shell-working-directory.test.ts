import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearActiveProjectRoot, setActiveProjectRoot } from "../../src/agent/project-root.js";
import { filesystemPermission } from "../../src/safety/filesystem-permissions.js";
import type { PermissionMode } from "../../src/safety/permission-mode.js";

let base: string;
let project: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "clai-shell-cwd-"));
  project = join(base, "project");
  outside = join(base, "outside");
  mkdirSync(project);
  mkdirSync(outside);
  symlinkSync(outside, join(project, "escape"));
  setActiveProjectRoot(project);
});

afterEach(() => {
  clearActiveProjectRoot();
  rmSync(base, { recursive: true, force: true });
});

function permission(command: string, mode: PermissionMode, cwd: string) {
  return filesystemPermission({ name: "shell.exec", args: { command, cwd } }, mode);
}

describe("a shell working directory that does not exist yet", () => {
  const missing = (root: string) => join(root, "not-created-yet");

  it.each(["allow-all", "default"] as const)("does not force a prompt in %s mode for a command that deletes nothing", (mode) => {
    expect(permission("npm create vite@latest app -- --template react", mode, missing(project))).toBeUndefined();
  });

  it("scopes a deletion by where the missing directory would live", () => {
    expect(permission("rm file.txt", "allow-all", missing(project))).toBe("allow");
    expect(permission("rm file.txt", "allow-all", missing(outside))).toBe("confirm");
    expect(permission("rm file.txt", "default", missing(project))).toBe("confirm");
  });

  it("resolves a missing directory beneath a symlink to its physical location", () => {
    expect(permission("rm file.txt", "allow-all", join(project, "escape", "not-created-yet"))).toBe("confirm");
  });

  it("still resolves traversal through a symlink before collapsing parent segments", () => {
    expect(permission("rm victim.txt", "allow-all", `${project}/escape/..`)).toBe("confirm");
  });

  it("fails closed when the directory cannot be inspected", () => {
    expect(permission("rm file.txt", "allow-all", `${project}/\0invalid`)).toBe("confirm");
  });

  it("resolves a relative directory against the physical process directory", () => {
    const previous = process.cwd();
    process.chdir(project);
    try {
      expect(permission("rm file.txt", "allow-all", "not-created-yet")).toBe("allow");
      expect(permission("rm file.txt", "allow-all", "escape/not-created-yet")).toBe("confirm");
    } finally {
      process.chdir(previous);
    }
  });
});
