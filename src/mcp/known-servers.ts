type JsonObject = Record<string, unknown>;

export interface KnownMcpServerSecret {
  readonly env: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly optional?: boolean | undefined;
  readonly password?: boolean | undefined;
  readonly target?: "env" | "auth.clientId" | undefined;
}

export interface KnownMcpServer {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly homepage?: string | undefined;
  readonly requires?: string | undefined;
  readonly oauth?: boolean | undefined;
  readonly secrets: readonly KnownMcpServerSecret[];
  readonly entry: JsonObject;
  readonly defaultArgs?:
    | ((context: { workspaceFolder: string }) => readonly string[])
    | undefined;
}

export interface KnownMcpInstallPlan {
  readonly server: KnownMcpServer;
  readonly entry: JsonObject;
  readonly missingSecrets: readonly KnownMcpServerSecret[];
  readonly adoptedEnvRefs: readonly string[];
}

const ENV_REF = (name: string): string => `\${env:${name}}`;

export const KNOWN_MCP_SERVERS: readonly KnownMcpServer[] = [
  {
    id: "github",
    title: "GitHub",
    summary: "Repos, issues, PRs, code search via the hosted GitHub MCP server.",
    homepage: "https://github.com/github/github-mcp-server",
    oauth: true,
    secrets: [
      {
        env: "GITHUB_OAUTH_CLIENT_ID",
        label: "GitHub OAuth App client ID (optional — enables device-code sign-in without a browser)",
        hint: "https://github.com/settings/developers",
        optional: true,
        target: "auth.clientId",
      },
    ],
    entry: {
      url: "https://api.githubcopilot.com/mcp/",
      auth: { kind: "oauth" },
    },
  },
  {
    id: "notion",
    title: "Notion",
    summary: "Search and edit Notion workspaces via the hosted Notion MCP server.",
    homepage: "https://developers.notion.com/docs/mcp",
    oauth: true,
    secrets: [],
    entry: {
      url: "https://mcp.notion.com/mcp",
      auth: { kind: "oauth" },
    },
  },
  {
    id: "context7",
    title: "Context7",
    summary: "Up-to-date library documentation for the agent.",
    homepage: "https://context7.com",
    secrets: [
      {
        env: "CONTEXT7_API_KEY",
        label: "Context7 API key (optional — raises rate limits)",
        hint: "https://context7.com/dashboard",
        optional: true,
        password: true,
      },
    ],
    entry: {
      url: "https://mcp.context7.com/mcp",
    },
  },
  {
    id: "fetch",
    title: "Fetch",
    summary: "Fetch and read web pages as markdown.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    requires: "uv (https://docs.astral.sh/uv/)",
    secrets: [],
    entry: {
      command: "uvx",
      args: ["mcp-server-fetch"],
    },
  },
  {
    id: "filesystem",
    title: "Filesystem",
    summary: "Read/write access to chosen directories.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    requires: "npx",
    secrets: [],
    entry: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
    },
    defaultArgs: ({ workspaceFolder }) => [workspaceFolder],
  },
  {
    id: "memory",
    title: "Memory",
    summary: "Persistent knowledge-graph memory between sessions.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    requires: "npx",
    secrets: [
      {
        env: "MEMORY_FILE_PATH",
        label: "Memory storage file path (optional)",
        optional: true,
      },
    ],
    entry: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
    },
  },
  {
    id: "sequential-thinking",
    title: "Sequential Thinking",
    summary: "Structured step-by-step reasoning scratchpad.",
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    requires: "npx",
    secrets: [],
    entry: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    },
  },
  {
    id: "brave-search",
    title: "Brave Search",
    summary: "Web and local search via the Brave Search API.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
    requires: "npx",
    secrets: [
      {
        env: "BRAVE_API_KEY",
        label: "Brave Search API key",
        hint: "https://brave.com/search/api/",
        password: true,
      },
    ],
    entry: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-brave-search"],
      env: { BRAVE_API_KEY: ENV_REF("BRAVE_API_KEY") },
    },
  },
  {
    id: "mongodb",
    title: "MongoDB",
    summary: "Query and manage MongoDB databases and Atlas clusters.",
    homepage: "https://github.com/mongodb-js/mongodb-mcp-server",
    requires: "npx",
    secrets: [
      {
        env: "MDB_MCP_CONNECTION_STRING",
        label: "MongoDB connection string",
        hint: "mongodb+srv://user:pass@cluster/db",
        password: true,
      },
    ],
    entry: {
      command: "npx",
      args: ["-y", "mongodb-mcp-server"],
      env: { MDB_MCP_CONNECTION_STRING: ENV_REF("MDB_MCP_CONNECTION_STRING") },
    },
  },
  {
    id: "puppeteer",
    title: "Puppeteer",
    summary: "Browser automation and screenshots.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
    requires: "npx",
    secrets: [],
    entry: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    },
  },
  {
    id: "slack",
    title: "Slack",
    summary: "Read and post Slack messages.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
    requires: "npx",
    secrets: [
      {
        env: "SLACK_BOT_TOKEN",
        label: "Slack bot token (xoxb-…)",
        password: true,
      },
      {
        env: "SLACK_TEAM_ID",
        label: "Slack team/workspace ID (T…)",
      },
    ],
    entry: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      env: {
        SLACK_BOT_TOKEN: ENV_REF("SLACK_BOT_TOKEN"),
        SLACK_TEAM_ID: ENV_REF("SLACK_TEAM_ID"),
      },
    },
  },
];

