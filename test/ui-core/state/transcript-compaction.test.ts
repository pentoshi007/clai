import { describe, expect, it } from "vitest";
import { asToolCallId } from "../../../src/app/events/app-event.js";
import {
  mergeCompactionSourceMaterial,
  serializeTranscriptForCompaction,
} from "../../../src/ui-core/state/transcript-compaction.js";
import type { TranscriptState } from "../../../src/ui-core/state/transcript-types.js";
import { EMPTY_TRANSCRIPT_STATE } from "../../../src/ui-core/state/transcript-types.js";

function stateFrom(
  items: Array<
    | { kind: "user"; id: string; text: string }
    | { kind: "assistant"; id: string; text: string }
    | {
        kind: "tool";
        id: string;
        name: string;
        argsDisplay: string;
        toolCallId?: string;
        status?: "ok" | "failed";
        exitCode?: number;
        summary?: string;
        artifactPath?: string;
      }
    | { kind: "notice"; id: string; level?: "info" | "warn"; text: string }
    | { kind: "compacted"; id: string; summary: string }
  >,
): TranscriptState {
  const order: string[] = [];
  const byId = new Map();
  let sequence = 0;
  for (const raw of items) {
    sequence += 1;
    order.push(raw.id);
    if (raw.kind === "user") {
      byId.set(raw.id, {
        id: raw.id,
        sequence,
        turnId: undefined,
        timestamp: sequence,
        kind: "user",
        text: raw.text,
      });
    } else if (raw.kind === "assistant") {
      byId.set(raw.id, {
        id: raw.id,
        sequence,
        turnId: undefined,
        timestamp: sequence,
        kind: "assistant",
        text: raw.text,
        streaming: false,
      });
    } else if (raw.kind === "tool") {
      byId.set(raw.id, {
        id: raw.id,
        sequence,
        turnId: undefined,
        timestamp: sequence,
        kind: "tool",
        toolCallId: asToolCallId(raw.toolCallId ?? raw.id),
        name: raw.name,
        argsDisplay: raw.argsDisplay,
        status: raw.status ?? "ok",
        exitCode: raw.exitCode,
        summary: raw.summary,
        artifactPath: raw.artifactPath,
        reason: undefined,
        outputBytes: 0,
        fileChanges: undefined,
      });
    } else if (raw.kind === "notice") {
      byId.set(raw.id, {
        id: raw.id,
        sequence,
        turnId: undefined,
        timestamp: sequence,
        kind: "notice",
        level: raw.level ?? "info",
        text: raw.text,
      });
    } else {
      byId.set(raw.id, {
        id: raw.id,
        sequence,
        turnId: undefined,
        timestamp: sequence,
        kind: "compacted",
        summary: raw.summary,
        beforeTokens: 100,
        afterTokens: 40,
      });
    }
  }
  return {
    ...EMPTY_TRANSCRIPT_STATE,
    order,
    byId,
    lastSequence: 0,
  };
}

describe("serializeTranscriptForCompaction", () => {
  it("includes user prompts, tools with spool output, and answers", () => {
    const state = stateFrom([
      { kind: "user", id: "u1", text: "find open ports" },
      {
        kind: "tool",
        id: "t1",
        name: "net.scan",
        argsDisplay: "127.0.0.1",
        exitCode: 0,
        artifactPath: "/tmp/nmap.txt",
      },
      { kind: "assistant", id: "a1", text: "port 5000 is open" },
    ]);
    const source = serializeTranscriptForCompaction(state, (id) =>
      id === asToolCallId("t1") ? "5000/tcp open" : "",
    );
    expect(source).toContain("USER INTENT/PROMPT:\nfind open ports");
    expect(source).toContain("TOOL/COMMAND: net.scan");
    expect(source).toContain("STATUS: ok (exit 0)");
    expect(source).toContain("5000/tcp open");
    expect(source).toContain("FULL ARTIFACT: /tmp/nmap.txt");
    expect(source).toContain("ASSISTANT RESPONSE:\nport 5000 is open");
  });

  it("preserves complete long tool fields for upstream chunking", () => {
    const args = `${"a".repeat(12_000)}ARGS-END`;
    const output = `${"o".repeat(16_000)}OUTPUT-END`;
    const state = stateFrom([
      {
        kind: "tool",
        id: "t-long",
        name: "shell.exec",
        argsDisplay: args,
      },
    ]);
    const source = serializeTranscriptForCompaction(state, () => output);
    expect(source).toContain("ARGS-END");
    expect(source).toContain("OUTPUT-END");
    expect(source).not.toContain("truncated");
  });

  it("starts from the last compacted card so prior memory is kept", () => {
    const state = stateFrom([
      { kind: "user", id: "u0", text: "ancient" },
      { kind: "compacted", id: "c1", summary: "Earlier: recon done" },
      { kind: "user", id: "u1", text: "continue exploit" },
      { kind: "assistant", id: "a1", text: "running" },
    ]);
    const source = serializeTranscriptForCompaction(state);
    expect(source).toContain("COMPACTED CONTEXT:\nEarlier: recon done");
    expect(source).toContain("continue exploit");
    expect(source).not.toContain("ancient");
  });

  it("never includes UI notices in model compaction source", () => {
    const state = stateFrom([
      { kind: "user", id: "u1", text: "build todo" },
      {
        kind: "notice",
        id: "n1",
        level: "info",
        text: "session resumed · 98 items · 109 model messages",
      },
      {
        kind: "notice",
        id: "n2",
        level: "info",
        text: "Ctrl+C again to exit",
      },
      { kind: "assistant", id: "a1", text: "ok" },
    ]);
    const source = serializeTranscriptForCompaction(state);
    expect(source).toContain("build todo");
    expect(source).not.toContain("session resumed");
    expect(source).not.toContain("Ctrl+C again");
    expect(source).not.toContain("SESSION EVENT");
  });
});

describe("mergeCompactionSourceMaterial", () => {
  it("combines visual transcript with older model turns", () => {
    const merged = mergeCompactionSourceMaterial(
      "USER INTENT/PROMPT:\nold history prompt",
      "USER: follow-up after resume\n\nASSISTANT: new answer",
    );
    expect(merged).toContain("old history prompt");
    expect(merged).toContain("OLDER MODEL TURNS");
    expect(merged).toContain("follow-up after resume");
  });

  it("falls back to whichever side is present", () => {
    expect(mergeCompactionSourceMaterial(undefined, "USER: only messages")).toContain(
      "only messages",
    );
    expect(mergeCompactionSourceMaterial("only visual", "")).toBe("only visual");
  });
});
