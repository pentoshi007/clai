import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import { asToolCallId } from "../../../src/app/events/app-event.js";
import {
  hasAnimatedTools,
  TOOL_BALL_INTERVAL_MS,
  TOOL_BALL_WIDTH,
  toolBallColorIndex,
  toolStatusBall,
} from "../../../src/ui-core/rendering/tool-status-ball.js";
import { themeFor } from "../../../src/ui-core/rendering/theme.js";
import { EMPTY_TRANSCRIPT_STATE, type ToolItem, type ToolStatus } from "../../../src/ui-core/state/transcript-types.js";

const theme = themeFor("dark");
const ACTIVE: ToolStatus[] = ["queued", "running"];
const DONE: ToolStatus[] = ["ok", "failed", "blocked"];
const ANSI = /\x1b\[[0-9;]*m/g;
const ball = (status: ToolStatus, now = 0, colorMode: "truecolor" | "256" | "16" | "none" = "truecolor", unicode = true) =>
  toolStatusBall(status, now, theme, colorMode, unicode);
const plain = (text: string): string => text.replace(ANSI, "");

describe("tool status ball", () => {
  it.each([...ACTIVE, ...DONE])("renders %s as a single text-height ball", (status) => {
    expect(plain(ball(status))).toBe("●");
    expect(stringWidth(plain(ball(status)))).toBe(TOOL_BALL_WIDTH);
  });

  it("cycles red, green and yellow while active", () => {
    const colors = [0, 1, 2, 3].map((step) => ball("running", step * TOOL_BALL_INTERVAL_MS));
    expect(colors).toEqual([
      "\x1b[38;2;240;82;78m●\x1b[39m",
      "\x1b[38;2;64;204;123m●\x1b[39m",
      "\x1b[38;2;250;204;21m●\x1b[39m",
      "\x1b[38;2;240;82;78m●\x1b[39m",
    ]);
  });

  it("keeps one colour per frame and never mixes them", () => {
    for (let step = 0; step < 12; step++) {
      const frame = ball("queued", step * TOOL_BALL_INTERVAL_MS);
      expect(frame.match(/\x1b\[38;2;/g)).toHaveLength(1);
      expect(plain(frame)).toBe("●");
    }
  });

  it("animates pending and running identically", () => {
    for (const now of [0, 90, 200, 650]) {
      expect(ball("queued", now)).toBe(ball("running", now));
    }
  });

  it("holds a static colour once the tool completes", () => {
    expect(ball("ok", 0)).toBe("\x1b[38;2;74;222;128m●\x1b[39m");
    expect(ball("failed", 0)).toBe("\x1b[38;2;248;113;113m●\x1b[39m");
    expect(ball("blocked", 0)).toBe("\x1b[38;2;248;113;113m●\x1b[39m");
    for (const status of DONE) expect(ball(status, 10_000)).toBe(ball(status, 0));
  });

  it("degrades to ascii markers without unicode", () => {
    expect(plain(ball("running", 0, "truecolor", false))).toBe("*");
    expect(plain(ball("ok", 0, "truecolor", false))).toBe("*");
    expect(plain(ball("failed", 0, "truecolor", false))).toBe("x");
    expect(plain(ball("blocked", 0, "truecolor", false))).toBe("x");
  });

  it("drops escape codes when colour is disabled", () => {
    expect(ball("running", TOOL_BALL_INTERVAL_MS, "none")).toBe("●");
    expect(ball("ok", 0, "none")).toBe("●");
  });

  it("paints reduced colour depths with a single ball", () => {
    for (const colorMode of ["256", "16"] as const) {
      const frame = ball("running", 0, colorMode);
      expect(frame).toContain("\x1b[");
      expect(plain(frame)).toBe("●");
    }
  });

  it("advances the palette index every interval", () => {
    expect(toolBallColorIndex(0)).toBe(0);
    expect(toolBallColorIndex(TOOL_BALL_INTERVAL_MS - 1)).toBe(0);
    expect(toolBallColorIndex(TOOL_BALL_INTERVAL_MS)).toBe(1);
    expect(toolBallColorIndex(TOOL_BALL_INTERVAL_MS * 3)).toBe(0);
    expect(toolBallColorIndex(-5)).toBe(0);
  });
});

describe("hasAnimatedTools", () => {
  const tool: ToolItem = {
    id: "ball-tool", sequence: 1, turnId: undefined, timestamp: 0, kind: "tool", toolCallId: asToolCallId("ball-call"),
    name: "shell.exec", argsDisplay: "printf ready", status: "queued", exitCode: undefined, summary: undefined,
    artifactPath: undefined, reason: undefined, outputBytes: 0, fileChanges: undefined,
  };
  const stateWith = (item: ToolItem) => ({ ...EMPTY_TRANSCRIPT_STATE, order: [item.id], byId: new Map([[item.id, item]]) });

  it.each(["queued", "running"] as const)("counts %s tools as animated", (status) => {
    expect(hasAnimatedTools(stateWith({ ...tool, status }))).toBe(true);
  });

  it("counts pending tools as animated", () => {
    expect(hasAnimatedTools(stateWith({ ...tool, pending: true }))).toBe(true);
  });

  it.each(DONE)("leaves %s tools static", (status) => {
    expect(hasAnimatedTools(stateWith({ ...tool, status }))).toBe(false);
  });
});
