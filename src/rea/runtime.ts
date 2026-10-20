import { createHash } from "node:crypto";
import { join } from "node:path";
import type { McpRuntime } from "../mcp/runtime.js";
import type { McpServerDefinition } from "../mcp/types.js";
import type { ToolResult } from "../types.js";
import { detectRea, reaMaintenance, reaRoot, runReaMaintenance } from "./install.js";
import { reaEnvironment } from "./node.js";
import type { ReaInstallation, ReaInstallOptions } from "./types.js";
import { REA_SERVER, REA_WORKFLOW } from "./workflow.js";

export const REA_ACTIONS = ["status", "install", "setup", "update", "enable", "disable", "reconnect", "guide"] as const;
export type ReaAction = typeof REA_ACTIONS[number];
const activations = new WeakMap<McpRuntime, Promise<ToolResult>>();
const result = (ok: boolean, output: string): ToolResult => ({ ok, output, exitCode: ok ? 0 : 1 });

export function reaServerDefinition(installation: ReaInstallation, root = reaRoot()): McpServerDefinition {
  const env = reaEnvironment(installation.node);
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const config = {
    transport: "stdio" as const, command: installation.node, args: [installation.entry, "mcp"],
    env: { [pathKey]: env[pathKey] ?? "", NODE_OPTIONS: "", NODE_PATH: "" },
    connectTimeoutMs: 60_000, timeoutMs: 600_000,
  };
  return {
    name: REA_SERVER, config, disabled: false, toolSelection: "all",
    source: { kind: "clai-user", path: join(root, "current.json"), rank: 0 },
    signature: createHash("sha256").update(JSON.stringify(config)).digest("hex"), secretValues: [],
  };
}

function select(runtime: McpRuntime): void {
  const { selection } = runtime.getState();
  if (selection.mode === "all") runtime.selectAll();
  else runtime.selectServers([...new Set([...(selection.mode === "servers" ? selection.serverNames : []), REA_SERVER])]);
}

async function enable(runtime: McpRuntime, reconnect: boolean, options: ReaInstallOptions): Promise<ToolResult> {
  const active = runtime.getState().snapshot.statuses.find((server) => server.name === REA_SERVER);
  if (active?.status === "ready" && !reconnect) {
    select(runtime);
    return result(true, `REA is already connected (${active.toolCount} tools). Reuse the current analysis; search relevant schemas with mcp.tools server="${REA_SERVER}".\n${REA_WORKFLOW}`);
  }
  const status = await detectRea(options.root);
  if (status.state !== "ready") {
    return result(false, status.state === "broken" ? status.reason : "REA is not installed. Use /rea install or rea.manage action=install (normal approval applies), then enable. No system npm/npx is required.");
  }
  if (reconnect && active) await runtime.stopServer(REA_SERVER);
  options.signal?.throwIfAborted();
  const state = await runtime.registerSessionServer(reaServerDefinition(status.installation, options.root));
  const server = state.snapshot.statuses.find((entry) => entry.name === REA_SERVER);
  if (server?.status !== "ready") {
    return result(false, `REA did not connect: ${server?.detail ?? server?.status ?? state.error ?? "no server reported"}. Inspect this launch error; /rea reconnect retries the connection without reinstalling or changing other agents.`);
  }
  select(runtime);
  const guide = join(status.installation.directory, "node_modules", "rea-agents", "skills", "reverse-engineer-anything", "SKILL.md");
  return result(true, `REA ${status.installation.version} connected as ${REA_SERVER} (${server.toolCount} tools). Tools are callable now via mcp.call; use mcp.tools with this server and a focused query.\n${REA_WORKFLOW}\nVersion-matched detailed guide (read only if needed): ${guide}`);
}

function activate(runtime: McpRuntime, options: ReaInstallOptions, reconnect = false): Promise<ToolResult> {
  const pending = activations.get(runtime);
  if (pending) return pending;
  const operation = enable(runtime, reconnect, options).finally(() => { activations.delete(runtime); });
  activations.set(runtime, operation);
  return operation;
}

export async function manageRea(runtime: McpRuntime, action: string, options: ReaInstallOptions = {}): Promise<ToolResult> {
  try {
    options.signal?.throwIfAborted();
    const existing = runtime.getState().snapshot.statuses.find((entry) => entry.name === REA_SERVER);
    if (["enable", "setup", "reconnect", "disable"].includes(action) && existing &&
        existing.source.path !== join(options.root ?? reaRoot(), "current.json")) {
      return result(false, `MCP server name "${REA_SERVER}" is already configured outside the managed REA integration. Rename that registration; it was not changed or stopped.`);
    }
    if (action === "status") {
      const status = await detectRea(options.root);
      const server = runtime.getState().snapshot.statuses.find((entry) => entry.name === REA_SERVER);
      const maintenance = reaMaintenance();
      const selection = runtime.getState().selection;
      const selected = server?.status === "ready" && (selection.mode === "all" || (selection.mode === "servers" && selection.serverNames.includes(REA_SERVER)));
      const installation = status.state === "ready" ? `REA ${status.installation.version} installed` : status.state === "broken" ? `REA needs repair: ${status.reason}` : "REA not installed; /rea install bootstraps it without npm/npx";
      return result(true, `${installation} · ${selected ? "enabled" : "inactive"}${server ? ` · ${server.status} (${server.toolCount} tools)${server.detail ? `: ${server.detail}` : ""}` : " · not started (lazy)"}${maintenance ? ` · ${maintenance.action} in progress` : ""}`);
    }
    if (action === "guide") {
      const status = await detectRea(options.root);
      const base = status.state === "ready" ? join(status.installation.directory, "node_modules", "rea-agents", "skills", "reverse-engineer-anything") : undefined;
      return result(true, `${REA_WORKFLOW}${base ? `\nDetailed guide: ${join(base, "SKILL.md")}\nFocused references: ${join(base, "references")} (javascript-applications.md, native-and-artifacts.md, android-applications.md, evidence-workflows.md, runtime-observation.md, connection-and-recovery.md). Read only the relevant reference.` : ""}`);
    }
    if (action === "disable") {
      if (runtime.getState().snapshot.statuses.some((server) => server.name === REA_SERVER)) await runtime.stopServer(REA_SERVER);
      return result(true, "REA disabled and its managed server stopped for this session. Other MCP servers and installed files are unchanged.");
    }
    if (action === "enable" || action === "reconnect") return await activate(runtime, options, action === "reconnect");
    if (action !== "install" && action !== "setup" && action !== "update") return result(false, `Unknown REA action. Choose: ${REA_ACTIONS.join(", ")}.`);
    const installed = await runReaMaintenance(action === "update" ? "update" : "install", options);
    if (!installed.ok) return result(false, `REA ${action} failed: ${installed.reason}. Previous installations were not replaced.`);
    if (action === "setup") return await activate(runtime, options);
    const active = runtime.getState().snapshot.statuses.some((server) => server.name === REA_SERVER && server.status === "ready");
    return result(true, `REA ${installed.installation.version} ${installed.changed ? action === "update" ? "updated" : "installed" : action === "update" ? "is already the latest" : "is already installed"}. ${active ? "Existing analysis stays on its current version; use /rea reconnect when safe to switch." : "Use /rea use or rea.manage action=enable to start it."} No other agent configuration was changed.`);
  } catch (error) {
    return result(false, `REA ${action} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
