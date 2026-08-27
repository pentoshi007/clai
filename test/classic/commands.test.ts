import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { slashCommands } from "../../src/app/commands/catalog.js";
import { normalizeCommandName } from "../../src/app/commands/command.js";
import { buildDefaultCommandRegistry } from "../../src/app/commands/registry.js";
import { getConfig, updateConfig } from "../../src/store/config.js";
import type { AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { createHarness, type Harness, type HarnessOptions } from "./app/harness.js";

const SANDBOX_KEYS = [
  "CLAI_DATA_DIR",
  "CLAI_HISTORY_DIR",
  "CLAI_CONFIG_DIR",
  "CLAI_SCOPE_FILE",
  "CLAI_PLAN_FILE",
  "CLAI_DISABLE_KEYCHAIN",
] as const;

let sandbox: string;
const savedEnv = new Map<string, string | undefined>();
const cwdAtStart = process.cwd();

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "clai-classic-commands-"));
  mkdirSync(join(sandbox, "data"), { recursive: true });
  for (const key of SANDBOX_KEYS) savedEnv.set(key, process.env[key]);
  process.env.CLAI_DATA_DIR = join(sandbox, "data");
  process.env.CLAI_HISTORY_DIR = join(sandbox, "data", "history");
  process.env.CLAI_CONFIG_DIR = sandbox;
  process.env.CLAI_SCOPE_FILE = join(sandbox, "scope.json");
  process.env.CLAI_PLAN_FILE = join(sandbox, "plan.json");
  process.env.CLAI_DISABLE_KEYCHAIN = "1";
});

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.chdir(cwdAtStart);
  rmSync(sandbox, { recursive: true, force: true });
});

let harness: Harness | undefined;

function open(options: HarnessOptions = {}): Harness {
  harness = createHarness({ ...options, commands: true });
  return harness;
}

beforeEach(() => {
  updateConfig({
    disableKeychain: true,
    freeOnly: false,
    providerFallback: false,
    privateMode: false,
    permissions: "default",
  });
});

afterEach(() => {
  harness?.dispose();
  harness = undefined;
  process.chdir(cwdAtStart);
  updateConfig({
    freeOnly: false,
    providerFallback: false,
    privateMode: false,
    permissions: "default",
  });
});

async function run(
  services: AppServices,
  name: string,
  args = "",
): Promise<boolean> {
  return services.commands.dispatch({ name, args });
}

function notices(services: AppServices): readonly string[] {
  return services.toast.getToasts().map((toast) => toast.message);
}

function noticed(services: AppServices, fragment: string): boolean {
  return notices(services).some((message) => message.includes(fragment));
}

/**
 * Every entry asserts observable state after dispatch — session, config,
 * transcript, or overlay — never merely that the name resolved.
 */
const covered = new Set<string>();

function spec(
  names: readonly string[],
  title: string,
  body: () => Promise<void> | void,
): void {
  for (const name of names) covered.add(normalizeCommandName(name));
  it(title, body);
}

