import { beforeEach, describe, expect, it } from "vitest";
import {
  evictSudoSession,
  formatSudoStdinPassword,
  looksLikeSudoAuthError,
  obtainSudoPassword,
  resetSudoSession,
  SUDO_SESSION_TTL_MS,
} from "../../src/tools/sudo-session.js";

const OK_AUTH = { ok: true, output: "", exitCode: 0 } as const;

function grantedRequest(secret = "pw") {
  return {
    requestSecret: async () => secret,
    title: "Administrator access",
    prompt: "password?",
  };
}

beforeEach(() => {
  resetSudoSession();
});

describe("formatSudoStdinPassword", () => {
  it("strips trailing newlines but keeps spaces and ends with one newline", () => {
    expect(formatSudoStdinPassword("secret")).toBe("secret\n");
    expect(formatSudoStdinPassword("secret\n")).toBe("secret\n");
    expect(formatSudoStdinPassword("secret\r\n\r\n")).toBe("secret\n");
    expect(formatSudoStdinPassword(" pass word ")).toBe(" pass word \n");
  });
});

describe("obtainSudoPassword", () => {
  it("prompts once, validates, and caches the password", async () => {
    let prompts = 0;
    const authInputs: string[] = [];
    const first = await obtainSudoPassword(
      {
        requestSecret: async () => {
          prompts += 1;
          return "s3cret";
        },
        title: "t",
        prompt: "p",
      },
      {
        runAuth: async (args) => {
          authInputs.push(args.stdinText ?? "");
          return OK_AUTH;
        },
      },
    );
    expect(first).toMatchObject({
      status: "granted",
      password: "s3cret",
      fromCache: false,
    });
    expect(authInputs).toEqual(["s3cret\n"]);

    // Second call within the TTL: no prompt, no re-validation.
    const second = await obtainSudoPassword(
      {
        requestSecret: async () => {
          prompts += 1;
          return "s3cret";
        },
        title: "t",
        prompt: "p",
      },
      {
        runAuth: async () => {
          throw new Error("must not re-validate a cached password");
        },
      },
    );
    expect(second).toMatchObject({
      status: "granted",
      password: "s3cret",
      fromCache: true,
    });
    expect(prompts).toBe(1);
  });

  it("coalesces concurrent requests onto a single prompt and validation", async () => {
    let prompts = 0;
    let validations = 0;
    let releasePrompt: ((value: string | undefined) => void) | undefined;
    const requestSecret = () =>
      new Promise<string | undefined>((resolve) => {
        prompts += 1;
        releasePrompt = resolve;
      });

    const deps = {
      runAuth: async () => {
        validations += 1;
        return OK_AUTH;
      },
    };
    // Two parallel privileged scans ask at the same time.
    const a = obtainSudoPassword(
      { requestSecret, title: "t", prompt: "p" },
      deps,
    );
    const b = obtainSudoPassword(
      { requestSecret, title: "t", prompt: "p" },
      deps,
    );
    expect(prompts).toBe(1);

    releasePrompt?.("batch-pw");
    const [outcomeA, outcomeB] = await Promise.all([a, b]);
    expect(outcomeA).toMatchObject({ status: "granted", password: "batch-pw" });
    expect(outcomeB).toMatchObject({ status: "granted", password: "batch-pw" });
    expect(validations).toBe(1);
  });

  it("shares a cancellation across concurrent waiters, then re-prompts later", async () => {
    let prompts = 0;
    const deps = { runAuth: async () => OK_AUTH };
    const cancelled = await Promise.all([
      obtainSudoPassword(
        {
          requestSecret: async () => {
            prompts += 1;
            return undefined;
          },
          title: "t",
          prompt: "p",
        },
        deps,
      ),
      obtainSudoPassword(
        { requestSecret: async () => "never-called", title: "t", prompt: "p" },
        deps,
      ),
    ]);
    expect(cancelled.map((o) => o.status)).toEqual(["cancelled", "cancelled"]);
    expect(prompts).toBe(1);

    // Nothing was cached: a later request prompts again.
    const retry = await obtainSudoPassword(
      {
        requestSecret: async () => {
          prompts += 1;
          return "pw";
        },
        title: "t",
        prompt: "p",
      },
      deps,
    );
    expect(retry.status).toBe("granted");
    expect(prompts).toBe(2);
  });

  it("does not cache a failed authentication", async () => {
    let prompts = 0;
    const fail = await obtainSudoPassword(
      {
        requestSecret: async () => {
          prompts += 1;
          return "wrong";
        },
        title: "t",
        prompt: "p",
      },
      {
        runAuth: async () => ({
          ok: false,
          output: "Sorry, try again.",
          exitCode: 1,
        }),
      },
    );
    expect(fail).toMatchObject({ status: "failed", detail: "Sorry, try again." });

    let validations = 0;
    const retry = await obtainSudoPassword(
      {
        requestSecret: async () => {
          prompts += 1;
          return "right";
        },
        title: "t",
        prompt: "p",
      },
      {
        runAuth: async () => {
          validations += 1;
          return OK_AUTH;
        },
      },
    );
    expect(retry).toMatchObject({ status: "granted", password: "right" });
    expect(prompts).toBe(2);
    expect(validations).toBe(1);
  });

  it("expires the cached password after the TTL", async () => {
    let clock = 1_000;
    let prompts = 0;
    const deps = {
      now: () => clock,
      runAuth: async () => OK_AUTH,
    };
    const first = await obtainSudoPassword(
      {
        requestSecret: async () => {
          prompts += 1;
          return "pw";
        },
        title: "t",
        prompt: "p",
      },
      deps,
    );
    expect(first.status).toBe("granted");

    clock += SUDO_SESSION_TTL_MS - 1;
    const stillCached = await obtainSudoPassword(
      grantedRequest(),
      deps,
    );
    expect(stillCached).toMatchObject({ status: "granted", fromCache: true });
    expect(prompts).toBe(1);

    clock += 2;
    const expired = await obtainSudoPassword(
      {
        requestSecret: async () => {
          prompts += 1;
          return "pw";
        },
        title: "t",
        prompt: "p",
      },
      deps,
    );
    expect(expired).toMatchObject({ status: "granted", fromCache: false });
    expect(prompts).toBe(2);
  });

  it("maps a validation spawn failure to a failed outcome", async () => {
    const outcome = await obtainSudoPassword(grantedRequest(), {
      runAuth: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.detail).toMatch(/could not start/);
    }
  });
});

