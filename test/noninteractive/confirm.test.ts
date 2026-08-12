import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "../../src/types.js";
import {
  CONFIRMATION_REQUIRED_MESSAGE,
  askSecret,
  askYesNo,
  parseYesNo,
  releaseInteractiveStdin,
} from "../../src/noninteractive/readline-prompts.js";
import {
  createStdioConfirmPort,
  createStdioSecretPort,
} from "../../src/noninteractive/stdio-confirm-port.js";

interface FakeIO {
  readonly input: PassThrough & { isTTY?: boolean };
  readonly output: PassThrough;
  written(): string;
}

function makeIO(options?: { tty?: boolean }): FakeIO {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = options?.tty ?? true;
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (chunk: Buffer | string) => chunks.push(String(chunk)));
  return { input, output, written: () => chunks.join("") };
}

function answer(io: FakeIO, line: string): void {
  setImmediate(() => io.input.write(`${line}\n`));
}

describe("releaseInteractiveStdin", () => {
  it("returns a resumed raw TTY to cooked paused state", () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode(mode: boolean): void;
    };
    input.isTTY = true;
    input.isRaw = true;
    input.setRawMode = (mode) => {
      input.isRaw = mode;
    };
    input.resume();

    releaseInteractiveStdin({ input });

    expect(input.isRaw).toBe(false);
    expect(input.isPaused()).toBe(true);
  });

  it("leaves non-TTY input ownership unchanged", () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = false;
    input.resume();

    releaseInteractiveStdin({ input });

    expect(input.isPaused()).toBe(false);
    input.pause();
  });
});

describe("readline y/n parsing", () => {
  it("maps the accepted spellings", () => {
    expect(parseYesNo("y")).toBe(true);
    expect(parseYesNo(" YES ")).toBe(true);
    expect(parseYesNo("n")).toBe(false);
    expect(parseYesNo("No")).toBe(false);
    expect(parseYesNo("maybe")).toBeUndefined();
  });

  it("reads y and n from the input stream", async () => {
    const yes = makeIO();
    answer(yes, "y");
    await expect(askYesNo("Run it?", yes)).resolves.toBe(true);

    const no = makeIO();
    answer(no, "n");
    await expect(askYesNo("Run it?", no)).resolves.toBe(false);
  });

  it("takes the default on empty input and re-asks on junk", async () => {
    const empty = makeIO();
    answer(empty, "");
    await expect(
      askYesNo("Run it?", { ...empty, defaultValue: false }),
    ).resolves.toBe(false);

    const junk = makeIO();
    setImmediate(() => junk.input.write("wat\ny\n"));
    await expect(askYesNo("Run it?", junk)).resolves.toBe(true);
    expect(junk.written()).toContain("please answer y or n");
  });
});

describe("secret prompts", () => {
  it("brackets the answer with echo-off / echo-on bytes on a TTY", async () => {
    const io = makeIO({ tty: true });
    answer(io, "sk-secret-value");
    const request = createStdioSecretPort(io);
    await expect(
      request({ title: "API key", prompt: "Enter API key:" }),
    ).resolves.toBe("sk-secret-value");
    const out = io.written();
    expect(out).toContain("\u001b[8m");
    expect(out).toContain("\u001b[28m");
    expect(out.indexOf("\u001b[8m")).toBeLessThan(out.indexOf("\u001b[28m"));
  });

  it("reads one line with no echo handling when stdin is not a TTY", async () => {
    const io = makeIO({ tty: false });
    answer(io, "piped-key");
    await expect(askSecret("Enter API key:", io)).resolves.toBe("piped-key");
    expect(io.written()).not.toContain("\u001b[8m");
    expect(io.written()).not.toContain("\u001b[28m");
  });
});

describe("non-TTY confirmations refuse instead of hanging", () => {
  it("rejects with the documented message", async () => {
    const io = makeIO({ tty: false });
    const port = createStdioConfirmPort(io);
    const call: ToolCall = { name: "shell.exec", args: { command: "ls" } };
    await expect(port.confirmTool(call)).rejects.toThrow(
      CONFIRMATION_REQUIRED_MESSAGE,
    );
    await expect(port.confirmPentest()).rejects.toThrow(
      CONFIRMATION_REQUIRED_MESSAGE,
    );
    expect(io.written()).toBe("");
  });
});

describe("-y semantics", () => {
  let configDir: string;

  beforeEach(() => {
    vi.resetModules();
    configDir = mkdtempSync(join(tmpdir(), "clai-noninteractive-confirm-"));
    vi.stubEnv("CLAI_CONFIG_DIR", configDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(configDir, { recursive: true, force: true });
  });

  async function load() {
    const { updateConfig } = await import("../../src/store/config.js");
    updateConfig({ permissions: "default" });
    const confirmPort = await import("../../src/agent/confirm-port.js");
    const { createSessionPolicy } = await import(
      "../../src/agent/session-policy.js"
    );
    return { ...confirmPort, createSessionPolicy };
  }

  it("short-circuits ordinary tools without prompting", async () => {
    const { confirmToolExecution, createSessionPolicy } = await load();
    const io = makeIO({ tty: false });
    const port = createStdioConfirmPort(io);
    const call: ToolCall = { name: "shell.exec", args: { command: "ls" } };
    await expect(
      confirmToolExecution(call, true, createSessionPolicy(), port),
    ).resolves.toBe(true);
    expect(io.written()).toBe("");
  });

  it("still prompts for fs.delete", async () => {
    const { confirmToolExecution, createSessionPolicy } = await load();
    const io = makeIO({ tty: true });
    const port = createStdioConfirmPort(io);
    answer(io, "y");
    const call: ToolCall = { name: "fs.delete", args: { path: "/tmp/x" } };
    await expect(
      confirmToolExecution(call, true, createSessionPolicy(), port),
    ).resolves.toBe(true);
    expect(io.written()).toContain("DELETE this path?");
  });

  it("still prompts when forceConfirm is set", async () => {
    const { confirmToolExecution, createSessionPolicy } = await load();
    const io = makeIO({ tty: true });
    const port = createStdioConfirmPort(io);
    answer(io, "n");
    const call: ToolCall = { name: "fs.write", args: { path: "/tmp/x" } };
    await expect(
      confirmToolExecution(call, true, createSessionPolicy(), port, {
        forceConfirm: true,
      }),
    ).resolves.toBe(false);
    expect(io.written()).toContain("Run fs.write");
  });

  it("authorizes pentest for the session only, never persisting it", async () => {
    const { ensurePentestAuthorization, createSessionPolicy } = await load();
    const { getConfig } = await import("../../src/store/config.js");
    const session = createSessionPolicy();
    const io = makeIO({ tty: false });
    const port = createStdioConfirmPort(io);
    const call: ToolCall = {
      name: "shell.exec",
      args: { command: "nmap -sV 10.0.0.1" },
    };
    await expect(
      ensurePentestAuthorization(call, true, session, port),
    ).resolves.toBe(true);
    expect(session.pentestAuthorized.value).toBe(true);
    expect(getConfig().pentestAuthorized).toBeFalsy();
    expect(io.written()).toBe("");
  });
});
