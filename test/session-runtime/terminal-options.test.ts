import { describe, expect, it } from "vitest";
import { parseRuntimeTerminalOptions, runtimeTerminalOptions, runtimeViewFrame } from "../../src/session-runtime/terminal-options.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { createInkTheme } from "../../src/classic/render/ink-theme.js";

describe("per-attachment terminal settings", () => {
  it("forwards terminal capabilities without forwarding unrelated environment secrets", () => {
    const options = runtimeTerminalOptions("classic", { TERM: "xterm-256color", TERM_PROGRAM: "termux", TMUX: "/tmp/tmux/session", OPENAI_API_KEY: "secret", CLAI_RUNTIME_TOKEN: "secret" });
    expect(options).toEqual({ ui: "classic", env: { TERM: "xterm-256color", TERM_PROGRAM: "termux", TMUX: "/tmp/tmux/session" } });
    expect(parseRuntimeTerminalOptions(options)).toEqual(options);
  });

  it.each([
    { WT_SESSION: "windows-terminal" }, { ConEmuANSI: "ON" },
    { TERMINAL_EMULATOR: "JetBrains-JediTerm" }, { VTE_VERSION: "6000" },
    { KITTY_WINDOW_ID: "1" }, { WEZTERM_EXECUTABLE: "wezterm.exe" },
    { GHOSTTY_RESOURCES_DIR: "/opt/ghostty" }, { KONSOLE_VERSION: "240800" },
    { ALACRITTY_WINDOW_ID: "1" }, { ALACRITTY_SOCKET: "/tmp/alacritty.sock" },
  ])("preserves terminal color evidence across npm runtime attachment: %j", (env) => {
    const options = runtimeTerminalOptions("classic", env);
    expect(options.env).toEqual(env);
    expect(parseRuntimeTerminalOptions(options)).toEqual(options);
    const input = { stdoutIsTTY: true, stdinIsTTY: true, columns: 100, rows: 30, platform: "win32" };
    const direct = detectCapabilities({ ...input, env });
    const attached = detectCapabilities({ ...input, env: options.env });
    expect(direct.colorMode).toBe("truecolor");
    expect(attached).toEqual(direct);
    const theme = createInkTheme({ ...attached, themeHint: "dark" });
    expect(theme.hex("#2563EB", "blue")).toContain("\u001b[38;2;37;99;235m");
  });

  it.each([
    { NO_COLOR: "1", colorMode: "none" },
    { FORCE_COLOR: "1", colorMode: "16" },
    { FORCE_COLOR: "2", colorMode: "256" },
    { FORCE_COLOR: "3", colorMode: "truecolor" },
  ])("preserves explicit color preferences: %j", ({ colorMode, ...override }) => {
    const env = { WT_SESSION: "windows-terminal", ...override };
    const input = { stdoutIsTTY: true, stdinIsTTY: true, columns: 100, rows: 30, platform: "win32" };
    const attached = detectCapabilities({ ...input, env: runtimeTerminalOptions("classic", env).env });
    expect(attached.colorMode).toBe(colorMode);
    expect(attached).toEqual(detectCapabilities({ ...input, env }));
  });

  it("preserves an explicitly selected theme through runtime attachment", () => {
    const env = { TERM: "xterm-256color", CLAI_THEME: "light" };
    const options = runtimeTerminalOptions("classic", env);
    expect(parseRuntimeTerminalOptions(options)).toEqual(options);
    expect(detectCapabilities({ env: options.env, stdoutIsTTY: true, stdinIsTTY: true, columns: 80, rows: 24 }).themeHint).toBe("light");
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
