import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wordlistFind } from "../src/tools/wordlists.js";

let originalHome: string | undefined;
let homeDir: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  homeDir = mkdtempSync(join(tmpdir(), "clai-wordlist-home-"));
  process.env.HOME = homeDir;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(homeDir, { recursive: true, force: true });
});

describe("wordlist.find", () => {
  it("finds a wordlist in a known per-OS location without touching /usr/share blindly", async () => {
    const wordlistDir = join(homeDir, "SecLists", "Discovery", "Web-Content");
    mkdirSync(wordlistDir, { recursive: true });
    writeFileSync(join(wordlistDir, "common.txt"), "admin\nlogin\n");

    const result = await wordlistFind({ query: "common.txt" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("common.txt");
  });

  it("resolves a known alias like rockyou to its real filename", async () => {
    const wordlistDir = join(homeDir, "wordlists");
    mkdirSync(wordlistDir, { recursive: true });
    writeFileSync(join(wordlistDir, "rockyou.txt"), "password\n123456\n");

    const result = await wordlistFind({ query: "rockyou" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("rockyou.txt");
  });

  it("fails cleanly (no throw, no noisy stderr) when nothing is found and expand=false", async () => {
    const result = await wordlistFind({ query: "definitely-not-a-real-wordlist.txt", expand: false });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("No match");
  });

  it("requires a query", async () => {
    const result = await wordlistFind({ query: "" });
    expect(result.ok).toBe(false);
  });
});
