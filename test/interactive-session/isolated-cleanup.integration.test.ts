import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { processAlive } from "../../src/os/process-tree.js";
import { tempArtifactDir } from "./helpers.js";

const dirs: string[] = [];
const moduleUrl = (name: string): string => pathToFileURL(join(process.cwd(), "src/interactive-session", name)).href;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each(["close", "cancelOwner", "closeAll"] as const)("awaits isolated PTY %s without other event-loop owners or lingering deadline timers", (operation) => {
  const root = tempArtifactDir();
  dirs.push(root);
  const source = `
    import { strict as assert } from 'node:assert';
    import { InteractiveSessionManager } from ${JSON.stringify(moduleUrl("manager.ts"))};
    import { RecoveryJournal } from ${JSON.stringify(moduleUrl("recovery-journal.ts"))};
    import { SessionTelemetry } from ${JSON.stringify(moduleUrl("telemetry.ts"))};
    const manager = new InteractiveSessionManager({
      artifactBaseDir: ${JSON.stringify(root)},
      journal: new RecoveryJournal(${JSON.stringify(join(root, "journal"))}),
      telemetry: new SessionTelemetry(async () => undefined),
      config: { gracefulCloseMs: 250, closeDeadlineMs: 5000 },
    });
    const capability = await manager.ptyCapability();
    if (!capability.available) {
      console.log(JSON.stringify({ unavailable: capability.reason }));
    } else {
      const started = await manager.start({ ownerId: 'isolated', command: ${JSON.stringify(`${JSON.stringify(process.execPath)} -e "console.log('READY');setInterval(()=>{},1000)"`)}, terminalMode: 'required', confirm: async () => true });
      assert.equal(started.transport, 'pty');
      let cursor = started.cursor;
      let output = started.page?.events.map(event => event.content).join('') ?? '';
      for (let attempt = 0; !output.includes('READY') && attempt < 10; attempt++) {
        const read = await manager.read({ ownerId: 'isolated', id: started.sessionId, cursor, waitMs: 300 });
        output += read.page?.events.map(event => event.content).join('') ?? '';
        cursor = read.page?.nextCursor ?? cursor;
      }
      assert.match(output, /READY/);
      const result = ${operation === "close" ? "await manager.close({ ownerId: 'isolated', id: started.sessionId })" : operation === "cancelOwner" ? "await manager.cancelOwner('isolated')" : "await manager.closeAll()"};
      const status = manager.status({ ownerId: 'isolated', id: started.sessionId });
      assert.equal(status.session.cleanupVerified, true);
      assert.equal(result.error, undefined);
      console.log(JSON.stringify({ transport: started.transport, pid: started.pid, cleanupVerified: status.session.cleanupVerified }));
    }
  `;
  const startedAt = Date.now();
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: process.cwd(), encoding: "utf8", timeout: 8000,
    env: { ...process.env, CLAI_DATA_DIR: join(root, "data"), CLAI_DISABLE_TELEMETRY: "1" },
  });
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const receipt = JSON.parse(child.stdout.trim()) as { unavailable?: string; transport?: string; pid?: number; cleanupVerified?: boolean };
  if (receipt.unavailable) {
    expect(receipt.unavailable.length).toBeGreaterThan(0);
    return;
  }
  expect(receipt.transport).toBe("pty");
  expect(receipt.cleanupVerified).toBe(true);
  if (receipt.pid) expect(processAlive(receipt.pid)).toBe(false);
  expect(Date.now() - startedAt).toBeLessThan(4000);
}, 10000);
