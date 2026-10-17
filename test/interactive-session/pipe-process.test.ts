import { afterEach, describe, expect, it } from "vitest";
import { startPipeProcess } from "../../src/interactive-session/transport-pipe.js";
import { LaunchFailure, type SessionTransport } from "../../src/interactive-session/transport.js";
import { processAlive } from "../../src/os/process-tree.js";

const active: SessionTransport[] = [];

afterEach(async () => {
  for (const transport of active.splice(0)) {
    await transport.requestTreeTermination("forceful");
    await transport.dispose();
  }
});

async function collect(transport: SessionTransport): Promise<string> {
  let output = "";
  transport.onOutput((event) => { output += Buffer.from(event.bytes).toString("utf8"); });
  await new Promise<void>((resolve) => transport.onExit(() => resolve()));
  await transport.waitForOutputDrain?.();
  return output;
}

describe("direct pipe process launch", () => {
  it("preserves literal arguments and the child environment without a shell or PTY", async () => {
    const args = ["path with spaces", "quote\"and'", "$(echo not-a-command); & literal", "C:\\a b\\c"];
    const script = `console.log(JSON.stringify({args:process.argv.slice(1),stdin:!!process.stdin.isTTY,stdout:!!process.stdout.isTTY,env:process.env.CLAI_PIPE_TEST,cwd:process.cwd()}))`;
    const { transport } = await startPipeProcess({
      file: process.execPath,
      args: ["-e", script, "--", ...args],
      cwd: process.cwd(),
      env: { ...process.env, CLAI_PIPE_TEST: "exact value" },
    });
    active.push(transport);
    expect(transport.kind).toBe("pipe");
    expect(JSON.parse(await collect(transport))).toEqual({
      args, stdin: false, stdout: false, env: "exact value", cwd: process.cwd(),
    });
  });

  it("retains early output until a consumer subscribes", async () => {
    const { transport } = await startPipeProcess({
      file: process.execPath,
      args: ["-e", "process.stdout.write('early-output'); process.stderr.write('early-error')"],
      cwd: process.cwd(),
    });
    active.push(transport);
    await new Promise<void>((resolve) => transport.onExit(() => resolve()));
    const output = await collect(transport);
    expect(output).toContain("early-output");
    expect(output).toContain("early-error");
  });

  it("reports an executable that could not be spawned", async () => {
    await expect(startPipeProcess({
      file: "clai-executable-that-does-not-exist",
      args: [],
      cwd: process.cwd(),
    })).rejects.toMatchObject({ code: "ENOENT", spawnConfirmed: false });
  });

  it("terminates the process when persisting its launch identity fails", async () => {
    let pid = -1;
    await expect(startPipeProcess({
      file: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      onLaunchIdentity(identity) {
        pid = identity.pid;
        throw new Error("identity storage failed");
      },
    })).rejects.toBeInstanceOf(LaunchFailure);
    expect(pid).toBeGreaterThan(0);
    await expect.poll(() => processAlive(pid)).toBe(false);
  });
});
