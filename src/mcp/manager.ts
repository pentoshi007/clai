import { discoverMcpServers } from "./discovery.js";
import { pathToFileURL } from "node:url";
import { safeCwd } from "../os/cwd.js";
import { McpClient, type McpClientOptions } from "./client.js";
import { redactSecrets } from "./format.js";
import { toToolMetadata } from "./results.js";
import { allocateWireNames, canonicalToolName, toolIdentity } from "./names.js";
import {
  awaitMcpOperation,
  McpTransportError,
  withTimeout,
  type McpTransport,
} from "./transport.js";
import { StdioTransport } from "./transport-stdio.js";
import {
  LegacySseTransport,
  StreamableHttpTransport,
  type HttpTransportOptions,
} from "./transport-http.js";
import {
  createAuthProvider,
  type AuthProviderDeps,
  type OAuthConsentInfo,
} from "./auth/provider.js";
import type { McpAuthProvider } from "./auth/types.js";
import type {
  McpDiscoveryOptions,
  McpDiscoveryResult,
  McpHttpConfig,
  McpInvalidServer,
  McpNormalizedResult,
  McpRequestOptions,
  McpServerDefinition,
  McpServerInfo,
  McpServerStatus,
  McpServerStatusKind,
  McpShadowedServer,
  McpSnapshot,
  McpToolMetadata,
  McpToolDescriptor,
} from "./types.js";

const DEFAULT_CONNECT_CONCURRENCY = 4;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

const STOPPED_DETAIL = "stopped for this session; its tools are removed from model requests";

export type McpTransportFactory = (definition: McpServerDefinition) => McpTransport;

export interface McpManagerOptions {
  readonly discovery?: McpDiscoveryOptions | undefined;
  readonly connectConcurrency?: number | undefined;
  readonly connectTimeoutMs?: number | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly transportFactory?: McpTransportFactory | undefined;
  readonly clientOptions?: McpClientOptions | undefined;
  readonly openBrowser?: ((url: string) => Promise<void>) | undefined;
  readonly requestOAuthConsent?: ((info: OAuthConsentInfo) => Promise<boolean>) | undefined;
  readonly oauthInteractive?: boolean | undefined;
  readonly onDeviceAuthorization?: AuthProviderDeps["onDeviceAuthorization"];
  readonly onAuthorizationUrl?: AuthProviderDeps["onAuthorizationUrl"];
  readonly readCallbackUrl?: AuthProviderDeps["readCallbackUrl"];
  readonly authProviderFactory?:
    | ((definition: McpServerDefinition) => McpAuthProvider | undefined)
    | undefined;
}

interface ConnectionState {
  definition: McpServerDefinition;
  client: McpClient | undefined;
  status: McpServerStatusKind;
  tools: McpToolMetadata[];
  detail: string | undefined;
  serverInfo: McpServerInfo | undefined;
  protocolVersion: string | undefined;
}

async function runBounded<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let index = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: size }, async () => {
    while (index < items.length) {
      const current = items[index++]!;
      await worker(current);
    }
  });
  await Promise.all(runners);
}

export class McpManager {
  private readonly connections = new Map<string, ConnectionState>();
  private readonly authProviders = new Map<string, McpAuthProvider>();
  private readonly authSignatures = new Map<string, string>();
  private readonly stopped = new Set<string>();
  private readonly listeners = new Set<(snapshot: McpSnapshot) => void>();
  private readonly recoveries = new Map<string, Promise<McpSnapshot>>();
  private readonly catalogRefreshes = new Set<ConnectionState>();
  private readonly dirtyCatalogs = new Set<ConnectionState>();
  private operations = Promise.resolve();
  private readonly lifetime = new AbortController();
  private closed = false;
  private discovery: McpDiscoveryResult = {
    servers: [],
    shadowed: [],
    invalid: [],
    sources: [],
    warnings: [],
  };

  constructor(private readonly options: McpManagerOptions = {}) {}

