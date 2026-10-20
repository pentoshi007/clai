import { describe, expect, it } from "vitest";
import {
  buildCompactionUserPrompt,
  chunkTranscriptForCompaction,
  compactionSinglePassInputBudget,
  COMPACTION_MAX_COMPLETION_TOKENS,
  COMPACTION_SYSTEM_PROMPT,
  looksLikeTranscriptReplay,
  MAX_COMPACTION_CHUNKS,
  normalizeCompactionSummary,
  trimTranscriptForCompaction,
} from "../src/agent/compaction-summary.js";
import {
  compactMessages,
  compactMessagesWithSummary,
  isCompactionMemoryMessage,
} from "../src/agent/context-manager.js";
import {
  RESPONDER_RESULT_LEDGER_PREFIX,
  upsertResponderResultLedger,
} from "../src/agent/responder-context.js";
import { buildTurnHistory } from "../src/agent/tool-call-parser.js";
import type { ResponderNotification } from "../src/tools/jobs.js";
import type { ChatMessage } from "../src/types.js";


function consumedResponderResult(): ResponderNotification {
  return {
    id: "completion:job-ledger",
    ownerSessionId: "ledger-session",
    jobId: "job-ledger",
    taskId: "t4",
    parentTaskId: "t2",
    status: "exited",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    exitCode: 0,
    stdoutArtifact: {
      path: "/tmp/job-ledger.stdout.log",
      chunks: [],
      bytes: 42,
      droppedBytes: 0,
      redacted: false,
      sha256: "abc",
    },
    stderrArtifact: {
      path: "/tmp/job-ledger.stderr.log",
      chunks: [],
      bytes: 0,
      droppedBytes: 0,
      redacted: false,
      sha256: "def",
    },
    commandDisplay: "scan target",
    wakeOnCompletion: true,
    responder: true,
    responderLeaseId: "lease-1",
    deliveredAt: "2026-01-01T00:00:02.000Z",
    analyzedAt: "2026-01-01T00:00:03.000Z",
  };
}
describe("compaction-summary prompts", () => {
  it("system prompt forbids continuing or inventing instead of summarizing", () => {
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/summarizing the session, not continuing it/);
    expect(COMPACTION_SYSTEM_PROMPT).toMatch(/invent findings, file contents, receipts, exit codes or completions/);
  });

  it("user prompt lists the memory sections in the required order with durable state", () => {
    const p = buildCompactionUserPrompt({
      source: { kind: "transcript", text: "USER: build app\nASSISTANT: ok" },
      durableState: "ACTIVE PLAN: t1 done",
    });
    const headings = p.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual([
      "## Active goal",
      "## User instructions",
      "## Context gathered",
      "## Work done",
      "## Current state and next steps",
      "## Past completed work",
      "## Relevant files",
      "## Issues and risks",
    ]);
    expect(p).toContain("DURABLE STATE");
    expect(p).toContain("ACTIVE PLAN: t1 done");
    expect(p).toContain("SOURCE (session transcript, oldest first):\n\nUSER: build app");
    expect(p).toMatch(/Requests to do something .* are tasks, not instructions/);
    expect(p).toMatch(/\[T1\] \(task: short task name\)/);
    expect(p).toMatch(/Omit the whole section when there are none/);
    expect(p).toMatch(/Do not write a "Last 3 user prompts \(latest first\)" section/);
    expect(p).not.toMatch(/\b(?:subagent\.(?:read|list)|instructions\.record)\b/);
  });

  it("plan-implement handoff makes executing the accepted plan the goal", () => {
    const p = buildCompactionUserPrompt({
      purpose: "plan-implement",
      source: { kind: "transcript", text: "USER: recon target\nTOOL: nmap open 443" },
      durableState: "ACTIVE PLAN: pentest",
    });
    expect(p).toContain("PURPOSE: the user accepted the plan built in plan mode");
    expect(p).toMatch(/Plan-mode restrictions such as gather-only or wait-for-approval are historical now/);
    expect(p).toMatch(/confirmed findings, negative results and untested areas/);
    expect(p).toContain("## Active goal");
  });

  it("keeps approval gates and responder ledger state authoritative", () => {
    const p = buildCompactionUserPrompt({ source: { kind: "conversation" } });
    expect(p).toMatch(/Compaction never grants approval/);
    expect(p).toMatch(/never describe a consumed=true result as unread/);
  });

  it("trims huge transcripts while keeping head and tail", () => {
    const big = "HEAD-" + "x".repeat(100_000) + "-TAIL";
    const out = trimTranscriptForCompaction(big, 1000);
    expect(out.length).toBeLessThan(1200);
    expect(out.startsWith("HEAD-")).toBe(true);
    expect(out.endsWith("-TAIL")).toBe(true);
    expect(out).toMatch(/omitted for length/i);
  });
});

