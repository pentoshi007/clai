import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getSession, listSessionSummaries, upsertSession } from "../src/store/history.js";
import { createCompositionRoot } from "../src/ui-core/bootstrap/composition-root.js";
import { applySessionResume } from "../src/ui-core/bootstrap/session-resume.js";
import { detectCapabilities } from "../src/ui-core/bootstrap/capabilities.js";

const keys = ["CLAI_DATA_DIR", "CLAI_HISTORY_DIR", "CLAI_CONFIG_DIR", "CLAI_PLAN_DIR", "CLAI_LOG_DIR", "CLAI_ARTIFACT_DIR", "CLAI_JOBS_DIR", "CLAI_DISABLE_KEYCHAIN"] as const;
let dir: string;
const saved = new Map<string, string | undefined>();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "clai-recency-"));
  for (const key of keys) saved.set(key, process.env[key]);
  process.env.CLAI_DATA_DIR = dir;
  process.env.CLAI_HISTORY_DIR = join(dir, "history");
  process.env.CLAI_CONFIG_DIR = dir;
  process.env.CLAI_PLAN_DIR = join(dir, "plans");
  process.env.CLAI_LOG_DIR = join(dir, "logs");
  process.env.CLAI_ARTIFACT_DIR = join(dir, "artifacts");
  process.env.CLAI_JOBS_DIR = join(dir, "jobs");
  process.env.CLAI_DISABLE_KEYCHAIN = "1";
});

afterAll(async () => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

const capabilities = () =>
  detectCapabilities({ env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns: 120, rows: 30 });

it("opening an older session does not make it the most recent", async () => {
  await upsertSession("older-session", [{ role: "user", content: "alpha" }], "alpha");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await upsertSession("newer-session", [{ role: "user", content: "beta" }], "beta");

  const before = await listSessionSummaries(10);
  expect(before.map((summary) => summary.id)).toEqual(["newer-session", "older-session"]);
  const olderBefore = await getSession("older-session");

  const services = createCompositionRoot({ capabilities: capabilities() });
  try {
    await applySessionResume(services, (await getSession("older-session"))!);
    expect((await getSession("older-session"))?.updatedAt).toBe(olderBefore?.updatedAt);

    await services.session.shutdown();
    expect((await getSession("older-session"))?.updatedAt).toBe(olderBefore?.updatedAt);
  } finally {
    services.dispose();
  }

  const after = await listSessionSummaries(10);
  expect(after.map((summary) => summary.id)).toEqual(["newer-session", "older-session"]);
});

it("a real change still rewrites the session", async () => {
  const services = createCompositionRoot({ capabilities: capabilities() });
  try {
    await applySessionResume(services, (await getSession("older-session"))!);
    const before = (await getSession("older-session"))?.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 20));
    services.session.setModel("changed-model");
    await services.session.persistNow();
    const after = (await getSession("older-session"))?.updatedAt;
    expect(after).not.toBe(before);
    expect((await getSession("older-session"))?.model).toBe("changed-model");
  } finally {
    services.dispose();
  }
});
