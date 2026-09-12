import { describe, expect, it } from "vitest";
import { panelFrameRows } from "../../../src/classic/panels/panel-frame.js";
import {
  sanitizeSecretInput,
  secretInitialState,
  secretKey,
  secretPaste,
  secretView,
} from "../../../src/classic/panels/secret-panel.js";
import { plainText } from "../../../src/classic/render/ansi-text.js";
import { createHarness, ink, rowsOf } from "./harness.js";

const REQUEST = { title: "sudo password", prompt: "sudo password required for: nmap -sV 10.0.0.1" };

function typed(value: string) {
  let state = secretInitialState();
  for (const char of value) {
    state = secretKey({ state, chord: char, text: char }).state;
  }
  return state;
}

function render(state = secretInitialState(), request = REQUEST) {
  const frame = secretView({ ink, columns: 80, rows: 5, request, state });
  return { frame, rows: rowsOf(panelFrameRows(frame).rows) };
}

describe("secret rows", () => {
  it("uses the magenta border and the lock title", () => {
    const { frame } = render();
    expect(frame.borderColor).toBe("magenta");
    expect(frame.title).toBe("🔒 sudo password");
    expect(frame.hints).toEqual(["⏎ submit", "esc cancel"]);
  });

  it("renders the prompt and a bullet mask", () => {
    const { rows } = render(typed("hunter2"));
    expect(rows[1]).toContain("sudo password required for: nmap -sV 10.0.0.1");
    expect(rows[2]).toContain("❯ •••••••");
  });

  it("never renders the plaintext for a masked request", () => {
    const frame = panelFrameRows(render(typed("hunter2")).frame).rows.join("\n");
    expect(frame).not.toContain("hunter2");
    expect(plainText(frame)).not.toContain("hunter2");
  });

  it("shows the value for reveal requests", () => {
    const { rows } = render(typed("https://api.example.com"), {
      title: "Modal endpoint",
      prompt: "endpoint URL",
      reveal: true,
    });
    expect(rows[2]).toContain("https://api.example.com");
  });

  it("always renders a caret at the input position", () => {
    expect(render(typed("hunter2")).rows[2]).toContain("•••••••▎");
    expect(
      render(typed("https://api.example.com"), {
        title: "Modal endpoint",
        prompt: "endpoint URL",
        reveal: true,
      }).rows[2],
    ).toContain("https://api.example.com▎");
    expect(render().rows[2]).toContain("❯ ▎");
  });

  it("seeds a revealed input from the shared request initial value", () => {
    const seeded = secretInitialState("{}");
    expect(seeded.buffer.reveal()).toBe("{}");
    expect(seeded.cursor).toBe(2);
    const { rows } = render(seeded, {
      title: "Add MCP server",
      prompt: "one server JSON",
      reveal: true,
      initialValue: "{}",
    });
    expect(rows[2]).toContain("❯ {}");

    const harness = createHarness();
    void harness.overlay.openSecret({
      title: "Add MCP server",
      prompt: "one server JSON",
      reveal: true,
      initialValue: "{}",
    });
    expect(harness.panels.getSnapshot().secret.buffer.reveal()).toBe("{}");
    expect(harness.panels.getSnapshot().secret.cursor).toBe(2);
  });
});

describe("secret keys", () => {
  it("keeps the value only in the buffer", () => {
    const state = typed("abc");
    expect(state.buffer.reveal()).toBe("abc");
    expect(String(state.buffer)).toBe("•••");
    expect(JSON.stringify({ secret: state.buffer })).toBe('{"secret":"•••"}');
    expect(JSON.stringify(state)).not.toContain("abc");
  });

  it("deletes backward and clears with ctrl+u", () => {
    let state = typed("abcd");
    state = secretKey({ state, chord: "backspace" }).state;
    expect(state.buffer.masked()).toBe("•••");
    state = secretKey({ state, chord: "ctrl+u" }).state;
    expect(state.buffer.length).toBe(0);
  });

  it("strips escapes and newlines from pasted bytes", () => {
    expect(sanitizeSecretInput("\u001b[31mpass\u001b[0m\nword\r\n")).toBe("password");
    const state = secretPaste(secretInitialState(), "\u001b[31msecret\u001b[0m\n");
    expect(state.buffer.reveal()).toBe("secret");
  });

  it("submits the plaintext exactly once and clears on cancel", async () => {
    const harness = createHarness();
    const answer = harness.overlay.openSecret(REQUEST);
    harness.press("p", "p");
    harness.press("w", "w");
    harness.press("enter");
    await expect(answer).resolves.toBe("pw");

    const cancelled = createHarness();
    const second = cancelled.overlay.openSecret(REQUEST);
    cancelled.press("x", "x");
    cancelled.press("escape");
    await expect(second).resolves.toBeUndefined();
  });

  it("swallows unmapped chords rather than leaking them to the router", () => {
    const harness = createHarness();
    void harness.overlay.openSecret(REQUEST);
    expect(harness.press("ctrl+g")).toBe(true);
  });

  it("routes a paste into the buffer, never into the transcript", () => {
    const harness = createHarness();
    void harness.overlay.openSecret(REQUEST);
    expect(harness.handlePasteThroughPanels("s3cr3t")).toBe(true);
    expect(harness.panels.getSnapshot().secret.buffer.reveal()).toBe("s3cr3t");
    expect(JSON.stringify(harness.panels.getSnapshot())).not.toContain("s3cr3t");
  });
});

