import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertEvaluationSnapshot, evaluationSnapshot } from "../../scripts/token-evaluation-provenance.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("pins tracked and untracked source, harness and dependency bytes and rejects mutation, addition or deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-snapshot-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  await Promise.all(["src", "scripts"].map((path) => mkdir(join(root, path))));
  await writeFile(join(root, "src", "tracked.ts"), "export const value = 1;\n");
  execFileSync("git", ["add", "src"], { cwd: root });
  const initial = await evaluationSnapshot(root);
  expect(await evaluationSnapshot(root)).toBe(initial);
  expect(() => assertEvaluationSnapshot(initial, initial)).not.toThrow();
  await writeFile(join(root, "src", "tracked.ts"), "export const value = 2;\n");
  expect(() => assertEvaluationSnapshot(initial, "changed")).toThrow("changed during collection");
  expect(await evaluationSnapshot(root)).not.toBe(initial);
  await writeFile(join(root, "src", "tracked.ts"), "export const value = 1;\n");
  expect(await evaluationSnapshot(root)).toBe(initial);
  for (const path of ["src/untracked.ts", "scripts/verifier.ts", "package-lock.json", "tsconfig.json"]) {
    await writeFile(join(root, path), "changed");
    expect(await evaluationSnapshot(root), path).not.toBe(initial);
    await rm(join(root, path));
    expect(await evaluationSnapshot(root), path).toBe(initial);
  }
  await writeFile(join(root, "README.md"), "independent delivery notes");
  expect(await evaluationSnapshot(root)).toBe(initial);
  await rm(join(root, "src", "tracked.ts"));
  expect(await evaluationSnapshot(root)).not.toBe(initial);
});
