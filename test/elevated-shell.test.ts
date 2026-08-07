import { afterEach, describe, expect, it } from "vitest";
import {
  formatSudoStdinPassword,
  prepareElevatedBackgroundCommand,
  preparePrivilegedBackgroundArgv,
  tryRunElevatedWithoutTty,
} from "../src/tools/elevated-shell.js";
import {
  getAllowInteractiveStdinInherit,
  setAllowInteractiveStdinInherit,
} from "../src/tools/shell.js";
import type { spawnArgv } from "../src/tools/shell.js";

describe("formatSudoStdinPassword", () => {
  it("strips trailing newlines but keeps spaces and ends with one newline", () => {
    expect(formatSudoStdinPassword("secret")).toBe("secret\n");
    expect(formatSudoStdinPassword("secret\n")).toBe("secret\n");
    expect(formatSudoStdinPassword("secret\r\n\r\n")).toBe("secret\n");
    expect(formatSudoStdinPassword(" pass word ")).toBe(" pass word \n");
  });
});

describe("preparePrivilegedBackgroundArgv", () => {
  it("authenticates first and returns a shell:false stdin-only sudo spec", async () => {
    const secret = "background-sudo-secret";
    const authInputs: string[] = [];
    const prepared = await preparePrivilegedBackgroundArgv(
      "nmap",
      ["-sS", "example.com"],
      { requestSecret: async () => secret },
      {
        isRoot: () => false,
        available: async () => true,
        runAuth: async (args) => {
          authInputs.push(args.stdinText ?? "");
          return { ok: true, output: "authenticated", exitCode: 0 };
        },
      },
    );

    expect(authInputs).toEqual([`${secret}\n`]);
    expect(prepared.prepared).toBe(true);
    if (prepared.prepared) {
      expect(prepared.spec).toMatchObject({
        command: "sudo",
        argv: ["-S", "-p", "", "nmap", "-sS", "example.com"],
        stdinText: `${secret}\n`,
      });
      expect(prepared.spec.display).not.toContain(secret);
    }
  });

  it("does not prepare or start after cancellation or failed authentication", async () => {
    const cancelled = await preparePrivilegedBackgroundArgv(
      "nmap",
      ["-sS", "example.com"],
      { requestSecret: async () => undefined },
      { isRoot: () => false, available: async () => true },
    );
    expect(cancelled).toMatchObject({
      prepared: false,
      result: { ok: false, exitCode: 130 },
    });

    const rejected = await preparePrivilegedBackgroundArgv(
      "nmap",
      ["-sS", "example.com"],
      { requestSecret: async () => "wrong" },
      {
        isRoot: () => false,
        available: async () => true,
        runAuth: async () => ({ ok: false, output: "Sorry, try again.", exitCode: 1 }),
      },
    );
    expect(rejected).toMatchObject({
      prepared: false,
      result: { ok: false, exitCode: 1 },
    });
    if (!rejected.prepared) expect(rejected.result.output).toMatch(/no background job was started/i);
  });
});

describe("prepareElevatedBackgroundCommand", () => {
  it("returns undefined for non-interactive commands", async () => {
    const result = await prepareElevatedBackgroundCommand("ls -la", {
      requestSecret: async () => "x",
    });
    expect(result).toBeUndefined();
  });

  it("wraps compound sudo commands as a whole via sh -c", async () => {
    const prepared = await prepareElevatedBackgroundCommand(
      "cd /tmp && echo hi | sudo tee /root/out",
      { requestSecret: async () => "pw" },
      {
        isRoot: () => false,
        available: async () => true,
        runAuth: async () => ({ ok: true, output: "", exitCode: 0 }),
      },
    );
    expect(prepared?.prepared).toBe(true);
    if (prepared?.prepared) {
      expect(prepared.spec.command).toBe("sudo");
      expect(prepared.spec.argv).toEqual([
        "-S",
        "-p",
        "",
        "sh",
        "-c",
        "cd /tmp && echo hi | sudo tee /root/out",
      ]);
      expect(prepared.spec.stdinText).toBe("pw\n");
    }
  });

  it("rejects tty-only tools with terminal session guidance", async () => {
    const prepared = await prepareElevatedBackgroundCommand(
      "ssh user@host uptime",
      { requestSecret: async () => "pw" },
    );
    expect(prepared?.prepared).toBe(false);
    if (prepared && !prepared.prepared) {
      expect(prepared.result.output).toMatch(/terminal\.start/);
    }
  });
});