describe("looksLikeTranscriptReplay", () => {
  it("flags fabricated fs.write receipts and tool transcript lines", () => {
    expect(
      looksLikeTranscriptReplay(
        "Created app/page.tsx\n  bytes=1909 lines=63 sha256_12=71aebb363f49\n  Do NOT re-read this file",
      ),
    ).toBe(true);
    expect(
      looksLikeTranscriptReplay("TOOL: Tool fs.read result (exit=0, ok=true):\n{...}"),
    ).toBe(true);
    expect(
      looksLikeTranscriptReplay(
        "Now I need to update package.json. Let me continue:\nTask t3: Update scripts\n[tools: fs.read]",
      ),
    ).toBe(true);
    expect(
      looksLikeTranscriptReplay(
        "<tool_call>fs.read<arg_key>path<arg_value>/app/package.json</arg_value>",
      ),
    ).toBe(true);
    expect(
      looksLikeTranscriptReplay(
        "<|tool_calls_section_begin|><|tool_call_begin|>functions.fs.read:0<|tool_call_argument_begin|>{}<|tool_call_end|>",
      ),
    ).toBe(true);
    expect(
      looksLikeTranscriptReplay(
        '<｜DSML｜invoke name="fs.read"><｜DSML｜parameter name="path">x</｜DSML｜parameter>',
      ),
    ).toBe(true);
    expect(
      looksLikeTranscriptReplay(
        '<|open|>call tool="fs.read"<|sep|><|close|>call>',
      ),
    ).toBe(true);
  });

  it("deduplicates repeated bullets while retaining their first occurrence", () => {
    const normalized = normalizeCompactionSummary(
      "## Work completed\n- Updated runner.ts\n- Updated runner.ts\n## Remaining work\n1. Run tests.\n1. Run tests.",
    );
    expect(normalized.match(/Updated runner\.ts/g)).toHaveLength(1);
    expect(normalized.match(/Run tests\./g)).toHaveLength(1);
  });

  it("retains matching facts under different section and parent scopes", () => {
    const source = [
      "## Parser review", "- Tests not run.",
      "## Transfer review", "- Tests not run.",
      "- Source A", "  - Verification pending.",
      "- Source B", "  - Verification pending.",
    ].join("\n");
    expect(normalizeCompactionSummary(source)).toBe(source);
  });

  it("preserves case-sensitive paths", () => {
    const source = "## Relevant files\n- /project/src/Foo.ts\n- /project/src/foo.ts";
    expect(normalizeCompactionSummary(source)).toBe(source);
  });

  it("preserves distinct literal whitespace within bullets", () => {
    const source = "## Key facts\n- Required output: `a  b`\n- Required output: `a b`";
    expect(normalizeCompactionSummary(source)).toBe(source);
  });

  it("does not flag a faithful structured summary", () => {
    const good = [
      "## User goals",
      "Convert the Vite todo app to Next.js preserving all features.",
      "## Work completed",
      "Installed Next.js 16, removed Vite, created app/layout.tsx and app/page.tsx.",
      "## Remaining work",
      "Update package.json scripts, then run the dev server.",
    ].join("\n");
    expect(looksLikeTranscriptReplay(good)).toBe(false);
  });
});

