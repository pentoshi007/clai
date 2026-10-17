import { describe, expect, it, vi } from "vitest";
import { SessionPersistenceQueue } from "../../src/app/controllers/session-persistence.js";
import type { PersistencePort, SaveSessionOptions } from "../../src/app/ports/persistence-port.js";
import type { ChatMessage } from "../../src/types.js";

function harness() {
  const writes: { messages: readonly ChatMessage[]; options: SaveSessionOptions | undefined; gate: ReturnType<typeof Promise.withResolvers<void>> }[] = [];
  const port: PersistencePort = {
    saveSession: vi.fn((messages, options) => {
      const gate = Promise.withResolvers<void>();
      writes.push({ messages, options, gate });
      return gate.promise;
    }),
    async loadPlan() { return undefined; },
    async savePlan() {},
    async deletePlan() {},
  };
  return { queue: new SessionPersistenceQueue(port), writes };
}
const messages = (content: string): ChatMessage[] => [{ role: "user", content }];

it("coalesces superseded pending snapshots without acknowledging them early", async () => {
  const { queue, writes } = harness();
  const first = queue.save(messages("first"), { sessionId: "s" });
  const second = queue.save(messages("second"), { sessionId: "s" });
  let latest = second;
  for (let i = 0; i < 1000; i += 1) latest = queue.save(messages(`latest-${i}`), { sessionId: "s" });
  expect(latest).toBe(second);
  expect(writes).toHaveLength(1);
  let acknowledged = false;
  void second.then(() => { acknowledged = true; });
  writes[0]!.gate.resolve();
  await first;
  expect(writes).toHaveLength(2);
  expect(acknowledged).toBe(false);
  expect(writes[1]!.messages).toEqual(messages("latest-999"));
  expect(writes[1]!.options?.revision).toBe(1002);
  writes[1]!.gate.resolve();
  await latest;
  expect(acknowledged).toBe(true);
});

it("preserves session and writer-generation barriers", async () => {
  const { queue, writes } = harness();
  const first = queue.save(messages("a1"), { sessionId: "a" });
  const pending = queue.save(messages("a2"), { sessionId: "a" });
  queue.newSession();
  const other = queue.save(messages("b1"), { sessionId: "b" });
  const rebound = queue.save(messages("a3"), { sessionId: "a" });
  for (const completion of [first, pending, other, rebound]) {
    writes.at(-1)!.gate.resolve();
    await completion;
  }
  expect(writes.map((write) => write.messages[0]?.content)).toEqual(["a1", "a2", "b1", "a3"]);
  expect(writes[0]!.options?.writerGeneration).not.toBe(writes[2]!.options?.writerGeneration);
});

it("rejects failed covering writes and permits a subsequent retry", async () => {
  const { queue, writes } = harness();
  const first = queue.save(messages("first"), { sessionId: "s" });
  const second = queue.save(messages("next"), { sessionId: "s" });
  const rejected = expect(first).rejects.toThrow("disk full");
  writes[0]!.gate.reject(new Error("disk full"));
  await rejected;
  expect(writes).toHaveLength(2);
  writes[1]!.gate.resolve();
  await second;
  const retry = queue.save(messages("retry"), { sessionId: "s" });
  writes[2]!.gate.resolve();
  await retry;
});

it("rejects every coalesced caller when its covering snapshot fails", async () => {
  const { queue, writes } = harness();
  const active = queue.save(messages("active"), { sessionId: "s" });
  const pending = queue.save(messages("pending"), { sessionId: "s", name: "retained title" });
  const latest = queue.save(messages("complete 日本語 🧪"), { sessionId: "s" });
  const failures = [expect(pending).rejects.toThrow("write failed"), expect(latest).rejects.toThrow("write failed")];
  writes[0]!.gate.resolve();
  await active;
  expect(writes[1]!.options?.name).toBe("retained title");
  expect(writes[1]!.messages).toEqual(messages("complete 日本語 🧪"));
  writes[1]!.gate.reject(new Error("write failed"));
  await Promise.all(failures);
});
