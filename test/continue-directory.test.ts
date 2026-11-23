import { mkdtempSync, symlinkSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getSession, upsertSession } from "../src/store/history.js";
import { createCompositionRoot } from "../src/ui-core/bootstrap/composition-root.js";
import { applySessionResume, resolveResumeTarget } from "../src/ui-core/bootstrap/session-resume.js";
import { detectCapabilities } from "../src/ui-core/bootstrap/capabilities.js";

const keys = ["CLAI_DATA_DIR", "CLAI_HISTORY_DIR", "CLAI_CONFIG_DIR", "CLAI_PLAN_DIR", "CLAI_LOG_DIR", "CLAI_ARTIFACT_DIR", "CLAI_JOBS_DIR", "CLAI_DISABLE_KEYCHAIN"] as const;
let dir: string;
const saved = new Map<string, string | undefined>();
const originalCwd = process.cwd();

const seed = (id: string, content: string, cwd: string) =>
  upsertSession(id, [{ role: "user", content }], content, undefined, undefined, undefined, undefined, undefined, undefined, { cwd });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "clai-continue-"));
  for (const key of keys) saved.set(key, process.env[key]);
  process.env.CLAI_DATA_DIR = dir;
  process.env.CLAI_HISTORY_DIR = join(dir, "history");
  process.env.CLAI_CONFIG_DIR = dir;
  process.env.CLAI_PLAN_DIR = join(dir, "plans");
  process.env.CLAI_LOG_DIR = join(dir, "logs");
  process.env.CLAI_ARTIFACT_DIR = join(dir, "artifacts");
  process.env.CLAI_JOBS_DIR = join(dir, "jobs");
  process.env.CLAI_DISABLE_KEYCHAIN = "1";
  for (const name of ["here", "elsewhere", "empty", "real"]) {
    await mkdir(join(dir, name), { recursive: true });
  }
  symlinkSync(join(dir, "real"), join(dir, "linked"));
});

afterAll(async () => {
  process.chdir(originalCwd);
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

it("resumes the latest session for the current directory, not the latest overall", async () => {
  await seed("here-old", "here old", join(dir, "here"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await seed("elsewhere-new", "elsewhere", join(dir, "elsewhere"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await seed("here-new", "here new", join(dir, "here"));

  process.chdir(join(dir, "here"));
  const resolved = await resolveResumeTarget({ kind: "latest" });
  expect(resolved.error).toBeUndefined();
  expect(resolved.record?.id).toBe("here-new");
});

it("never opens a session from another directory", async () => {
  process.chdir(join(dir, "empty"));
  const resolved = await resolveResumeTarget({ kind: "latest" });
  expect(resolved.record).toBeUndefined();
  expect(resolved.error).toBeUndefined();
});

it("bare resume still picks the newest session across directories", async () => {
  process.chdir(join(dir, "empty"));
  const resolved = await resolveResumeTarget({ kind: "latest", scope: "global" });
  expect(resolved.record?.id).toBe("here-new");
});

it("matches a session stored through a symlinked path", async () => {
  await seed("linked-session", "linked", join(dir, "linked"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await seed("newer-elsewhere", "newer", join(dir, "elsewhere"));
  process.chdir(join(dir, "real"));
  const resolved = await resolveResumeTarget({ kind: "latest" });
  expect(resolved.record?.id).toBe("linked-session");
});

it("keeps the directory a resumed session belongs to", async () => {
  process.chdir(join(dir, "elsewhere"));
  const services = createCompositionRoot({
    capabilities: detectCapabilities({ env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns: 120, rows: 30 }),
  });
  try {
    await applySessionResume(services, (await getSession("here-new"))!);
    services.session.setModel("changed-model");
    await services.session.persistNow();
  } finally {
    services.dispose();
  }
  expect((await getSession("here-new"))?.cwd).toBe(join(dir, "here"));
});
