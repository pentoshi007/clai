import { describe, expect, it, vi } from "vitest";

const history = vi.hoisted(() => ({ listSessionSummaries: vi.fn(), getSession: vi.fn() }));
vi.mock("../../src/store/history.js", async (original) => ({
  ...(await original<typeof import("../../src/store/history.js")>()),
  ...history,
}));

import { resolveResumeOption, resolveResumeTarget } from "../../src/ui-core/bootstrap/session-resume.js";

describe("resume options", () => {
  it("resumes the latest session globally without an id and preserves explicit id selection", () => {
    expect(resolveResumeOption({ resume: true })).toEqual({ kind: "latest", scope: "global" });
    expect(resolveResumeOption({ resume: "  abc  ", continue: true })).toEqual({ kind: "id", id: "abc" });
    expect(resolveResumeOption({ continue: true })).toEqual({ kind: "latest" });
    expect(resolveResumeOption({})).toBeUndefined();
  });

  it("selects the most recent saved session across directories for bare resume", async () => {
    history.listSessionSummaries.mockResolvedValue([{ id: "newest", cwd: "/elsewhere" }, { id: "here", cwd: process.cwd() }]);
    history.getSession.mockImplementation(async (id: string) => ({ id, messages: [], transcript: [] }));
    expect((await resolveResumeTarget({ kind: "latest", scope: "global" })).record?.id).toBe("newest");
    expect((await resolveResumeTarget({ kind: "latest" })).record?.id).toBe("here");
  });

  it("reports empty history without mutating or discarding session data", async () => {
    history.listSessionSummaries.mockResolvedValue([]);
    history.getSession.mockClear();
    expect(await resolveResumeTarget({ kind: "latest", scope: "global" })).toEqual({ record: undefined, error: "no saved sessions yet" });
    expect(history.getSession).not.toHaveBeenCalled();
  });
});
