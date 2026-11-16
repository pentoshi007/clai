import { describe, expect, it } from "vitest";
import { LoopGuard, type ActionSequenceDecision } from "../src/agent/loop-guard.js";

type Call = { name: string; args: Record<string, unknown> };

function runRound(
  guard: LoopGuard,
  step: number,
  calls: Call[],
  output: (call: Call) => string,
): ActionSequenceDecision {
  const decision = guard.observeActionSequence(calls);
  if (decision.suppress) return decision;
  for (const call of calls) {
    guard.recordAttempt(step, call.name, call.args, true, 0, output(call));
  }
  guard.completeActionSequence(calls, true, calls.map(output).join("\n"));
  return decision;
}

const runScript: Call[] = [{ name: "shell.exec", args: { command: "node script.js" } }];
const readScript: Call[] = [{ name: "fs.read", args: { path: "script.js" } }];
const editScript = (revision: number): Call[] => [
  {
    name: "fs.edit",
    args: { path: "script.js", oldText: `v${revision}`, newText: `v${revision + 1}` },
  },
];

describe("loop guard state changes", () => {
  it("re-runs a script after every fix even when its output never changes", () => {
    const guard = new LoopGuard();
    for (let fix = 0; fix < 6; fix += 1) {
      expect(runRound(guard, fix * 2, runScript, () => "")).toMatchObject({
        suppress: false,
        warn: false,
      });
      runRound(guard, fix * 2 + 1, editScript(fix), () => "edited script.js");
    }
  });

  it("re-runs a script after a shell command changes its environment", () => {
    const guard = new LoopGuard();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(runRound(guard, attempt * 2, runScript, () => "Done.").suppress).toBe(false);
      runRound(
        guard,
        attempt * 2 + 1,
        [{ name: "shell.exec", args: { command: `npm install dep-${attempt}` } }],
        () => "added 1 package",
      );
    }
  });

  it("re-runs a script after a read shows the workspace changed outside the agent", () => {
    const guard = new LoopGuard();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(runRound(guard, attempt * 2, runScript, () => "same").suppress).toBe(false);
      runRound(guard, attempt * 2 + 1, readScript, () => `body ${attempt}`);
    }
  });

  it("still stops a run-and-read cycle when nothing changes", () => {
    const guard = new LoopGuard();
    const decisions: ActionSequenceDecision[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      decisions.push(runRound(guard, attempt * 2, runScript, () => "same"));
      runRound(guard, attempt * 2 + 1, readScript, () => "body");
    }
    expect(decisions.map(({ suppress, warn }) => ({ suppress, warn }))).toEqual([
      { suppress: false, warn: false },
      { suppress: false, warn: false },
      { suppress: false, warn: true },
      { suppress: true, warn: false },
    ]);
  });

  it("still stops two alternating commands that keep producing the same results", () => {
    const guard = new LoopGuard();
    const build: Call[] = [{ name: "shell.exec", args: { command: "npm run build" } }];
    let suppressed = false;
    for (let cycle = 0; cycle < 8 && !suppressed; cycle += 1) {
      suppressed = runRound(guard, cycle * 2, runScript, () => "same").suppress;
      if (!suppressed) suppressed = runRound(guard, cycle * 2 + 1, build, () => "built").suppress;
    }
    expect(suppressed).toBe(true);
  });

  it("does not treat re-reading an unchanged file as a state change", () => {
    const guard = new LoopGuard();
    runRound(guard, 0, readScript, () => "body");
    const epoch = guard.changeEpoch;
    runRound(guard, 1, readScript, () => "body");
    expect(guard.changeEpoch).toBe(epoch);
  });
});
