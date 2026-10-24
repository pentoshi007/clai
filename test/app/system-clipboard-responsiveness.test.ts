import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSystemClipboardPort } from "../../src/app/adapters/in-memory-clipboard-adapter.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function clipboardCommand(name: string, script: string, directory?: string): Promise<string> {
  const dir = directory ?? await mkdtemp(join(tmpdir(), "clai-clipboard-async-"));
  if (!directory) directories.push(dir);
  const command = join(dir, name);
  await writeFile(command, `#!${process.execPath}\n${script}\n`);
  await chmod(command, 0o755);
  vi.stubEnv("PATH", dir);
  return dir;
}

describe.skipIf(process.platform !== "linux")("asynchronous system clipboard", () => {
  it("allows rendering/input while reading clipboard text and preserves trailing newlines", async () => {
    await clipboardCommand("wl-paste", "setTimeout(() => process.stdout.write('clipboard text\\n'), 150);");
    let responsive = false;
    const timer = setTimeout(() => { responsive = true; }, 20);
    try {
      expect(await createSystemClipboardPort().readText?.()).toBe("clipboard text\n");
      expect(responsive).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  it("allows rendering/input while writing clipboard text", async () => {
    const dir = await clipboardCommand("wl-copy", "let text=''; process.stdin.on('data', chunk => text += chunk); process.stdin.on('end', () => setTimeout(() => require('fs').writeFileSync(process.argv[1]+'.txt', text), 150));");
    let responsive = false;
    const timer = setTimeout(() => { responsive = true; }, 20);
    try {
      const clipboard = createSystemClipboardPort();
      await clipboard.writeText("exact clipboard bytes");
      expect(responsive).toBe(true);
      expect(await readFile(join(dir, "wl-copy.txt"), "utf8")).toBe("exact clipboard bytes");
      expect(clipboard.lastText).toBe("exact clipboard bytes");
    } finally {
      clearTimeout(timer);
    }
  });

  it("requests only text and never returns cached text over an image-only clipboard", async () => {
    const dir = await clipboardCommand("wl-copy", "process.stdin.resume();");
    await clipboardCommand("wl-paste", "if (process.argv.includes('text')) process.exit(1); process.stdout.write('binary image payload');", dir);
    const clipboard = createSystemClipboardPort();
    await clipboard.writeText("stale copied text");
    expect(await clipboard.readText?.()).toBe("");
  });
});
