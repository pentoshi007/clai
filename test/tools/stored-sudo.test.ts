import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setMachineSudoPassword } from "../../src/store/credentials.js";
import { resetKnownSecrets } from "../../src/security/known-secrets.js";
import { obtainSudoPassword, resetSudoSession } from "../../src/tools/sudo-session.js";
import { preparePrivilegedBackgroundArgv, tryRunElevatedWithoutTty } from "../../src/tools/elevated-shell.js";

let root: string;
const original = process.env.CLAI_DATA_DIR;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "clai-stored-sudo-"));
  process.env.CLAI_DATA_DIR = root;
  resetSudoSession();
});
afterEach(async () => {
  resetSudoSession();
  resetKnownSecrets();
  if (original === undefined) delete process.env.CLAI_DATA_DIR;
  else process.env.CLAI_DATA_DIR = original;
  await rm(root, { recursive: true, force: true });
});
const OK = { ok: true, output: "", exitCode: 0 };

describe("automatic machine sudo", () => {
  it("never opens a modal for a stored password and sends it only to sudo stdin", async () => {
    await setMachineSudoPassword("stored-fixture");
    const requestSecret = vi.fn(async () => "must-not-prompt");
    const runAuth = vi.fn(async () => OK);
    const result = await obtainSudoPassword({ requestSecret, title: "Sudo", prompt: "Password" }, { runAuth });
    expect(result).toMatchObject({ status: "granted", password: "stored-fixture" });
    expect(requestSecret).not.toHaveBeenCalled();
    expect(runAuth).toHaveBeenCalledWith(expect.objectContaining({ command: "sudo", argv: ["-S", "-p", "", "-v"], stdinText: "stored-fixture\n", noArtifact: true }));
    expect(JSON.stringify(runAuth.mock.calls[0]?.[0]?.argv)).not.toContain("stored-fixture");
  });

  it("fails clearly without prompting if the stored password is rejected", async () => {
    await setMachineSudoPassword("wrong-stored-fixture");
    const requestSecret = vi.fn();
    const result = await obtainSudoPassword({ requestSecret, title: "Sudo", prompt: "Password" }, { runAuth: async () => ({ ok: false, output: "incorrect password wrong-stored-fixture", exitCode: 1 }) });
    expect(result).toMatchObject({ status: "failed", detail: expect.stringContaining("/creds") });
    expect(JSON.stringify(result)).not.toContain("wrong-stored-fixture");
    expect(requestSecret).not.toHaveBeenCalled();
  });

  it("runs foreground elevation without any secret UI port", async () => {
    await setMachineSudoPassword("headless-fixture");
    const run = vi.fn(async () => OK);
    const result = await tryRunElevatedWithoutTty("sudo id", {}, { isRoot: () => false, available: async () => true, run });
    expect(result?.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toMatchObject({ command: "sudo", stdinText: "headless-fixture\n" });
  });

  it("prepares background elevation without a UI port", async () => {
    await setMachineSudoPassword("background-fixture");
    const result = await preparePrivilegedBackgroundArgv("id", [], {}, { isRoot: () => false, available: async () => true, runAuth: async () => OK });
    expect(result).toMatchObject({ prepared: true, spec: { command: "sudo", stdinText: "background-fixture\n" } });
  });

  it("does not authenticate after cancellation", async () => {
    await setMachineSudoPassword("aborted-fixture");
    const controller = new AbortController();
    controller.abort();
    const runAuth = vi.fn();
    expect(await obtainSudoPassword({ title: "Sudo", prompt: "Password", signal: controller.signal }, { runAuth })).toEqual({ status: "cancelled" });
    expect(runAuth).not.toHaveBeenCalled();
  });
});
