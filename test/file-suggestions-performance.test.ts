import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFileSuggestions } from "../src/ui/mentions/file-suggestions.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

let directory = "";
beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), "clai-file-suggestions-"));
  fs.mkdirSync(join(directory, "source"));
  fs.mkdirSync(join(directory, "node_modules"));
  fs.writeFileSync(join(directory, ".hidden"), "hidden");
  for (let index = 0; index < 100; index += 1) {
    fs.writeFileSync(join(directory, `file-${String(index).padStart(3, "0")}.ts`), "full content");
  }
  vi.mocked(fs.statSync).mockClear();
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("file completion directory metadata", () => {
  it("does not stat every ordinary entry while preserving ordering and limits", () => {
    const suggestions = findFileSuggestions("", directory);
    expect(suggestions).toHaveLength(12);
    expect(suggestions[0]).toEqual({ value: "source/", label: "source/", isDir: true });
    expect(suggestions[1]?.value).toBe("file-000.ts");
    expect(suggestions.some((item) => item.value.includes("node_modules") || item.value.includes("hidden"))).toBe(false);
    expect(fs.statSync).not.toHaveBeenCalled();
    expect(findFileSuggestions("file-", directory, 150)).toHaveLength(100);
    expect(fs.statSync).not.toHaveBeenCalled();
  });

  it("follows directory and file symlinks and omits broken links", () => {
    fs.symlinkSync(join(directory, "source"), join(directory, "alias-dir"), "dir");
    fs.symlinkSync(join(directory, "file-000.ts"), join(directory, "alias-file"), "file");
    fs.symlinkSync(join(directory, "missing"), join(directory, "alias-missing"), "file");
    expect(findFileSuggestions("alias-", directory)).toEqual([
      { value: "alias-dir/", label: "alias-dir/", isDir: true },
      { value: "alias-file", label: "alias-file", isDir: false },
    ]);
    expect(fs.statSync).toHaveBeenCalledTimes(3);
  });

  it("refreshes filesystem changes without a stale completion cache", () => {
    expect(findFileSuggestions("new", directory)).toEqual([]);
    fs.mkdirSync(join(directory, "new-folder"));
    fs.writeFileSync(join(directory, "new-file"), "new");
    expect(findFileSuggestions("new", directory).map((item) => item.value)).toEqual(["new-folder/", "new-file"]);
    fs.rmSync(join(directory, "new-file"));
    expect(findFileSuggestions("new", directory).map((item) => item.value)).toEqual(["new-folder/"]);
    expect(findFileSuggestions("missing/", directory)).toEqual([]);
    expect(findFileSuggestions(".h", directory).map((item) => item.value)).toEqual([".hidden"]);
  });
});
