import { describe, expect, it } from "vitest";
import { looksLikeSlashCommand } from "../src/repl.js";

describe("looksLikeSlashCommand — dragged paths vs real commands", () => {
  it("treats real slash commands as commands", () => {
    for (const line of [
      "/help",
      "/model",
      "/model gpt-oss-20b",
      "/implement",
      "/clear",
      "/scope add example.com",
      "/provider nvidia",
      "/plan",
    ]) {
      expect(looksLikeSlashCommand(line)).toBe(true);
    }
  });

  it("does NOT treat absolute file paths as commands", () => {
    for (const line of [
      "/Users/aniketpandey/Desktop/Screenshot.png",
      "/Users/aniketpandey/Desktop/Screenshot\\ 2026.png whatis this",
      "/tmp/a b.txt",
      "/etc/hosts",
      "/opt/wordlist/rockyou.txt",
      "/usr/share/wordlists",
    ]) {
      expect(looksLikeSlashCommand(line)).toBe(false);
    }
  });

  it("handles a bare slash and empty input safely", () => {
    expect(looksLikeSlashCommand("/")).toBe(false);
    expect(looksLikeSlashCommand("")).toBe(false);
    expect(looksLikeSlashCommand("hello")).toBe(false);
  });

  it("still flags a single-word mistyped command for the help path", () => {
    // "/helpp" is not a known command but has no path shape, so it should
    // still route to handleSlash (which prints "unknown command … try /help").
    expect(looksLikeSlashCommand("/helpp")).toBe(true);
  });
});
