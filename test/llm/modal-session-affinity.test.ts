import { afterEach, describe, expect, it, vi } from "vitest";
import { modalSessionId, resetModalSessionId } from "../../src/llm/modal.js";
import { sessionCacheAffinityKey } from "../../src/llm/cache-affinity.js";
import { currentSessionAffinity, withSessionAffinity } from "../../src/llm/session-affinity.js";

afterEach(() => {
  vi.unstubAllEnvs();
  resetModalSessionId();
});

describe("Modal sticky-session cache isolation", () => {
  it.each(["", "configured-session"])("keeps concurrent agents isolated with configured ID %j", async (configured) => {
    vi.stubEnv("MODAL_SESSION_ID", configured);
    const scopes = ["parent", "parent:subagent:one", "parent:subagent:two", "parent:auxiliary"];
    await withSessionAffinity("parent", async () => {
      const before = modalSessionId();
      const ids = await Promise.all(scopes.map((scope) => withSessionAffinity(scope, async () => {
        const id = modalSessionId();
        await Promise.resolve();
        expect(modalSessionId()).toBe(id);
        expect(id).toBe(sessionCacheAffinityKey(configured ? `${configured}\0${scope}` : scope));
        return id;
      })));
      expect(new Set(ids).size).toBe(scopes.length);
      expect(modalSessionId()).toBe(before);
      expect(withSessionAffinity(scopes[1]!, modalSessionId)).toBe(ids[1]);
    });
    expect(currentSessionAffinity()).toBeUndefined();
  });

  it("preserves standalone configured and generated IDs", () => {
    vi.stubEnv("MODAL_SESSION_ID", "configured-session");
    expect(modalSessionId()).toBe("configured-session");
    vi.stubEnv("MODAL_SESSION_ID", "");
    const generated = modalSessionId();
    expect(modalSessionId()).toBe(generated);
    resetModalSessionId();
    expect(modalSessionId()).not.toBe(generated);
  });
});
