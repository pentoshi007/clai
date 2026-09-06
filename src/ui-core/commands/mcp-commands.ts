import type { CommandInvocation } from "../../app/commands/command.js";
import {
  displayMcpConfigPath,
  projectMcpConfigPath,
  writeProjectMcpServer,
  writeUserMcpServer,
} from "../../mcp/config-file.js";
import { formatCatalog, formatStatuses, formatToolLine } from "../../mcp/format.js";
import {
  KNOWN_MCP_SERVERS,
  knownMcpServer,
  planKnownMcpInstall,
  type KnownMcpServer,
} from "../../mcp/known-servers.js";
import { formatMcpToken } from "../../mcp/mentions.js";
import { mcpSelectionLabel } from "../../mcp/runtime.js";
import { MCP_SOURCE_LABELS, type McpServerStatus } from "../../mcp/types.js";
import type { PickerOption } from "../rendering/picker-filter.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import { composerActionPort } from "../composer/composer-action-port.js";

const ADD_VALUE = "__mcp_add__";
const KNOWN_PREFIX = "__mcp_known__:";
const LOGIN_PREFIX = "__mcp_login__:";
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

function resolveConfiguredServer(
  services: AppServices,
  query: string,
): McpServerStatus | undefined {
  const snapshot = services.mcp.getState().snapshot;
  const direct = resolveServer(snapshot.statuses, query);
  if (direct) return direct;
  const needle = query.trim().toLowerCase();
  const alias = snapshot.shadowed.find(
    (entry) => entry.name.toLowerCase() === needle,
  );
  if (!alias) return undefined;
  return snapshot.statuses.find((status) => status.name === alias.shadowedByName);
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

async function addServer(
  services: AppServices,
  supplied = "",
): Promise<string | undefined> {
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
    const pendingToast = services.toast.show(
      `adding MCP server ${written.serverName}…`,
      { level: "info", sticky: true },
    );
    try {
      const state = await services.mcp.refresh({ force: true });
      const status = state.snapshot.statuses.find(
        (candidate) => candidate.name === written.serverName,
      );
      if (status?.status === "ready") selectServer(services, status);
      services.session.notice(
        status?.status === "ready" ? "info" : "warn",
        `${written.replaced ? "updated" : "added"} MCP server ${written.serverName} in ${written.displayPath}${status?.status === "ready" ? ` · use ${formatMcpToken(written.serverName)} in your prompt · ${status.toolCount} tool${status.toolCount === 1 ? "" : "s"}` : ` · ${status?.status ?? "not discovered"}${status?.detail ? ` · ${status.detail}` : ""}`}`,
      );
      return written.serverName;
    } finally {
      services.toast.dismiss(pendingToast);
    }
  }
  return undefined;
}

async function loginServer(
  services: AppServices,
  query: string,
): Promise<boolean> {
  const status = resolveConfiguredServer(services, query);
  if (!status) {
    services.session.notice(
      "warn",
      query
        ? `no unique MCP server matching "${query}"`
        : "usage: /mcp login <server>",
    );
    return false;
  }
  if (!services.mcp.canLogin(status.name)) {
    services.session.notice(
      "warn",
      `MCP server ${status.name} is not configured for OAuth login`,
    );
    return false;
  }
  services.session.notice("info", `opening OAuth sign-in for MCP server ${status.name}…`);
  const result = await services.mcp.agentLogin(status.name);
  services.session.notice(result.ok ? "info" : "warn", result.output);
  if (!result.ok) return false;
  const next = services.mcp
    .getState()
    .snapshot.statuses.find((candidate) => candidate.name === status.name);
  if (next?.status === "ready") selectServer(services, next);
  return true;
}