describe("LLM compaction integration shape", () => {
  it("feeds structured prompt and stores model memory", async () => {
    const msgs: ChatMessage[] = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content:
        `message-${index}-` +
        "content-to-exceed-limits-".repeat(20),
    }));
    msgs[0] = {
      role: "system",
      content: "ACTIVE PLAN for this session (goal: todo)\nTasks:\n  1. [t1] (done) scaffold",
    };

    let seen = "";
    const result = await compactMessagesWithSummary(
      msgs,
      async (prompt) => {
        seen = prompt;
        expect(prompt).toContain("## Active goal");
        expect(prompt).toContain("DURABLE STATE");
        expect(prompt).toContain("ACTIVE PLAN");
        return "## User goals\nBuild todo app\n## Remaining work\nImplement feature";
      },
      { keepRecent: 4 },
    );
    expect(result.summarized).toBe(true);
    expect(seen.length).toBeGreaterThan(50);
    expect(result.messages.some((m) => m.content.includes("Build todo app"))).toBe(
      true,
    );
  });

  it("compacts a roughly 600k-token prefix once within a 1m window", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "stable system prefix" },
      { role: "user", content: `large history ${"x".repeat(1_960_000)}` },
      { role: "assistant", content: "prior work completed" },
      { role: "user", content: "recent request" },
      { role: "assistant", content: "recent response" },
    ];
    const stages: Array<{
      prompt: string;
      sourceMessages: readonly ChatMessage[] | undefined;
    }> = [];
    const result = await compactMessagesWithSummary(
      messages,
      async (prompt, stage) => {
        stages.push({ prompt, sourceMessages: stage?.sourceMessages });
        return "## Work completed\nPrior work is preserved.\n## Remaining work\nContinue.";
      },
      {
        budgetTokens: 0,
        keepRecent: 2,
        singlePassInputBudgetTokens:
          compactionSinglePassInputBudget(1_000_000),
      },
    );

    expect(compactionSinglePassInputBudget(1_000_000)).toBe(
      1_000_000 - COMPACTION_MAX_COMPLETION_TOKENS - 4_096,
    );
    expect(stages).toHaveLength(1);
    expect(stages[0]?.sourceMessages).toHaveLength(messages.length);
    expect(stages[0]?.sourceMessages?.[1]).toBe(messages[1]);
    expect(stages[0]?.sourceMessages?.at(-1)).toBe(messages.at(-1));
    expect(stages[0]?.prompt.length).toBeLessThan(15_000);
    expect(stages[0]?.prompt).toContain("LATEST USER PROMPTS (newest first");
    expect(result.summarized).toBe(true);
    expect(result.messages.map((message) => message.role)).toEqual(["system", "system"]);
    expect(result.messages.find(isCompactionMemoryMessage)?.content).toContain("> recent request");
  });

  it("keeps every region while bounding a manual compaction to map-reduce", async () => {
    const msgs: ChatMessage[] = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `turn-${index}`,
    }));
    // A real UI transcript can contain many large tool cards. Every region is
    // supplied to a map pass, then merged once; no nested splitter may turn
    // that into an unbounded request fan-out.
    const transcript = Array.from(
      { length: 80 },
      (_, index) => `TOOL ${index}:\n${"x".repeat(2_000)}`,
    ).join("\n\n");
    const prompts: string[] = [];
    const result = await compactMessagesWithSummary(
      msgs,
      async (prompt) => {
        prompts.push(prompt);
        return "## Work completed\nCompacted bounded transcript.\n## Remaining work\nContinue.";
      },
      { budgetTokens: 0, keepRecent: 2 },
      transcript,
    );

    expect(result.summarized).toBe(true);
    expect(prompts.length).toBeGreaterThan(2);
    expect(prompts.length).toBeLessThanOrEqual(MAX_COMPACTION_CHUNKS + 1);
    expect(prompts.some((prompt) => prompt.includes("TOOL 0:"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("TOOL 79:"))).toBe(true);
  });

  it("fails compaction when the model replays the transcript instead of summarizing", async () => {
    const msgs: ChatMessage[] = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `message-${index}-` + "content-to-exceed-limits-".repeat(20),
    }));
    await expect(
      compactMessagesWithSummary(
        msgs,
        async () =>
          "Let me continue.\nTask t3: Update scripts\n[tools: fs.write]\nTOOL: Tool fs.write result (exit=0, ok=true):\nWrote package.json bytes=610 lines=26 sha256_12=8f7c3b8e1d2a",
        { keepRecent: 4 },
      ),
    ).rejects.toThrow(/replayed the transcript/i);
  });

  it("plan-implement purpose uses handoff memory prefix", async () => {
    const msgs: ChatMessage[] = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `m-${index}-` + "x".repeat(200),
    }));
    const result = await compactMessagesWithSummary(
      msgs,
      async (prompt) => {
        expect(prompt).toMatch(/Research evidence/i);
        return "## Research evidence\nPorts 80/443 open\n## Remaining work\nt2 auth";
      },
      { keepRecent: 2, purpose: "plan-implement" },
    );
    const mem = result.messages.find(
      (m) =>
        m.role === "system" &&
        /PLAN MODE HANDOFF/i.test(m.content) &&
        m.content.includes("Ports 80/443"),
    );
    expect(mem).toBeTruthy();
    expect(mem!.content).toMatch(/gather-only\/await-approval gates are historical/i);
    expect(mem!.content).toMatch(/ACTIVE PLAN and SESSION STATE are authoritative/i);
  });

  it("continues recognizing legacy plan-handoff memories on session resume", () => {
    expect(
      isCompactionMemoryMessage({
        role: "system",
        content:
          "Session memory from PLAN MODE research that was used to build the comprehensive detailed plan and tasks you are seeing now (handoff to agent implement — gather-only phase is over; execute approved tasks):\nlegacy memory",
      }),
    ).toBe(true);
  });

  it("replaces index-zero compaction memory during LLM re-compaction", async () => {
    const staleMemory: ChatMessage = {
      role: "system",
      content:
        "Session memory from compacted earlier turns:\n\nstale resumed memory",
    };
    const messages: ChatMessage[] = [
      staleMemory,
      { role: "user", content: "old request" },
      { role: "assistant", content: "old response" },
      { role: "user", content: "recent request" },
      { role: "assistant", content: "recent response" },
    ];
    let prompt = "";

    const result = await compactMessagesWithSummary(
      messages,
      async (value) => {
        prompt = value;
        return "## Research evidence\nFresh handoff only";
      },
      { budgetTokens: 0, keepRecent: 2, purpose: "plan-implement" },
    );

    expect(prompt).toContain("stale resumed memory");
    const memories = result.messages.filter(isCompactionMemoryMessage);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toContain("PLAN MODE HANDOFF");
    expect(memories[0]?.content).toContain("Fresh handoff only");
    expect(result.messages).not.toContain(staleMemory);
  });

  it("replaces index-zero compaction memory during mechanical re-compaction", () => {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "Session memory from compacted earlier turns:\n\nstale resumed memory",
      },
      { role: "user", content: "old request " + "x".repeat(200) },
      { role: "assistant", content: "old response " + "x".repeat(200) },
      { role: "user", content: "recent request" },
      { role: "assistant", content: "recent response" },
    ];

    const result = compactMessages(messages, {
      budgetTokens: 0,
      keepRecent: 2,
    });

    const memories = result.filter(isCompactionMemoryMessage);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toContain("Earlier turns in this session");
    expect(result).not.toContain(messages[0]);
    expect(memories[0]?.content).toContain("stale resumed memory");
    expect(memories[0]?.content).toContain("## Last 3 user prompts (latest first)");
  });
});


