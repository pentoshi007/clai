import { describe, expect, it } from "vitest";
import type { TranscriptItem as ClassicItem } from "../../../src/tui/state.js";
import {
  displayCompactSummary,
  hydrateFromClassicTranscript,
  hydrateFromMessages,
  serializeForHistory,
} from "../../../src/tui-v2/state/transcript-hydrate.js";
import { asToolCallId } from "../../../src/app/events/app-event.js";
import type { TranscriptState } from "../../../src/tui-v2/state/transcript-types.js";

describe("hydrateFromClassicTranscript", () => {
  it("restores user, assistant, and tool rows with spool output", () => {
    const classic: ClassicItem[] = [
      { kind: "user", id: "u1", text: "who is uk pm", done: true },
      {
        kind: "tool",
        id: "t1",
        name: "web.search",
        argsDisplay: "uk pm",
        output: "duckduckgo: 1 result\n{}",
        status: "ok",
        exitCode: 0,
        done: true,
      },
      {
        kind: "assistant",
        id: "a1",
        text: "Keir Starmer",
        streaming: false,
        done: true,
      },
    ];
    const { state, toolOutputs } = hydrateFromClassicTranscript(classic);
    expect(state.order).toHaveLength(3);
    const items = state.order.map((id) => state.byId.get(id)!);
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "assistant"]);
    expect(toolOutputs.get(asToolCallId("t1"))).toContain("duckduckgo");
  });

  it("maps fail status to failed", () => {
    const classic: ClassicItem[] = [
      {
        kind: "tool",
        id: "t2",
        name: "shell.exec",
        argsDisplay: "false",
        output: "err",
        status: "fail",
        exitCode: 1,
        done: true,
      },
    ];
    const { state } = hydrateFromClassicTranscript(classic);
    const tool = state.byId.get("t2");
    expect(tool?.kind).toBe("tool");
    if (tool?.kind === "tool") expect(tool.status).toBe("failed");
  });
});

describe("hydrateFromMessages", () => {
  it("rebuilds user/assistant from model history when no transcript", () => {
    const { state } = hydrateFromMessages([
      { role: "system", content: "ignored" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(state.order).toHaveLength(2);
    const kinds = state.order.map((id) => state.byId.get(id)!.kind);
    expect(kinds).toEqual(["user", "assistant"]);
  });

  it("resets lastSequence so live turns after /history are not dropped", () => {
    // Regression: hydrate used to set lastSequence = N while the session
    // sequencer rebinds to 0, so turn-started (seq 1) was ignored.
    const { state } = hydrateFromMessages([
      { role: "user", content: "old prompt" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "another" },
      { role: "assistant", content: "reply" },
    ]);
    expect(state.order.length).toBeGreaterThan(1);
    expect(state.lastSequence).toBe(0);
  });
});

describe("post-hydrate live events", () => {
  it("applies turn-started after classic hydrate (new YOU row)", async () => {
    const { applyAppEvent } = await import(
      "../../../src/tui-v2/state/transcript-reducer.js"
    );
    const { asSessionId, asTurnId } = await import(
      "../../../src/app/events/app-event.js"
    );
    const { EventSequencer, createCountingIdFactory } = await import(
      "../../../src/app/events/sequencer.js"
    );

    const classic: ClassicItem[] = [
      { kind: "user", id: "u1", text: "old", done: true },
      { kind: "assistant", id: "a1", text: "prior", streaming: false, done: true },
    ];
    const { state: hydrated } = hydrateFromClassicTranscript(classic);
    expect(hydrated.lastSequence).toBe(0);

    const seq = new EventSequencer(
      asSessionId("sess-hist"),
      createCountingIdFactory("h"),
      { now: () => 1 },
    );
    // Mimic loadHistory rebind — sequence starts at 1 again.
    const next = applyAppEvent(
      hydrated,
      seq.build("turn-started", { prompt: "follow-up after resume" }, asTurnId("t1")),
    );
    const users = next.order
      .map((id) => next.byId.get(id)!)
      .filter((i) => i.kind === "user");
    expect(users).toHaveLength(2);
    expect(users[1]).toMatchObject({ kind: "user", text: "follow-up after resume" });
  });
});

describe("serializeForHistory", () => {
  it("round-trips a simple transcript", () => {
    const state: TranscriptState = {
      order: ["u1", "a1"],
      byId: new Map([
        [
          "u1",
          {
            id: "u1",
            sequence: 1,
            turnId: undefined,
            timestamp: 1,
            kind: "user",
            text: "hi",
          },
        ],
        [
          "a1",
          {
            id: "a1",
            sequence: 2,
            turnId: undefined,
            timestamp: 2,
            kind: "assistant",
            text: "yo",
            streaming: false,
          },
        ],
      ]),
      pendingAssistantId: undefined,
      pendingThinkingId: undefined,
      lastSequence: 2,
      runningStatus: undefined,
      expandThinkingGlobal: false,
      expandOutputGlobal: false,
      itemOverrides: new Map(),
    };
    const classic = serializeForHistory(state, () => "");
    expect(classic).toHaveLength(2);
    expect(classic[0]).toMatchObject({ kind: "user", text: "hi" });
    const again = hydrateFromClassicTranscript(classic);
    expect(again.state.order).toHaveLength(2);
  });
});

describe("displayCompactSummary", () => {
  it("strips the session memory prefix", () => {
    expect(
      displayCompactSummary(
        "Session memory from compacted earlier turns:\n\nUser goals: ship it",
      ),
    ).toBe("User goals: ship it");
  });
});
