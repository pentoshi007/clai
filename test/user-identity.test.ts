import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("node:child_process", async (load) => ({ ...await load<typeof import("node:child_process")>(), execFileSync: fixture.command }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const uid = Object.getOwnPropertyDescriptor(process, "getuid");
const actualUser = { uid: 1001, gid: 1001, username: "operator", homedir: "/home/operator" };
vi.mock("node:fs", async (load) => {
  const actual = await load<typeof import("node:fs")>();
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => args[0] === "/etc/passwd" ? "operator:x:1001:1001::/home/operator:/bin/bash\n" : actual.readFileSync(...args) };
});

function identity(os: string, userId: number): void {
  Object.defineProperty(process, "platform", { configurable: true, value: os });
  Object.defineProperty(process, "getuid", { configurable: true, value: () => userId });
}

beforeEach(() => {
  vi.resetModules();
  fixture.command.mockReset();
  vi.stubEnv("SUDO_UID", String(actualUser.uid));
  vi.stubEnv("SUDO_USER", actualUser.username);
  vi.stubEnv("HOME", "/root");
});

afterEach(() => {
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", platform);
  if (uid) Object.defineProperty(process, "getuid", uid);
  else Reflect.deleteProperty(process, "getuid");
});

describe("invoking user storage identity", () => {
  it("uses the actual Linux account home, not sudo's root HOME", async () => {
    identity("linux", 0);
    const { getUserHome, getStorageUid } = await import("../src/os/user-identity.js");
    expect(getUserHome()).toBe(actualUser.homedir);
    expect(getStorageUid()).toBe(actualUser.uid);
  });

  it("resolves macOS home and preferences through the directory service", async () => {
    identity("darwin", 0);
    vi.stubEnv("CLAI_CONFIG_DIR", "");
    fixture.command.mockReturnValue(`NFSHomeDirectory: /Users/operator\nUniqueID: ${actualUser.uid}\nPrimaryGroupID: ${actualUser.gid}\n`);
    const { getUserHome, getConfigDirectory } = await import("../src/os/user-identity.js");
    expect(getUserHome()).toBe("/Users/operator");
    expect(getConfigDirectory()).toBe("/Users/operator/Library/Preferences/clai-nodejs");
    expect(fixture.command).toHaveBeenCalledTimes(1);
  });

  it("ignores forged sudo variables for an ordinary user and on Windows", async () => {
    identity("linux", 1111);
    const { getInvokingUser } = await import("../src/os/user-identity.js");
    expect(getInvokingUser()).toBeUndefined();
    identity("win32", 0);
    expect(getInvokingUser()).toBeUndefined();
    expect(fixture.command).not.toHaveBeenCalled();
  });

  it("preserves explicit storage roots in elevated sessions", async () => {
    identity("linux", 0);
    const root = process.env.CLAI_DATA_DIR!;
    const { getDataDir } = await import("../src/store/paths.js");
    const { runtimeMetadataPath } = await import("../src/session-runtime/paths.js");
    expect(getDataDir()).toBe(root);
    expect(runtimeMetadataPath("shared")).toContain(join(root, "runtimes"));
  });

  it("keeps fallback socket identity stable between sudo and normal launches", async () => {
    identity("linux", 0);
    vi.stubEnv("CLAI_DATA_DIR", `/tmp/${"long/".repeat(40)}`);
    const { runtimeSocketPath } = await import("../src/session-runtime/paths.js");
    const elevated = runtimeSocketPath("same-session");
    identity("linux", actualUser.uid);
    expect(runtimeSocketPath("same-session")).toBe(elevated);
  });

  it("normalizes home before configuration and provider modules initialize", async () => {
    identity("linux", 0);
    vi.stubEnv("XDG_CONFIG_HOME", "/root/.config");
    vi.stubEnv("USER", "root");
    vi.stubEnv("LOGNAME", "root");
    const { initializeUserEnvironment } = await import("../src/os/user-identity.js");
    initializeUserEnvironment();
    expect(process.env.HOME).toBe(actualUser.homedir);
    expect(process.env.XDG_CONFIG_HOME).toBeUndefined();
    expect(process.env.USER).toBe(actualUser.username);
  });
});