describe("evictSudoSession", () => {
  it("drops the cached password so the next call re-prompts", async () => {
    let prompts = 0;
    const deps = { runAuth: async () => OK_AUTH };
    await obtainSudoPassword(
      {
        requestSecret: async () => {
          prompts += 1;
          return "pw";
        },
        title: "t",
        prompt: "p",
      },
      deps,
    );
    expect(prompts).toBe(1);

    evictSudoSession();
    const after = await obtainSudoPassword(
      {
        requestSecret: async () => {
          prompts += 1;
          return "pw";
        },
        title: "t",
        prompt: "p",
      },
      deps,
    );
    expect(after).toMatchObject({ status: "granted", fromCache: false });
    expect(prompts).toBe(2);
  });

  it("only evicts when the expected password still matches the cache", async () => {
    const deps = { runAuth: async () => OK_AUTH };
    await obtainSudoPassword(grantedRequest("current"), deps);

    evictSudoSession("some-other-password");
    const stillCached = await obtainSudoPassword(grantedRequest(), deps);
    expect(stillCached).toMatchObject({
      status: "granted",
      password: "current",
      fromCache: true,
    });
  });
});

describe("looksLikeSudoAuthError", () => {
  it("matches sudo authentication failures only", () => {
    expect(looksLikeSudoAuthError("Sorry, try again.")).toBe(true);
    expect(looksLikeSudoAuthError("sudo: 3 incorrect password attempts")).toBe(
      true,
    );
    expect(looksLikeSudoAuthError("authentication failure")).toBe(true);
    // nmap's own privilege complaint is NOT an auth failure.
    expect(
      looksLikeSudoAuthError("You requested a scan type which requires root privileges."),
    ).toBe(false);
  });
});
