import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Any ambient data-root override (e.g. a CI-injected CLAI_DATA_DIR) would
// defeat the per-test HOME isolation below and let history.jsonl accumulate
// across cases. Route every data root through the fresh per-test temp dir and
// restore the originals afterwards so the test is hermetic regardless of env.
const dataEnvKeys = [
  "CLAI_DATA_DIR",
  "CLAI_HISTORY_DIR",
  "CLAI_PLAN_DIR",
  "CLAI_LOG_DIR",
  "CLAI_ARTIFACT_DIR",
  "CLAI_JOBS_DIR",
] as const;

let originalHome: string | undefined;
let originalConfigDir: string | undefined;
let originalDataEnv: Partial<Record<(typeof dataEnvKeys)[number], string | undefined>>;
let homeDir: string;
let configDir: string;
let dataDir: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalConfigDir = process.env.CLAI_CONFIG_DIR;
  originalDataEnv = {};
  for (const key of dataEnvKeys) originalDataEnv[key] = process.env[key];
  homeDir = mkdtempSync(join(tmpdir(), "clai-history-home-"));
  configDir = mkdtempSync(join(tmpdir(), "clai-history-config-"));
  dataDir = mkdtempSync(join(tmpdir(), "clai-history-data-"));
  process.env.HOME = homeDir;
  process.env.CLAI_CONFIG_DIR = configDir;
  process.env.CLAI_DATA_DIR = dataDir;
  for (const key of dataEnvKeys) {
    if (key !== "CLAI_DATA_DIR") delete process.env[key];
  }
  vi.resetModules();
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalConfigDir === undefined) delete process.env.CLAI_CONFIG_DIR;
  else process.env.CLAI_CONFIG_DIR = originalConfigDir;
  for (const key of dataEnvKeys) {
    const value = originalDataEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(homeDir, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
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

  it("ignores malformed JSON lines in the JSONL history file gracefully", async () => {
    const { getHistoryPath, listSessions, upsertSession } = await import("../src/store/history.js");
    const { appendFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");

    // Pre-populate with a valid record
    await upsertSession(
      "sess-valid",
      [{ role: "user", content: "hello" }],
      undefined,
      [{ kind: "user", id: "u1", text: "hello", done: true }],
    );

    // Append some malformed content directly to the JSONL file
    const path = getHistoryPath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, 'malformed_line_not_json_at_all\nkind":"thinking","id":"think-2","content":"corrupted JSONL"\n');

    // Add another valid record
    await upsertSession(
      "sess-valid-2",
      [{ role: "user", content: "world" }],
      undefined,
      [{ kind: "user", id: "u2", text: "world", done: true }],
    );

    // Verify listSessions reads both valid records and successfully ignores the malformed ones
    const sessions = await listSessions(10);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.id).sort()).toEqual(["sess-valid", "sess-valid-2"]);
  });

  it("names a session from the first user message on its very first write", async () => {
    const { upsertSession, listSessions } = await import("../src/store/history.js");

    // This mirrors the TUI autosave: no explicit name, called the moment the
    // first user turn lands (before the assistant has replied).
    await upsertSession(
      "fresh-session",
      [{ role: "user", content: "how do I reverse a linked list in python" }],
      undefined,
      [{ kind: "user", id: "u1", text: "how do I reverse a linked list in python", done: true }],
    );

    const sessions = await listSessions(10);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.name).toBe("how do I reverse a linked list in python");
  });

  it("keeps a longer fallback name before adding an ellipsis", async () => {
    const { saveSession, upsertSession } = await import("../src/store/history.js");
    const content = "manual history title ".repeat(8) + "final detail";
    const expected = `${content.slice(0, 96)}…`;
    const messages = [{ role: "user" as const, content }];

    const upserted = await upsertSession("fallback-upsert", messages);
    const saved = await saveSession(messages);

    expect(upserted.name).toBe(expected);
    expect(saved.name).toBe(expected);
  });

  it("keeps an existing name across later upserts instead of blanking it", async () => {
    const { upsertSession, listSessions } = await import("../src/store/history.js");

    await upsertSession(
      "titled-session",
      [{ role: "user", content: "explain kubernetes" }],
      "Kubernetes basics",
    );
    // A later autosave (no explicit name) must not overwrite the title.
    await upsertSession("titled-session", [
      { role: "user", content: "explain kubernetes" },
      { role: "assistant", content: "Kubernetes is a container orchestrator…" },
    ]);

    const sessions = await listSessions(10);
    expect(sessions[0]?.name).toBe("Kubernetes basics");
  });

  it("rejects a lower revision that arrives after a compacted snapshot", async () => {
    const { getSession, upsertSession } = await import("../src/store/history.js");
    const compactedMemory =
      "Session memory from compacted earlier turns:\n\npost-resume work complete";

    await upsertSession(
      "revisioned-session",
      [
        { role: "system", content: compactedMemory },
        { role: "user", content: "latest follow-up" },
        { role: "assistant", content: "latest answer" },
      ],
      "Compacted session",
      [
        {
          kind: "compacted",
          id: "compact-5",
          summary: compactedMemory,
          originalItems: [],
          done: true,
        },
      ],
      { contextTokens: 12_000, contextLimit: 128_000, exact: false },
      5,
      "0000000000000002-writer-new",
    );

    // This models an older writer completing late. Even a much larger local
    // sequence must lose to the newer writer generation.
    await upsertSession(
      "revisioned-session",
      [
        { role: "user", content: "old resumed task" },
        { role: "assistant", content: "old progress" },
      ],
      "Stale session",
      [{ kind: "user", id: "u-old", text: "old resumed task", done: true }],
      { contextTokens: 88_000, contextLimit: 128_000, exact: true },
      999,
      "0000000000000001-writer-old",
    );

    const restored = await getSession("revisioned-session");
    expect(restored?.revision).toBe(5);
    expect(restored?.name).toBe("Compacted session");
    expect(restored?.messages[0]?.content).toBe(compactedMemory);
    expect(restored?.transcript?.[0]?.kind).toBe("compacted");
    expect(restored?.contextUsage?.contextTokens).toBe(12_000);
  });

  it("round-trips and clears the restart continuation checkpoint", async () => {
    const { getSession, upsertSession } = await import("../src/store/history.js");
    const messages = [{ role: "user" as const, content: "resume work" }];
    const writer = "0000000000000003-restart";

    await upsertSession(
      "restart-session",
      messages,
      undefined,
      undefined,
      undefined,
      1,
      writer,
      { status: "aborted", reason: "cancelled during tool execution" },
    );
    expect((await getSession("restart-session"))?.previousTurn).toEqual({
      status: "aborted",
      reason: "cancelled during tool execution",
    });

    await upsertSession(
      "restart-session",
      messages,
      undefined,
      undefined,
      undefined,
      2,
      writer,
      null,
    );
    expect((await getSession("restart-session"))?.previousTurn).toBeUndefined();
  });
});