async function addKnownServer(
  services: AppServices,
  query: string,
): Promise<void> {
  const known = knownMcpServer(query);
  if (!known) {
    services.session.notice(
      "warn",
      `unknown catalog server "${query}" · catalog: ${KNOWN_MCP_SERVERS.map((server) => server.id).join(", ")}`,
    );
    return;
  }
  const existing = resolveConfiguredServer(services, known.id);
  if (existing) {
    services.session.notice(
      "info",
      `MCP server ${known.id} is already configured (${existing.status})`,
    );
    if (existing.status === "ready") selectServer(services, existing);
    return;
  }
  const pendingToast = services.toast.show(
    `adding ${known.title} MCP server…`,
    { level: "info", sticky: true },
  );
  try {
    await finishKnownServerAdd(services, known);
  } finally {
    services.toast.dismiss(pendingToast);
  }
}

async function finishKnownServerAdd(
  services: AppServices,
  known: KnownMcpServer,
): Promise<void> {
  const collected: Record<string, string> = {};
  for (const secret of known.secrets) {
    if (secret.optional) continue;
    if (process.env[secret.env]) continue;
    const requestSecret = services.ports.requestSecret;
    const value = requestSecret
      ? await requestSecret({
          title: `Add ${known.title} MCP server`,
          prompt: `${secret.label}${secret.hint ? ` — ${secret.hint}` : ""}`,
        })
      : await services.overlay.openTextEditor({
          title: `Add ${known.title} MCP server`,
          prompt: `${secret.label}${secret.hint ? ` — ${secret.hint}` : ""}`,
          submitLabel: "save",
        });
    if (value === undefined || value.trim() === "") {
      services.session.notice(
        "warn",
        `MCP server ${known.id} not added · ${secret.env} is required`,
      );
      return;
    }
    collected[secret.env] = value.trim();
  }
  const plan = planKnownMcpInstall(known, { secrets: collected });
  const snippet = JSON.stringify({ [known.id]: plan.entry });
  const userScope = Object.keys(collected).length > 0;
  const written = userScope
    ? await writeUserMcpServer(snippet)
    : await writeProjectMcpServer(snippet);
  if (!written.ok) {
    services.session.notice(
      "warn",
      `MCP config not changed · ${written.displayPath} · ${written.error}`,
    );
    return;
  }
  const state = await services.mcp.refresh({ force: true });
  const status = state.snapshot.statuses.find(
    (candidate) => candidate.name === written.serverName,
  );
  if (status?.status === "ready") {
    selectServer(services, status);
    services.session.notice(
      "info",
      `${written.replaced ? "updated" : "added"} ${known.title} MCP in ${written.displayPath} · ${status.toolCount} tool${status.toolCount === 1 ? "" : "s"} · use ${formatMcpToken(known.id)} in your prompt`,
    );
    return;
  }
  if (known.oauth && services.mcp.canLogin(written.serverName)) {
    services.session.notice(
      "info",
      `added ${known.title} MCP in ${written.displayPath} · signing in…`,
    );
    await loginServer(services, written.serverName);
    return;
  }
  services.session.notice(
    "warn",
    `added ${known.title} MCP in ${written.displayPath} · ${status?.status ?? "not discovered"}${status?.detail ? ` · ${status.detail}` : ""}${known.requires ? ` · requires ${known.requires}` : ""}`,
  );
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

function canSignIn(
  services: AppServices,
  status: McpServerStatus,
): boolean {
  if (!services.mcp.canLogin(status.name)) return false;
  return status.status === "error" || status.status === "degraded";
}

function serverPickerOptions(services: AppServices): PickerOption[] {
  const state = services.mcp.getState();
  return state.snapshot.statuses.map((status) => {
    const signIn = canSignIn(services, status);
    return {
      value: signIn ? `${LOGIN_PREFIX}${status.name}` : status.name,
      label: `${signIn ? "sign in" : status.status === "ready" ? "live" : status.status} · ${status.name}`,
      description: signIn
        ? `OAuth sign-in · ${statusDescription(status)}`
        : statusDescription(status),
      active:
        state.selection.mode === "servers" &&
        state.selection.serverNames.includes(status.name),
    };
  });
}

function knownPickerOptions(
  statuses: readonly McpServerStatus[],
): PickerOption[] {
  const configured = new Set(statuses.map((status) => status.name.toLowerCase()));
  return KNOWN_MCP_SERVERS.filter(
    (server) => !configured.has(server.id) && !configured.has(server.title.toLowerCase()),
  ).map((server) => ({
    value: `${KNOWN_PREFIX}${server.id}`,
    label: `+ add ${server.title}`,
    description: `${server.summary}${server.oauth ? " · OAuth sign-in" : server.secrets.length > 0 ? " · needs API key" : " · no auth needed"}`,
  }));
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
    ...knownPickerOptions(state.snapshot.statuses),
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
    ...serverPickerOptions(services),
  ];
}

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
      if (value.startsWith(KNOWN_PREFIX)) {
        void addKnownServer(services, value.slice(KNOWN_PREFIX.length));
        return;
      }
      if (value.startsWith(LOGIN_PREFIX)) {
        void loginServer(services, value.slice(LOGIN_PREFIX.length));
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
  const status = resolveConfiguredServer(services, query);
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

type McpSubcommandHandler = (
  services: AppServices,
  tail: string,
) => void | Promise<void>;

async function loginCommand(services: AppServices, tail: string): Promise<void> {
  await loginServer(services, tail);
}

async function addCommand(services: AppServices, tail: string): Promise<void> {
  if (tail && !tail.startsWith("{") && !tail.startsWith("[")) {
    const known = knownMcpServer(tail);
    if (known) {
      await addKnownServer(services, known.id);
      return;
    }
    if (!tail.includes('"')) {
      services.session.notice(
        "warn",
        `unknown catalog server "${tail}" · catalog: ${KNOWN_MCP_SERVERS.map((server) => server.id).join(", ")} · or paste a JSON server object`,
      );
      return;
    }
  }
  await addServer(services, tail);
}

function locationsCommand(services: AppServices): void {
  services.overlay.openPager(
    "MCP configuration locations",
    locationLines(services).join("\n"),
    undefined,
    undefined,
    "plain",
  );
}

function allCommand(services: AppServices): void {
  services.mcp.selectAll();
  services.session.notice("info", "MCP selection · all live servers · session only");
}

function offCommand(services: AppServices): void {
  services.mcp.selectOff();
  services.session.notice("info", "MCP tools off for this session");
}

function listCommand(services: AppServices): void {
  services.overlay.openPager(
    "MCP catalog",
    catalogText(services),
    undefined,
    undefined,
    "plain",
  );
}

function statusCommand(services: AppServices): void {
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
}

function toolsCommand(services: AppServices, tail: string): void {
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
}

async function refreshCommand(services: AppServices): Promise<void> {
  services.session.notice("info", "refreshing MCP configurations and live tools…");
  const state = await services.mcp.refresh({ force: true });
  const ready = state.snapshot.statuses.filter(
    (status) => status.status === "ready",
  ).length;
  services.session.notice(
    state.error ? "warn" : "info",
    `MCP refresh · ${ready}/${state.snapshot.statuses.length} live · ${state.activeToolCount} active tools${state.error ? ` · ${state.error}` : ""}`,
  );
}

const MCP_SUBCOMMANDS = new Map<string, McpSubcommandHandler>([
  ["login", loginCommand],
  ["auth", loginCommand],
  ["signin", loginCommand],
  ["add", addCommand],
  ["new", addCommand],
  ["locations", locationsCommand],
  ["location", locationsCommand],
  ["paths", locationsCommand],
  ["all", allCommand],
  ["auto", allCommand],
  ["on", allCommand],
  ["off", offCommand],
  ["none", offCommand],
  ["list", listCommand],
  ["catalog", listCommand],
  ["status", statusCommand],
  ["tools", toolsCommand],
  ["refresh", refreshCommand],
  ["reload", refreshCommand],
  ["reconnect", reconnect],
]);

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
  const handler = MCP_SUBCOMMANDS.get(command);
  if (handler) {
    await handler(services, tail);
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
