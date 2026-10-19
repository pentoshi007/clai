import { describe, expect, it } from "vitest";

import {
  freebuffCloudDevEnv,
  freebuffEnvProfile,
  freebuffParentInfo,
  freebuffProxyKind,
  freebuffTerminalProgramKind,
  freebuffTimezoneProfile,
  normalizeFreebuffProcessName,
  type FreebuffProcInfo,
} from "../src/llm/freebuff-env-profile.js";

function procChain(entries: Record<number, FreebuffProcInfo>): (pid: number) => FreebuffProcInfo | null {
  return (pid) => entries[pid] ?? null;
}

describe("Freebuff environment profile", () => {
  it("emits the v1 key list in wire order with normalized process ancestry", () => {
    const profile = freebuffEnvProfile({
      env: { TERM: "xterm-256color", COLORTERM: "", NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      platform: "linux",
      ppid: 500,
      stdinIsTTY: false,
      stdoutIsTTY: true,
      columns: 120,
      rows: 40,
      timeZone: "America/New_York",
      readProc: procChain({
        500: { ppid: 400, name: "bash" },
        400: { ppid: 300, name: "tmux" },
      }),
    });
    expect(profile).toBe(
      "v1;in=0;out=1;tp=none;term=1;ct=0;sz=120x40;ci=0;ssh=0;l=0;p=shell;g=mux;osc=na;tzo=0;px=none;tls=0;ca=0;cde=none",
    );
  });

  it("marks the launcher hop and reports the post-launcher ancestry", () => {
    const info = freebuffParentInfo(
      { platform: "linux", ppid: 500, launcherPid: "500" },
      procChain({
        500: { ppid: 400, name: "freebuff" },
        400: { ppid: 300, name: "bash" },
        300: { ppid: 200, name: "tmux" },
      }),
    );
    expect(info).toEqual({ launcher: true, parent: "shell", grandparent: "mux" });
  });

  it("falls back to unknown ancestry on unreadable or win32 process tables", () => {
    expect(freebuffParentInfo({ platform: "linux", ppid: 500, launcherPid: undefined }, () => null)).toEqual({
      launcher: false,
      parent: "unknown",
      grandparent: "unknown",
    });
    expect(freebuffParentInfo({ platform: "win32", ppid: 500, launcherPid: undefined })).toEqual({
      launcher: false,
      parent: "na",
      grandparent: "na",
    });
  });

  it("adds a normalized stz entry only when TZ is set and the zone shape is valid", () => {
    const withZone = freebuffEnvProfile({ env: { TZ: "UTC" }, timeZone: "zoneinfo/Europe/Berlin", readProc: () => null });
    expect(withZone).toContain(";tzo=1;px=none;");
    expect(withZone).toContain("stz=Europe/Berlin");
    const invalid = freebuffEnvProfile({ env: { TZ: "UTC" }, timeZone: "Zonky", readProc: () => null });
    expect(invalid).toContain("tzo=1");
    expect(invalid).not.toContain("stz=");
  });

  it("detects CI, SSH and terminal program signals", () => {
    const ci = freebuffEnvProfile({ env: { CI: "1", TERM_PROGRAM: "vscode" }, readProc: () => null });
    expect(ci).toContain(";ci=1;");
    expect(ci).toContain("tp=vscode");
    const actions = freebuffEnvProfile({ env: { GITHUB_ACTIONS: "true" }, readProc: () => null });
    expect(actions).toContain(";ci=1;");
    const ssh = freebuffEnvProfile({ env: { SSH_CONNECTION: "10.0.0.1 5 10.0.0.2 22" }, readProc: () => null });
    expect(ssh).toContain(";ssh=1;");
    expect(freebuffTerminalProgramKind("WezTerm")).toBe("wezterm");
    expect(freebuffTerminalProgramKind("strange-term")).toBe("other");
    expect(freebuffTerminalProgramKind(undefined)).toBe("none");
  });

  it("classifies proxies and cloud dev environments", () => {
    expect(freebuffProxyKind({ HTTP_PROXY: "http://127.0.0.1:8080", HTTPS_PROXY: "http://10.0.0.9:3128" })).toBe("loopback");
    expect(freebuffProxyKind({ ALL_PROXY: "10.0.0.9:3128" })).toBe("remote");
    expect(freebuffProxyKind({})).toBe("none");
    expect(freebuffProxyKind({ HTTPS_PROXY: "not a url at all" })).toBe("remote");
    expect(freebuffCloudDevEnv({ CODESPACES: "true" })).toBe("codespaces");
    expect(freebuffCloudDevEnv({ GITPOD_WORKSPACE_ID: "x" })).toBe("gitpod");
    expect(freebuffCloudDevEnv({ CLOUD_SHELL: "true" })).toBe("cloudshell");
    expect(freebuffCloudDevEnv({ CODER: "true" })).toBe("coder");
    expect(freebuffCloudDevEnv({})).toBe("none");
  });

  it("normalizes process names into the documented buckets", () => {
    expect(normalizeFreebuffProcessName("/usr/bin/fish")).toBe("shell");
    expect(normalizeFreebuffProcessName("tmux: server")).toBe("mux");
    expect(normalizeFreebuffProcessName("tmux")).toBe("mux");
    expect(normalizeFreebuffProcessName("screen")).toBe("mux");
    expect(normalizeFreebuffProcessName("sshd-worker")).toBe("sshd");
    expect(normalizeFreebuffProcessName("node.exe")).toBe("node");
    expect(normalizeFreebuffProcessName("python3.12")).toBe("python");
    expect(normalizeFreebuffProcessName("bun")).toBe("bun");
    expect(normalizeFreebuffProcessName("ghostty")).toBe("terminal");
    expect(normalizeFreebuffProcessName("nvim")).toBe("editor");
    expect(normalizeFreebuffProcessName("cursor helper")).toBe("editor");
    expect(normalizeFreebuffProcessName("mystery")).toBe("other");
    expect(normalizeFreebuffProcessName(undefined)).toBe("unknown");
    expect(normalizeFreebuffProcessName("  ")).toBe("unknown");
  });

  it("accepts only one- or two-segment zone names up to 64 characters", () => {
    expect(freebuffTimezoneProfile("America/Argentina/Buenos_Aires")).toBe("America/Argentina/Buenos_Aires");
    expect(freebuffTimezoneProfile("zoneinfo/Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(freebuffTimezoneProfile("NotAZone")).toBeNull();
    expect(freebuffTimezoneProfile("A".repeat(70))).toBeNull();
    expect(freebuffTimezoneProfile(null)).toBeNull();
  });
});
