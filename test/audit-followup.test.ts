import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runToolCall, toolRegistry } from "../src/tools/registry.js";
import { classifyToolCall } from "../src/safety/classifier.js";
import { fsRead } from "../src/tools/fs.js";
import { updateConfig, getConfig } from "../src/store/config.js";
import {
  saveScope,
  clearScope,
  resetScopeCache,
} from "../src/store/scope.js";
import {
  containsShellMetacharacter,
  commandHasMutatingArg,
} from "../src/safety/patterns.js";

/* -------------------------------------------------------------------------
 * Audit follow-up #1 — tool.batch must not run mutating http.fetch calls.
 * ------------------------------------------------------------------------- */
describe("audit#1 — tool.batch refuses mutating child calls", () => {
  it("rejects http.fetch POST inside a batch", async () => {
    await expect(
      runToolCall({
        name: "tool.batch",
        args: {
          calls: [
            {
              name: "http.fetch",
              args: { url: "https://example.com", method: "POST" },
            },
          ],
        },
      }),
    ).rejects.toThrow(/refuses http\.fetch/i);
  });

  it("rejects http.fetch DELETE/PUT/PATCH inside a batch", async () => {
    for (const method of ["DELETE", "PUT", "PATCH"]) {
      await expect(
        runToolCall({
          name: "tool.batch",
          args: {
            calls: [
              {
                name: "http.fetch",
                args: { url: "https://example.com", method },
              },
            ],
          },
        }),
      ).rejects.toThrow(/refuses http\.fetch/i);
    }
  });

  it("permits http.fetch GET inside a batch", async () => {
    // We only check the classifier path; mock fetch for completeness.
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    try {
      const result = await runToolCall({
        name: "tool.batch",
        args: {
          calls: [
            {
              name: "http.fetch",
              args: { url: "https://example.com", method: "GET" },
            },
          ],
        },
      });
      expect(result.ok).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});

/* -------------------------------------------------------------------------
 * Audit follow-up #2 — public domain scans through shell.exec are scoped.
 * ------------------------------------------------------------------------- */
describe("audit#2 — shell.exec public domain scanners are scoped", () => {
  beforeEach(() => {
    resetScopeCache();
  });
  afterEach(async () => {
    await clearScope().catch(() => undefined);
    resetScopeCache();
  });

  it("blocks `nmap example.com` without scope", () => {
    const decision = classifyToolCall({
      name: "shell.exec",
      args: { command: "nmap example.com" },
    });
    expect(decision.level).toBe("block");
    expect(decision.reason).toMatch(/scope/i);
  });

  it("blocks `nuclei -u https://example.com` without scope", () => {
    const decision = classifyToolCall({
      name: "shell.exec",
      args: { command: "nuclei -u https://example.com -severity high" },
    });
    expect(decision.level).toBe("block");
  });

  it("blocks `ffuf -u https://example.com/FUZZ -w wordlists/common.txt` without scope", () => {
    const decision = classifyToolCall({
      name: "shell.exec",
      args: {
        command:
          "ffuf -u https://example.com/FUZZ -w /usr/share/wordlists/common.txt",
      },
    });
    expect(decision.level).toBe("block");
  });

  it("private RFC1918 ffuf with wordlists/*.txt still confirms (not blocked)", () => {
    const decision = classifyToolCall({
      name: "shell.exec",
      args: {
        command:
          "ffuf -u http://192.168.1.1/FUZZ -w /usr/share/wordlists/common.txt",
      },
    });
    expect(decision.level).toBe("confirm");
  });

  it("paths like wordlists/common.txt do not count as public hostnames", () => {
    const decision = classifyToolCall({
      name: "shell.exec",
      args: {
        command:
          "gobuster dir -u http://192.168.1.1 -w /usr/share/wordlists/common.txt",
      },
    });
    expect(decision.level).toBe("confirm");
  });

  it("permits `nmap example.com` once scope covers it", async () => {
    await saveScope({
      authorizedTargets: ["example.com"],
    });
    resetScopeCache();
    const decision = classifyToolCall(
      { name: "shell.exec", args: { command: "nmap example.com" } },
      { scope: { authorizedTargets: ["example.com"] } },
    );
    expect(decision.level).toBe("confirm");
  });
});

/* -------------------------------------------------------------------------
 * Audit follow-up #3 — fs.read/list/search are sandboxed.
 * ------------------------------------------------------------------------- */
describe("audit#3 — fs reads are sandboxed", () => {
  it("fs.read refuses paths outside sandbox roots when sandboxReads=true", async () => {
    const before = getConfig().sandboxReads;
    updateConfig({ sandboxReads: true });
    // Default config: sandboxRoots=[cwd]. Reads of /etc/hosts (outside cwd,
    // tmpdir, $HOME) must be refused. /etc/hosts is unlikely to be a secret
    // path so this exercises the sandbox-only check.
    try {
      await expect(fsRead("/etc/hosts")).rejects.toThrow(/sandbox/i);
    } finally {
      updateConfig({ sandboxReads: before });
    }
  });

  it("classifier still marks fs.read safe — sandbox enforcement happens in fs.ts", () => {
    const decision = classifyToolCall({
      name: "fs.read",
      args: { path: "/etc/hosts" },
    });
    // Classifier reports safe (we keep its job narrow), but the runtime
    // fs.ts layer refuses the read. Both layers complement each other.
    expect(decision.level).toBe("safe");
  });

  it("sandboxReads=false opt-out lets fs.read escape the sandbox", async () => {
    const before = getConfig().sandboxReads;
    updateConfig({ sandboxReads: false });
    try {
      // /etc/hosts is readable on macOS+Linux test runners. We only assert
      // that the call no longer throws our sandbox error; the actual file
      // contents aren't important.
      const result = await fsRead("/etc/hosts").catch((error) => error);
      expect(result instanceof Error && /sandbox/i.test(result.message)).toBe(
        false,
      );
    } finally {
      updateConfig({ sandboxReads: before });
    }
  });

  it("paths inside cwd remain readable", async () => {
    const result = await fsRead("./package.json", { maxBytes: 64 });
    expect(result.ok).toBe(true);
  });

  it("paths inside tmpdir remain readable (artifact directory)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-sandbox-"));
    const path = join(dir, "x.txt");
    writeFileSync(path, "hello");
    try {
      const result = await fsRead(path);
      expect(result.ok).toBe(true);
      expect(result.output).toContain("hello");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/* -------------------------------------------------------------------------
 * Audit follow-up #4 — shell safety patterns: sed -i, awk system(),
 * git config --global, npm config set, find -exec/-delete, docker run, ...
 * ------------------------------------------------------------------------- */
describe("audit#4 — mutating-arg patterns flip safe-base commands to confirm", () => {
  it("commandHasMutatingArg matches sed -i", () => {
    expect(commandHasMutatingArg("sed -i 's/foo/bar/' file.txt")).toBe(true);
    expect(commandHasMutatingArg("sed 's/foo/bar/' file.txt")).toBe(false);
  });

  it("commandHasMutatingArg matches awk system()/getline", () => {
    expect(
      commandHasMutatingArg("awk 'BEGIN { system(\"rm -rf /\") }'"),
    ).toBe(true);
    expect(
      commandHasMutatingArg("awk 'BEGIN { \"id\" | getline line }'"),
    ).toBe(true);
    expect(commandHasMutatingArg("awk '{print $1}' file")).toBe(false);
  });

  it("commandHasMutatingArg matches find -exec / -delete / -execdir / -ok", () => {
    expect(
      commandHasMutatingArg("find . -name '*.log' -exec rm {} +"),
    ).toBe(true);
    expect(commandHasMutatingArg("find /tmp -delete")).toBe(true);
    expect(commandHasMutatingArg("find . -name '*.log'")).toBe(false);
  });

  it("commandHasMutatingArg matches git config --global / npm config set", () => {
    expect(commandHasMutatingArg("git config --global user.name foo")).toBe(
      true,
    );
    expect(commandHasMutatingArg("git config --system foo bar")).toBe(true);
    expect(commandHasMutatingArg("git config user.name")).toBe(false); // read-only
    expect(commandHasMutatingArg("git config --get user.email")).toBe(false);
    expect(commandHasMutatingArg("npm config set registry https://x")).toBe(
      true,
    );
    expect(commandHasMutatingArg("npm config get registry")).toBe(false);
  });

  it("classifier confirms `git config --global ...`", () => {
    const decision = classifyToolCall({
      name: "shell.exec",
      args: { command: "git config --global user.name foo" },
    });
    expect(decision.level).toBe("confirm");
  });

  it("classifier confirms `npm config set ...`", () => {
    const decision = classifyToolCall({
      name: "shell.exec",
      args: { command: "npm config set registry https://example.com" },
    });
    expect(decision.level).toBe("confirm");
  });

  it("classifier confirms `awk 'BEGIN { system(...) }'`", () => {
    const decision = classifyToolCall({
      name: "shell.exec",
      args: { command: "awk 'BEGIN { system(\"id\") }'" },
    });
    expect(decision.level).toBe("confirm");
  });

  it("classifier confirms `sed -i ...`", () => {
    const decision = classifyToolCall({
      name: "shell.exec",
      args: { command: "sed -i 's/foo/bar/' README.md" },
    });
    expect(decision.level).toBe("confirm");
  });

  it("classifier confirms `find . -exec rm`", () => {
    const decision = classifyToolCall({
      name: "shell.exec",
      args: { command: "find . -name '*.log' -exec rm {} +" },
    });
    expect(decision.level).toBe("confirm");
  });

  it("classifier confirms `docker run ...`", () => {
    const decision = classifyToolCall({
      name: "shell.exec",
      args: { command: "docker run -it ubuntu bash" },
    });
    expect(decision.level).toBe("confirm");
  });

  it("classifier confirms `kubectl apply -f`", () => {
    const decision = classifyToolCall({
      name: "shell.exec",
      args: { command: "kubectl apply -f deploy.yaml" },
    });
    expect(decision.level).toBe("confirm");
  });
});

/* -------------------------------------------------------------------------
 * Audit follow-up #5 — shell artifacts redacted on disk after close.
 * ------------------------------------------------------------------------- */
describe("audit#5 — shellExec artifact is redacted after close", () => {
  it("artifact at outputPath does not contain raw API-key-shaped strings", async () => {
    const { readFile } = await import("node:fs/promises");
    const fakeKey = "sk-ant-1234567890ABCDEF1234567890";
    const result = await toolRegistry["shell.exec"]!({
      command: `echo ${fakeKey}`,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.output).not.toContain(fakeKey);
    if (result.outputPath) {
      const onDisk = await readFile(result.outputPath, "utf8");
      // Even though the live capture wrote the raw bytes, the post-close
      // redaction must scrub them before any external reader gets a chance.
      expect(onDisk).not.toContain(fakeKey);
    }
  });

  it("spawnArgv artifact is also redacted after close", async () => {
    const { readFile } = await import("node:fs/promises");
    const { spawnArgv } = await import("../src/tools/shell.js");
    const fakeKey = "AIzaSyBOgUS-PROBABLY-NOT-A-REAL-KEY";
    const result = await spawnArgv({
      command: "echo",
      argv: [fakeKey],
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.output).not.toContain(fakeKey);
    if (result.outputPath) {
      const onDisk = await readFile(result.outputPath, "utf8");
      expect(onDisk).not.toContain(fakeKey);
    }
  });
});

/* -------------------------------------------------------------------------
 * Audit follow-up #6 — readJson byte cap + readStreamLines idle timeout.
 * ------------------------------------------------------------------------- */
describe("audit#6 — http helpers cap responses and watchdog streams", () => {
  it("readStreamLines aborts when no bytes arrive within idleTimeoutMs", async () => {
    const { readStreamLines } = await import("../src/llm/http.js");
    // Construct a stream that never emits a byte. The reader should bail
    // after our short idle timeout with a stalled-stream provider error.
    const stream = new ReadableStream<Uint8Array>({
      start() {
        /* never push */
      },
    });
    const response = new Response(stream);
    let lines = 0;
    const start = Date.now();
    await expect(
      (async () => {
        for await (const _line of readStreamLines(response, {
          idleTimeoutMs: 50,
        })) {
          lines += 1;
        }
      })(),
    ).rejects.toThrow(/stalled/i);
    expect(lines).toBe(0);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("readStreamLines yields lines as they arrive", async () => {
    const { readStreamLines } = await import("../src/llm/http.js");
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("first\nsec"));
        controller.enqueue(encoder.encode("ond\nthird\n"));
        controller.close();
      },
    });
    const response = new Response(stream);
    const collected: string[] = [];
    for await (const line of readStreamLines(response)) {
      collected.push(line);
    }
    expect(collected).toEqual(["first", "second", "third"]);
  });

  it("readStreamLines aborts when total bytes exceed maxBytes", async () => {
    const { readStreamLines } = await import("../src/llm/http.js");
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("x".repeat(2_000) + "\n"));
        controller.close();
      },
    });
    const response = new Response(stream);
    await expect(
      (async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _line of readStreamLines(response, {
          maxBytes: 100,
        })) {
          // consume
        }
      })(),
    ).rejects.toThrow(/exceeded/i);
  });
});
