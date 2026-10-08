import { describe, expect, it } from "vitest";
import { parseRuntimeTerminalOptions, runtimeTerminalOptions, runtimeViewFrame } from "../../src/session-runtime/terminal-options.js";

describe("per-attachment terminal settings", () => {
  it("forwards terminal capabilities without forwarding unrelated environment secrets", () => {
    const options = runtimeTerminalOptions("classic", { TERM: "xterm-256color", TERM_PROGRAM: "termux", TMUX: "/tmp/tmux/session", OPENAI_API_KEY: "secret", CLAI_RUNTIME_TOKEN: "secret" });
    expect(options).toEqual({ ui: "classic", env: { TERM: "xterm-256color", TERM_PROGRAM: "termux", TMUX: "/tmp/tmux/session" } });
    expect(parseRuntimeTerminalOptions(options)).toEqual(options);
  });

  it.each([
    { ui: "unknown", env: {} }, { ui: "auto", env: { OPENAI_API_KEY: "secret" } },
    { ui: "tui", env: { TERM: "x".repeat(257) } }, { ui: "classic", env: [] },
  ])("rejects invalid or nonterminal settings: %j", (options) => {
    expect(parseRuntimeTerminalOptions(options)).toBeUndefined();
  });

  it("validates view routing and preserves complete UTF-8 input", () => {
    const attach = { type: "view-attach", clientId: "phone", columns: 38, rows: 20, terminal: { ui: "auto", env: { TERM: "xterm-256color" } } };
    expect(runtimeViewFrame(attach)).toEqual(attach);
    const data = Buffer.from("private_界_🙂").toString("base64");
    expect(runtimeViewFrame({ type: "view-input", clientId: "phone", data })).toEqual({ type: "view-input", clientId: "phone", data });
    expect(runtimeViewFrame({ ...attach, clientId: "" })).toBeUndefined();
    expect(runtimeViewFrame({ ...attach, columns: 0 })).toBeUndefined();
    expect(runtimeViewFrame({ type: "view-input", clientId: "phone", data: "invalid" })).toBeUndefined();
    expect(runtimeViewFrame({ type: "view-resize", clientId: "phone", columns: 28, rows: 12 })).toBeDefined();
  });
});
