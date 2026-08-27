import type { CommandInvocation } from "../../app/commands/command.js";
import {
  displayMcpConfigPath,
  projectMcpConfigPath,
  writeProjectMcpServer,
} from "../../mcp/config-file.js";
import { formatCatalog, formatStatuses, formatToolLine } from "../../mcp/format.js";
import { formatMcpToken } from "../../mcp/mentions.js";
import { mcpSelectionLabel } from "../../mcp/runtime.js";
import { MCP_SOURCE_LABELS, type McpServerStatus } from "../../mcp/types.js";
import type { PickerOption } from "../rendering/picker-filter.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import { composerActionPort } from "../composer/composer-action-port.js";

const ADD_VALUE = "__mcp_add__";
const ALL_VALUE = "__mcp_all__";
const OFF_VALUE = "__mcp_off__";

function selectionText(services: AppServices): string {
  return mcpSelectionLabel(services.mcp.getState().selection);
}

function statusDescription(status: McpServerStatus): string {
  const source = MCP_SOURCE_LABELS[status.source.kind];
  const detail = status.detail ? ` · ${status.detail}` : "";
  return `${status.status} · ${status.transport} · ${status.toolCount} tool${status.toolCount === 1 ? "" : "s"} · ${source} (${status.source.kind}) · ${status.source.path}${detail}`;
}

function resolveServer(
  statuses: readonly McpServerStatus[],
  query: string,
): McpServerStatus | undefined {
  const needle = query.trim().toLowerCase();
  const exact = statuses.find((status) => status.name.toLowerCase() === needle);
  if (exact) return exact;
  const partial = statuses.filter((status) =>
    status.name.toLowerCase().includes(needle),
  );
  return partial.length === 1 ? partial[0] : undefined;
}

function selectServer(services: AppServices, status: McpServerStatus): void {
  if (status.status !== "ready") {
    services.session.notice(
      "warn",
      `MCP server ${status.name} is ${status.status}${status.detail ? ` · ${status.detail}` : ""} · use /mcp reconnect ${status.name}`,
    );
    return;
  }
  const token = formatMcpToken(status.name);
  if (composerActionPort.insert(`${token} `)) {
    services.focus.focusRegion("composer");
    return;
  }
  services.mcp.selectServer(status.name);
  services.session.notice(
    "info",
    `type ${token} in your prompt to use this server · ${status.toolCount} live tool${status.toolCount === 1 ? "" : "s"}`,
  );
}

function locationLines(services: AppServices): string[] {
  const target = projectMcpConfigPath();
  const paths = new Set<string>([
    ...services.mcp.getState().snapshot.statuses.map((status) => status.source.path),
    ...services.mcp.getState().snapshot.invalid.map((entry) => entry.source.path),
  ]);
  paths.delete(target);
  return [
    `Project config: ${displayMcpConfigPath(target)}`,
    ...[...paths].sort().map((path) => `Inherited config: ${path}`),
  ];
}

const ADD_TEMPLATE = `{
  "docs": {
    "command": "docs-server",
    "args": []
  }
}`;

async function addServer(services: AppServices, supplied = ""): Promise<void> {
  const target = projectMcpConfigPath();
  const displayPath = displayMcpConfigPath(target);
  let draft = supplied.trim();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!draft) {
      const input = await services.overlay.openTextEditor({
        title: "Add MCP server",
        prompt: `Paste one server JSON object for ${displayPath} — a named object, or a one-entry {"servers":{…}} fragment.`,
        placeholder: ADD_TEMPLATE,
        submitLabel: "add server",
        ...(attempt > 0 ? { initialValue: draft } : {}),
      });
      if (input === undefined || input.trim() === "") return;
      draft = input;
    }
    const written = await writeProjectMcpServer(draft);
    if (!written.ok) {
      services.session.notice(
        "warn",
        `MCP config not changed · ${written.displayPath} · ${written.error}`,
      );
      // Reopen with the text intact so a long paste is never retyped.
      const retry = await services.overlay.openTextEditor({
        title: "Add MCP server · fix and retry",
        prompt: `${written.error}`,
        initialValue: draft,
        placeholder: ADD_TEMPLATE,
        submitLabel: "add server",
      });
      if (retry === undefined || retry.trim() === "") return;
      draft = retry;
      continue;
    }
    const state = await services.mcp.refresh({ force: true });
    const status = state.snapshot.statuses.find(
      (candidate) => candidate.name === written.serverName,
    );
    if (status?.status === "ready") selectServer(services, status);
    services.session.notice(
      status?.status === "ready" ? "info" : "warn",
      `${written.replaced ? "updated" : "added"} MCP server ${written.serverName} in ${written.displayPath}${status?.status === "ready" ? ` · use ${formatMcpToken(written.serverName)} in your prompt · ${status.toolCount} tool${status.toolCount === 1 ? "" : "s"}` : ` · ${status?.status ?? "not discovered"}${status?.detail ? ` · ${status.detail}` : ""}`}`,
    );
    return;
  }
}

