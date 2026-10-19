import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InteractiveSessionManager } from "../../src/interactive-session/manager.js";
import { RecoveryJournal } from "../../src/interactive-session/recovery-journal.js";
import { SessionTelemetry } from "../../src/interactive-session/telemetry.js";
import { createInteractiveSessionHandlers } from "../../src/tools/interactive-session-tools.js";
import { renderUserCredentials } from "../../src/agent/context/user-credentials.js";
import { FakeTransportFactory } from "./helpers.js";

const ownerId = "user-secret-input";
const cleanups: Array<() => Promise<void>> = [];

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "clai-user-secret-"));
  const factory = new FakeTransportFactory({ ptyAvailable: true });
  const manager = new InteractiveSessionManager({
    artifactBaseDir: dir,
    transports: factory,
    journal: new RecoveryJournal(join(dir, "journal")),
    telemetry: new SessionTelemetry(async () => undefined),
  });
  cleanups.push(async () => {
    await manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });
  const started = await manager.start({ ownerId, command: "repl", confirm: async () => true });
  return { manager, factory, started, send: createInteractiveSessionHandlers(manager)["terminal.send"] };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("user-provided terminal secret input", () => {
  it("automatically reuses a labeled password without opening either UI's modal", async () => {
    const { send, factory, started } = await fixture();
    const requestSecret = vi.fn(async () => "modal-value");
    const result = await send({ id: started.sessionId, kind: "secret", quietMs: 25 }, {
      sessionId: ownerId, confirmed: true, userPrompt: "SSH host: localhost\nusername: lab\npassword: supplied-fixture", requestSecret,
    });
    expect(result.ok).toBe(true);
    expect(requestSecret).not.toHaveBeenCalled();
    expect(factory.last().writes).toEqual(["supplied-fixture\r"]);
    expect(JSON.stringify(result)).not.toContain("supplied-fixture");
  });

  it("works without a secret-input UI when explicitly selecting user input", async () => {
    const { send, factory, started } = await fixture();
    const result = await send({ id: started.sessionId, kind: "secret", secretSource: "user", submit: "none", quietMs: 25 }, {
      sessionId: ownerId, confirmed: true, userPrompt: 'password: "試験-🙂 with spaces"',
    });
    expect(result.ok).toBe(true);
    expect(factory.last().writes).toEqual(["試験-🙂 with spaces"]);
  });

  it("reuses a password from earlier authentic user messages", async () => {
    const { send, factory, started } = await fixture();
    const result = await send({ id: started.sessionId, kind: "secret", quietMs: 25 }, {
      sessionId: ownerId, confirmed: true, userPrompt: "continue", userMessages: [
        { role: "user", content: "password is earlier-fixture" },
        { role: "assistant", content: "password: wrong-assistant-value" },
        { role: "tool", content: "password: wrong-tool-value" },
        { role: "user", internal: true, content: "password: wrong-internal-value" },
        { role: "user", content: "continue" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(factory.last().writes).toEqual(["earlier-fixture\r"]);
  });

  it("reuses the authoritative carried password after compaction", async () => {
    const { send, factory, started } = await fixture();
    const result = await send({ id: started.sessionId, kind: "secret", quietMs: 25 }, {
      sessionId: ownerId, confirmed: true, userPrompt: "continue", userMessages: [
        { role: "system", content: "Session memory: password: fabricated-summary-value" },
        { role: "system", content: ["DURABLE WORK ENVELOPE (canonical)", ...renderUserCredentials(["host: localhost", "password: carried-fixture"])].join("\n") },
      ],
    });
    expect(result.ok).toBe(true);
    expect(factory.last().writes).toEqual(["carried-fixture\r"]);
  });

  it("retains an explicit masked-input override even when a password was supplied", async () => {
    const { send, factory, started } = await fixture();
    const requestSecret = vi.fn(async () => "modal-value");
    const result = await send({ id: started.sessionId, kind: "secret", secretSource: "prompt", quietMs: 25 }, {
      sessionId: ownerId, confirmed: true, userPrompt: "password: supplied-fixture", requestSecret,
    });
    expect(result.ok).toBe(true);
    expect(requestSecret).toHaveBeenCalledOnce();
    expect(factory.last().writes).toEqual(["modal-value\r"]);
  });

  it.each(["connect to SSH", "password: first-fixture\npassword: second-fixture"])(
    "falls back to masked input when the supplied password is missing or ambiguous: %s",
    async (userPrompt) => {
      const { send, factory, started } = await fixture();
      const requestSecret = vi.fn(async () => "modal-value");
      const result = await send({ id: started.sessionId, kind: "secret", quietMs: 25 }, {
        sessionId: ownerId, confirmed: true, userPrompt, requestSecret,
      });
      expect(result.ok).toBe(true);
      expect(requestSecret).toHaveBeenCalledOnce();
      expect(factory.last().writes).toEqual(["modal-value\r"]);
    },
  );

  it("never prompts or sends a guessed value when user-only resolution is ambiguous", async () => {
    const { send, factory, started } = await fixture();
    const requestSecret = vi.fn(async () => "modal-value");
    const result = await send({ id: started.sessionId, kind: "secret", secretSource: "user" }, {
      sessionId: ownerId, confirmed: true, userPrompt: "password: first-fixture\npassword: second-fixture", requestSecret,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/ambiguous/i);
    expect(requestSecret).not.toHaveBeenCalled();
    expect(factory.last().writes).toEqual([]);
  });

  it("registers a reused password before any echo and keeps it out of terminal artifacts", async () => {
    const { manager, send, factory, started } = await fixture();
    const value = "echo-fixture-試験🙂";
    const args = { id: started.sessionId, kind: "secret", secretSource: "user", quietMs: 100 };
    const pending = send(args, { sessionId: ownerId, confirmed: true, userPrompt: `password: ${value}` });
    await expect.poll(() => factory.last().writes.length).toBe(1);
    factory.last().emit(`echo ${value.slice(0, 5)}`);
    factory.last().emit(`${value.slice(5)}\n`);
    const result = await pending;
    expect(result.output).toContain("[redacted]");
    expect(JSON.stringify({ args, result })).not.toContain(value);
    expect(factory.last().writes).toEqual([`${value}\r`]);
    await manager.close({ ownerId, id: started.sessionId });
    expect(readFileSync(started.artifact.path, "utf8")).not.toContain(value);
  });

  it.each(["exited", "wrong owner", "invalid cursor"])("preflights %s before resolving or delivering a user password", async (scenario) => {
    const { manager, send, factory, started } = await fixture();
    if (scenario === "exited") await manager.close({ ownerId, id: started.sessionId });
    const requestSecret = vi.fn(async () => "modal-value");
    const result = await send({ id: started.sessionId, kind: "secret", ...(scenario === "invalid cursor" ? { cursor: 100 } : {}) }, {
      sessionId: scenario === "wrong owner" ? "other-owner" : ownerId,
      confirmed: true, userPrompt: "password: supplied-fixture", requestSecret,
    });
    expect(result.ok).toBe(false);
    expect(requestSecret).not.toHaveBeenCalled();
    expect(factory.last().writes).toEqual([]);
  });

  it.each([
    { kind: "secret", secretSource: "invalid" },
    { kind: "secret", secretSource: 5 },
    { kind: "secret", secretSource: "user", text: "do-not-send" },
    { kind: "text", secretSource: "user", text: "do-not-send" },
    { kind: "control", secretSource: "user", control: "interrupt" },
    { kind: "eof", secretSource: "user" },
  ])("rejects invalid secret-source arguments without delivery: %j", async (args) => {
    const { send, factory, started } = await fixture();
    const requestSecret = vi.fn(async () => "modal-value");
    const result = await send({ id: started.sessionId, ...args }, {
      sessionId: ownerId, confirmed: true, userPrompt: "password: supplied-fixture", requestSecret,
    });
    expect(result.ok).toBe(false);
    expect(requestSecret).not.toHaveBeenCalled();
    expect(factory.last().writes).toEqual([]);
  });
});


describe("stored terminal secret input", () => {
  it.each(["store", "sudo"])("delivers a %s credential without a UI or secret in arguments", async (source) => {
    const { saveCredential, setMachineSudoPassword } = await import("../../src/store/credentials.js");
    const { resetKnownSecrets } = await import("../../src/security/known-secrets.js");
    const dir = mkdtempSync(join(tmpdir(), "clai-terminal-vault-"));
    const original = process.env.CLAI_DATA_DIR;
    process.env.CLAI_DATA_DIR = dir;
    try {
      const value = "stored-terminal-fixture-試験🙂";
      const id = source === "store" ? await saveCredential({ title: "Password only", content: value }) : undefined;
      if (source === "sudo") await setMachineSudoPassword(value);
      const { manager, send, factory, started } = await fixture();
      const requestSecret = vi.fn();
      const args = { id: started.sessionId, kind: "secret", secretSource: source, ...(id ? { credentialId: id } : {}), quietMs: 100 };
      const pending = send(args, { sessionId: ownerId, confirmed: true, requestSecret });
      await expect.poll(() => factory.last().writes.length).toBe(1);
      factory.last().emit(`echo ${value.slice(0, 8)}`);
      factory.last().emit(`${value.slice(8)}\n`);
      const result = await pending;
      expect(result.ok).toBe(true);
      expect(requestSecret).not.toHaveBeenCalled();
      expect(factory.last().writes).toEqual([`${value}\r`]);
      expect(JSON.stringify({ args, result })).not.toContain(value);
      await manager.close({ ownerId, id: started.sessionId });
      expect(readFileSync(started.artifact.path, "utf8")).not.toContain(value);
    } finally {
      if (original === undefined) delete process.env.CLAI_DATA_DIR;
      else process.env.CLAI_DATA_DIR = original;
      resetKnownSecrets();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
