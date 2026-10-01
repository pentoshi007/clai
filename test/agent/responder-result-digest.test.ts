import { describe, expect, it } from "vitest";
import {
  MAX_RESULT_DIGEST_CHARS,
  RESPONDER_RESULT_LEDGER_PREFIX,
  normalizeResultDigest,
  parseResponderLedgerLine,
  responderResultLedgerEntry,
  upsertResponderResultLedger,
} from "../../src/agent/responder-context.js";
import type { ResponderNotification } from "../../src/tools/jobs.js";

type LedgerMessages = Array<{
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}>;

const notification = (
  overrides: Partial<ResponderNotification> = {},
): ResponderNotification =>
  ({
    id: "completion:job-1",
    jobId: "job-1",
    status: "exited",
    taskId: "t4",
    parentTaskId: "t2",
    readAt: "2026-01-01T00:00:00.000Z",
    analyzedAt: "2026-01-01T00:00:01.000Z",
    stdoutArtifact: { path: "/data/My Artifacts/job-1.log", chunks: [], bytes: 10 },
    stderrArtifact: { path: "/data/My Artifacts/job-1.err", chunks: [], bytes: 0 },
    ...overrides,
  }) as ResponderNotification;

const latestLedger = (messages: LedgerMessages): string =>
  messages.filter((message) => message.content.startsWith(RESPONDER_RESULT_LEDGER_PREFIX)).at(-1)!
    .content;

describe("responder result digest", () => {
  it("normalises to one bounded, redacted line", () => {
    expect(normalizeResultDigest(undefined)).toBeUndefined();
    expect(normalizeResultDigest("   \n\t ")).toBeUndefined();
    expect(normalizeResultDigest("a\n\n b\t c")).toBe("a b c");
    const long = normalizeResultDigest("word ".repeat(200))!;
    expect(long.length).toBe(MAX_RESULT_DIGEST_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });

  it("round-trips through a ledger line, including quotes, backslashes and spaced artifact paths", () => {
    const digest = 'Admin panel at "/admin" needs C:\\tmp\\key; 3 hosts up';
    const line = responderResultLedgerEntry(notification({ resultDigest: digest }));
    expect(line).toContain('artifact=/data/My Artifacts/job-1.log summary="');
    expect(parseResponderLedgerLine(line)).toEqual({
      notificationId: "completion:job-1",
      jobId: "job-1",
      digest,
    });
  });

  it("writes no summary field when no conclusion was recorded", () => {
    const line = responderResultLedgerEntry(notification());
    expect(line).not.toContain("summary=");
    expect(parseResponderLedgerLine(line)).toEqual({
      notificationId: "completion:job-1",
      jobId: "job-1",
    });
  });

  it("ignores a malformed summary field instead of throwing", () => {
    expect(
      parseResponderLedgerLine('- notification=n1 job=j1 artifact=/a summary="unterminated'),
    ).toEqual({ notificationId: "n1", jobId: "j1" });
    expect(parseResponderLedgerLine('- notification=n1 job=j1 summary="\\q"')).toEqual({
      notificationId: "n1",
      jobId: "j1",
    });
  });

  it("appends a fresh ledger copy that keeps earlier entries and their conclusions", () => {
    const messages: LedgerMessages = [{ role: "user", content: "start" }];
    upsertResponderResultLedger(messages, notification({ resultDigest: "first conclusion" }));
    const afterFirst = messages.length;
    upsertResponderResultLedger(
      messages,
      notification({ id: "completion:job-2", jobId: "job-2", resultDigest: "second conclusion" }),
    );

    expect(messages).toHaveLength(afterFirst + 1);
    const ledger = latestLedger(messages);
    expect(ledger).toContain('summary="first conclusion"');
    expect(ledger).toContain('summary="second conclusion"');
    expect(ledger.split("\n").filter((line) => line.startsWith("- notification="))).toHaveLength(2);
  });

  it("replaces the entry in place when the same result is recorded again", () => {
    const messages: LedgerMessages = [];
    upsertResponderResultLedger(messages, notification({ resultDigest: "old" }));
    upsertResponderResultLedger(messages, notification({ resultDigest: "new" }));
    const ledger = latestLedger(messages);
    expect(ledger).toContain('summary="new"');
    expect(ledger).not.toContain('summary="old"');
  });
});
