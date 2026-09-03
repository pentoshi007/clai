import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const releaseWorkflow = readFileSync(
  join(root, ".github/workflows/release.yml"),
  "utf8",
);

function validateJob(): string {
  const start = releaseWorkflow.indexOf("  validate:");
  const end = releaseWorkflow.indexOf("\n  build:");
  return releaseWorkflow.slice(start, end);
}

describe("release identity gate (REL-002)", () => {
  it("verifies tag and package version in the job every build depends on", () => {
    const validate = validateJob();
    expect(validate).toContain("Verify tag matches package.json version");
    expect(validate).toContain("refusing to release");
    // build/publish must be gated on validate, not on the npm-token job.
    // build additionally requires a green CI run on the same commit so a tag
    // can never ship while CI is red.
    expect(releaseWorkflow).toMatch(/build:\n\s+needs: \[validate, ci-gate\]/);
    expect(releaseWorkflow).toMatch(/publish:\n\s+needs: build/);
    expect(releaseWorkflow).toContain("Require green CI on this commit");
  });
});

describe("generated prompt drift gate (REL-003)", () => {
  it("checks embedded prompts in the same checkout that builds binaries", () => {
    expect(validateJob()).toContain("npm run embed-prompts:check");
  });

  it("passes for the committed tree and fails on drift", () => {
    expect(() =>
      execFileSync(process.execPath, ["scripts/embed-prompts.mjs", "--check"], {
        cwd: root,
        stdio: "pipe",
      }),
    ).not.toThrow();

    const backupDir = mkdtempSync(join(tmpdir(), "clai-prompt-drift-"));
    const generated = join(root, "src/prompts/embedded.ts");
    const backup = join(backupDir, "embedded.ts");
    copyFileSync(generated, backup);
    try {
      writeFileSync(
        generated,
        readFileSync(generated, "utf8").replace(
          "export const EMBEDDED_PROMPTS",
          "export const EMBEDDED_PROMPTS /* drifted */",
        ),
      );
      let failed = false;
      try {
        execFileSync(process.execPath, ["scripts/embed-prompts.mjs", "--check"], {
          cwd: root,
          stdio: "pipe",
        });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    } finally {
      copyFileSync(backup, generated);
    }
  });
});