  subscribe(listener: (snapshot: McpSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    this.operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private get connectTimeoutMs(): number {
    return this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  private get requestTimeoutMs(): number {
    return this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private createTransport(definition: McpServerDefinition): McpTransport {
    const config = definition.config;
    if (config.transport === "stdio") {
      if (this.options.transportFactory) return this.options.transportFactory(definition);
      return new StdioTransport(config, {
        requestTimeoutMs: config.timeoutMs ?? this.requestTimeoutMs,
      });
    }
    const authProvider = this.buildAuthProvider(definition, config);
    if (this.options.transportFactory) return this.options.transportFactory(definition);
    const httpOptions: HttpTransportOptions = {
      requestTimeoutMs: config.timeoutMs ?? this.requestTimeoutMs,
      ...(authProvider ? { authProvider } : {}),
    };
    if (config.transport === "sse") return new LegacySseTransport(config, httpOptions);
    return new StreamableHttpTransport(config, httpOptions);
  }

  private buildAuthProvider(
    definition: McpServerDefinition,
    config: McpHttpConfig,
  ): McpAuthProvider {
    const reusable = this.authProviders.get(definition.name);
    if (reusable && this.authSignatures.get(definition.name) === definition.signature) {
      return reusable;
    }
    if (this.options.authProviderFactory) {
      const custom = this.options.authProviderFactory(definition);
      if (custom) {
        this.rememberAuthProvider(definition, custom);
        return custom;
      }
    }
    const deps: AuthProviderDeps = {
      serverUrl: config.url,
      ...(this.options.openBrowser ? { openBrowser: this.options.openBrowser } : {}),
      ...(this.options.requestOAuthConsent
        ? { requestConsent: this.options.requestOAuthConsent }
        : {}),
      ...(this.options.oauthInteractive !== undefined
        ? { interactive: this.options.oauthInteractive }
        : {}),
      ...(this.options.onDeviceAuthorization
        ? { onDeviceAuthorization: this.options.onDeviceAuthorization }
        : {}),
      ...(this.options.onAuthorizationUrl
        ? { onAuthorizationUrl: this.options.onAuthorizationUrl }
        : {}),
      ...(this.options.readCallbackUrl ? { readCallbackUrl: this.options.readCallbackUrl } : {}),
    };
    const provider = createAuthProvider(config.auth ?? { kind: "oauth" }, deps);
    this.rememberAuthProvider(definition, provider);
    return provider;
  }

  private rememberAuthProvider(definition: McpServerDefinition, provider: McpAuthProvider): void {
    this.authProviders.set(definition.name, provider);
    this.authSignatures.set(definition.name, definition.signature);
  }

  canLogin(serverName: string): boolean {
    const definition = this.findDefinition(serverName);
    if (!definition || definition.config.transport === "stdio") return false;
    const auth = definition.config.auth;
    return auth === undefined || auth.kind === "oauth";
  }

  resolveServerName(serverName: string): string | undefined {
    return this.findDefinition(serverName)?.name;
  }

  private findDefinition(serverName: string): McpServerDefinition | undefined {
    const direct =
      this.discovery.servers.find((server) => server.name === serverName) ??
      this.connections.get(serverName)?.definition;
    if (direct) return direct;
    const alias = this.discovery.shadowed.find(
      (entry) => entry.name === serverName && entry.shadowedByName !== serverName,
    );
    if (!alias) return undefined;
    return this.discovery.servers.find((server) => server.name === alias.shadowedByName);
  }

  liveSecrets(serverName: string): readonly string[] {
    return this.authProviders.get(serverName)?.liveSecrets() ?? [];
  }

  private mergedSecrets(definition: McpServerDefinition): string[] {
    return [...definition.secretValues, ...this.liveSecrets(definition.name)];
  }

  getDiscovery(): McpDiscoveryResult {
    return this.discovery;
  }

  get discoveryWorkspaceFolder(): string | undefined {
    return this.options.discovery?.workspaceFolder;
  }

  async refresh(options: { force?: boolean } = {}): Promise<McpSnapshot> {
    return this.enqueue(() => this.refreshConnections(options));
  }

  private async refreshConnections(options: { force?: boolean }): Promise<McpSnapshot> {
    if (this.closed) return this.snapshot();
    this.discovery = discoverMcpServers(this.options.discovery ?? {});
    const next = new Map<string, McpServerDefinition>();
    for (const definition of this.discovery.servers) next.set(definition.name, definition);

    for (const [name, state] of [...this.connections]) {
      if (!next.has(name)) {
        await this.disposeConnection(state);
        this.connections.delete(name);
      }
    }

    const toConnect: McpServerDefinition[] = [];
    for (const definition of this.discovery.servers) {
      const idle: McpServerStatusKind | undefined = definition.disabled
        ? "disabled"
        : this.stopped.has(definition.name)
          ? "stopped"
          : undefined;
      if (idle !== undefined) {
        const existing = this.connections.get(definition.name);
        if (existing) await this.disposeConnection(existing);
        this.setIdleConnection(definition, idle);
        continue;
      }
      const existing = this.connections.get(definition.name);
      const reusable =
        existing !== undefined &&
        existing.status === "ready" &&
        existing.definition.signature === definition.signature &&
        options.force !== true;
      if (reusable) {
        existing.definition = definition;
        continue;
      }
      if (existing) await this.disposeConnection(existing);
      this.connections.set(definition.name, {
        definition,
        client: undefined,
        status: "connecting",
        tools: [],
        detail: undefined,
        serverInfo: undefined,
        protocolVersion: undefined,
      });
      toConnect.push(definition);
    }

    await runBounded(
      toConnect,
      this.options.connectConcurrency ?? DEFAULT_CONNECT_CONCURRENCY,
      (definition) => this.connect(definition),
    );

    return this.snapshot();
  }

  forceRefresh(): Promise<McpSnapshot> {
    return this.refresh({ force: true });
  }

  private setIdleConnection(
    definition: McpServerDefinition,
    status: Extract<McpServerStatusKind, "disabled" | "stopped">,
  ): void {
    this.connections.set(definition.name, {
      definition,
      client: undefined,
      status,
      tools: [],
      detail: status === "disabled" ? "disabled by configuration" : STOPPED_DETAIL,
      serverInfo: undefined,
      protocolVersion: undefined,
    });
  }

  isStopped(serverName: string): boolean {
    return this.stopped.has(this.resolveServerName(serverName) ?? serverName);
  }

  async stop(serverName: string): Promise<McpSnapshot> {
    return this.enqueue(() => this.stopConnection(serverName));
  }

  private async stopConnection(serverName: string): Promise<McpSnapshot> {
    const definition = this.findDefinition(serverName);
    if (!definition) return this.snapshot();
    const existing = this.connections.get(definition.name);
    if (existing) await this.disposeConnection(existing);
    this.stopped.add(definition.name);
    this.setIdleConnection(definition, "stopped");
    return this.snapshot();
  }

  async reconnect(name: string): Promise<McpSnapshot> {
    return this.enqueue(() => this.reconnectConnection(name));
  }

  private async reconnectConnection(name: string): Promise<McpSnapshot> {
    if (this.closed) return this.snapshot();
    const definition = this.findDefinition(name);
    if (!definition) return this.snapshot();
    const resolved = definition.name;
    this.stopped.delete(resolved);
    const existing = this.connections.get(resolved);
    if (existing) await this.disposeConnection(existing);
    if (definition.disabled) {
      this.setIdleConnection(definition, "disabled");
      return this.snapshot();
    }
    this.connections.set(resolved, {
      definition,
      client: undefined,
      status: "connecting",
      tools: [],
      detail: undefined,
      serverInfo: undefined,
      protocolVersion: undefined,
    });
    await this.connect(definition);
    return this.snapshot();
  }

  private async connect(definition: McpServerDefinition): Promise<void> {
    const state = this.connections.get(definition.name);
    if (!state) return;
    const primaryError = await this.attemptConnect(
      definition,
      state,
      this.createTransport(definition),
    );
    if (primaryError === undefined) return;
    const fallback = this.fallbackTransportFor(definition, primaryError);
    if (!fallback) return;
    const fallbackError = await this.attemptConnect(definition, state, fallback);
    if (fallbackError !== undefined) return;
    const status =
      primaryError instanceof McpTransportError && primaryError.status !== undefined
        ? ` ${primaryError.status}`
        : "";
    const note = `primary ${definition.config.transport} transport failed with${status || " an error"}; connected via ${fallback.kind} fallback`;
    state.detail = state.detail ? `${state.detail} · ${note}` : note;
  }

  private fallbackTransportFor(
    definition: McpServerDefinition,
    error: unknown,
  ): McpTransport | undefined {
    if (this.options.transportFactory) return undefined;
    if (!(error instanceof McpTransportError)) return undefined;
    const status = error.status ?? 0;
    if (![400, 404, 405, 410, 415].includes(status)) return undefined;
    const config = definition.config;
    if (config.transport === "stdio") return undefined;
    const alternate: McpHttpConfig = {
      ...config,
      transport: config.transport === "sse" ? "http" : "sse",
    };
    const authProvider = this.buildAuthProvider(definition, config);
    const httpOptions: HttpTransportOptions = {
      requestTimeoutMs: config.timeoutMs ?? this.requestTimeoutMs,
      ...(authProvider ? { authProvider } : {}),
    };
    return alternate.transport === "sse"
      ? new LegacySseTransport(alternate, httpOptions)
      : new StreamableHttpTransport(alternate, httpOptions);
  }

  private async attemptConnect(
    definition: McpServerDefinition,
    state: ConnectionState,
    transport: McpTransport,
  ): Promise<unknown> {
    let client: McpClient | undefined;
    const timeoutMs = definition.config.connectTimeoutMs ?? this.connectTimeoutMs;
    const { signal, dispose } = withTimeout(this.lifetime.signal, timeoutMs);
    try {
      client = new McpClient(transport, {
        roots: () => [
          {
            uri: pathToFileURL(this.options.discovery?.workspaceFolder ?? safeCwd()).href,
          },
        ],
        ...this.options.clientOptions,
      });
      client.onToolsChanged(() => this.scheduleCatalogRefresh(state));
      const init = await awaitMcpOperation(
        client.initialize({
          timeoutMs,
          signal,
        }),
        signal,
      );
      state.client = client;
      state.serverInfo = init.serverInfo;
      state.protocolVersion = init.protocolVersion;
      try {
        const descriptors = await client.listTools({
          timeoutMs,
          signal,
        });
        state.tools = this.catalogTools(definition, descriptors);
        state.status = "ready";
        state.detail = undefined;
      } catch (error) {
        state.status = "degraded";
        state.tools = [];
        state.detail = describeError(error, this.mergedSecrets(definition));
      }
    } catch (error) {
      state.status = "error";
      state.tools = [];
      state.detail = describeError(error, this.mergedSecrets(definition));
      if (client) await client.close().catch(() => undefined);
      state.client = undefined;
      return error;
    } finally {
      dispose();
    }
    return undefined;
  }

  private catalogTools(
    definition: McpServerDefinition,
    descriptors: readonly McpToolDescriptor[],
  ): McpToolMetadata[] {
    const unique = new Map<string, McpToolDescriptor>();
    for (const tool of descriptors) {
      if (definition.toolSelection !== "all" && !definition.toolSelection.includes(tool.name))
        continue;
      if (!unique.has(tool.name)) unique.set(tool.name, tool);
    }
    const selected = [...unique.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    const allocated = allocateWireNames(
      selected.map((tool) => ({
        serverName: definition.name,
        toolName: tool.name,
      })),
    );
    return selected.map((tool) =>
      toToolMetadata(
        definition.name,
        tool,
        allocated.get(toolIdentity(definition.name, tool.name))!,
      ),
    );
  }

  private reconcileToolNames(): void {
    const all = [...this.connections.values()].flatMap((state) =>
      state.status === "ready"
        ? state.tools.map((tool) => ({
            serverName: tool.serverName,
            toolName: tool.toolName,
          }))
        : [],
    );
    const allocated = allocateWireNames(all);
    for (const state of this.connections.values()) {
      state.tools = state.tools.map((tool) => {
        const canonicalName = canonicalToolName(tool.serverName, tool.toolName);
        const wireName =
          allocated.get(toolIdentity(tool.serverName, tool.toolName)) ?? tool.wireName;
        return canonicalName === tool.canonicalName && wireName === tool.wireName
          ? tool
          : { ...tool, canonicalName, wireName };
      });
    }
  }

  private scheduleCatalogRefresh(state: ConnectionState): void {
    if (this.closed) return;
    if (this.catalogRefreshes.has(state)) {
      this.dirtyCatalogs.add(state);
      return;
    }
    this.catalogRefreshes.add(state);
    void this.enqueue(async () => {
      if (this.closed || this.connections.get(state.definition.name) !== state || !state.client)
        return;
      this.dirtyCatalogs.delete(state);
      try {
        const descriptors = await state.client.listTools({
          timeoutMs: state.definition.config.connectTimeoutMs ?? this.connectTimeoutMs,
          signal: this.lifetime.signal,
        });
        state.tools = this.catalogTools(state.definition, descriptors);
        state.status = "ready";
        state.detail = undefined;
      } catch (error) {
        state.detail = `Tool catalog refresh failed: ${describeError(error, this.mergedSecrets(state.definition))}`;
      }
      const snapshot = this.snapshot();
      for (const listener of this.listeners) listener(snapshot);
    })
      .catch(() => undefined)
      .finally(() => {
        this.catalogRefreshes.delete(state);
        if (
          this.dirtyCatalogs.delete(state) &&
          !this.closed &&
          this.connections.get(state.definition.name) === state
        )
          this.scheduleCatalogRefresh(state);
      });
  }

  private async disposeConnection(state: ConnectionState): Promise<void> {
    const client = state.client;
    state.client = undefined;
    if (client) await client.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    this.lifetime.abort(new McpTransportError("closed", "MCP manager closed."));
    await this.enqueue(() => this.disposeAll());
    this.listeners.clear();
  }

  private async disposeAll(): Promise<void> {
    const states = [...this.connections.values()];
    this.connections.clear();
    this.stopped.clear();
    await Promise.all(states.map((state) => this.disposeConnection(state)));
  }

  snapshot(): McpSnapshot {
    this.reconcileToolNames();
    const statuses: McpServerStatus[] = [];
    const tools: McpToolMetadata[] = [];
    const byCanonical = new Map<string, McpToolMetadata>();
    const byWire = new Map<string, McpToolMetadata>();
    const ordered = [...this.connections.values()].sort((a, b) =>
      a.definition.name.localeCompare(b.definition.name),
    );
    for (const state of ordered) {
      statuses.push(this.toStatus(state));
      if (state.status === "ready") {
        for (const tool of state.tools) {
          if (byCanonical.has(tool.canonicalName)) continue;
          byCanonical.set(tool.canonicalName, tool);
          byWire.set(tool.wireName, tool);
          tools.push(tool);
        }
      }
    }
    const snapshot: McpSnapshot = {
      createdAt: Date.now(),
      statuses: Object.freeze(statuses),
      tools: Object.freeze(tools),
      toolsByCanonicalName: byCanonical,
      toolsByWireName: byWire,
      shadowed: this.discovery.shadowed as readonly McpShadowedServer[],
      invalid: this.discovery.invalid as readonly McpInvalidServer[],
    };
    return Object.freeze(snapshot);
  }

  private toStatus(state: ConnectionState): McpServerStatus {
    const base = {
      name: state.definition.name,
      status: state.status,
      transport: state.definition.config.transport,
      source: state.definition.source,
      toolCount: state.tools.length,
      signature: state.definition.signature,
    };
    return {
      ...base,
      ...(state.detail !== undefined ? { detail: state.detail } : {}),
      ...(state.serverInfo !== undefined ? { serverInfo: state.serverInfo } : {}),
      ...(state.protocolVersion !== undefined ? { protocolVersion: state.protocolVersion } : {}),
    };
  }

  getTool(name: string): McpToolMetadata | undefined {
    this.reconcileToolNames();
    for (const state of this.connections.values()) {
      if (state.status !== "ready") continue;
      const found = state.tools.find(
        (tool) => tool.canonicalName === name || tool.wireName === name,
      );
      if (found) return found;
    }
    return undefined;
  }

  listTools(): McpToolMetadata[] {
    return this.snapshot().tools.slice();
  }

  private recoverConnection(serverName: string, client: McpClient): Promise<McpSnapshot> {
    const pending = this.recoveries.get(serverName);
    if (pending) return pending;
    if (this.connections.get(serverName)?.client !== client)
      return Promise.resolve(this.snapshot());
    const recovery = this.reconnect(serverName).then((snapshot) => {
      for (const listener of this.listeners) listener(snapshot);
      return snapshot;
    });
    this.recoveries.set(serverName, recovery);
    void recovery
      .finally(() => {
        if (this.recoveries.get(serverName) === recovery) this.recoveries.delete(serverName);
      })
      .catch(() => undefined);
    return recovery;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpRequestOptions = {},
  ): Promise<McpNormalizedResult> {
    const tool = this.getTool(name);
    if (!tool) {
      throw new McpTransportError("protocol", `Unknown MCP tool "${name}".`);
    }
    const state = this.connections.get(tool.serverName);
    if (!state || !state.client || state.status !== "ready") {
      throw new McpTransportError("closed", `MCP server "${tool.serverName}" is not ready.`);
    }
    const requestOptions = {
      ...options,
      timeoutMs: options.timeoutMs ?? state.definition.config.timeoutMs ?? this.requestTimeoutMs,
      signal: options.signal
        ? AbortSignal.any([options.signal, this.lifetime.signal])
        : this.lifetime.signal,
    };
    const deadline = Date.now() + requestOptions.timeoutMs;
    const client = state.client;
    try {
      return await client.callTool(tool.toolName, args, requestOptions);
    } catch (error) {
      if (
        this.closed ||
        this.stopped.has(tool.serverName) ||
        options.signal?.aborted ||
        !(error instanceof McpTransportError)
      )
        throw error;
      const expiredSession = error.status === 404 && client.getSessionId() !== undefined;
      const transient =
        ["closed", "network"].includes(error.kind) &&
        (error.status === undefined || error.status >= 500);
      if (!expiredSession && !transient) throw error;
      const remainingMs = deadline - Date.now();
      const recovery = this.recoverConnection(tool.serverName, client);
      if (remainingMs <= 0) throw error;
      const { signal, dispose } = withTimeout(requestOptions.signal, remainingMs);
      try {
        await awaitMcpOperation(recovery, signal);
      } finally {
        dispose();
      }
      if (!expiredSession && !tool.readOnly && !tool.idempotent) throw error;
      const current = this.connections.get(tool.serverName);
      const replacement = this.getTool(tool.canonicalName);
      if (
        !current?.client ||
        current.status !== "ready" ||
        !replacement ||
        replacement.readOnly !== tool.readOnly ||
        replacement.idempotent !== tool.idempotent ||
        replacement.destructive !== tool.destructive ||
        replacement.openWorld !== tool.openWorld ||
        JSON.stringify(replacement.inputSchema) !== JSON.stringify(tool.inputSchema)
      )
        throw error;
      if (options.signal?.aborted)
        throw new McpTransportError("cancelled", "MCP tool call cancelled during reconnect.");
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new McpTransportError("timeout", "MCP tool deadline expired during reconnect.");
      return current.client.callTool(tool.toolName, args, {
        ...requestOptions,
        timeoutMs: remaining,
      });
    }
  }

  async login(serverName: string): Promise<{ ok: boolean; detail: string }> {
    const definition = this.findDefinition(serverName);
    if (!definition) {
      return { ok: false, detail: `Unknown MCP server "${serverName}".` };
    }
    const resolved = definition.name;
    const config = definition.config;
    if (config.transport === "stdio") {
      return {
        ok: false,
        detail: `MCP server "${resolved}" is stdio and uses environment credentials, not OAuth login.`,
      };
    }
    const provider = this.authProviders.get(resolved) ?? this.buildAuthProvider(definition, config);
    try {
      const ok = await provider.onUnauthorized(undefined, {
        interactive: true,
        signal: this.lifetime.signal,
      });
      return ok
        ? { ok: true, detail: `Authenticated MCP server ${resolved}.` }
        : {
            ok: false,
            detail: `MCP server "${resolved}" does not use OAuth (or authorization was declined).`,
          };
    } catch (error) {
      return {
        ok: false,
        detail: describeError(error, this.mergedSecrets(definition)),
      };
    }
  }
}

function describeError(error: unknown, secretValues: readonly string[] = []): string {
  const text =
    error instanceof McpTransportError
      ? `${error.kind}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  return redactSecrets(text, secretValues);
}