describe("tryRunElevatedWithoutTty", () => {
  const prev = getAllowInteractiveStdinInherit();
  afterEach(() => {
    setAllowInteractiveStdinInherit(prev);
  });

  it("returns undefined when no secret port", async () => {
    const r = await tryRunElevatedWithoutTty("sudo whoami", {});
    expect(r).toBeUndefined();
  });

  it("returns undefined for non-interactive commands", async () => {
    const r = await tryRunElevatedWithoutTty("ls -la", {
      requestSecret: async () => "x",
    });
    expect(r).toBeUndefined();
  });

  it("returns undefined when already root — no modal, no wrap", async () => {
    let prompted = false;
    const r = await tryRunElevatedWithoutTty(
      "sudo whoami",
      {
        requestSecret: async () => {
          prompted = true;
          return "x";
        },
      },
      { isRoot: () => true },
    );
    expect(r).toBeUndefined();
    expect(prompted).toBe(false);
  });

  it("returns cancelled when secret modal is dismissed", async () => {
    const r = await tryRunElevatedWithoutTty(
      "sudo whoami",
      { requestSecret: async () => undefined },
      { isRoot: () => false, available: async () => true },
    );
    expect(r?.ok).toBe(false);
    expect(r?.exitCode).toBe(130);
    expect(r?.output).toMatch(/cancelled/i);
  });

  it("fails clearly when sudo is unavailable", async () => {
    const r = await tryRunElevatedWithoutTty(
      "sudo whoami",
      { requestSecret: async () => "x" },
      { isRoot: () => false, available: async () => false },
    );
    expect(r?.ok).toBe(false);
    expect(r?.output).toMatch(/sudo is unavailable/i);
  });

  it("elevates compound sudo pipelines via a whole-command sh -c wrap", async () => {
    const runs: Parameters<typeof spawnArgv>[0][] = [];
    const r = await tryRunElevatedWithoutTty(
      "cd /tmp && sudo nmap -sS example.com | tee out.txt",
      { requestSecret: async () => "pw" },
      {
        isRoot: () => false,
        available: async () => true,
        run: async (args) => {
          runs.push(args);
          return { ok: true, output: "done", exitCode: 0 };
        },
      },
    );
    expect(r?.ok).toBe(true);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      command: "sudo",
      argv: ["-S", "-p", "", "-v"],
      stdinText: "pw\n",
    });
    expect(runs[1]).toMatchObject({
      command: "sudo",
      argv: [
        "-S",
        "-p",
        "",
        "sh",
        "-c",
        "cd /tmp && sudo nmap -sS example.com | tee out.txt",
      ],
      stdinText: "pw\n",
    });
  });

  it("elevates sudo with uppercase flags without mangling them", async () => {
    const runs: Parameters<typeof spawnArgv>[0][] = [];
    const r = await tryRunElevatedWithoutTty(
      "sudo -E -u root env",
      { requestSecret: async () => "pw" },
      {
        isRoot: () => false,
        available: async () => true,
        run: async (args) => {
          runs.push(args);
          return { ok: true, output: "", exitCode: 0 };
        },
      },
    );
    expect(r?.ok).toBe(true);
    expect(runs[1]?.argv).toEqual([
      "-S",
      "-p",
      "",
      "sh",
      "-c",
      "sudo -E -u root env",
    ]);
  });

  it("surfaces authentication failure without running the command", async () => {
    const runs: Parameters<typeof spawnArgv>[0][] = [];
    const r = await tryRunElevatedWithoutTty(
      "sudo whoami",
      { requestSecret: async () => "wrong" },
      {
        isRoot: () => false,
        available: async () => true,
        run: async (args) => {
          runs.push(args);
          return { ok: false, output: "Sorry, try again.", exitCode: 1 };
        },
      },
    );
    expect(r?.ok).toBe(false);
    expect(r?.output).toMatch(/authentication failed/i);
    expect(runs).toHaveLength(1);
  });

  it("routes tty-only tools to interactive sessions instead of sudo", async () => {
    const r = await tryRunElevatedWithoutTty("ssh user@host uptime", {
      requestSecret: async () => "x",
    });
    expect(r?.ok).toBe(false);
    expect(r?.output).toMatch(/terminal\.start/);
    expect(r?.output).not.toMatch(/simple `sudo/);
  });
});

describe("interactive stdin inherit policy", () => {
  const prev = getAllowInteractiveStdinInherit();
  afterEach(() => {
    setAllowInteractiveStdinInherit(prev);
  });

  it("defaults true and can be disabled for TUI", () => {
    setAllowInteractiveStdinInherit(true);
    expect(getAllowInteractiveStdinInherit()).toBe(true);
    setAllowInteractiveStdinInherit(false);
    expect(getAllowInteractiveStdinInherit()).toBe(false);
  });
});