describe("classic command parity (W12)", () => {
  spec(["ask", "agent"], "/ask and /agent switch mode and persist the default", async () => {
    const { services } = open();
    await run(services, "ask");
    expect(services.session.getState().mode).toBe("ask");
    expect(getConfig().defaultMode).toBe("ask");
    await run(services, "agent");
    expect(services.session.getState().mode).toBe("agent");
    expect(getConfig().defaultMode).toBe("agent");
  });

  spec(["model"], "/model <name> applies the model to the session", async () => {
    const { services } = open();
    await run(services, "model", "gpt-4o-mini");
    expect(services.session.getState().model).toBe("gpt-4o-mini");
  });

  spec(["models"], "/models raises the sticky cross-provider fetch toast", async () => {
    const { services } = open();
    await run(services, "models");
    const fetching = services.toast
      .getToasts()
      .find((toast) => toast.key === "models-fetch");
    expect(fetching).toBeDefined();
    expect(fetching?.sticky).toBe(true);
    expect(fetching?.message).toContain("collecting models");
  });

  spec(["provider"], "/provider <id> switches provider", async () => {
    const { services } = open();
    expect(services.commands.resolve("use")).toBeUndefined();
    const savedKey = process.env.NVIDIA_API_KEY;
    process.env.NVIDIA_API_KEY = "nvapi-classic-commands-test";
    try {
      await run(services, "provider", "nvidia");
      await vi.waitFor(() => expect(services.session.getState().provider).toBe("nvidia"));
    } finally {
      if (savedKey === undefined) delete process.env.NVIDIA_API_KEY;
      else process.env.NVIDIA_API_KEY = savedKey;
    }
  });

  spec(["set"], "/set with no arguments opens the credential picker", async () => {
    const { services } = open();
    void run(services, "set");
    await vi.waitFor(() => expect(services.overlay.getState().kind).toBe("picker"));
  });

  spec(["unset"], "/unset with no arguments opens the credential picker", async () => {
    const { services } = open();
    void run(services, "unset");
    await vi.waitFor(() => expect(services.overlay.getState().kind).toBe("picker"));
  });

  spec(["keys"], "/keys opens the credential status pager", async () => {
    const { services } = open();
    await run(services, "keys");
    await vi.waitFor(() => expect(services.overlay.getState().kind).toBe("pager"));
    const overlay = services.overlay.getState();
    if (overlay.kind === "pager") expect(overlay.title).toBe("Credential status");
  });

  spec(["info"], "/info opens a provider info pager", async () => {
    const { services } = open();
    services.session.setProvider("nvidia");
    await run(services, "info");
    await vi.waitFor(() => expect(services.overlay.getState().kind).toBe("pager"));
    const overlay = services.overlay.getState();
    expect(overlay.kind).toBe("pager");
    if (overlay.kind === "pager") expect(overlay.title).toContain("nvidia");
  });

  spec(
    ["search", "search-provider"],
    "/search opens the search provider picker and the alias resolves",
    async () => {
      const { services } = open();
      expect(services.commands.resolve("search-provider")).toBe("search");
      await run(services, "search");
      const overlay = services.overlay.getState();
      expect(overlay.kind).toBe("picker");
      if (overlay.kind === "picker") expect(overlay.request.title).toMatch(/search/i);
    },
  );

  spec(["effort", "reasoning"], "/effort <level> writes the thinking config", async () => {
    const { services } = open();
    expect(services.commands.resolve("reasoning")).toBe("effort");
    await run(services, "reasoning", "high");
    expect(getConfig().thinking.enabled).toBe(true);
    expect(getConfig().thinking.effort).toBe("high");
    await run(services, "effort", "off");
    expect(getConfig().thinking.enabled).toBe(false);
  });

  spec(["clear"], "/clear empties the transcript and abandons the session id", async () => {
    const { services } = open();
    services.session.loadHistory([{ role: "user", content: "hi" }]);
    const id = services.session.sessionId;
    const cleared = vi.spyOn(services.plan, "clear");
    await run(services, "clear");
    expect(services.session.messages).toHaveLength(0);
    expect(services.session.sessionId).not.toBe(id);
    expect(services.session.isPlanApproved()).toBe(false);
    expect(cleared).toHaveBeenCalled();
    expect(services.transcript.getState().order).toHaveLength(0);
    expect(noticed(services, "Session cleared")).toBe(true);
  });

  spec(["new"], "/new mints a new session id", async () => {
    const { services } = open();
    const before = services.session.sessionId;
    await run(services, "new");
    expect(services.session.sessionId).not.toBe(before);
    expect(services.session.isPlanApproved()).toBe(false);
    expect(noticed(services, "Fresh session")).toBe(true);
  });

  spec(["history"], "/history opens the session picker with the live session first", async () => {
    const { services } = open();
    services.session.loadHistory([{ role: "user", content: "hi" }]);
    await run(services, "history");
    await vi.waitFor(() => expect(services.overlay.getState().kind).toBe("picker"));
    const overlay = services.overlay.getState();
    if (overlay.kind === "picker") {
      expect(overlay.request.options[0]?.value).toBe("__current__");
    }
  });

  spec(["save"], "/save reports nothing to save, then persists once there is history", async () => {
    const { services } = open();
    await run(services, "save");
    await vi.waitFor(() => expect(noticed(services, "nothing to save yet")).toBe(true));
    services.session.loadHistory([{ role: "user", content: "hi" }]);
    await run(services, "save", "named-session");
    await vi.waitFor(() =>
      expect(noticed(services, `saved session ${services.session.sessionId}`)).toBe(true),
    );
  });

  spec(["reset"], "/reset clears saved history in the sandboxed store", async () => {
    const { services } = open();
    await run(services, "reset");
    await vi.waitFor(() => expect(noticed(services, "history cleared")).toBe(true));
  });

  spec(["cwd"], "/cwd reports and changes the working directory", async () => {
    const { services } = open();
    await run(services, "cwd");
    expect(noticed(services, `cwd: ${process.cwd()}`)).toBe(true);
    await run(services, "cwd", sandbox);
    expect(process.cwd()).toContain(sandbox.replace(/^\/private/, ""));
    await run(services, "cwd", join(sandbox, "does-not-exist"));
    expect(noticed(services, "no such directory")).toBe(true);
  });

  spec(["allow", "disallow"], "/allow and /disallow manage the session allow-list", async () => {
    const { services } = open();
    await run(services, "allow", "shell.exec");
    expect(services.session.allowedTools()).toContain("shell.exec");
    await run(services, "disallow", "shell.exec");
    expect(services.session.allowedTools()).not.toContain("shell.exec");
  });

  spec(["think", "thinking"], "/think toggles global thinking expansion", async () => {
    const { services } = open();
    expect(services.commands.resolve("thinking")).toBe("think");
    await run(services, "thinking");
    expect(services.transcript.getState().expandThinkingGlobal).toBe(true);
    await run(services, "think");
    expect(services.transcript.getState().expandThinkingGlobal).toBe(false);
  });

  spec(["output"], "/output reports when no tool output exists yet", async () => {
    const { services } = open();
    await run(services, "output");
    expect(noticed(services, "no tool output yet")).toBe(true);
    expect(services.transcript.getState().expandOutputGlobal).toBe(false);
  });

  spec(["jobs"], "/jobs opens the jobs panel", async () => {
    const { services } = open();
    expect(services.commands.resolve("jobs")).toBe("jobs");
    await run(services, "jobs");
    expect(services.overlay.getState().kind).toBe("jobs");
  });

  spec(["freeonly", "fallback"], "/freeonly and /fallback toggle config", async () => {
    const { services } = open();
    await run(services, "freeonly", "on");
    expect(getConfig().freeOnly).toBe(true);
    await run(services, "fallback", "on");
    expect(getConfig().providerFallback).toBe(true);
    await run(services, "freeonly");
    expect(noticed(services, "freeOnly=true")).toBe(true);
  });

  spec(["fallback"], "/fallback with no args opens the on/off picker", async () => {
    const { services } = open();
    await run(services, "fallback");
    const overlay = services.overlay.getState();
    expect(overlay.kind).toBe("picker");
    if (overlay.kind !== "picker") return;
    const options = overlay.request.options;
    expect(options.map((o) => o.value)).toEqual(["on", "off"]);
    expect(options.find((o) => o.value === "off")?.active).toBe(true);
    overlay.onSelect("on");
    expect(getConfig().providerFallback).toBe(true);
  });

  spec(["compact"], "/compact reports when there is nothing to compact", async () => {
    const { services } = open();
    await run(services, "compact");
    await vi.waitFor(() => expect(noticed(services, "nothing to compact yet")).toBe(true));
  });

  spec(["context"], "/context reports message and token estimates", async () => {
    const { services } = open();
    services.session.loadHistory([
      { role: "user", content: "hello world" },
      { role: "assistant", content: "hi there" },
    ]);
    await run(services, "context");
    expect(notices(services).some((message) => /context: 2 messages/.test(message))).toBe(true);
  });

  spec(["plan"], "/plan enters plan mode, /plan off returns to agent, /plan view pages", async () => {
    const { services } = open();
    await run(services, "plan");
    expect(services.session.getState().mode).toBe("plan");
    expect(getConfig().defaultMode).toBe("plan");
    await run(services, "plan", "off");
    expect(services.session.getState().mode).toBe("agent");
    await run(services, "plan", "view");
    await vi.waitFor(() =>
      expect(
        services.overlay.getState().kind === "pager" ||
          notices(services).some((message) => /plan/i.test(message)),
      ).toBe(true),
    );
  });

  spec(["implement"], "/implement is inert without an approved plan", async () => {
    const { services } = open();
    await run(services, "implement");
    expect(services.plan.current()).toBeUndefined();
    expect(services.session.isPlanApproved()).toBe(false);
    expect(services.session.getState().mode).toBe("agent");
  });

  spec(["discard"], "/discard reports when there is no active plan", async () => {
    const { services } = open();
    await run(services, "discard");
    await vi.waitFor(() => expect(noticed(services, "no active plan to discard")).toBe(true));
  });

  spec(["scope"], "/scope opens the scope editor and /scope clear disables scoping", async () => {
    const { services } = open();
    void run(services, "scope");
    await vi.waitFor(() => expect(services.overlay.getState().kind).toBe("scope-editor"));
    services.overlay.close();
    await run(services, "scope", "clear");
    await vi.waitFor(() => expect(noticed(services, "engagement scope cleared")).toBe(true));
  });

  spec(["privacy"], "/privacy on|status|off drives private mode", async () => {
    const { services } = open();
    await run(services, "privacy", "on");
    await vi.waitFor(() => expect(getConfig().privateMode).toBe(true));
    await run(services, "privacy", "status");
    await vi.waitFor(() => expect(noticed(services, "private mode: on")).toBe(true));
    await run(services, "privacy", "off");
    await vi.waitFor(() => expect(getConfig().privateMode).toBe(false));
  });

  spec(["permissions"], "/permissions sets the mode directly and offers a picker", async () => {
    const { services } = open();
    await run(services, "permissions", "allow-all");
    expect(getConfig().permissions).toBe("allow-all");
    await run(services, "permissions");
    const overlay = services.overlay.getState();
    expect(overlay.kind).toBe("picker");
    if (overlay.kind === "picker") expect(overlay.request.title).toBe("Permissions");
  });

  spec(["update"], "/update reports the result of the updates port", async () => {
    const { services } = open();
    await run(services, "update");
    await vi.waitFor(() => expect(notices(services).length).toBeGreaterThan(0));
  });

  spec(["exit", "quit"], "/exit and its /quit alias request a clean shutdown", async () => {
    const requestExit = vi.fn();
    const { services } = open({ requestExit });
    expect(services.commands.resolve("quit")).toBe("exit");
    await run(services, "quit");
    expect(requestExit).toHaveBeenCalledOnce();
  });

  spec(["help"], "/help opens the pager with generated command reference", async () => {
    const { services } = open();
    await run(services, "help");
    const overlay = services.overlay.getState();
    expect(overlay.kind).toBe("pager");
    if (overlay.kind === "pager") {
      expect(overlay.title).toContain("Command");
      expect(overlay.body).toContain("/model");
      expect(overlay.body).toContain("/jobs");
      expect(overlay.body).toContain("## Extensions");
      expect(overlay.body).toContain("/mcp");
      expect(overlay.body).toContain(".clai/mcp.json");
      expect(overlay.body).toContain("off by default");
    }
  });

  spec(["shortcuts"], "/shortcuts opens the pager with generated key reference", async () => {
    const { services } = open();
    await run(services, "shortcuts");
    const overlay = services.overlay.getState();
    expect(overlay.kind).toBe("pager");
    if (overlay.kind === "pager") {
      expect(overlay.title).toBe("Keyboard shortcuts");
      expect(overlay.body.length).toBeGreaterThan(0);
    }
  });

  spec(["skills"], "/skills opens the skill picker, or explains where skills live", async () => {
    const { services } = open();
    await run(services, "skills");
    await vi.waitFor(() => {
      const overlay = services.overlay.getState();
      if (overlay.kind === "picker") {
        expect(overlay.request.title).toContain("Skills");
        return;
      }
      expect(notices(services).some((text) => /skill/i.test(text))).toBe(true);
    });
  });

  spec(["mcp"], "/mcp opens the shared server picker with project configuration actions", async () => {
    const { services } = open();
    void run(services, "mcp");
    await vi.waitFor(() => expect(services.overlay.getState().kind).toBe("picker"));
    const overlay = services.overlay.getState();
    if (overlay.kind === "picker") {
      expect(overlay.request.title).toContain(".clai/mcp.json");
      expect(overlay.request.options.map((option) => option.label)).toEqual(
        expect.arrayContaining(["+ add MCP server", "MCP tools off"]),
      );
    }
  });

  spec(["usage"], "/usage opens the formatted pager with the session token ledger", async () => {
    const { services } = open();
    await run(services, "usage");
    const overlay = services.overlay.getState();
    expect(overlay.kind).toBe("pager");
    if (overlay.kind === "pager") {
      expect(overlay.title).toContain("usage");
      expect(overlay.markdown).toBe("force");
      expect(overlay.body).toContain("# Session usage");
    }
  });

  it("exercises every catalogue command, aliases included", () => {
    const registry = buildDefaultCommandRegistry();
    const missing = slashCommands
      .map((entry) => normalizeCommandName(entry.command))
      .filter((name) => !covered.has(name));
    expect(missing).toEqual([]);
    for (const name of covered) expect(registry.has(name)).toBe(true);
  });
});
