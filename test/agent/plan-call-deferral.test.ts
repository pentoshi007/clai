import { describe, expect, it } from "vitest";
import { decidePlanCallDeferral } from "../../src/agent/turn/loop/plan-call-deferral.js";

const boundOf = (...names: string[]) =>
  names.map((name) => ({ call: { name } }));

describe("plan call deferral", () => {
  it("runs everything when no plan.create is present", () => {
    const decision = decidePlanCallDeferral(boundOf("fs.read", "fs.list"));
    expect(decision).toEqual({
      runCount: 2,
      deferReason:
        "Cancelled — not executed this turn (deferred or omitted).",
      notice: undefined,
      systemMessage: undefined,
    });
  });

  it("runs only the gathering calls before plan.create", () => {
    const decision = decidePlanCallDeferral(
      boundOf("dns.lookup", "net.scan", "plan.create", "fs.write"),
    );
    expect(decision.runCount).toBe(2);
    expect(decision.notice).toBe(
      "deferring plan.create until reconnaissance results are available",
    );
    expect(decision.deferReason).toContain("must wait until reconnaissance");
    expect(decision.systemMessage).toContain("Only the 2 gathering call(s)");
    expect(decision.systemMessage).toContain("2 plan/follow-on call(s)");
  });

  it("runs only plan.create when it leads follow-on calls", () => {
    const decision = decidePlanCallDeferral(
      boundOf("plan.create", "fs.write", "shell.exec"),
    );
    expect(decision.runCount).toBe(1);
    expect(decision.notice).toBe(
      "creating the plan now; deferring follow-on calls until it is approved",
    );
    expect(decision.systemMessage).toContain("alongside 2 follow-on call(s)");
  });

  it("runs a solitary plan.create with no deferral message", () => {
    const decision = decidePlanCallDeferral(boundOf("plan.create"));
    expect(decision.runCount).toBe(1);
    expect(decision.notice).toBeUndefined();
    expect(decision.systemMessage).toBeUndefined();
  });

  it("handles an empty round", () => {
    expect(decidePlanCallDeferral([]).runCount).toBe(0);
  });
});
