import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptItem } from "../src/app/ports/transcript-item.js";
import type { ChatMessage } from "../src/types.js";

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
  homeDir = mkdtempSync(join(tmpdir(), "clai-history-amp-home-"));
  configDir = mkdtempSync(join(tmpdir(), "clai-history-amp-config-"));
  dataDir = mkdtempSync(join(tmpdir(), "clai-history-amp-data-"));
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

function frames(path: string): Array<{ t: string }> {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { t: string });
}

function fileStamp(path: string): string {
  const info = statSync(path);
  return `${info.ino}:${info.size}:${info.mtimeMs}`;
}

function turn(index: number): { messages: ChatMessage[]; items: TranscriptItem[] } {
  const output = Array.from({ length: 30 }, (_, row) => `  ✓ case ${index}.${row} passes`).join("\n");
  return {
    messages: [
      { role: "user", content: `task ${index}` },
      { role: "assistant", content: "", toolCalls: [{ id: `call-${index}`, name: "shell.exec", args: { command: `npm test ${index}` } }] },
      { role: "tool", toolCallId: `call-${index}`, content: output },
      { role: "assistant", content: `## Result ${index}\n\nAll tests pass for module ${index}.` },
    ],
    items: [
      { kind: "user", id: `u-${index}`, text: `task ${index}`, done: true },
      { kind: "thinking", id: `th-${index}`, content: `checking module ${index}`, done: true },
      { kind: "tool", id: `t-${index}`, name: "shell.exec", argsDisplay: `npm test ${index}`, output, status: "ok", done: true },
      { kind: "assistant", id: `a-${index}`, text: `## Result ${index}\n\nAll tests pass for module ${index}.`, done: true },
    ] as TranscriptItem[],
  };
}

function conversation(turns: number): { messages: ChatMessage[]; transcript: TranscriptItem[] } {
  const messages: ChatMessage[] = [{ role: "system", content: "system" }];
  const transcript: TranscriptItem[] = [];
  for (let index = 0; index < turns; index += 1) {
    const next = turn(index);
    messages.push(...next.messages);
    transcript.push(...next.items);
  }
  return { messages, transcript };
}

describe("history write amplification", () => {
  it("appends a small delta to only the saved session's file", async () => {
    const { upsertSession, listSessions, getSession, getSessionLogPath } = await import("../src/store/history.js");
    await upsertSession("big-session", [{ role: "user", content: "b".repeat(200_000) }]);
    const big = getSessionLogPath("big-session");
    const bigStamp = fileStamp(big);

    await upsertSession("small-session", [{ role: "user", content: "hello" }, { role: "assistant", content: "answer 1" }]);
    const small = getSessionLogPath("small-session");
    const afterFirst = statSync(small).size;
    for (let index = 2; index <= 4; index += 1) {
      await upsertSession("small-session", [{ role: "user", content: "hello" }, { role: "assistant", content: `answer ${index}` }]);
    }

    expect(fileStamp(big)).toBe(bigStamp);
    expect(frames(small).map((frame) => frame.t)).toEqual(["base", "delta", "delta", "delta"]);
    expect(statSync(small).size - afterFirst).toBeLessThan(3 * 2_048);
    expect((await listSessions(10)).map((session) => session.id).sort()).toEqual(["big-session", "small-session"]);
    expect((await getSession("small-session"))?.messages[1]?.content).toBe("answer 4");
  });

  it("never rewrites another session's file", async () => {
    const { upsertSession, getSessionLogPath } = await import("../src/store/history.js");
    const ids = ["alpha", "beta", "gamma"];
    for (const id of ids) await upsertSession(id, [{ role: "user", content: `${id} ${"x".repeat(50_000)}` }]);
    for (let round = 0; round < 70; round += 1) {
      const id = ids[round % ids.length]!;
      const others = ids.filter((other) => other !== id).map((other) => [other, fileStamp(getSessionLogPath(other))] as const);
      await upsertSession(id, [{ role: "user", content: `${id} ${"x".repeat(50_000)}` }, { role: "assistant", content: `round ${round}` }]);
      for (const [other, stamp] of others) expect(fileStamp(getSessionLogPath(other))).toBe(stamp);
    }
  });

  it("compacts a session once its deltas pile up", async () => {
    const { upsertSession, getSession, getSessionLogPath } = await import("../src/store/history.js");
    const bulk = "c".repeat(100_000);
    for (let revision = 1; revision <= 70; revision += 1) {
      await upsertSession("busy-session", [{ role: "user", content: bulk }, { role: "assistant", content: `revision ${revision}` }]);
    }
    const kinds = frames(getSessionLogPath("busy-session")).map((frame) => frame.t);
    expect(kinds[0]).toBe("base");
    expect(kinds.length).toBeLessThanOrEqual(65);
    expect((await getSession("busy-session"))?.messages[1]?.content).toBe("revision 70");
  });

  it("compacts when superseded bases dominate the file", async () => {
    const { upsertSession, getSession, getSessionLogPath } = await import("../src/store/history.js");
    for (let revision = 1; revision <= 6; revision += 1) {
      await upsertSession("fat-session", [{ role: "user", content: String(revision).repeat(600_000) }]);
    }
    const path = getSessionLogPath("fat-session");
    expect(statSync(path).size).toBeLessThan(3 * 600_000 + 1_100_000);
    expect((await getSession("fat-session"))?.messages[0]?.content).toBe("6".repeat(600_000));
  });

  it("writes at most 64 KB when a 1,000-item session gains a turn", async () => {
    const { upsertSession, getSession, getSessionLogPath } = await import("../src/store/history.js");
    const { messages, transcript } = conversation(250);
    expect(transcript).toHaveLength(1_000);
    await upsertSession("long-session", messages, "long", transcript, undefined, 1, "0001-writer");
    const path = getSessionLogPath("long-session");
    const before = statSync(path).size;
    const next = turn(250);
    await upsertSession("long-session", [...messages, ...next.messages], "long", [...transcript, ...next.items], undefined, 2, "0001-writer");
    expect(statSync(path).size - before).toBeLessThanOrEqual(64 * 1024);
    const restored = await getSession("long-session");
    expect(restored?.transcript).toHaveLength(1_004);
    expect(restored?.messages.at(-1)?.content).toBe(next.messages.at(-1)?.content);
  }, 20_000);
});
