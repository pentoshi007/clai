import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isIndependentRuntimeChild,
  RUNTIME_CHILD_ENV,
  RUNTIME_SESSION_ENV,
  RUNTIME_SOCKET_ENV,
  RUNTIME_TOKEN_ENV,
  RUNTIME_VIEWS_ENV,
} from "../../src/session-runtime/launch.js";

const environment = {
  [RUNTIME_CHILD_ENV]: "1",
  [RUNTIME_SESSION_ENV]: "runtime-session",
  [RUNTIME_SOCKET_ENV]: "runtime-socket",
  [RUNTIME_TOKEN_ENV]: "a".repeat(64),
  [RUNTIME_VIEWS_ENV]: "1",
};

function configure(): void {
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
}

afterEach(() => vi.unstubAllEnvs());

describe("independent runtime child startup", () => {
  it("recognises a socket-backed child even when its stdio is not a terminal", () => {
    configure();
    expect(isIndependentRuntimeChild()).toBe(true);
  });

  it.each(Object.keys(environment))("does not bypass normal stdin handling without %s", (key) => {
    configure();
    vi.stubEnv(key, undefined);
    expect(isIndependentRuntimeChild()).toBe(false);
  });

  it("keeps legacy terminal children on the normal startup path", () => {
    configure();
    vi.stubEnv(RUNTIME_VIEWS_ENV, "0");
    expect(isIndependentRuntimeChild()).toBe(false);
  });
});
