import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (load) => ({ ...await load<typeof import("node:child_process")>(), spawn: mocks.spawn }));
import { createKey, readKey } from "../src/store/credentials/crypto.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => { Object.defineProperty(process, "platform", platform); mocks.spawn.mockReset(); });

function dpapi() {
  mocks.spawn.mockImplementation((_command: string, args: readonly string[]) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    let input = "";
    child.stdin.on("data", (data: Buffer) => { input += data.toString(); });
    child.stdin.on("finish", () => {
      const clear = args.join(" ").includes("::Unprotect(");
      const result = clear ? Buffer.from(input, "base64").toString().slice(7) : Buffer.from(`sealed:${input}`).toString("base64");
      child.stdout.end(result);
      child.emit("close", 0);
    });
    return child;
  });
}

describe("Windows credential key protection contract", () => {
  it("uses CurrentUser DPAPI with key bytes only on stdin and round-trips the key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clai-dpapi-"));
    try {
      dpapi();
      Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
      const path = join(dir, "master.key");
      const key = await createKey(path);
      const disk = await readFile(path, "utf8");
      expect(disk).toMatch(/^dpapi:/);
      expect(disk).not.toContain(key.toString("base64"));
      expect(await readKey(path)).toEqual(key);
      expect(mocks.spawn).toHaveBeenCalledTimes(2);
      for (const call of mocks.spawn.mock.calls) {
        expect(JSON.stringify(call[1])).toContain("DataProtectionScope]::CurrentUser");
        expect(JSON.stringify(call[1])).not.toContain(key.toString("base64"));
      }
    } finally {
      Object.defineProperty(process, "platform", platform);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
