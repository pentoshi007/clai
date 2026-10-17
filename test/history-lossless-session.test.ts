import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { TranscriptItem } from "../src/app/ports/transcript-item.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clai-lossless-history-"));
  for (const key of ["CLAI_CONFIG_DIR", "CLAI_DATA_DIR", "CLAI_HISTORY_DIR", "CLAI_PLAN_DIR", "CLAI_LOG_DIR", "CLAI_ARTIFACT_DIR", "CLAI_JOBS_DIR"]) vi.stubEnv(key, dir);
  vi.resetModules();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
  vi.resetModules();
});
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("lossless durable long sessions", () => {
  it("writes and reloads more than 2000 legacy originals and complete long Unicode text", async () => {
    const history = await import("../src/store/history.js");
    const { hydrateFromClassicTranscript, serializeForHistory } = await import("../src/ui-core/state/transcript-hydrate.js");
    const large = "complete 日本語 🧪 e\u0301\n".repeat(8000);
    const originals: TranscriptItem[] = Array.from({ length: 2200 }, (_, index) => ({
      id: `original-${index}`, kind: "assistant", text: index === 0 ? large : `complete original ${index} 日本語 🧪`, done: true,
    }));
    const transcript: TranscriptItem[] = [{ id: "legacy-card", kind: "compacted", summary: "memory", originalItems: originals, done: true }];
    await history.upsertSession("lossless", [{ role: "user", content: "continue" }], undefined, transcript);
    vi.resetModules();
    const restarted = await import("../src/store/history.js");
    const restored = await restarted.getSession("lossless");
    expect(restored?.transcript).toHaveLength(2201);
    expect(restored!.transcript!.map((item) => item.id)).toEqual([...originals.map((item) => item.id), "legacy-card"]);
    const first = restored!.transcript![0]!;
    expect(first.kind).toBe("assistant");
    if (first.kind !== "assistant") throw new Error("wrong restored kind");
    expect(hash(first.text)).toBe(hash(large));
    const hydrated = hydrateFromClassicTranscript(restored!.transcript!);
    const serialized = serializeForHistory(hydrated.state, () => "");
    expect(serialized).toHaveLength(2201);
    expect(serialized.at(-2)).toMatchObject({ id: "original-2199", text: "complete original 2199 日本語 🧪" });
    expect(serialized.at(-1)).toMatchObject({ originalItems: [] });
  });

  it("rejects failed disk writes, preserves the previous durable version and permits retry", async () => {
    const history = await import("../src/store/history.js");
    const index = await import("../src/store/history-index.js");
    await history.upsertSession("retry", [{ role: "user", content: "durable first" }]);
    const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const write = vi.spyOn(index, "appendIndexedHistoryRecord").mockRejectedValueOnce(failure);
    await expect(history.upsertSession("retry", [{ role: "user", content: "retained retry" }])).rejects.toBe(failure);
    expect(write).toHaveBeenCalledTimes(1);
    expect((await history.getSession("retry"))?.messages[0]?.content).toBe("durable first");
    write.mockRestore();
    await history.upsertSession("retry", [{ role: "user", content: "retained retry" }]);
    expect((await history.getSession("retry"))?.messages[0]?.content).toBe("retained retry");
  });
});
