import { describe, expect, it } from "vitest";
import { LoopGuard } from "../src/agent/loop-guard.js";
import { completedOperationObservationDigest, completedOperationSignature } from "../src/agent/outcomes.js";

describe("LoopGuard", () => {
  it("does not block the first call", () => {
    const guard = new LoopGuard();
    const result = guard.shouldBlock("shell.exec", { command: "whoami" });
    expect(result.block).toBe(false);
    expect(result.reason).toBe(undefined);
  });

  it("never warns or blocks successful identical re-calls", () => {
    const guard = new LoopGuard();
    guard.recordAttempt(0, "shell.exec", { command: "whoami" }, true);
    const once = guard.shouldBlock("shell.exec", { command: "whoami" });
    expect(once.block).toBe(false);
    expect(once.reason).toBeUndefined();

    guard.recordAttempt(1, "shell.exec", { command: "whoami" }, true);
    guard.recordAttempt(2, "shell.exec", { command: "whoami" }, true);
    const thrice = guard.shouldBlock("shell.exec", { command: "whoami" });
    expect(thrice.block).toBe(false);
    expect(thrice.reason).toBeUndefined();
  });

  it("allows one empty success comparison before suppressing an unchanged result", () => {
    const guard = new LoopGuard();
    const args = { command: "true" };
    guard.recordAttempt(0, "shell.exec", args, true, 0, "");
    expect(guard.shouldBlock("shell.exec", args).block).toBe(false);
    guard.recordAttempt(1, "shell.exec", args, true, 0, "");
    expect(guard.shouldBlock("shell.exec", args).block).toBe(false);
    guard.recordAttempt(2, "shell.exec", args, true, 0, "");

    expect(guard.shouldBlock("shell.exec", args)).toMatchObject({
      block: true,
      kind: "unchanged-success",
      reason: expect.stringMatching(/empty result/i),
    });
  });

  it("allows an empty-result retry after a distinct successful action or one new reason", () => {
    const args = { command: "true" };
    const afterProgress = new LoopGuard();
    afterProgress.recordAttempt(0, "shell.exec", args, true, 0, "");
    afterProgress.recordAttempt(1, "shell.exec", { command: "printf ready" }, true, 0, "ready");
    expect(afterProgress.shouldBlock("shell.exec", args).block).toBe(false);

    const withReason = new LoopGuard();
    withReason.recordAttempt(0, "shell.exec", args, true, 0, "");
    withReason.recordAttempt(1, "shell.exec", args, true, 0, "");
    withReason.recordAttempt(2, "shell.exec", args, true, 0, "");
    const retry = {
      retryReason: { code: "service-ready", detail: "the dependency is now running" },
    };
    expect(withReason.shouldBlock("shell.exec", args, retry).block).toBe(false);
    expect(withReason.shouldBlock("shell.exec", args, retry).block).toBe(true);
  });

  it("allows one transient failure retry and every retry after an intervening action", () => {
    const guard = new LoopGuard();
    const command = { command: "node test.js" };

    guard.recordAttempt(0, "shell.exec", command, false, 1, "failed");
    expect(guard.shouldBlock("shell.exec", command).block).toBe(false);
    guard.recordAttempt(1, "shell.exec", command, false, 1, "failed");
    expect(guard.shouldBlock("shell.exec", command).block).toBe(true);

    guard.recordAttempt(2, "fs.edit", { path: "test.js", oldText: "a", newText: "b" }, true, 0, "edited");
    expect(guard.shouldBlock("shell.exec", command).block).toBe(false);

    guard.recordAttempt(3, "shell.exec", command, false, 1, "still failed");
    expect(guard.shouldBlock("shell.exec", command).block).toBe(false);
    guard.recordAttempt(4, "shell.exec", command, false, 1, "still failed");
    expect(guard.shouldBlock("shell.exec", command).block).toBe(true);

    guard.recordAttempt(5, "fs.write", { path: "test.js", content: "fixed" }, true, 0, "written");
    expect(guard.shouldBlock("shell.exec", command).block).toBe(false);
  });

  it("compares a repeated observation and allows it again after a different action", () => {
    const guard = new LoopGuard();
    const list = { path: "/tmp/project" };

    guard.recordAttempt(0, "fs.list", list, true, 0, "a.txt");
    expect(guard.shouldBlock("fs.list", list).block).toBe(false);
    guard.recordAttempt(1, "fs.list", list, true, 0, "a.txt");
    expect(guard.shouldBlock("fs.list", list).block).toBe(false);
    guard.recordAttempt(2, "fs.list", list, true, 0, "a.txt");
    expect(guard.shouldBlock("fs.list", list).block).toBe(true);

    guard.recordAttempt(3, "tool.check", { tools: ["node"] }, true, 0, "node 26");
    expect(guard.shouldBlock("fs.list", list).block).toBe(false);
  });

  it("suppresses a twice-unchanged successful read without affecting mutations", () => {
    const guard = new LoopGuard();
    const args = { path: "/tmp/blog" };
    guard.recordAttempt(0, "fs.list", args, true, 0, "a\nb\n");
    expect(guard.shouldBlock("fs.list", args).block).toBe(false);
    guard.recordAttempt(1, "fs.list", args, true, 0, "a\nb\n");
    expect(guard.shouldBlock("fs.list", args).block).toBe(false);
    guard.recordAttempt(2, "fs.list", args, true, 0, "a\nb\n");

    expect(guard.shouldBlock("fs.list", args)).toMatchObject({
      block: true,
      kind: "unchanged-success",
    });
    expect(guard.shouldBlock("fs.write", { path: "/tmp/blog/c", content: "c" }).block).toBe(false);
  });

  it("returns the prior successful observation for suppressed recovery", () => {
    const guard = new LoopGuard();
    const args = { path: "/tmp/blog" };
    guard.recordAttempt(0, "fs.list", args, true, 0, "a\nb\n");
    expect(guard.getPriorObservation("fs.list", args)).toBe("a\nb");
  });

  it("treats whitespace-normalized commands as equivalent for failure tracking", () => {
    const guard = new LoopGuard();
    guard.recordAttempt(0, "shell.exec", { command: "  ls   -la  " }, false, 1, "failed");
    expect(guard.shouldBlock("shell.exec", { command: "ls -la" }).block).toBe(false);
    guard.recordAttempt(1, "shell.exec", { command: "ls -la" }, false, 1, "failed");
    expect(guard.shouldBlock("shell.exec", { command: " ls   -la " }).block).toBe(true);
  });

  it("does not confuse different arguments", () => {
    const guard = new LoopGuard();
    guard.recordAttempt(0, "shell.exec", { command: "whoami" }, false);
    const result = guard.shouldBlock("shell.exec", { command: "hostname" });
    expect(result.block).toBe(false);
  });

  it("tracks attempt count correctly", () => {
    const guard = new LoopGuard();
    expect(guard.getAttemptCount("shell.exec", { command: "ls" })).toBe(0);
    guard.recordAttempt(0, "shell.exec", { command: "ls" }, true);
    expect(guard.getAttemptCount("shell.exec", { command: "ls" })).toBe(1);
    guard.recordAttempt(1, "shell.exec", { command: "ls" }, true);
    expect(guard.getAttemptCount("shell.exec", { command: "ls" })).toBe(2);
  });

  it("detects repeated failures", () => {
    const guard = new LoopGuard();
    guard.recordAttempt(0, "shell.exec", { command: "foo" }, false);
    guard.recordAttempt(1, "shell.exec", { command: "bar" }, false);
    guard.recordAttempt(2, "shell.exec", { command: "baz" }, false);
    expect(guard.hasRepeatedFailures(3)).toBe(true);
    expect(guard.hasRepeatedFailures(4)).toBe(false);
  });

  it("sorts args keys for consistent canonicalization", () => {
    const guard = new LoopGuard();
    const sig1 = guard.canonicalize("test", { b: 2, a: 1 });
    const sig2 = guard.canonicalize("test", { a: 1, b: 2 });
    expect(sig1).toBe(sig2);
  });

  it("blocks a twice-identical failed mutate without structured retry context", () => {
    const guard = new LoopGuard();
    const args = { path: "src/App.jsx", content: "x" };
    guard.recordAttempt(0, "fs.write", args, false, 1, "denied");
    expect(guard.shouldBlock("fs.write", args).block).toBe(false);
    guard.recordAttempt(1, "fs.write", args, false, 1, "denied");
    expect(guard.shouldBlock("fs.write", args).block).toBe(true);
    expect(
      guard.shouldBlock("fs.write", args, {
        dependenciesChanged: true,
      }).block,
    ).toBe(false);
  });


  it("blocks a same-batch exact side effect after its first success", () => {
    const guard = new LoopGuard();
    const args = { path: "events.log", content: "event\n" };
    guard.recordAttempt(0, "fs.append", args, true, 0, "appended");
    expect(guard.shouldBlock("fs.append", args)).toMatchObject({
      block: true,
      kind: "unchanged-success",
    });
  });

  it("does not blindly retry a failed action with uncertain delivery", () => {
    const guard = new LoopGuard();
    const args = { id: "terminal-1", kind: "text", text: "next", cursor: 4 };
    guard.recordAttempt(0, "terminal.send", args, false, 1, "delivery unknown");
    expect(guard.shouldBlock("terminal.send", args)).toMatchObject({
      block: true,
      kind: "failed-retry",
    });
    expect(
      guard.shouldBlock("terminal.send", args, {
        retryReason: { code: "NOT_DELIVERED", detail: "transport rejected before write" },
      }).block,
    ).toBe(false);
  });
  it("does not block or warn for task.update or plan.create", () => {
    const guard = new LoopGuard();
    const args = { taskId: "1", state: "in_progress" };
    guard.recordAttempt(0, "task.update", args, true);
    guard.recordAttempt(1, "task.update", args, true);
    guard.recordAttempt(2, "task.update", args, true);
    const result = guard.shouldBlock("task.update", args);
    expect(result.block).toBe(false);
    expect(result.reason).toBeUndefined();

    const planArgs = { tasks: [] };
    guard.recordAttempt(0, "plan.create", planArgs, true);
    guard.recordAttempt(1, "plan.create", planArgs, true);
    const planResult = guard.shouldBlock("plan.create", planArgs);
    expect(planResult.block).toBe(false);
    expect(planResult.reason).toBeUndefined();
  });

  it("allows one fs.list retry after successful scaffold work", () => {
    const guard = new LoopGuard();
    const listArgs = { path: "/Users/me/Desktop/blogging-app" };
    guard.recordAttempt(0, "fs.list", listArgs, false, 1, "missing");
    expect(guard.shouldBlock("fs.list", listArgs).block).toBe(false);
    guard.recordAttempt(1, "fs.list", listArgs, false, 1, "missing");
    expect(guard.shouldBlock("fs.list", listArgs).block).toBe(true);
    guard.recordAttempt(
      2,
      "shell.exec",
      {
        command:
          'mkdir -p "/Users/me/Desktop/blogging-app" && npm create vite@latest .',
      },
      true,
    );
    const retry = guard.shouldBlock("fs.list", listArgs);
    expect(retry.block).toBe(false);
  });

  it("blocks a failed read-only probe restored after interruption", () => {
    const guard = new LoopGuard();
    const args = {
      command:
        'curl -s -o /dev/null -w "%{http_code}" "https://images.picsum.photos/id/866/800/400" 2>&1',
    };
    const signature = completedOperationSignature("shell.exec", args);
    expect(signature).toBeDefined();
    guard.restoreCompletedOperations([
      {
        signature: signature!,
        tool: "shell.exec",
        summary: "failed curl probe",
        observation: "000",
        ok: false,
        exitCode: 6,
        observationDigest: completedOperationObservationDigest("shell.exec", "000"),
        observedAt: new Date().toISOString(),
      },
    ]);

    expect(guard.shouldBlock("shell.exec", args).block).toBe(false);
    guard.recordAttempt(0, "shell.exec", args, false, 6, "000");
    expect(guard.shouldBlock("shell.exec", args)).toMatchObject({
      block: true,
      kind: "failed-retry",
    });
    expect(
      guard.shouldBlock("shell.exec", args, {
        retryReason: { code: "dns-fixed", detail: "resolver changed" },
      }).block,
    ).toBe(false);
    expect(
      guard.shouldBlock("shell.exec", args, {
        retryReason: { code: "dns-fixed", detail: "resolver changed" },
      }).block,
    ).toBe(true);
    expect(
      guard.shouldBlock("shell.exec", {
        command:
          'curl -sS -L -o /dev/null -w "%{http_code}" "https://picsum.photos/id/866/800/400"',
      }).block,
    ).toBe(false);
  });

  it("allows the first action sequence", () => {
    const guard = new LoopGuard();
    const seq = [{ name: "shell.exec", args: { command: "node test.mjs" } }];

    const decision = guard.observeActionSequence(seq);
    expect(decision.suppress).toBe(false);
    expect(decision.warn).toBe(false);
    guard.completeActionSequence(seq, true);
  });

  it("warns on the third unchanged observation and suppresses the fourth", () => {
    const guard = new LoopGuard();
    const seq = [{ name: "shell.exec", args: { command: "node test.mjs" } }];

    guard.observeActionSequence(seq);
    guard.completeActionSequence(seq, true, "same-output");
    expect(guard.observeActionSequence(seq).suppress).toBe(false);
    guard.completeActionSequence(seq, true, "same-output");
    expect(guard.observeActionSequence(seq)).toMatchObject({
      suppress: false,
      warn: true,
    });
    guard.completeActionSequence(seq, true, "same-output");

    const decision = guard.observeActionSequence(seq);
    expect(decision.suppress).toBe(true);
    expect(decision.terminal).toBe(false);
    expect(decision.repetitions).toBe(1);
  });

  it("keeps running an observable sequence while its outcome changes", () => {
    const guard = new LoopGuard();
    const seq = [{ name: "http.fetch", args: { url: "https://example.test/status" } }];

    guard.observeActionSequence(seq);
    guard.completeActionSequence(seq, true, "pending");
    expect(guard.observeActionSequence(seq).suppress).toBe(false);
    guard.completeActionSequence(seq, true, "running");
    expect(guard.observeActionSequence(seq).suppress).toBe(false);
    guard.completeActionSequence(seq, true, "complete");
    expect(guard.observeActionSequence(seq).suppress).toBe(false);
  });

  it("warns then suppresses an identical consecutive sequence even when outcomes keep changing", () => {
    const guard = new LoopGuard();
    const seq = [
      { name: "fs.search", args: { pattern: "continueQueue", path: "/src" } },
      { name: "fs.list", args: { path: "/src/components" } },
    ];

    guard.observeActionSequence(seq);
    guard.completeActionSequence(seq, true, "outcome-a");
    expect(guard.observeActionSequence(seq)).toMatchObject({ suppress: false, warn: false });
    guard.completeActionSequence(seq, true, "outcome-b");
    expect(guard.observeActionSequence(seq)).toMatchObject({ suppress: false, warn: false });
    guard.completeActionSequence(seq, true, "outcome-c");
    expect(guard.observeActionSequence(seq)).toMatchObject({ suppress: false, warn: true });
    guard.completeActionSequence(seq, true, "outcome-d");
    expect(guard.observeActionSequence(seq)).toMatchObject({ suppress: true, terminal: false });
    guard.completeActionSequence(seq, true, "outcome-e");
    expect(guard.observeActionSequence(seq)).toMatchObject({ suppress: true, terminal: true });
  });

  it("does not count duplicate calls emitted within a single response as a loop", () => {
    const guard = new LoopGuard();
    const seq = [
      { name: "fs.read", args: { path: "/tmp/a.txt" } },
      { name: "fs.read", args: { path: "/tmp/a.txt" } },
    ];

    expect(guard.observeActionSequence(seq)).toMatchObject({ suppress: false, warn: false });
    guard.completeActionSequence(seq, true, "body");
    guard.observeActionSequence([
      { name: "fs.list", args: { path: "/tmp" } },
    ]);
    expect(guard.observeActionSequence(seq)).toMatchObject({ suppress: false, warn: false });
  });

  it("still suppresses an immediately repeated side effect", () => {
    const guard = new LoopGuard();
    const seq = [{ name: "fs.append", args: { path: "events.log", content: "x\n" } }];

    guard.observeActionSequence(seq);
    guard.completeActionSequence(seq, true, "first");
    expect(guard.observeActionSequence(seq)).toMatchObject({
      suppress: true,
      terminal: false,
    });
  });

  it("does not let an observable sibling weaken side-effect replay protection", () => {
    const guard = new LoopGuard();
    const seq = [
      { name: "fs.append", args: { path: "events.log", content: "x\n" } },
      { name: "fs.list", args: { path: "." } },
    ];

    guard.observeActionSequence(seq);
    guard.completeActionSequence(seq, true, "first");
    expect(guard.observeActionSequence(seq).suppress).toBe(true);
  });

  it("applies side-effect replay protection through tool.batch", () => {
    const guard = new LoopGuard();
    const seq = [
      {
        name: "tool.batch",
        args: {
          calls: [
            { name: "fs.list", args: { path: "." } },
            { name: "fs.append", args: { path: "events.log", content: "x\n" } },
          ],
        },
      },
    ];

    guard.observeActionSequence(seq);
    guard.completeActionSequence(seq, true, "first");
    expect(guard.observeActionSequence(seq).suppress).toBe(true);
  });

  it("escalates only after repeated suppressed replays", () => {
    const guard = new LoopGuard();
    const seq = [{ name: "shell.exec", args: { command: "node test.mjs" } }];

    guard.observeActionSequence(seq);
    guard.completeActionSequence(seq, true, "same-output");
    expect(guard.observeActionSequence(seq).suppress).toBe(false);
    guard.completeActionSequence(seq, true, "same-output");
    expect(guard.observeActionSequence(seq).warn).toBe(true);
    guard.completeActionSequence(seq, true, "same-output");
    expect(guard.observeActionSequence(seq).terminal).toBe(false);
    expect(guard.observeActionSequence(seq).terminal).toBe(false);
    expect(guard.observeActionSequence(seq)).toMatchObject({
      suppress: true,
      terminal: true,
    });
  });

  it("resetAllSequenceCounts allows commands to run again after suppression", () => {
    const guard = new LoopGuard();
    const seq = [{ name: "shell.exec", args: { command: "node test.mjs" } }];

    guard.observeActionSequence(seq);
    guard.completeActionSequence(seq, true, "same-output");
    expect(guard.observeActionSequence(seq).suppress).toBe(false);
    guard.completeActionSequence(seq, true, "same-output");
    expect(guard.observeActionSequence(seq).warn).toBe(true);
    guard.completeActionSequence(seq, true, "same-output");
    expect(guard.observeActionSequence(seq).suppress).toBe(true);
    guard.resetAllSequenceCounts();
    const after = guard.observeActionSequence(seq);
    expect(after.suppress).toBe(false);
    expect(after.warn).toBe(false);
  });

  it("resetAllSequenceCounts clears per-call unchanged observation state", () => {
    const guard = new LoopGuard();
    const args = { path: "/tmp/poll" };
    guard.recordAttempt(0, "fs.list", args, true, 0, "same");
    guard.recordAttempt(1, "fs.list", args, true, 0, "same");
    guard.recordAttempt(2, "fs.list", args, true, 0, "same");
    expect(guard.shouldBlock("fs.list", args).block).toBe(true);

    guard.resetAllSequenceCounts();
    expect(guard.shouldBlock("fs.list", args).block).toBe(false);
    guard.recordAttempt(3, "fs.list", args, true, 0, "same");
    expect(guard.shouldBlock("fs.list", args).block).toBe(false);
  });

  it("allows a sequence separated by progress-changing actions", () => {
    const guard = new LoopGuard();
    const seqA = [{ name: "shell.exec", args: { command: "node test.js" } }];
    const seqB = [{ name: "fs.edit", args: { path: "test.js", oldText: "a", newText: "b" } }];

    for (let i = 0; i < 4; i++) {
      expect(guard.observeActionSequence(seqA)).toMatchObject({
        suppress: false,
        oscillation: false,
      });
      guard.completeActionSequence(seqA, true, `test-${i}`);
      expect(guard.observeActionSequence(seqB)).toMatchObject({
        suppress: false,
        oscillation: false,
      });
      guard.completeActionSequence(seqB, true, `edit-${i}`);
    }

    expect(guard.observeActionSequence(seqA)).toMatchObject({
      suppress: false,
      oscillation: false,
      warn: false,
    });
  });

  it("warns then suppresses an unchanged period-two cycle", () => {
    const guard = new LoopGuard();
    const seqA = [{ name: "shell.exec", args: { command: "node test.js" } }];
    const seqB = [{ name: "fs.read", args: { path: "test.js" } }];

    for (let i = 0; i < 2; i++) {
      guard.observeActionSequence(seqA);
      guard.completeActionSequence(seqA, true, "same-a");
      guard.observeActionSequence(seqB);
      guard.completeActionSequence(seqB, true, "same-b");
    }

    expect(guard.observeActionSequence(seqA)).toMatchObject({
      suppress: false,
      oscillation: true,
      warn: true,
    });
    guard.completeActionSequence(seqA, true, "same-a");
    guard.observeActionSequence(seqB);
    guard.completeActionSequence(seqB, true, "same-b");
    expect(guard.observeActionSequence(seqA)).toMatchObject({
      suppress: true,
      oscillation: true,
    });
  });

  it("detects an unchanged period-three cycle", () => {
    const guard = new LoopGuard();
    const sequences = ["a", "b", "c"].map((path) => [
      { name: "fs.read", args: { path } },
    ]);

    for (let cycle = 0; cycle < 2; cycle++) {
      for (const sequence of sequences) {
        guard.observeActionSequence(sequence);
        guard.completeActionSequence(sequence, true, "same");
      }
    }

    expect(guard.observeActionSequence(sequences[0]!)).toMatchObject({
      oscillation: true,
      warn: true,
      suppress: false,
    });
  });

  it("does not suppress a genuinely new sequence", () => {
    const guard = new LoopGuard();
    const seqA = [{ name: "fs.read", args: { path: "a" } }];
    const seqC = [{ name: "fs.read", args: { path: "c" } }];

    guard.observeActionSequence(seqA);
    guard.completeActionSequence(seqA, true);

    const fresh = guard.observeActionSequence(seqC);
    expect(fresh.suppress).toBe(false);
    expect(fresh.oscillation).toBe(false);
    expect(fresh.warn).toBe(false);
  });

  it("getSequenceRunCount tracks completed eligible sequences", () => {
    const guard = new LoopGuard();
    const seq = [{ name: "shell.exec", args: { command: "npm test" } }];

    expect(guard.getSequenceRunCount(seq)).toBe(0);
    guard.observeActionSequence(seq);
    guard.completeActionSequence(seq, true);
    expect(guard.getSequenceRunCount(seq)).toBe(1);
    guard.observeActionSequence(seq);
    guard.completeActionSequence(seq, true);
    expect(guard.getSequenceRunCount(seq)).toBe(2);
  });

  it("resetSequenceCount clears count for a specific sequence", () => {
    const guard = new LoopGuard();
    const seq = [{ name: "shell.exec", args: { command: "npm test" } }];

    guard.observeActionSequence(seq);
    guard.completeActionSequence(seq, true, "same-output");
    expect(guard.getSequenceRunCount(seq)).toBe(1);
    expect(guard.observeActionSequence(seq).suppress).toBe(false);
    guard.completeActionSequence(seq, true, "same-output");
    expect(guard.observeActionSequence(seq).warn).toBe(true);
    guard.completeActionSequence(seq, true, "same-output");
    expect(guard.observeActionSequence(seq).suppress).toBe(true);

    guard.resetSequenceCount(seq);
    expect(guard.getSequenceRunCount(seq)).toBe(0);
    const after = guard.observeActionSequence(seq);
    expect(after.warn).toBe(false);
    expect(after.suppress).toBe(false);
  });
});
