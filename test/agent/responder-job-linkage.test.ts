import { describe, expect, it } from "vitest";
import { appendPlanTask, createPlan, type SessionPlan } from "../../src/store/plan.js";
import { linkResponderJobToPlan } from "../../src/agent/turn/responder-job-linkage.js";
import { delegationTaskTitle } from "../../src/agent/responder-parent.js";
import type { BackgroundJob } from "../../src/tools/jobs.js";

const command = "npm test -- --run --reporter verbose test/a.test.ts test/b.test.ts";

const job = (overrides: Partial<BackgroundJob> = {}): BackgroundJob =>
  ({
    id: "job-1",
    status: "running",
    pid: 42,
    command,
    commandDisplay: command,
    stdoutArtifact: "/tmp/job-1.out",
    ownerSessionId: "s1",
    responder: true,
    ...overrides,
  }) as BackgroundJob;

const link = async (plan: SessionPlan, launched: BackgroundJob) => {
  let live = structuredClone(plan);
  await linkResponderJobToPlan(
    {
      loadPlan: async () => live,
      mutatePlan: async (mutator) => {
        const draft = structuredClone(live);
        if (!mutator(draft)) return { ok: false };
        live = draft;
        return { ok: true, plan: draft };
      },
      linkJob: (_id, patch) => ({ ...launched, ...patch }),
      renderPlan: () => undefined,
      setPendingSessionStatePlan: () => undefined,
      notify: () => undefined,
    },
    {
      job: launched,
      call: { name: "shell.exec", args: { command, responder: true } },
      toolEventId: "tool-1",
      delegationTaskId: undefined,
      dispatchedTaskId: undefined,
    },
    { ok: true, output: "started" },
  );
  return live;
};

const basePlan = (): SessionPlan =>
  createPlan({ sessionId: "s1", goal: "ship", detail: "d", kind: "build", taskTitles: ["Run suite"] });

describe("Responder job plan linkage", () => {
  it("titles a new Responder subtask with the job name shown in the Responder block", async () => {
    const plan = await link(basePlan(), job({ name: "full test suite" }));
    const child = plan.tasks.find((task) => task.responderOwned);
    expect(child?.title).toBe("Responder · full test suite");
  });

  it("retitles a delegation record to the launched job label", async () => {
    const plan = basePlan();
    appendPlanTask(plan, {
      title: delegationTaskTitle({ name: "shell.exec", args: { command } }),
      state: "in_progress",
      dependencies: [],
      resourceLocks: [],
      responderOwned: true,
      delegationId: "dg-1",
    });
    const linked = await link(plan, job({ name: "full test suite", delegationId: "dg-1" }));
    const children = linked.tasks.filter((task) => task.responderOwned);
    expect(children).toHaveLength(1);
    expect(children[0]?.title).toBe("Responder · full test suite");
    expect(children[0]?.jobId).toBe("job-1");
  });
});
