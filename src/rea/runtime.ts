import { createHash } from "node:crypto";
import { join } from "node:path";
import type { McpRuntime } from "../mcp/runtime.js";
import { reaConnection, reaTools } from "./connection.js";
import type { McpServerDefinition } from "../mcp/types.js";
import type { ToolResult } from "../types.js";
import { detectRea, reaMaintenance, reaRoot, runReaMaintenance } from "./install.js";
import { reaEnvironment } from "./node.js";
import type { ReaInstallation, ReaInstallOptions, ReaStatus } from "./types.js";
import { REA_SERVER, reaWorkflowContext } from "./workflow.js";

export const REA_ACTIONS = ["status", "install", "setup", "update", "enable", "disable", "reconnect", "guide"] as const;
export type ReaAction = typeof REA_ACTIONS[number];
const activations = new WeakMap<McpRuntime, Promise<ToolResult>>();
const running = new WeakMap<McpRuntime, ReaInstallation>();
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

const UNMANAGED = `MCP server name "${REA_SERVER}" is already configured outside the managed REA integration. Rename that registration; it was not changed or stopped.`;

function unmanaged(runtime: McpRuntime, root = reaRoot()): boolean {
  const existing = runtime.getState().snapshot.statuses.find((entry) => entry.name === REA_SERVER);
  return existing !== undefined && existing.source.path !== join(root, "current.json");
}

function unavailable(status: Exclude<ReaStatus, { state: "ready" }>): string {
  return status.state === "broken"
    ? `REA needs repair: ${status.reason}. /rea setup (or rea.manage action=setup, normal approval) repairs and connects it.`
    : "REA is not installed. /rea setup (or rea.manage action=setup, normal approval) installs about 250 MB without system npm/npx and connects it; connecting returns the workflow and tool index.";
}

function select(runtime: McpRuntime): void {
  if (reaConnection(runtime).selected) return;
  const { selection } = runtime.getState();
  if (selection.mode === "all") runtime.selectAll();
  else runtime.selectServers([...new Set([...(selection.mode === "servers" ? selection.serverNames : []), REA_SERVER])]);
}

async function enable(runtime: McpRuntime, reconnect: boolean, options: ReaInstallOptions): Promise<ToolResult> {
  const active = runtime.getState().snapshot.statuses.find((server) => server.name === REA_SERVER);
  if (active?.status === "ready" && !reconnect) {
    select(runtime);
    return result(true, `REA is already connected as ${REA_SERVER} (${active.toolCount} tools); reuse the current analysis.\n${reaWorkflowContext(running.get(runtime), reaTools(runtime))}`);
  }
  const status = await detectRea(options.root);
  if (status.state !== "ready") return result(false, unavailable(status));
  if (reconnect && active) {
    await runtime.stopServer(REA_SERVER);
    running.delete(runtime);
  }
  options.signal?.throwIfAborted();
  const state = await runtime.registerSessionServer(reaServerDefinition(status.installation, options.root));
  const server = state.snapshot.statuses.find((entry) => entry.name === REA_SERVER);
  if (server?.status !== "ready") {
    return result(false, `REA did not connect: ${server?.detail ?? server?.status ?? state.error ?? "no server reported"}. Inspect this launch error; /rea reconnect retries the connection without reinstalling or changing other agents.`);
  }
  running.set(runtime, status.installation);
  select(runtime);
  return result(true, `REA ${status.installation.version} connected as ${REA_SERVER} (${server.toolCount} tools); callable now via mcp.call.\n${reaWorkflowContext(status.installation, reaTools(runtime))}`);
}

function untilAborted<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export async function reaMentionContext(runtime: McpRuntime, options: ReaInstallOptions = {}): Promise<string> {
  options.signal?.throwIfAborted();
  if (unmanaged(runtime, options.root)) return `REA WORKFLOW\n${UNMANAGED}`;
  const connected = await untilAborted(manageRea(runtime, "enable", options), options.signal);
  options.signal?.throwIfAborted();
  if (!connected.ok) return `REA WORKFLOW\n${connected.output}`;
  return reaWorkflowContext(running.get(runtime), reaTools(runtime));
}

function activate(runtime: McpRuntime, options: ReaInstallOptions, reconnect = false): Promise<ToolResult> {
  const pending = activations.get(runtime);
  if (pending && !reconnect) return pending;
  const run = (): Promise<ToolResult> => enable(runtime, reconnect, options);
  const operation = (pending ? pending.catch(() => undefined).then(run) : run()).finally(() => {
    if (activations.get(runtime) === operation) activations.delete(runtime);
  });
  activations.set(runtime, operation);
  return operation;
}

export async function manageRea(runtime: McpRuntime, action: string, options: ReaInstallOptions = {}): Promise<ToolResult> {
  try {
    options.signal?.throwIfAborted();
    if (["enable", "setup", "reconnect", "disable"].includes(action) && unmanaged(runtime, options.root)) {
      return result(false, UNMANAGED);
    }
    if (action === "status") {
      const status = await detectRea(options.root);
      const { server, selected } = reaConnection(runtime);
      const maintenance = reaMaintenance();
      const installation = status.state === "ready" ? `REA ${status.installation.version} installed` : status.state === "broken" ? `REA needs repair: ${status.reason}` : "REA not installed; /rea install bootstraps it without npm/npx";
      return result(true, `${installation} · ${selected ? "enabled" : "inactive"}${server ? ` · ${server.status} (${server.toolCount} tools)${server.detail ? `: ${server.detail}` : ""}` : " · not started (lazy)"}${maintenance ? ` · ${maintenance.action} in progress` : ""}`);
    }
    if (action === "guide") {
      if (reaConnection(runtime).server?.status === "ready") return result(true, reaWorkflowContext(running.get(runtime), reaTools(runtime)));
      const status = await detectRea(options.root);
      return result(true, `${reaWorkflowContext(status.state === "ready" ? status.installation : undefined)}\nThe REA TOOLS index is added once REA is connected: rea.manage action=enable.`);
    }
    if (action === "disable") {
      if (runtime.getState().snapshot.statuses.some((server) => server.name === REA_SERVER)) await runtime.stopServer(REA_SERVER);
      running.delete(runtime);
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
