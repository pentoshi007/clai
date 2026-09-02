import { describe, expect, it } from "vitest";
import type { ResponderNotification } from "../../src/tools/jobs.js";
import {
  decideResponderRead,
  parseResponderReadRequest,
  type ResponderReadPorts,
  type ResponderReadWakeIdentity,
} from "../../src/agent/turn/responder-read-tool.js";

const notification = (
  overrides: Partial<ResponderNotification> = {},
): ResponderNotification =>
  ({
    id: "n1",
    jobId: "j1",
    sessionId: "s1",
    kind: "responder-result",
    createdAt: 1,
    ...overrides,
  }) as ResponderNotification;

const noWake: ResponderReadWakeIdentity = {
  wakeTurn: false,
  notificationId: undefined,
  jobId: undefined,
  resultRevision: undefined,
};

const ports = (
  overrides: Partial<ResponderReadPorts> = {},
): ResponderReadPorts => ({
  pendingNotifications: [],
  matchesWakeRevision: () => true,
  isClaimed: () => true,
  markRead: () => true,
  ...overrides,
});

describe("responder read tool", () => {
  it("trims identifiers and keeps the tool name", () => {
    expect(
      parseResponderReadRequest("job.read", {
        notificationId: "  n1 ",
        jobId: 7,
      }),
    ).toEqual({ toolName: "job.read", notificationId: "n1", jobId: "" });
  });

  it("requires an identifier", () => {
    const decision = decideResponderRead(
      { toolName: "job.read", notificationId: "", jobId: "" },
      noWake,
      ports(),
    );
    expect(decision.marked).toBe(false);
    expect(decision.output).toBe(
      "job.read failed: jobId or notificationId is required.",
    );
  });

  it("marks a claimed delivered notification read and releases the claim", () => {
    const target = notification();
    const decision = decideResponderRead(
      { toolName: "task.read", notificationId: "n1", jobId: "" },
      noWake,
      ports({ pendingNotifications: [target] }),
    );
    expect(decision.marked).toBe(true);
    expect(decision.output).toBe(
      "Responder job j1 (n1) marked delivered and read after model analysis.",
    );
    expect(decision.ledgerNotification).toBe(target);
    expect(decision.releaseClaimId).toBe("n1");
  });

  it("rejects mismatched identifier pairs before any read", () => {
    let marked = false;
    const decision = decideResponderRead(
      { toolName: "job.read", notificationId: "n1", jobId: "other" },
      noWake,
      ports({
        pendingNotifications: [notification()],
        markRead: () => {
          marked = true;
          return true;
        },
      }),
    );
    expect(marked).toBe(false);
    expect(decision.output).toBe(
      "job.read failed: jobId and notificationId refer to different Responder results.",
    );
  });

  it("refuses undelivered results that were never claimed", () => {
    const decision = decideResponderRead(
      { toolName: "job.read", notificationId: "n1", jobId: "" },
      noWake,
      ports({ pendingNotifications: [notification()], isClaimed: () => false }),
    );
    expect(decision.marked).toBe(false);
    expect(decision.output).toContain("was not delivered to this model turn");
    expect(decision.releaseClaimId).toBeUndefined();
  });

  it("reports an unavailable result when nothing matches", () => {
    const decision = decideResponderRead(
      { toolName: "job.read", notificationId: "", jobId: "j9" },
      noWake,
      ports(),
    );
    expect(decision.output).toBe(
      "job.read failed: Responder result j9 is unavailable, consumed, or archived.",
    );
  });

  it("reports a persistence failure distinctly", () => {
    const decision = decideResponderRead(
      { toolName: "job.read", notificationId: "n1", jobId: "" },
      noWake,
      ports({ pendingNotifications: [notification()], markRead: () => false }),
    );
    expect(decision.marked).toBe(false);
    expect(decision.output).toBe(
      "job.read failed: read state for Responder result n1 could not be persisted.",
    );
  });

  it("acknowledges a stale wake idempotently with its revision", () => {
    const decision = decideResponderRead(
      { toolName: "job.read", notificationId: "n1", jobId: "j1" },
      {
        wakeTurn: true,
        notificationId: "n1",
        jobId: "j1",
        resultRevision: 3,
      },
      ports(),
    );
    expect(decision.marked).toBe(true);
    expect(decision.output).toBe(
      "Responder result j1 revision 3 was already settled or discarded; the stale wake is acknowledged idempotently.",
    );
    expect(decision.releaseClaimId).toBe("n1");
  });

  it("filters pending notifications by wake revision on a wake turn", () => {
    const decision = decideResponderRead(
      { toolName: "job.read", notificationId: "n1", jobId: "" },
      { wakeTurn: true, notificationId: "n2", jobId: undefined, resultRevision: undefined },
      ports({
        pendingNotifications: [notification()],
        matchesWakeRevision: () => false,
      }),
    );
    expect(decision.marked).toBe(false);
    expect(decision.output).toContain("is unavailable, consumed, or archived");
  });
});