export function knownMcpServer(query: string): KnownMcpServer | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;
  const exact = KNOWN_MCP_SERVERS.find(
    (server) =>
      server.id === needle || server.title.toLowerCase() === needle,
  );
  if (exact) return exact;
  const partial = KNOWN_MCP_SERVERS.filter(
    (server) => server.id.includes(needle) || server.title.toLowerCase().includes(needle),
  );
  return partial.length === 1 ? partial[0] : undefined;
}

function withEnvValue(
  envRef: string,
  secrets: ReadonlyMap<string, string>,
): string {
  return secrets.get(envRef) ?? ENV_REF(envRef);
}

export function planKnownMcpInstall(
  server: KnownMcpServer,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>> | undefined;
    readonly secrets?: Readonly<Record<string, string>> | undefined;
    readonly workspaceFolder?: string | undefined;
  } = {},
): KnownMcpInstallPlan {
  const env = options.env ?? process.env;
  const provided = new Map(Object.entries(options.secrets ?? {}));
  const missing: KnownMcpServerSecret[] = [];
  const adopted: string[] = [];
  const literals = new Map<string, string>();

  for (const secret of server.secrets) {
    const live = env[secret.env];
    if (live !== undefined && live.length > 0) {
      adopted.push(secret.env);
      continue;
    }
    const given = provided.get(secret.env);
    if (given !== undefined && given.length > 0) {
      literals.set(secret.env, given);
      continue;
    }
    if (!secret.optional) missing.push(secret);
  }

  const entry = JSON.parse(JSON.stringify(server.entry)) as JsonObject;
  if (entry.env && typeof entry.env === "object") {
    const envBlock = { ...(entry.env as JsonObject) };
    for (const [key, value] of Object.entries(envBlock)) {
      if (typeof value === "string") envBlock[key] = withEnvValue(key, literals);
    }
    entry.env = envBlock;
  }
  for (const secret of server.secrets) {
    if (secret.target === "auth.clientId") {
      const literal = literals.get(secret.env) ?? (adopted.includes(secret.env) ? ENV_REF(secret.env) : undefined);
      if (literal) {
        const auth = { ...((entry.auth as JsonObject | undefined) ?? { kind: "oauth" }) };
        auth.clientId = literal;
        entry.auth = auth;
      }
      continue;
    }
    const literal = literals.get(secret.env);
    const adoptedRef = adopted.includes(secret.env);
    if (!literal && !adoptedRef) continue;
    const envBlock = { ...((entry.env as JsonObject | undefined) ?? {}) };
    if (!(secret.env in envBlock)) {
      envBlock[secret.env] = literal ?? ENV_REF(secret.env);
      entry.env = envBlock;
    }
  }
  if (server.defaultArgs) {
    const extra = server.defaultArgs({
      workspaceFolder: options.workspaceFolder ?? process.cwd(),
    });
    if (extra.length > 0) {
      const current = Array.isArray(entry.args) ? (entry.args as unknown[]) : [];
      entry.args = [...current, ...extra];
    }
  }
  return {
    server,
    entry,
    missingSecrets: missing,
    adoptedEnvRefs: adopted,
  };
}