function pickerTitle(services: AppServices): string {
  const state = services.mcp.getState();
  const statuses = state.snapshot.statuses;
  const ready = statuses.filter((status) => status.status === "ready").length;
  const target = displayMcpConfigPath(projectMcpConfigPath());
  const progress = state.refreshing
    ? " · connecting…"
    : state.snapshot.createdAt === 0
      ? " · discovering…"
      : "";
  return `MCP · ${target} · ${ready}/${statuses.length} live · ${state.activeToolCount} active tools${progress}`;
}

function pickerOptions(services: AppServices): PickerOption[] {
  const state = services.mcp.getState();
  const target = displayMcpConfigPath(projectMcpConfigPath());
  return [
    {
      value: ADD_VALUE,
      label: "+ add MCP server",
      description: `paste one JSON server object · merge into ${target}`,
    },
    {
      value: OFF_VALUE,
      label: "MCP tools off",
      description: "default · hide MCP tools from agent requests for this session",
      active: state.selection.mode === "off",
    },
    {
      value: ALL_VALUE,
      label: "all live servers",
      description: "expose every ready MCP tool for this session",
      active: state.selection.mode === "all",
    },
    ...state.snapshot.statuses.map((status) => ({
      value: status.name,
      label: `${status.status === "ready" ? "live" : status.status} · ${status.name}`,
      description: statusDescription(status),
      active:
        state.selection.mode === "servers" &&
        state.selection.serverNames.includes(status.name),
    })),
  ];
}

/**
 * Opens immediately from the current snapshot: a remote server can take up to
 * the 30s connect timeout, and blocking the picker on that looked like a hang.
 * Rows and title are replaced in place once discovery settles.
 */
function openPicker(services: AppServices): void {
  services.overlay.openPicker(
    {
      title: pickerTitle(services),
      searchDescription: true,
      twoLine: true,
      options: pickerOptions(services),
    },
    (value) => {
      const statuses = services.mcp.getState().snapshot.statuses;
      services.overlay.close();
      if (value === ADD_VALUE) {
        void addServer(services);
        return;
      }
      if (value === ALL_VALUE) {
        services.mcp.selectAll();
        services.session.notice("info", "MCP selection · all live servers · session only");
        return;
      }
      if (value === OFF_VALUE) {
        services.mcp.selectOff();
        services.session.notice("info", "MCP tools off for this session");
        return;
      }
      const status = statuses.find((candidate) => candidate.name === value);
      if (status) selectServer(services, status);
    },
  );
}

function refreshOpenPicker(services: AppServices): void {
  if (services.overlay.getState().kind !== "picker") return;
  services.overlay.replacePickerOptions(
    pickerOptions(services),
    pickerTitle(services),
  );
}

