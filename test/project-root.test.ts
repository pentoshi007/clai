import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join, parse } from "node:path";
import { homedir } from "node:os";
import {
  clearActiveProjectRoot,
  extractProjectRootFromScaffold,
  extractProjectRootFromText,
  getActiveProjectRoot,
  remapAgentCwdWrite,
  resolveToolPath,
  setActiveProjectRoot,
} from "../src/agent/project-root.js";
import { safeCwd } from "../src/os/cwd.js";
import { isOutsideWorkingDirectory } from "../src/tools/fs.js";

const notTheTempDirectory = (): void => {
  const elsewhere = join(parse(process.cwd()).root, "clai-not-the-temp-directory");
  for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, elsewhere);
};

describe("project root sticky paths", () => {
  afterEach(() => {
    clearActiveProjectRoot();
    vi.unstubAllEnvs();
  });

  it("extracts Desktop/todo-app from plan-like text", () => {
    const root = extractProjectRootFromText(
      "Scaffold Vite React project in /Users/aniketpandey/Desktop/todo-app",
    );
    expect(root).toBe("/Users/aniketpandey/Desktop/todo-app");
  });

  it("extracts from create-vite command + Desktop cwd", () => {
    const root = extractProjectRootFromScaffold(
      "npm create vite@latest todo-app -- --template react",
      "/Users/aniketpandey/Desktop",
    );
    expect(root).toBe("/Users/aniketpandey/Desktop/todo-app");
  });

  it("resolves relative fs paths under project root not agent cwd", () => {
    const project = join(homedir(), "Desktop", "todo-app");
    setActiveProjectRoot(project);
    expect(resolveToolPath("src/App.jsx")).toBe(join(project, "src/App.jsx"));
    expect(resolveToolPath("src/App.jsx")).not.toContain("/clai/src/");
  });

  it("keeps an absolute user path absolute even while a project root is pinned", () => {
    setActiveProjectRoot(join(homedir(), "Desktop", "todo-app"));
    const requested = join(homedir(), "Desktop", "3d", "src", "city.js");
    expect(resolveToolPath(requested)).toBe(requested);
  });

  it("remaps agent-cwd absolute src writes onto project root", () => {
    const project = join(homedir(), "Desktop", "todo-app");
    const agent = safeCwd();
    setActiveProjectRoot(project);
    const wrong = join(agent, "src", "App.jsx");
    const fixed = remapAgentCwdWrite(wrong, "src/App.jsx");
    expect(fixed).toBe(join(project, "src", "App.jsx"));
  });

  it("set/get active root", () => {
    setActiveProjectRoot("/tmp/my-app");
    expect(getActiveProjectRoot()).toBe("/tmp/my-app");
  });

  it("treats the pinned project as trusted for allow-all write decisions", () => {
    notTheTempDirectory();
    const project = join(homedir(), "Desktop", "bloging-app");
    setActiveProjectRoot(project);

    expect(isOutsideWorkingDirectory(join(project, "src", "App.tsx"))).toBe(false);
    expect(
      isOutsideWorkingDirectory(join(homedir(), "Desktop", "unrelated-app", "App.tsx")),
    ).toBe(true);
  });

  it("forces confirmation when an in-project symlink escapes the project root", () => {
    notTheTempDirectory();
    const base = mkdtempSync(join(homedir(), "clai-project-root-test-"));
    const project = join(base, "project");
    const sibling = join(base, "sibling");
    try {
      mkdirSync(project);
      mkdirSync(sibling);
      symlinkSync(sibling, join(project, "linked-sibling"));
      setActiveProjectRoot(project);

      expect(
        isOutsideWorkingDirectory(join(project, "linked-sibling", "config.ts")),
      ).toBe(true);
    } finally {
      clearActiveProjectRoot();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("does not pin bare Desktop as sticky root", () => {
    setActiveProjectRoot(join(homedir(), "Desktop"));
    expect(getActiveProjectRoot()).toBeUndefined();
  });

  it("extracts cargo/rails style paths via scaffold helper", () => {
    const root = extractProjectRootFromScaffold(
      "cargo new widget",
      "/Users/aniketpandey/Desktop",
    );
    expect(root).toBe("/Users/aniketpandey/Desktop/widget");
  });
});