describe("secret cursor editing", () => {
  it("moves the caret with arrows, home, and end", () => {
    let state = typed("abcd");
    state = secretKey({ state, chord: "left" }).state;
    state = secretKey({ state, chord: "left" }).state;
    expect(state.cursor).toBe(2);
    state = secretKey({ state, chord: "right" }).state;
    expect(state.cursor).toBe(3);
    state = secretKey({ state, chord: "home" }).state;
    expect(state.cursor).toBe(0);
    state = secretKey({ state, chord: "end" }).state;
    expect(state.cursor).toBe(4);
    for (let i = 0; i < 6; i += 1) {
      state = secretKey({ state, chord: "left" }).state;
    }
    expect(state.cursor).toBe(0);
    state = secretKey({ state, chord: "right" }).state;
    state = secretKey({ state, chord: "right" }).state;
    state = secretKey({ state, chord: "right" }).state;
    state = secretKey({ state, chord: "right" }).state;
    state = secretKey({ state, chord: "right" }).state;
    expect(state.cursor).toBe(4);
  });

  it("deletes from the middle with backspace and delete", () => {
    let state = typed("abcd");
    state = secretKey({ state, chord: "left" }).state;
    state = secretKey({ state, chord: "left" }).state;
    state = secretKey({ state, chord: "backspace" }).state;
    expect(state.buffer.reveal()).toBe("acd");
    expect(state.cursor).toBe(1);
    state = secretKey({ state, chord: "delete" }).state;
    expect(state.buffer.reveal()).toBe("ad");
    expect(state.cursor).toBe(1);
    state = secretKey({ state, chord: "delete" }).state;
    expect(state.buffer.reveal()).toBe("a");
    state = secretKey({ state, chord: "delete" }).state;
    expect(state.buffer.reveal()).toBe("a");
    state = secretKey({ state, chord: "backspace" }).state;
    state = secretKey({ state, chord: "backspace" }).state;
    expect(state.buffer.reveal()).toBe("");
    expect(state.cursor).toBe(0);
  });

  it("inserts at the cursor, not at the end", () => {
    let state = typed("ad");
    state = secretKey({ state, chord: "home" }).state;
    state = secretKey({ state, chord: "right" }).state;
    state = secretKey({ state, chord: "x", text: "x" }).state;
    expect(state.buffer.reveal()).toBe("axd");
    expect(state.cursor).toBe(2);
    state = secretPaste(state, "XY");
    expect(state.buffer.reveal()).toBe("axXYd");
    expect(state.cursor).toBe(4);
  });

  it("renders the caret at the cursor position", () => {
    let state = typed("abcdef");
    state = secretKey({ state, chord: "left" }).state;
    state = secretKey({ state, chord: "left" }).state;
    state = secretKey({ state, chord: "left" }).state;
    expect(render(state).rows[2]).toContain("•••▎•••");
    expect(
      render(state, { title: "Modal endpoint", prompt: "endpoint URL", reveal: true }).rows[2],
    ).toContain("abc▎def");
  });

  it("keeps the caret visible when the value overflows the field", () => {
    const long = `${"a".repeat(70)}TAIL`;
    let state = typed(long);
    const endView = render(state, {
      title: "Modal endpoint",
      prompt: "endpoint URL",
      reveal: true,
    });
    expect(endView.rows[2]).toContain("…");
    expect(endView.rows[2]).toContain("TAIL▎");
    state = secretKey({ state, chord: "home" }).state;
    const homeView = render(state, {
      title: "Modal endpoint",
      prompt: "endpoint URL",
      reveal: true,
    });
    expect(homeView.rows[2]).toContain("❯ ▎aaa");
    expect(homeView.rows[2]).toContain("T…");
  });
});
