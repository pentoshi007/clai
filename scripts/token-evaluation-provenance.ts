import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixtureInstructions, type TokenFixture } from "./token-overhead-fixtures.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
export async function evaluationSnapshot(checkout: string, surfaces: readonly string[] = ["src", "scripts", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.token-audit.json"]): Promise<string> {
  const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...surfaces],
    { cwd: checkout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  const hash = createHash("sha256");
  for (const path of [...new Set(paths.split("\0").filter(Boolean))].sort()) {
    hash.update(`${path}\0`);
    try {
      hash.update(createHash("sha256").update(await readFile(join(checkout, path))).digest());
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      hash.update("missing");
    }
  }
  return hash.digest("hex");
}

export function assertEvaluationSnapshot(expected: string, actual: string): void {
  if (expected !== actual) throw new Error("Evaluation source/harness changed during collection; retained trials are not a frozen comparison");
}
export async function evaluationProvenance(checkout: string, fixture: TokenFixture, selection?: { readonly id: string; readonly digest: string }) {
  let revision: string | null = null;
  let sourceDiffSha256: string | null = null;
  try {
    revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    sourceDiffSha256 = digest(execFileSync("git", ["diff", "HEAD", "--", "src"], { cwd: checkout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {}
  const sourceDigests = await Promise.all(["src/prompts/system.agent.md", "src/prompts/system.ask.md", "src/prompts/embedded.ts", "src/agent/runner.ts", "src/agent/turn/loop/round-request.ts"].map(async (path) =>
    ({ path, sha256: digest(await readFile(join(checkout, path), "utf8")) })));
  return { revision, sourceDiffSha256, profile: selection?.id ?? "legacy", profileDigest: selection?.digest ?? null, sourceDigests, fixtureSha256: digest(JSON.stringify({ name: fixture.name,
    prompts: fixture.prompts, files: fixture.files, fixtureInstructions, hiddenAssertions: fixture.hiddenAssertions, turnAssertions: fixture.turnAssertions,
    verify: String(fixture.verify), prepare: fixture.prepare ? String(fixture.prepare) : null })), node: process.version, platform: process.platform, architecture: process.arch };
}
