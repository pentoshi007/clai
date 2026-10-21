import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildWorkspaceOrientation,
  classifyWorkIntent,
  detectPackageManager,
  discoverImmediateProjectRoots,
  extractScaffoldTargetName,
  guessProjectFolderName,
  isBareParentDirectory,
  isExistingProjectDir,
  isScaffoldCancelledOutput,
  resolveScaffoldTargetPath,
  scaffoldLooksMaterialized,
  scaffoldTargetConflictMessage,
  snapshotDir,
} from "../src/agent/workspace-orient.js";
import {
  clearActiveProjectRoot,
  setActiveProjectRoot,
  setActiveProjectRootIfValid,
  getActiveProjectRoot,
  resolveToolPath,
} from "../src/agent/project-root.js";
import { homedir } from "node:os";

describe("workspace orientation (stack-agnostic)", () => {
  const temps: string[] = [];
  afterEach(() => {
    clearActiveProjectRoot();
    for (const t of temps) {
      try {
        rmSync(t, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    temps.length = 0;
  });

  function tmpProject(withPkg = true): string {
    const dir = mkdtempSync(join(tmpdir(), "clai-ws-"));
    temps.push(dir);
    if (withPkg) writeFileSync(join(dir, "package.json"), '{"name":"x"}');
    return dir;
  }

  it("detects existing projects via markers", () => {
    const dir = tmpProject(true);
    expect(isExistingProjectDir(dir)).toBe(true);
    const empty = tmpProject(false);
    expect(isExistingProjectDir(empty)).toBe(false);
  });

  it("detects package manager from lockfiles", () => {
    const dir = tmpProject(true);
    expect(detectPackageManager(dir)).toBe("npm");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9");
    expect(detectPackageManager(dir)).toBe("pnpm");
    const text = buildWorkspaceOrientation({ cwd: dir, candidateProject: dir });
    expect(text).toMatch(/package manager \(from lockfile\/manifest\): pnpm/i);
  });

  it("snapshots dir entries and markers", () => {
    const dir = tmpProject(true);
    writeFileSync(join(dir, "README.md"), "hi");
    const snap = snapshotDir(dir);
    expect(snap.exists).toBe(true);
    expect(snap.isProject).toBe(true);
    expect(snap.markers).toContain("package.json");
    expect(snap.entries).toEqual(expect.arrayContaining(["package.json", "README.md"]));
  });

  it("buildWorkspaceOrientation includes cwd and existing subfolder", () => {
    const parent = mkdtempSync(join(tmpdir(), "clai-parent-"));
    temps.push(parent);
    const app = join(parent, "todo-app");
    mkdirSync(app);
    writeFileSync(join(app, "Cargo.toml"), "[package]\nname='x'");
    const text = buildWorkspaceOrientation({
      cwd: parent,
      destinationHint: parent,
      extraPaths: [app],
    });
    expect(text).toMatch(/WORKSPACE STATUS/);
    expect(text).toContain(app);
    expect(text).toMatch(/EXISTING PROJECT|Cargo\.toml/);
    expect(text).toMatch(/do NOT re-scaffold/i);
  });

  it("discovers arbitrary marker-bearing immediate projects under a bare destination", () => {
    const root = mkdtempSync(join(tmpdir(), "clai-destination-"));
    temps.push(root);
    const desktop = join(root, "Desktop");
    const blog = join(desktop, "blogging-app");
    const hidden = join(desktop, ".hidden-project");
    const dependencies = join(desktop, "node_modules");
    mkdirSync(blog, { recursive: true });
    mkdirSync(hidden, { recursive: true });
    mkdirSync(dependencies, { recursive: true });
    writeFileSync(join(blog, "package.json"), '{"name":"blogging-app"}');
    writeFileSync(join(hidden, "package.json"), '{"name":"hidden"}');
    writeFileSync(join(dependencies, "package.json"), '{"name":"noise"}');

    expect(discoverImmediateProjectRoots(desktop)).toEqual([blog]);
    const orientation = buildWorkspaceOrientation({
      cwd: root,
      destinationHint: desktop,
    });
    expect(orientation).toContain(blog);
    expect(orientation).toMatch(/discovered existing project under destination/i);
    const cwdOrientation = buildWorkspaceOrientation({ cwd: desktop });
    expect(cwdOrientation).toContain(blog);
    expect(cwdOrientation).not.toContain(hidden);
    expect(cwdOrientation).not.toContain(dependencies);
  });

  it("filters noise before applying the discovered-project result cap", () => {
    const root = mkdtempSync(join(tmpdir(), "clai-many-children-"));
    temps.push(root);
    const desktop = join(root, "Desktop");
    mkdirSync(desktop, { recursive: true });
    for (let index = 0; index < 100; index += 1) {
      mkdirSync(join(desktop, `a-noise-${String(index).padStart(3, "0")}`));
    }
    const project = join(desktop, "z-real-project");
    mkdirSync(project);
    writeFileSync(join(project, "go.mod"), "module example.com/real");

    expect(discoverImmediateProjectRoots(desktop, 1)).toEqual([project]);
  });

  it.each([
    ["create a watch website on my desktop folder", "new"],
    ["write a report on the scan results", "new"],
    ["create a weather app that shows current temperature and updates live", "new"],
    ["start a new project for a blog", "new"],
    ["fix the watch website on my desktop", "existing"],
    ["add a login page to my watch website", "existing"],
    ["continue the watch-website project", "existing"],
    ["create a new feature in this app", "existing"],
    ["make it faster", "existing"],
    ["explain the architecture", "unspecified"],
    ["yes go ahead", "unspecified"],
  ] as const)("classifies %j as %s work", (prompt, intent) => {
    expect(classifyWorkIntent(prompt)).toBe(intent);
  });

  it("marks namesake and discovered work as untargeted for new requests", () => {
    const root = mkdtempSync(join(tmpdir(), "clai-new-work-"));
    temps.push(root);
    const desktop = join(root, "Desktop");
    const existing = join(desktop, "watch-website");
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, "index.html"), "<html></html>");

    const fresh = buildWorkspaceOrientation({
      cwd: root,
      destinationHint: desktop,
      namesakePath: existing,
      intent: "new",
    });
    expect(fresh).toMatch(/Request intent: NEW work/);
    expect(fresh).toContain(`existing path with the requested name: ${existing}`);
    expect(fresh).toMatch(/EXISTING WORK — not the target of this new request/);
    expect(fresh).not.toMatch(/EXISTING PROJECT — do NOT re-scaffold/);

    const continuing = buildWorkspaceOrientation({
      cwd: root,
      destinationHint: desktop,
      namesakePath: existing,
      intent: "existing",
    });
    expect(continuing).toMatch(/Request intent: work on EXISTING/);
    expect(continuing).toMatch(/EXISTING PROJECT — do NOT re-scaffold/);
    expect(continuing).not.toMatch(/not the target of this new request/);
  });

  it("describes whether the cwd is the task folder", () => {
    const empty = tmpProject(false);
    expect(buildWorkspaceOrientation({ cwd: empty })).toMatch(
      /Process cwd role: empty folder — it is the task folder/,
    );
    mkdirSync(join(empty, ".clai"));
    expect(buildWorkspaceOrientation({ cwd: empty })).toMatch(
      /Process cwd role: empty folder — it is the task folder/,
    );
    const project = tmpProject(true);
    expect(buildWorkspaceOrientation({ cwd: project })).toMatch(
      /Process cwd role: inside existing work/,
    );
    const parent = mkdtempSync(join(tmpdir(), "clai-role-"));
    temps.push(parent);
    const desktop = join(parent, "Desktop");
    mkdirSync(desktop);
    expect(buildWorkspaceOrientation({ cwd: desktop })).toMatch(
      /Process cwd role: general parent folder/,
    );
  });

  it("guesses todo-app and blogging-app from natural language", () => {
    expect(
      guessProjectFolderName("create a react todo app in desktop directory"),
    ).toBe("todo-app");
    expect(
      guessProjectFolderName("create a react blogging app in desktop directory"),
    ).toBe("blogging-app");
    expect(guessProjectFolderName("build app in Desktop/my-api")).toBe("my-api");
  });

  it("extracts scaffold target names across stacks", () => {
    expect(
      extractScaffoldTargetName(
        "npm create vite@latest todo-app -- --template react",
      ),
    ).toBe("todo-app");
    expect(extractScaffoldTargetName("cargo new mycrate")).toBe("mycrate");
    expect(extractScaffoldTargetName("rails new blog")).toBe("blog");
    expect(extractScaffoldTargetName("poetry new svc")).toBe("svc");
  });

  it("resolves scaffold target under shell cwd", () => {
    expect(
      resolveScaffoldTargetPath(
        "npm create vite@latest todo-app -- --template react",
        "/Users/alice/Desktop",
      ),
    ).toBe("/Users/alice/Desktop/todo-app");
    expect(
      resolveScaffoldTargetPath("cargo new widget", "/tmp/work"),
    ).toBe("/tmp/work/widget");
    expect(
      resolveScaffoldTargetPath("go mod init github.com/a/b", "/tmp/proj"),
    ).toBe("/tmp/proj");
  });

  it("resolves cd Desktop && create vite name to Desktop/name not Desktop", () => {
    expect(
      extractScaffoldTargetName(
        "cd /Users/alice/Desktop && npm create vite@latest blogging-app -- --template react",
      ),
    ).toBe("blogging-app");
    expect(
      resolveScaffoldTargetPath(
        "cd /Users/alice/Desktop && npm create vite@latest blogging-app -- --template react",
      ),
    ).toBe("/Users/alice/Desktop/blogging-app");
    expect(
      scaffoldTargetConflictMessage(
        "cd /Users/alice/Desktop && npm create vite@latest brand-new-xyz -- --template react",
      ),
    ).toBeUndefined();
  });

  it("resolves cd && create . chained shell commands", () => {
    expect(
      resolveScaffoldTargetPath(
        "mkdir -p /Users/alice/Desktop/todo-app && cd /Users/alice/Desktop/todo-app && npm init vite@latest . -- --template react",
        "/Users/alice/Desktop/clai",
      ),
    ).toBe("/Users/alice/Desktop/todo-app");
  });

  it("strips quotes from cd/mkdir targets so scaffold post-check finds the real path", () => {
    expect(
      resolveScaffoldTargetPath(
        'mkdir -p "/Users/alice/Desktop/blogging-app" && cd "/Users/alice/Desktop/blogging-app" && npm create vite@latest . -- --template react',
        "/Users/alice/Desktop/clai",
      ),
    ).toBe("/Users/alice/Desktop/blogging-app");
  });

  it("detects cancelled scaffold output", () => {
    expect(isScaffoldCancelledOutput("└  Operation cancelled")).toBe(true);
    expect(isScaffoldCancelledOutput("Scaffolding project in /tmp/x...")).toBe(
      false,
    );
  });

  it("blocks scaffold into existing non-empty project", () => {
    const dir = tmpProject(true);
    const parent = join(dir, "..");
    const name = dir.split(/[/\\]/).pop()!;
    // Command creates sibling-looking name under parent - use absolute path form
    const msg = scaffoldTargetConflictMessage(
      `npm create vite@latest ${dir} -- --template react`,
      parent,
    );
    expect(msg).toMatch(/already exists/i);
    expect(msg).toMatch(/CONTINUE/i);
  });

  it("allows scaffold into missing path", () => {
    const parent = mkdtempSync(join(tmpdir(), "clai-empty-"));
    temps.push(parent);
    const msg = scaffoldTargetConflictMessage(
      "npm create vite@latest brand-new-app -- --template react",
      parent,
    );
    expect(msg).toBeUndefined();
  });

  it("scaffoldLooksMaterialized requires real tree", () => {
    const dir = tmpProject(true);
    expect(scaffoldLooksMaterialized(dir)).toBe(true);
    expect(scaffoldLooksMaterialized(join(dir, "nope"))).toBe(false);
  });

  it("refuses to pin bare Desktop as active project root", () => {
    const desk = join(homedir(), "Desktop");
    expect(isBareParentDirectory(desk)).toBe(true);
    setActiveProjectRoot(desk);
    expect(getActiveProjectRoot()).toBeUndefined();
    expect(setActiveProjectRootIfValid(desk)).toBe(false);
  });

  it("pins existing project and resolves relative paths there", () => {
    const dir = tmpProject(true);
    expect(setActiveProjectRootIfValid(dir)).toBe(true);
    expect(resolveToolPath("src/main.rs")).toBe(join(dir, "src/main.rs"));
  });

  it("does not pin non-existent invented project path", () => {
    const fake = join(homedir(), "Desktop", "definitely-not-real-xyz-999");
    if (existsSync(fake)) {
      // skip weird environments
      return;
    }
    expect(setActiveProjectRootIfValid(fake)).toBe(false);
    expect(getActiveProjectRoot()).toBeUndefined();
  });
});
