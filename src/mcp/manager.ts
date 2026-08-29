import { discoverMcpServers } from "./discovery.js";
import { McpClient, type McpClientOptions } from "./client.js";
import { redactSecrets } from "./format.js";
import { toToolMetadata } from "./results.js";
import {
  allocateWireNames,
  canonicalToolName,
  toolIdentity,
} from "./names.js";
import { McpTransportError, type McpTransport } from "./transport.js";
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
} from "./types.js";

const DEFAULT_CONNECT_CONCURRENCY = 4;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

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
  private discovery: McpDiscoveryResult = {
    servers: [],
    shadowed: [],
    invalid: [],
    sources: [],
    warnings: [],
  };

  constructor(private readonly options: McpManagerOptions = {}) {}

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
      return new StdioTransport(config, { requestTimeoutMs: this.requestTimeoutMs });
    }
    const authProvider = this.buildAuthProvider(definition, config);
    if (this.options.transportFactory) return this.options.transportFactory(definition);
    const httpOptions: HttpTransportOptions = {
      requestTimeoutMs: this.requestTimeoutMs,
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
    };
    const provider = createAuthProvider(config.auth ?? { kind: "oauth" }, deps);
    this.rememberAuthProvider(definition, provider);
    return provider;
  }

  private rememberAuthProvider(
    definition: McpServerDefinition,
    provider: McpAuthProvider,
  ): void {
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

  async refresh(options: { force?: boolean } = {}): Promise<McpSnapshot> {
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
      if (definition.disabled) {
        const existing = this.connections.get(definition.name);
        if (existing) await this.disposeConnection(existing);
        this.connections.set(definition.name, {
          definition,
          client: undefined,
          status: "disabled",
          tools: [],
          detail: "disabled by configuration",
          serverInfo: undefined,
          protocolVersion: undefined,
        });
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

  async reconnect(name: string): Promise<McpSnapshot> {
    const definition = this.findDefinition(name);
    if (!definition) return this.snapshot();
    const resolved = definition.name;
    const existing = this.connections.get(resolved);
    if (existing) await this.disposeConnection(existing);
    if (definition.disabled) {
      this.connections.set(resolved, {
        definition,
        client: undefined,
        status: "disabled",
        tools: [],
        detail: "disabled by configuration",
        serverInfo: undefined,
        protocolVersion: undefined,
      });
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
    let client: McpClient | undefined;
    try {
      const transport = this.createTransport(definition);
      client = new McpClient(transport, this.options.clientOptions ?? {});
      const init = await client.initialize({ timeoutMs: this.connectTimeoutMs });
      state.client = client;
      state.serverInfo = init.serverInfo;
      state.protocolVersion = init.protocolVersion;
      try {
        const descriptors = await client.listTools({ timeoutMs: this.connectTimeoutMs });
        const selected = descriptors
          .filter(
            (descriptor) =>
              definition.toolSelection === "all" ||
              definition.toolSelection.includes(descriptor.name),
          )
          .filter(
            (descriptor, index, list) =>
              list.findIndex((candidate) => candidate.name === descriptor.name) === index,
          )
          .sort((a, b) => a.name.localeCompare(b.name));
        const allocated = allocateWireNames(
          selected.map((descriptor) => ({
            serverName: definition.name,
            toolName: descriptor.name,
          })),
        );
        state.tools = selected.map((descriptor) =>
          toToolMetadata(
            definition.name,
            descriptor,
            allocated.get(toolIdentity(definition.name, descriptor.name))!,
          ),
        );
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
    }
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
      state.tools = state.tools.map((tool) => ({
        ...tool,
        canonicalName: canonicalToolName(tool.serverName, tool.toolName),
        wireName:
          allocated.get(toolIdentity(tool.serverName, tool.toolName)) ??
          tool.wireName,
      }));
    }
  }

  private async disposeConnection(state: ConnectionState): Promise<void> {
    const client = state.client;
    state.client = undefined;
    if (client) await client.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    const states = [...this.connections.values()];
    this.connections.clear();
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
    return await state.client.callTool(tool.toolName, args, {
      timeoutMs: this.requestTimeoutMs,
      ...options,
    });
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
    const provider =
      this.authProviders.get(resolved) ?? this.buildAuthProvider(definition, config);
    try {
      const ok = await provider.onUnauthorized(undefined);
      return ok
        ? { ok: true, detail: `Authenticated MCP server ${resolved}.` }
        : {
            ok: false,
            detail: `MCP server "${resolved}" does not use OAuth (or authorization was declined).`,
          };
    } catch (error) {
      return { ok: false, detail: describeError(error, this.mergedSecrets(definition)) };
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
