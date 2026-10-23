import { expect, it } from "vitest";
import { LoopGuard } from "../../src/agent/loop-guard.js";

it.each(["skill.load", "fs.read"])("allows %s recovery after every compaction while still stopping live-context loops", name => {
  const guard = new LoopGuard();
  const args = name === "skill.load" ? { name: "clai-superman-skill" } : { path: "/skills/references/web-api.md" };
  const calls = [{ name, args }];
  for (let round = 0; round < 6; round += 1) {
    expect(guard.observeActionSequence(calls).suppress).toBe(false);
    expect(guard.shouldBlock(name, args).block).toBe(false);
    guard.recordAttempt(round, name, args, true, 0, "Full relevant instructions");
    guard.completeActionSequence(calls, true, "unchanged-body");
    guard.resetReadOnly();
  }
  for (let step = 0; step < 4; step += 1) {
    guard.observeActionSequence(calls);
    guard.recordAttempt(step + 6, name, args, true, 0, "Full relevant instructions");
    guard.completeActionSequence(calls, true, "unchanged-body");
  }
  expect(guard.observeActionSequence(calls).suppress).toBe(true);
});

it("does not authorize replaying a side-effect sequence after compaction", () => {
  const guard = new LoopGuard();
  const calls = [{ name: "fs.write", args: { path: "/work/output.txt", content: "saved" } }];
  for (let step = 0; step < 4; step += 1) {
    guard.observeActionSequence(calls);
    guard.recordAttempt(step, calls[0]!.name, calls[0]!.args, true, 0, "saved");
    guard.completeActionSequence(calls, true, "unchanged-body");
  }
  guard.resetReadOnly();
  expect(guard.observeActionSequence(calls).suppress).toBe(true);
});
