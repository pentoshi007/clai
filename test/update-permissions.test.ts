import { accessSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writableDirectory } from "../src/commands/update/native.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, accessSync: vi.fn(actual.accessSync), mkdtempSync: vi.fn(actual.mkdtempSync) };
});
afterEach(() => vi.restoreAllMocks());

describe("Windows installation directory permission checks", () => {
  it("rejects an ACL-restricted directory even if fs.access reports access", () => {
    vi.mocked(accessSync).mockImplementation(() => {});
    vi.mocked(mkdtempSync).mockImplementationOnce(() => { throw Object.assign(new Error("ACL denied"), { code: "EACCES" }); });
    expect(writableDirectory("C:\\Program Files\\clai", "win32")).toBe(false);
    expect(accessSync).not.toHaveBeenCalled();
  });
  it("probes a writable directory and leaves no probe behind", () => {
    const root = mkdtempSync(join(tmpdir(), "clai-permission-test-"));
    try {
      expect(writableDirectory(root, "win32")).toBe(true);
      expect(readdirSync(root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
