import { describe, expect, it, vi } from "vitest";
import type { ResponderNotification } from "../../src/tools/jobs.js";
import { ResponderClaimLedger } from "../../src/agent/turn/responder-claims.js";

const notification = (
  id: string,
  overrides: Partial<ResponderNotification> = {},
): ResponderNotification =>
  ({
    id,
    ownerSessionId: "session-1",
    jobId: `job-${id}`,
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    stdoutArtifact: { path: "/artifacts/out.log", bytes: 0, truncated: false },
    stderrArtifact: { path: "/artifacts/err.log", bytes: 0, truncated: false },
    commandDisplay: "npm test",
    wakeOnCompletion: true,
    responder: true,
    ...overrides,
  }) as ResponderNotification;

describe("responder claim ledger", () => {
  it("owns membership, size, and insertion-ordered ids", () => {
    const ledger = new ResponderClaimLedger({
      getPendingNotifications: () => [],
      releaseClaim: () => undefined,
    });

    ledger.add("n-1");
    ledger.add("n-2");
    ledger.add("n-1");
    expect(ledger.size).toBe(2);
    expect(ledger.has("n-1")).toBe(true);
    expect(ledger.ids()).toEqual(["n-1", "n-2"]);

    ledger.delete("n-1");
    expect(ledger.has("n-1")).toBe(false);
    expect(ledger.ids()).toEqual(["n-2"]);
  });

  it("keeps a claim whose delivery started and was never consumed", () => {
    const releaseClaim = vi.fn();
    const ledger = new ResponderClaimLedger({
      getPendingNotifications: () => [
        notification("n-inflight", {
          deliveryStartedAt: "2026-01-01T00:00:02.000Z",
        }),
      ],
      releaseClaim,
    });
    ledger.add("n-inflight");
    ledger.release();

    expect(releaseClaim).not.toHaveBeenCalled();
  });

  it("releases consumed, unstarted, and no-longer-pending claims", () => {
    const releaseClaim = vi.fn();
    const ledger = new ResponderClaimLedger({
      getPendingNotifications: () => [
        notification("n-read", {
          deliveryStartedAt: "2026-01-01T00:00:02.000Z",
          readAt: "2026-01-01T00:00:03.000Z",
        }),
        notification("n-analyzed", {
          deliveryStartedAt: "2026-01-01T00:00:02.000Z",
          analyzedAt: "2026-01-01T00:00:03.000Z",
        }),
        notification("n-acknowledged", {
          deliveryStartedAt: "2026-01-01T00:00:02.000Z",
          acknowledgedAt: "2026-01-01T00:00:03.000Z",
        }),
        notification("n-unstarted"),
      ],
      releaseClaim,
    });
    for (const id of [
      "n-read",
      "n-analyzed",
      "n-acknowledged",
      "n-unstarted",
      "n-absent",
    ]) {
      ledger.add(id);
    }
    ledger.release();

    expect(releaseClaim.mock.calls.map(([id]) => id)).toEqual([
      "n-read",
      "n-analyzed",
      "n-acknowledged",
      "n-unstarted",
      "n-absent",
    ]);
  });
});
