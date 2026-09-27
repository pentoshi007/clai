import { describe, expect, it, vi } from "vitest";
import { applySessionResume } from "../../src/ui-core/bootstrap/session-resume.js";

describe("session resume plan hydration", () => {
  it("propagates plan read failures before mutating the live session", async () => {
    const clear = vi.fn();
    const loadHistory = vi.fn();
    const services = {
      plan: {
        load: vi.fn().mockRejectedValue(new Error("plan store unavailable")),
        clear,
      },
      session: { loadHistory },
    } as unknown as Parameters<typeof applySessionResume>[0];
    const record = {
      id: "session",
      name: "session",
      messages: [],
    } as unknown as Parameters<typeof applySessionResume>[1];

    await expect(applySessionResume(services, record)).rejects.toThrow(
      "plan store unavailable",
    );
    expect(clear).not.toHaveBeenCalled();
    expect(loadHistory).not.toHaveBeenCalled();
  });
});
