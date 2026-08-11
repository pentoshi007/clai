import { describe, expect, it } from "vitest";
import { installConsoleGuard } from "../../../src/ui-core/bootstrap/console-guard.js";
import { isSuppressedConsoleMessage } from "../../../src/ui-core/bootstrap/console-suppress.js";

describe("isSuppressedConsoleMessage", () => {
  it("suppresses the EventTarget memory-leak warning", () => {
    const msg =
      'Possible EventTarget memory leak detected. 11 resize listeners added to [CliRenderer]. MaxListeners is undefined. Use events.setMaxListeners() to increase limit';
    expect(isSuppressedConsoleMessage(msg)).toBe(true);
  });

  it("suppresses the React setState-in-render %s warning", () => {
    const msg =
      'Cannot update a component (`%s`) while rendering a different component (`%s`). To locate the bad setState() call inside `%s`, follow the stack trace as described in https://react.dev/link/setstate-in-render TranscriptView IntroCard IntroCard';
    expect(isSuppressedConsoleMessage(msg)).toBe(true);
  });

  it("does not suppress ordinary warnings", () => {
    expect(
      isSuppressedConsoleMessage('modelVisionSupport: "omniroute" is not a canonical ProviderId'),
    ).toBe(false);
    expect(isSuppressedConsoleMessage("some other error")).toBe(false);
  });
});

describe("console guard onCapture wiring", () => {
  it("captures messages and calls onCapture with the raw text", () => {
    const captured: string[] = [];
    const restore = installConsoleGuard({
      logDir: "/nonexistent-clai-update-test",
      onCapture: (_level, message) => captured.push(message),
    });
    try {
      console.warn("just a check");
    } finally {
      restore();
    }
    expect(captured.some((m) => m.includes("just a check"))).toBe(true);
  });
});