import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ command: vi.fn(), loginuid: undefined as string | undefined, tty: undefined as number | undefined }));
vi.mock("node:tty", async (load) => ({ ...await load<typeof import("node:tty")>(), isatty: (fd: number) => fixture.tty !== undefined && fd === 0 }));
vi.mock("node:child_process", async (load) => ({ ...await load<typeof import("node:child_process")>(), execFileSync: fixture.command }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const uid = Object.getOwnPropertyDescriptor(process, "getuid");
const actualUser = { uid: 1001, gid: 1001, username: "operator", homedir: "/home/operator" };
vi.mock("node:fs", async (load) => {
  const actual = await load<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (args[0] === "/etc/passwd") return "root:x:0:0::/root:/bin/sh\noperator:x:1001:1001::/home/operator:/bin/bash\n";
      if (args[0] === "/proc/self/loginuid") {
        if (fixture.loginuid === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return fixture.loginuid;
      }
      return actual.readFileSync(...args);
    },
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => fixture.tty !== undefined && args[0] === 0 ? { uid: fixture.tty } as never : actual.fstatSync(...args),
  };
});

function identity(os: string, userId: number): void {
  Object.defineProperty(process, "platform", { configurable: true, value: os });
  Object.defineProperty(process, "getuid", { configurable: true, value: () => userId });
}

beforeEach(() => {
  vi.resetModules();
  fixture.command.mockReset();
  fixture.loginuid = undefined;
  fixture.tty = undefined;
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

  it("maps pkexec and doas elevation to the invoking account", async () => {
    identity("linux", 0);
    vi.stubEnv("SUDO_UID", "");
    vi.stubEnv("PKEXEC_UID", String(actualUser.uid));
    let module = await import("../src/os/user-identity.js");
    expect(module.getUserHome()).toBe(actualUser.homedir);
    vi.resetModules();
    vi.stubEnv("PKEXEC_UID", "");
    vi.stubEnv("DOAS_USER", actualUser.username);
    module = await import("../src/os/user-identity.js");
    expect(module.getInvokingUser()).toMatchObject({ uid: actualUser.uid, username: actualUser.username });
    vi.resetModules();
    vi.stubEnv("DOAS_USER", "missing-user");
    module = await import("../src/os/user-identity.js");
    fixture.command.mockReturnValue("");
    expect(() => module.getInvokingUser()).toThrow(/refusing to create a separate root history store/);
  });

  it("maps su sessions through the Linux login uid and falls back to the terminal owner", async () => {
    identity("linux", 0);
    vi.stubEnv("SUDO_UID", "");
    fixture.loginuid = String(actualUser.uid);
    let module = await import("../src/os/user-identity.js");
    expect(module.getStorageUid()).toBe(actualUser.uid);
    vi.resetModules();
    fixture.loginuid = "4294967295";
    fixture.tty = actualUser.uid;
    module = await import("../src/os/user-identity.js");
    expect(module.getUserHome()).toBe(actualUser.homedir);
  });

  it("keeps a genuine root login on root storage without failing", async () => {
    identity("linux", 0);
    vi.stubEnv("SUDO_UID", "");
    fixture.loginuid = "0";
    fixture.tty = 0;
    let module = await import("../src/os/user-identity.js");
    expect(module.getInvokingUser()).toBeUndefined();
    vi.resetModules();
    fixture.loginuid = "4242";
    fixture.command.mockReturnValue("");
    module = await import("../src/os/user-identity.js");
    expect(module.getInvokingUser()).toBeUndefined();
  });

  it("resolves a macOS sudo user from the uid when SUDO_USER is missing", async () => {
    identity("darwin", 0);
    vi.stubEnv("SUDO_USER", "");
    fixture.command.mockImplementation((_file: string, args: string[]) => args[1] === "-search"
      ? `operator\t\tUniqueID = (\n    ${actualUser.uid}\n)\n`
      : `NFSHomeDirectory: /Users/operator\nUniqueID: ${actualUser.uid}\nPrimaryGroupID: ${actualUser.gid}\n`);
    const { getUserHome } = await import("../src/os/user-identity.js");
    expect(getUserHome()).toBe("/Users/operator");
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