describe("responder result compaction durability", () => {
  it("keeps the consumed ledger in persisted turn history and mechanical compaction", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "main system prompt" },
      { role: "user", content: "start work" },
      { role: "assistant", content: "working" },
    ];
    upsertResponderResultLedger(messages, consumedResponderResult());
    messages.push(
      { role: "user", content: "continue" },
      { role: "assistant", content: "continued" },
      { role: "user", content: "finish" },
      { role: "assistant", content: "finished" },
    );

    const history = buildTurnHistory(messages, "finished");
    const ledger = history.find(
      (message) =>
        message.role === "system" &&
        message.content.startsWith(RESPONDER_RESULT_LEDGER_PREFIX),
    );
    expect(ledger?.content).toContain("notification=completion:job-ledger");
    expect(ledger?.content).toContain("consumed=true");

    const compacted = compactMessages(history, {
      budgetTokens: 0,
      keepRecent: 2,
    });
    expect(compacted).toContain(ledger);
  });

  it("injects the consumed ledger as trusted durable state for model compaction", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "main system prompt" },
      { role: "user", content: "old request" },
      { role: "assistant", content: "old response" },
    ];
    upsertResponderResultLedger(messages, consumedResponderResult());
    messages.push(
      { role: "user", content: "recent request" },
      { role: "assistant", content: "recent response" },
    );
    let prompt = "";

    const result = await compactMessagesWithSummary(
      messages,
      async (value) => {
        prompt = value;
        return "## Work completed\nConsumed job-ledger findings.\n## Remaining work\nContinue.";
      },
      { budgetTokens: 0, keepRecent: 2 },
    );

    expect(prompt).toContain(RESPONDER_RESULT_LEDGER_PREFIX);
    expect(prompt).toContain("notification=completion:job-ledger");
    expect(prompt).toContain("consumed=true");
    expect(prompt).toMatch(/never describe a consumed=true result as unread/);
    const ledger = result.messages.find(
      (message) =>
        message.role === "system" &&
        message.content.startsWith(RESPONDER_RESULT_LEDGER_PREFIX),
    );
    expect(ledger?.content).toContain("notification=completion:job-ledger");
    expect(ledger?.content).toContain("consumed=true");
  });
});


describe("chunkTranscriptForCompaction", () => {
  it("caps map-stage calls at MAX_COMPACTION_CHUNKS for very long transcripts", () => {
    const longTranscript = Array.from(
      { length: 4000 },
      (_, i) => `turn ${i}: ${"x".repeat(100)}`,
    ).join("\n\n");
    const chunks = chunkTranscriptForCompaction(longTranscript);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(MAX_COMPACTION_CHUNKS);
  });

  it("preserves every region of history across chunks", () => {
    const longTranscript = Array.from(
      { length: 4000 },
      (_, i) => `turn ${i}: ${"y".repeat(100)}`,
    ).join("\n\n");
    const chunks = chunkTranscriptForCompaction(longTranscript);
    const rejoined = chunks.join("");
    for (let i = 0; i < 4000; i += 500) {
      expect(rejoined).toContain(`turn ${i}:`);
    }
  });
});
