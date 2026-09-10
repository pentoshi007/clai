import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  InteractiveSessionManager,
  type ConfirmPreview,
} from "../../src/interactive-session/manager.js";
import { RecoveryJournal } from "../../src/interactive-session/recovery-journal.js";
import { SessionTelemetry } from "../../src/interactive-session/telemetry.js";
import { createSessionTransportFactory } from "../../src/interactive-session/transport-factory.js";
import { ProcessIdentityTracker } from "../../src/os/process-identity.js";
import { processAlive } from "../../src/os/process-tree.js";
import { tempArtifactDir } from "./helpers.js";

const OWNER = "conv-platform-integration";
const approve: ConfirmPreview = async () => true;
const FIXTURE = join(process.cwd(), "test/fixtures/interactive-child.mjs");
const CHILD = `${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)}`;
const SUPPORTED_PLATFORMS: NodeJS.Platform[] = ["darwin", "linux", "win32"];

let dirs: string[] = [];
let managers: InteractiveSessionManager[] = [];
let children: ChildProcess[] = [];

function build(): InteractiveSessionManager {
  const dir = tempArtifactDir();
  dirs.push(dir);
  const manager = new InteractiveSessionManager({
    transports: createSessionTransportFactory(),
    artifactBaseDir: dir,
    journal: new RecoveryJournal(join(dir, "journal")),
    telemetry: new SessionTelemetry(async () => undefined),
    config: { gracefulCloseMs: 250, closeDeadlineMs: 5_000 },
  });
  managers.push(manager);
  return manager;
}

function textOf(page: { events: readonly { content: string }[] } | undefined): string {
  return (page?.events ?? []).map((event) => event.content).join("");
}

async function send(manager: InteractiveSessionManager, id: string, text: string, cursor = 0) {
  return await manager.send({
    ownerId: OWNER,
    id,
    input: { kind: "text", text, submit: "enter" },
    cursor,
    quietMs: 150,
    deadlineMs: 10_000,
    confirm: approve,
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(predicate(), "condition did not become true before the platform-test deadline").toBe(true);
}

function pythonCapability(): { command?: string; reason?: string } {
  for (const command of ["python3", "python"]) {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true,
    });
    if (!result.error && result.status === 0) return { command };
  }
  return {
    reason: `Neither python3 nor python is executable on ${process.platform}; real Python REPL round trip unavailable`,
  };
}

const python = pythonCapability();
const platformSupported = SUPPORTED_PLATFORMS.includes(process.platform);
const platformReason = `Task 10.4 targets macOS, Linux, and Windows; current platform is ${process.platform}`;

