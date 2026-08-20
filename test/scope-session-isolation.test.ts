import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  addScopeTargets,
  addSessionScopeTargets,
  clearScope,
  clearSessionScope,
  getSessionScopePath,
  loadScope,
  loadScopeForSession,
  releaseSessionScope,
  replaceScopeTargets,
  replaceSessionScopeTargets,
  resetScopeCache,
  resetSessionScopeCache,
  saveSessionScope,
  type EngagementScope,
} from "../src/store/scope.js";

const SESSION_A = "sess-aaaa1111";
const SESSION_B = "sess-bbbb2222";

let scopeDir: string;

function scope(targets: string[]): EngagementScope {
  const now = new Date().toISOString();
  return { authorizedTargets: targets, createdAt: now, updatedAt: now };
}

async function targetsFor(sessionId: string | undefined): Promise<string[] | undefined> {
  return (await loadScopeForSession(sessionId))?.authorizedTargets;
}

beforeEach(async () => {
  scopeDir = mkdtempSync(join(tmpdir(), "clai-scope-bindings-"));
  process.env.CLAI_SCOPE_DIR = scopeDir;
  resetScopeCache();
  await clearScope();
  resetScopeCache();
});

afterEach(async () => {
  resetScopeCache();
  await clearScope();
  delete process.env.CLAI_SCOPE_DIR;
  await rm(scopeDir, { recursive: true, force: true });
});

describe("scope is bound to the session that set it", () => {
  it("does not leak a session's scope into another session", async () => {
    await saveSessionScope(SESSION_A, scope(["lab.example"]));
    expect(await targetsFor(SESSION_A)).toEqual(["lab.example"]);
    expect(await targetsFor(SESSION_B)).toBeUndefined();
  });

  it("keeps two sessions on independent target lists", async () => {
    await addSessionScopeTargets(SESSION_A, ["a.example"]);
    await addSessionScopeTargets(SESSION_B, ["b.example"]);
    await addSessionScopeTargets(SESSION_A, ["a2.example"]);

    expect((await targetsFor(SESSION_A))?.sort()).toEqual(["a.example", "a2.example"]);
    expect(await targetsFor(SESSION_B)).toEqual(["b.example"]);
  });

  it("survives a cache reset by reading the binding back from disk", async () => {
    await replaceSessionScopeTargets(SESSION_A, ["disk.example"]);
    resetSessionScopeCache();
    expect(await targetsFor(SESSION_A)).toEqual(["disk.example"]);
    expect(await targetsFor(SESSION_B)).toBeUndefined();
  });

  it("writes one envelope file per session id", async () => {
    await saveSessionScope(SESSION_A, scope(["lab.example"]));
    const raw = JSON.parse(await readFile(getSessionScopePath(SESSION_A), "utf8")) as {
      version: number;
      sessionId: string;
      scope: EngagementScope | null;
    };
    expect(raw.version).toBe(1);
    expect(raw.sessionId).toBe(SESSION_A);
    expect(raw.scope?.authorizedTargets).toEqual(["lab.example"]);
  });

  it("keeps a path-hostile session id inside the scope directory", () => {
    const path = getSessionScopePath("../../escape/../id with spaces");
    expect(dirname(resolve(path))).toBe(resolve(scopeDir));
    expect(basename(path)).not.toContain("/");
  });
});

describe("global CLI scope only seeds unbound sessions", () => {
  it("is inherited by a session that never ran /scope", async () => {
    await replaceScopeTargets(["global.example"]);
    resetScopeCache();
    expect(await targetsFor(SESSION_A)).toEqual(["global.example"]);
    expect(await targetsFor(undefined)).toEqual(["global.example"]);
  });

  it("is ignored once the session has its own binding", async () => {
    await replaceScopeTargets(["global.example"]);
    resetScopeCache();
    await saveSessionScope(SESSION_A, scope(["session.example"]));
    expect(await targetsFor(SESSION_A)).toEqual(["session.example"]);
    expect(await targetsFor(SESSION_B)).toEqual(["global.example"]);
  });

  it("is not re-inherited after an explicit clear in that session", async () => {
    await replaceScopeTargets(["global.example"]);
    resetScopeCache();
    await addSessionScopeTargets(SESSION_A, ["session.example"]);
    await clearSessionScope(SESSION_A);

    expect(await targetsFor(SESSION_A)).toBeUndefined();
    resetSessionScopeCache();
    expect(await targetsFor(SESSION_A)).toBeUndefined();
    expect(await targetsFor(SESSION_B)).toEqual(["global.example"]);
  });

  it("stays untouched when a session writes its own scope", async () => {
    await replaceScopeTargets(["global.example"]);
    resetScopeCache();
    await replaceSessionScopeTargets(SESSION_A, ["session.example"]);
    resetScopeCache();
    expect((await loadScope())?.authorizedTargets).toEqual(["global.example"]);
  });

  it("still accepts CLI mutations while sessions are bound", async () => {
    await saveSessionScope(SESSION_A, scope(["session.example"]));
    await addScopeTargets(["global.example"]);
    resetScopeCache();
    expect((await loadScope())?.authorizedTargets).toEqual(["global.example"]);
    expect(await targetsFor(SESSION_A)).toEqual(["session.example"]);
  });
});

describe("session teardown releases the binding", () => {
  it("re-inherits the global default after the binding is released", async () => {
    await replaceScopeTargets(["global.example"]);
    resetScopeCache();
    await saveSessionScope(SESSION_A, scope(["session.example"]));
    expect(await targetsFor(SESSION_A)).toEqual(["session.example"]);

    await releaseSessionScope(SESSION_A);
    expect(await targetsFor(SESSION_A)).toEqual(["global.example"]);
  });

  it("is safe to release a session that never had a binding", async () => {
    await expect(releaseSessionScope("sess-never-bound")).resolves.toBeUndefined();
  });
});

describe("session scope mutators", () => {
  it("clears the binding when replace is given no usable targets", async () => {
    await addSessionScopeTargets(SESSION_A, ["a.example"]);
    expect(await replaceSessionScopeTargets(SESSION_A, ["   "])).toBeUndefined();
    expect(await targetsFor(SESSION_A)).toBeUndefined();
  });

  it("rejects an add with no usable targets", async () => {
    await expect(addSessionScopeTargets(SESSION_A, ["  "])).rejects.toThrow(/No valid targets/);
  });

  it("preserves createdAt across mutations and moves updatedAt forward", async () => {
    const first = await addSessionScopeTargets(SESSION_A, ["a.example"]);
    const second = await addSessionScopeTargets(SESSION_A, ["b.example"]);
    expect(second.createdAt).toBe(first.createdAt);
    expect(Date.parse(second.updatedAt!)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt!));
  });

  it("drops a scope that carries no authorized targets", async () => {
    expect(await saveSessionScope(SESSION_A, scope([]))).toBeUndefined();
    expect(await targetsFor(SESSION_A)).toBeUndefined();
  });

  it("ignores a corrupt binding file instead of throwing", async () => {
    await saveSessionScope(SESSION_A, scope(["lab.example"]));
    resetSessionScopeCache();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(getSessionScopePath(SESSION_A), "{ not json", "utf8");
    resetSessionScopeCache();
    await expect(targetsFor(SESSION_A)).resolves.toBeUndefined();
  });
});
