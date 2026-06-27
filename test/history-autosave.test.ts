import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let originalHome: string | undefined;
let originalConfigDir: string | undefined;
let homeDir: string;
let configDir: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalConfigDir = process.env.CLAI_CONFIG_DIR;
  homeDir = mkdtempSync(join(tmpdir(), "clai-history-home-"));
  configDir = mkdtempSync(join(tmpdir(), "clai-history-config-"));
  process.env.HOME = homeDir;
  process.env.CLAI_CONFIG_DIR = configDir;
  vi.resetModules();
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalConfigDir === undefined) delete process.env.CLAI_CONFIG_DIR;
  else process.env.CLAI_CONFIG_DIR = originalConfigDir;
  await rm(homeDir, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
  vi.resetModules();
});

describe("history autosave upsert", () => {
  it("updates one live session record instead of appending duplicates", async () => {
    const { upsertSession, listSessions } = await import("../src/store/history.js");

    await upsertSession(
      "live-session",
      [{ role: "user", content: "first prompt" }],
      undefined,
      [{ kind: "user", id: "u1", text: "first prompt", done: true }],
    );
    await upsertSession(
      "live-session",
      [
        { role: "user", content: "first prompt" },
        { role: "assistant", content: "partial answer" },
      ],
      undefined,
      [
        { kind: "user", id: "u1", text: "first prompt", done: true },
        { kind: "assistant", id: "a1", text: "partial answer", streaming: false, done: true },
      ],
    );

    const sessions = await listSessions(10);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe("live-session");
    expect(sessions[0]?.messages).toHaveLength(2);
    expect(sessions[0]?.transcript?.map((item) => item.kind)).toEqual(["user", "assistant"]);
  });
});