afterEach(async () => {
  for (const manager of managers) await manager.closeAll("app-shutdown").catch(() => undefined);
  for (const child of children) {
    if (child.pid && processAlive(child.pid)) child.kill("SIGKILL");
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  managers = [];
  children = [];
  dirs = [];
});

describe.skipIf(!platformSupported)(`supported-platform integration (${platformSupported ? process.platform : platformReason})`, () => {
  it("captures and compares a real process identity", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    const tracker = new ProcessIdentityTracker();
    const identity = tracker.capture(child.pid, { refresh: true });
    expect(identity, `process identity evidence must be readable on ${process.platform}`).toMatch(/^[a-f0-9]{64}$/);
    expect(tracker.compare(child.pid, identity)).toBe("match");

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    expect(tracker.compare(child.pid, identity)).toBe("gone");
  });

  it("runs PTY load/spawn/resize/I/O/cleanup or proves preferred pipe fallback", async () => {
    const manager = build();
    const capability = await manager.ptyCapability();
    if (!capability.available) {
      expect(capability.reason?.trim().length).toBeGreaterThan(0);
    }

    const started = await manager.start({
      ownerId: OWNER,
      command: CHILD,
      terminalMode: "preferred",
      confirm: approve,
    });
    if (started.transport === "pty") {
      expect(capability.available).toBe(true);
      expect(started.degradedReason).toBeUndefined();
    } else {
      expect(started.degradedReason).toBe("PTY_UNAVAILABLE");
    }

    if (started.transport === "pty") {
      const resized = await manager.resize({
        ownerId: OWNER,
        id: started.sessionId,
        columns: 101,
        rows: 37,
      });
      expect(resized.dimensions).toEqual({ columns: 101, rows: 37 });
    }

    const echoed = await send(manager, started.sessionId, "echo platform-io");
    expect(echoed.delivery).toBe("delivered");
    expect(textOf(echoed.page)).toContain("platform-io");
    const closed = await manager.close({ ownerId: OWNER, id: started.sessionId });
    expect(closed.cleanupVerified).toBe(true);
    expect(closed.error).toBeUndefined();
  });

  it.skipIf(!python.command)(
    `runs a real Python REPL round trip${python.reason ? `; skip reason: ${python.reason}` : ""}`,
    async () => {
      const manager = build();
      const started = await manager.start({
        ownerId: OWNER,
        command: `${JSON.stringify(python.command)} -u -i`,
        terminalMode: "preferred",
        confirm: approve,
      });
      const marker = "CLAI_PYTHON_REPL_ROUND_TRIP";
      const result = await send(
        manager,
        started.sessionId,
        'print("CLAI_" + "PYTHON_REPL_ROUND_TRIP")',
      );
      expect(result.delivery).toBe("delivered");
      let output = textOf(result.page);
      let cursor = result.page!.nextCursor;
      for (let attempt = 0; attempt < 10 && !output.includes(marker); attempt += 1) {
        const read = await manager.read({
          ownerId: OWNER,
          id: started.sessionId,
          cursor,
          waitMs: 300,
        });
        output += textOf(read.page);
        cursor = read.page!.nextCursor;
      }
      expect(output).toContain(marker);
      const closed = await manager.close({ ownerId: OWNER, id: started.sessionId });
      expect(closed.cleanupVerified).toBe(true);
    },
  );

  it("verifies root, child, and grandchild disappearance with heartbeat evidence", async () => {
    const manager = build();
    const evidenceDir = tempArtifactDir();
    dirs.push(evidenceDir);
    const started = await manager.start({
      ownerId: OWNER,
      command: CHILD,
      terminalMode: "pipe",
      confirm: approve,
    });
    const result = await send(manager, started.sessionId, `tree ${evidenceDir}`);
    let output = textOf(result.page);
    let cursor = result.page!.nextCursor;
    const identities = /tree root=(\d+) child=(\d+) grandchild=(\d+)/;
    for (let attempt = 0; attempt < 10 && !identities.test(output); attempt += 1) {
      const read = await manager.read({ ownerId: OWNER, id: started.sessionId, cursor, waitMs: 300 });
      output += textOf(read.page);
      cursor = read.page!.nextCursor;
    }
    const match = identities.exec(output);
    expect(match, "fixture must report all three process identities").not.toBeNull();
    const pids = match!.slice(1).map(Number);
    const heartbeatPaths = ["root.heartbeat", "child.heartbeat", "grandchild.heartbeat"].map((name) =>
      join(evidenceDir, name),
    );

    await waitUntil(() => heartbeatPaths.every((path) => {
      try {
        return Number(readFileSync(path, "utf8")) > 0;
      } catch {
        return false;
      }
    }));
    expect(pids.every((pid) => processAlive(pid))).toBe(true);

    const closed = await manager.close({ ownerId: OWNER, id: started.sessionId });
    expect(closed.cleanupVerified).toBe(true);
    await waitUntil(() => pids.every((pid) => !processAlive(pid)));
    const stoppedAt = heartbeatPaths.map((path) => statSync(path).mtimeMs);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(heartbeatPaths.map((path) => statSync(path).mtimeMs)).toEqual(stoppedAt);
  });
});
