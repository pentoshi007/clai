import { describe, expect, it } from "vitest";
import {
  codingSessionFromContext,
  isProtocolPlaceholderOutput,
} from "../src/agent/progress-pause-policy.js";

describe("progress policy helpers", () => {
  it("treats coding plan kind as a coding session", () => {
    expect(
      codingSessionFromContext({ buildLike: false, planKind: "coding" }),
    ).toBe(true);
    expect(
      codingSessionFromContext({ buildLike: false, planKind: "pentest" }),
    ).toBe(false);
    expect(
      codingSessionFromContext({ buildLike: true, planKind: "general" }),
    ).toBe(true);
  });

  it("detects protocol repair placeholders", () => {
    expect(
      isProtocolPlaceholderOutput(
        "[context-note] No stored body for shell.exec (id=x) in earlier context.",
      ),
    ).toBe(true);
    expect(
      isProtocolPlaceholderOutput(
        "[protocol] closed incomplete shell.exec call after resume (id=x). Ignore this row for evidence.",
      ),
    ).toBe(true);
    expect(
      isProtocolPlaceholderOutput(
        "[internal-pairing] synthetic close for shell.exec (id=x).",
      ),
    ).toBe(true);
    expect(isProtocolPlaceholderOutput("file a.ts\nfile b.ts")).toBe(false);
  });
});
