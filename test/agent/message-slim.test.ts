import { describe, expect, it } from "vitest";
import {
  elidedStubReuseMessage,
  findElidedStubArg,
  measureToolCallsChars,
  slimToolArgs,
  slimValue,
  SLIM_ARG_ABSOLUTE_MAX_CHARS,
  SLIM_ARG_STRING_CHARS,
} from "../../src/agent/message-slim.js";
import { estimateMessagesTokens } from "../../src/agent/context-manager.js";
import { LoopGuard } from "../../src/agent/loop-guard.js";
import { appendAssistantWithTools } from "../../src/agent/tool-history.js";
import type { ChatMessage } from "../../src/types.js";

describe("message-slim", () => {
  it("fingerprints large strings but keeps small ones", () => {
    const small = "hello";
    const large = "x".repeat(SLIM_ARG_ABSOLUTE_MAX_CHARS + 50);
    expect(slimValue(small)).toBe(small);
    const slimmed = String(slimValue(large));
    expect(slimmed).toMatch(/«\d+ chars sha256=/);
    expect(slimmed).toMatch(/never reuse this stub/);
    expect(slimmed.length).toBeLessThan(140);
    expect(slimmed).not.toContain("x".repeat(20));
  });

  it("stubs bulk body keys aggressively but preserves command args", () => {
    const bulk = slimToolArgs({
      path: "a.ts",
      content: "c".repeat(SLIM_ARG_STRING_CHARS + 50),
    });
    expect(String(bulk.content)).toMatch(/«450 chars sha256=/);

    const command = "nmap " + "-sS ".repeat(200) + "example.com";
    const slimmed = slimToolArgs({ command });
    expect(slimmed.command).toBe(command);

    const hugeCommand = "x".repeat(SLIM_ARG_ABSOLUTE_MAX_CHARS + 10);
    expect(String(slimToolArgs({ command: hugeCommand }).command)).toMatch(
      /«\d+ chars sha256=/,
    );
  });

  it("findElidedStubArg detects old and new stub formats recursively", () => {
    const legacy = "«522 chars sha256=acb3f2e19221»";
    const modern =
      "«522 chars sha256=acb3f2e19221 — elided from history; never reuse this stub, regenerate the full value»";
    expect(findElidedStubArg({ command: legacy })?.key).toBe("args.command");
    expect(
      findElidedStubArg({ files: [{ path: "a", content: modern }] })?.key,
    ).toBe("args.files[0].content");
    expect(findElidedStubArg({ command: "nmap -sS example.com" })).toBeUndefined();
    expect(findElidedStubArg(undefined)).toBeUndefined();
    expect(findElidedStubArg({ command: "prefix «522 chars sha256=acb3f2e19221» suffix" })).toBeUndefined();
  });

  it("elidedStubReuseMessage names the offending argument", () => {
    expect(elidedStubReuseMessage("args.command")).toContain("args.command");
    expect(elidedStubReuseMessage("args.command")).toMatch(/complete literal value/);
  });

  it("slims writeMany file contents while keeping paths", () => {
    const args = {
      files: [
        { path: "src/App.tsx", content: "a".repeat(5_000) },
        { path: "src/main.tsx", content: "b".repeat(5_000) },
      ],
    };
    const slimmed = slimToolArgs(args);
    const files = slimmed.files as { path: string; content: string }[];
    expect(files[0]!.path).toBe("src/App.tsx");
    expect(files[0]!.content).toMatch(/«5000 chars/);
    expect(JSON.stringify(slimmed).length).toBeLessThan(500);
  });

  it("counts toolCalls in estimateMessagesTokens", () => {
    const body = "c".repeat(30_000);
    const msgs: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c1",
            name: "fs.write",
            args: { path: "x.ts", content: body },
          },
        ],
      },
    ];
    // Content-only estimate would be ~0; with toolCalls it must see the body.
    expect(estimateMessagesTokens(msgs)).toBeGreaterThan(5_000);
  });

  it("appendAssistantWithTools does not retain full write bodies", () => {
    const messages: ChatMessage[] = [];
    const huge = "z".repeat(20_000);
    appendAssistantWithTools(messages, "", [
      {
        id: "w1",
        name: "fs.write",
        args: { path: "Big.tsx", content: huge },
      },
    ]);
    const stored = messages[0]!.toolCalls?.[0]?.args?.content;
    expect(typeof stored).toBe("string");
    expect(String(stored)).not.toContain("z".repeat(100));
    expect(String(stored)).toMatch(/«20000 chars/);
  });

  it("LoopGuard signatures stay small for large write args", () => {
    const guard = new LoopGuard();
    const content = "q".repeat(100_000);
    const sig = guard.canonicalize("fs.write", {
      path: "a.ts",
      content,
    });
    expect(sig.length).toBeLessThan(200);
    expect(sig).not.toContain("q".repeat(50));
    // Identical content fingerprints the same.
    expect(
      guard.canonicalize("fs.write", { path: "a.ts", content }),
    ).toBe(sig);
    // Different content → different signature.
    expect(
      guard.canonicalize("fs.write", {
        path: "a.ts",
        content: "r".repeat(100_000),
      }),
    ).not.toBe(sig);
  });

  it("measureToolCallsChars reflects arg bulk", () => {
    const n = measureToolCallsChars([
      { id: "1", name: "fs.write", args: { content: "x".repeat(1000) } },
    ]);
    expect(n).toBeGreaterThan(1000);
  });
});