function catalogText(services: AppServices): string {
  const state = services.mcp.getState();
  const discovery = state.snapshot;
  const warnings = services.mcp
    .getState()
    .snapshot.statuses.filter((status) => status.detail)
    .map((status) => `  ${status.name}: ${status.detail}`);
  return [
    ...locationLines(services),
    "",
    `Selection: ${selectionText(services)} · active tools: ${state.activeToolCount} · catalog: ${state.catalogSignature}`,
    state.refreshing ? "Refresh: in progress" : "Refresh: idle",
    state.error ? `Runtime warning: ${state.error}` : "",
    "",
    formatCatalog(discovery),
    ...(warnings.length > 0 ? ["", "Server details:", ...warnings] : []),
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n")
    .trim();
}

function toolText(services: AppServices, serverName?: string): string {
  const tools = services.mcp
    .getState()
    .snapshot.tools.filter((tool) => !serverName || tool.serverName === serverName);
  if (tools.length === 0) {
    return serverName
      ? `No live tools are available from MCP server ${serverName}.`
      : "No live MCP tools are available.";
  }
  return tools.map(formatToolLine).join("\n");
}

async function reconnect(
  services: AppServices,
  query: string,
): Promise<void> {
  const statuses = services.mcp.getState().snapshot.statuses;
  const status = resolveServer(statuses, query);
  if (!status) {
    services.session.notice(
      "warn",
      query
        ? `no unique MCP server matching "${query}"`
        : "usage: /mcp reconnect <server>",
    );
    return;
  }
  services.session.notice("info", `reconnecting MCP server ${status.name}…`);
  const state = await services.mcp.reconnect(status.name);
  const next = state.snapshot.statuses.find((candidate) => candidate.name === status.name);
  if (next?.status === "ready") {
    services.session.notice(
      "info",
      `MCP server ${status.name} live · ${next.toolCount} tool${next.toolCount === 1 ? "" : "s"}`,
    );
  } else {
    services.session.notice(
      "warn",
      `MCP server ${status.name} ${next?.status ?? "unavailable"}${next?.detail ? ` · ${next.detail}` : ""}`,
    );
  }
}

export async function handleMcp(
  services: AppServices,
  invocation: CommandInvocation,
): Promise<void> {
  const args = invocation.args.trim();
  const [rawCommand = "", ...rest] = args.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const tail = rest.join(" ").trim();

  if (!command) {
    openPicker(services);
    await services.mcp.ensureReady();
    refreshOpenPicker(services);
    return;
  }
  await services.mcp.ensureReady();
  if (command === "add" || command === "new") {
    await addServer(services, tail);
    return;
  }
  if (command === "locations" || command === "location" || command === "paths") {
    services.overlay.openPager(
      "MCP configuration locations",
      locationLines(services).join("\n"),
      undefined,
      undefined,
      "plain",
    );
    return;
  }
  if (command === "all" || command === "auto" || command === "on") {
    services.mcp.selectAll();
    services.session.notice("info", "MCP selection · all live servers · session only");
    return;
  }
  if (command === "off" || command === "none") {
    services.mcp.selectOff();
    services.session.notice("info", "MCP tools off for this session");
    return;
  }
  if (command === "list" || command === "catalog") {
    services.overlay.openPager("MCP catalog", catalogText(services), undefined, undefined, "plain");
    return;
  }
  if (command === "status") {
    const state = services.mcp.getState();
    services.overlay.openPager(
      "MCP status",
      [
        ...locationLines(services),
        "",
        `Selection: ${selectionText(services)} · ${state.activeToolCount} active tools`,
        "",
        formatStatuses(state.snapshot.statuses),
        ...(state.snapshot.invalid.length > 0
          ? [
              "",
              "Invalid configurations:",
              ...state.snapshot.invalid.map(
                (entry) =>
                  `  ${entry.name} · ${entry.source.path} · ${entry.errors.join("; ")}`,
              ),
            ]
          : []),
      ].join("\n"),
      undefined,
      undefined,
      "plain",
    );
    return;
  }
  if (command === "tools") {
    const server = tail
      ? resolveServer(services.mcp.getState().snapshot.statuses, tail)
      : undefined;
    if (tail && !server) {
      services.session.notice("warn", `no unique MCP server matching "${tail}"`);
      return;
    }
    services.overlay.openPager(
      server ? `MCP tools · ${server.name}` : "MCP tools",
      toolText(services, server?.name),
      undefined,
      undefined,
      "plain",
    );
    return;
  }
  if (command === "refresh" || command === "reload") {
    services.session.notice("info", "refreshing MCP configurations and live tools…");
    const state = await services.mcp.refresh({ force: true });
    const ready = state.snapshot.statuses.filter((status) => status.status === "ready").length;
    services.session.notice(
      state.error ? "warn" : "info",
      `MCP refresh · ${ready}/${state.snapshot.statuses.length} live · ${state.activeToolCount} active tools${state.error ? ` · ${state.error}` : ""}`,
    );
    return;
  }
  if (command === "reconnect") {
    await reconnect(services, tail);
    return;
  }

  const status = resolveServer(services.mcp.getState().snapshot.statuses, args);
  if (!status) {
    services.session.notice(
      "warn",
      `no unique MCP server matching "${args}" · use /mcp to browse or /mcp list for details`,
    );
    return;
  }
  selectServer(services, status);
}
