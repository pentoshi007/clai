import { describe, expect, it } from "vitest";
import { createGovernorState, governProgress, type GovernorPolicy } from "../src/agent/evidence-governor.js";

const policy: GovernorPolicy = { resourceEnvelope: 3, emergencyCeiling: 6, reflectionAfterNoDelta: 2, pauseAfterNoDelta: 3, repetitionThreshold: 0.8 };

describe("evidence progress governor", () => {
  it("continues on productive evidence or hypothesis deltas despite repetition", () => {
    const evidence = governProgress(createGovernorState(), "activity", { evidenceDelta: 1, repetitionScore: 1, policy });
    expect(evidence).toMatchObject({ recommendation: "continue", shouldContinue: true, state: { evidenceTotal: 1, consecutiveNoDelta: 0 } });
    const hypothesis = governProgress(evidence.state, "activity", { hypothesisDelta: 2, repetitionScore: 1, policy });
    expect(hypothesis).toMatchObject({ recommendation: "continue", state: { hypothesisTotal: 2, consecutiveNoDelta: 0 } });
  });

  it("keeps repetitive no-delta work in reflection without pausing", () => {
    let state = governProgress(createGovernorState(), "activity", { repetitionScore: 1, policy }).state;
    const reflection = governProgress(state, "activity", { repetitionScore: 1, policy });
    expect(reflection).toMatchObject({ recommendation: "reflect", shouldContinue: true, requireEvidence: true });
    state = reflection.state;
    expect(governProgress(state, "activity", { repetitionScore: 1, policy })).toMatchObject({ recommendation: "reflect", shouldContinue: true, requireEvidence: true });
  });

  it("treats both resource thresholds as reflection, never success or pause", () => {
    const envelope = governProgress(createGovernorState(), "activity", { resourceCost: 3, policy });
    expect(envelope).toMatchObject({ recommendation: "reflect", shouldContinue: true });
    const emergency = governProgress(envelope.state, "activity", { evidenceDelta: 4, resourceCost: 3, policy });
    expect(emergency).toMatchObject({ recommendation: "reflect", shouldContinue: true, requireEvidence: true });
    expect(emergency.recommendation).not.toBe("succeeded");
  });

  it("recommends success only for completion backed by new evidence", () => {
    expect(governProgress(createGovernorState(), "completion", { policy })).toMatchObject({ recommendation: "reflect", shouldContinue: true, requireEvidence: true });
    expect(governProgress(createGovernorState(), "completion", { evidenceDelta: 1, policy })).toMatchObject({ recommendation: "succeeded", shouldContinue: false, requireEvidence: false });
  });
});
