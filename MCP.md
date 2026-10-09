# MCP servers in clai

MCP connects clai to tools supplied by local programs and remote services. Both Classic and OpenTUI share the same connections, tool selection, confirmation rules, and sign-in flows. Connecting a server discovers its tools; selecting it makes those tools available to the current conversation.

## Quick setup

Open `/mcp` and choose a server from the catalog, or choose **add MCP server** and paste one named JSON server definition. Catalog entries prompt for required keys or start sign-in when needed. Custom definitions are merged into the project's `.clai/mcp.json`, preserving existing servers. Catalog entries with keys entered during setup are saved in user configuration rather than the project file.

Activate a configured server in a prompt:

```text
@mcp:docs Find the API documentation for this project.
```

Use `/mcp all` to enable all ready servers, or `/mcp off` to hide MCP tools. Read-only tools are available in ask mode. Tools that change external state follow the usual confirmation policy in agent mode.

| Command | Purpose |
| --- | --- |
| `/mcp` | Open the server picker, including setup and sign-in actions. |
| `/mcp add` | Paste one server's JSON configuration. |
| `/mcp add <catalog-name>` | Set up a server from the built-in catalog. |
| `/mcp list` | Inspect discovered servers, their sources, and connection details. |
| `/mcp status` | Show the current selection and connection status. |
| `/mcp tools [server]` | Browse available tools in the UI. |
| `/mcp login <server>` | Start OAuth sign-in explicitly. |
| `/mcp reconnect <server>` | Reconnect one server and load its current tools. |
| `/mcp stop <server>` | Stop a connection for this session and remove its tools from requests. |
| `/mcp start <server>` | Reconnect a stopped server. |
| `/mcp refresh` | Reload configuration and reconnect configured servers. |

## Transports and credentials

### Local programs

Stdio servers run as child processes, exchanging MCP messages over stdin and stdout. Install the server's required runtime or executable first. Arguments are passed separately, with no shell interpolation.

```json
{
  "servers": {
    "docs": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "your-mcp-server", "--root", "${workspaceFolder}"],
      "env": {
        "SERVICE_API_KEY": "${env:SERVICE_API_KEY}"
      },
      "connectTimeoutMs": 30000,
      "timeoutMs": 60000
    }
  }
}
```

Commands such as `npx` and `uvx` resolve through the process environment, including Windows command shims. Set `cwd` when a server needs a particular working directory. Environment credentials stay in the server process and are redacted from supported configuration displays.

### Remote services with API keys

Streamable HTTP is the default for a URL. Use `auth.kind: "bearer"` for a bearer token, or `auth.kind: "header"` for a service-specific key header:

```json
{
  "servers": {
    "tickets": {
      "url": "https://service.example.com/mcp",
      "auth": {
        "kind": "bearer",
        "token": "${env:SERVICE_TOKEN}"
      }
    },
    "search": {
      "url": "https://search.example.com/mcp",
      "auth": {
        "kind": "header",
        "headers": {
          "X-API-Key": "${env:SEARCH_API_KEY}"
        }
      }
    }
  }
}
```

Top-level `headers` are also accepted. Use `auth.kind: "none"` to disable OAuth discovery for a public service. For a legacy HTTP+SSE endpoint, set `type: "sse"`. clai can try the alternate HTTP/SSE transport when the endpoint rejects the initial transport with a compatibility status.

### OAuth sign-in

A remote server without an explicit auth block uses OAuth discovery when authentication is required. Connection startup and tool calls can reuse or refresh stored credentials, but do not launch a fresh interactive sign-in. Choose the sign-in row in `/mcp`, run `/mcp login <server>`, or complete a catalog server's setup to authorize access.

On a desktop, clai can open the authorization page and receive its local callback automatically. The sign-in dialog also shows the URL and accepts a complete callback URL, so browser launching is optional.

Over SSH or on a machine without a browser:

1. Start `/mcp login <server>` and open the displayed link on your phone or computer.
2. Complete sign-in. If the final localhost page cannot load, copy its full URL from the browser's address bar.
3. Paste that URL into clai's sign-in dialog, including `code` and `state`. clai verifies that it belongs to the pending request and exchanges the code using PKCE.

When the authorization server advertises device-code sign-in, clai shows a verification URL and a user code instead. Open the URL on any device, approve access, and clai completes sign-in automatically. The server must supply this flow; it cannot be synthesized for servers that only offer browser redirects.

Some services require a registered OAuth client rather than dynamic registration:

```json
{
  "servers": {
    "workspace": {
      "url": "https://service.example.com/mcp",
      "auth": {
        "kind": "oauth",
        "clientId": "${env:MCP_CLIENT_ID}",
        "clientSecret": "${env:MCP_CLIENT_SECRET}",
        "scopes": ["read", "write"],
        "callbackPort": 8765,
        "tokenEndpointAuthMethod": "client_secret_basic"
      }
    }
  }
}
```

Use the service's registered redirect URI `http://127.0.0.1:8765/callback` with this example. Omit `clientSecret` for a public client. Supported token endpoint methods are `none`, `client_secret_basic`, and `client_secret_post`; clai also uses the authorization server's advertised method when possible. `authorizationServer` and `resource` can be set when the service requires explicit discovery or audience settings.

OAuth credentials are scoped by resource, authorization server, and configured client identity. Expanding requested scopes requires authorization for the new grant. Refreshes are coordinated across terminals so rotating refresh tokens are consumed once. Credentials are retained in restricted local files under `~/.clai/mcp-oauth/` and mirrored to the OS keyring when available. Existing `mcp-oauth.json` credentials remain readable and are migrated as used. These local files contain plaintext secrets; POSIX permissions are `0600` for files and `0700` for directories.

## Configuration compatibility

clai reads JSON and JSONC configuration. It accepts `servers`, `mcpServers`, a bare server map, and OpenCode-style `mcp` maps. A pasted definition may also use a top-level `name` alongside its server fields.

| Compatible field | clai behavior |
| --- | --- |
| `type: "local"` | Stdio transport. |
| `type: "remote"` or `"streamable-http"` | Streamable HTTP transport. |
| `command: ["npx", "-y", "server"]` | First entry is the executable; remaining entries are arguments. |
| `environment` | Alias for a stdio server's `env`. |
| `enabled: false` | Disable the server; `disabled: true` is also accepted. |
| `timeout` | Alias for `timeoutMs`, in milliseconds. |
| `oauth: false` | Disable OAuth discovery. |
| `oauth: {"clientId": "…", "scope": "read"}` | Compatible OAuth configuration; native `auth` takes precedence. |

`tools` can restrict a server to an array of tool names. `${env:NAME}` and `${workspaceFolder}` are resolved before connecting; missing variables appear as configuration errors in `/mcp list`.

Configuration is discovered in this precedence order:

1. Files listed by `CLAI_MCP_CONFIG`, separated by the OS path delimiter (`:` on POSIX, `;` on Windows).
2. Project `.clai/mcp.json`, `.mcp.json`, repository `.github/mcp.json`, and `.vscode/mcp.json`.
3. User clai configuration, then supported Copilot, Claude, and VS Code user configurations.

Within the same source category, the nearest project directory wins. Duplicate names and equivalent server connections are shown as shadowed entries. To reuse another tool's configuration explicitly, point `CLAI_MCP_CONFIG` at that file; clai does not rewrite the source merely by reading it.

## Context use and caching

Native provider requests use a fixed MCP control interface. Selecting a server or updating its catalog keeps that interface stable; the current selection and catalog are supplied through conversation context. Each turn retains the catalog it started with, while server notifications update the catalog for subsequent turns.

Small catalogs include compact descriptions and schemas. When the catalog exceeds its inline budget, clai defers schemas to `mcp.tools`, which searches names and descriptions and returns bounded pages. The agent can narrow a query to one server, follow a cursor, and call any selected tool through `mcp.call`. A cursor is invalidated when its catalog or query changes, so paging cannot silently skip tools.

Schema constraints, references, alternatives, and definitions are retained. Long descriptions are shortened for model context. Large tool results and oversized catalog pages use output artifacts, allowing the agent to read further detail while keeping the full output available to the transcript and UI. Structured results, images, and resource links are preserved through the MCP result path.

MCP servers must be trusted before their tools are used. Their descriptions and results are treated as external data, and mutation confirmations apply to the actual target tool. An in-flight call is rejected if its schema or safety annotations change underneath the retained catalog.

## Troubleshooting

| Symptom | Action or behavior |
| --- | --- |
| Server is invalid | Check `/mcp list` for missing environment variables, malformed fields, or the winning config source. |
| Executable cannot start | Install its runtime, check `PATH` and `cwd`, then use `/mcp reconnect <server>`. |
| First connection is slow | Increase `connectTimeoutMs` if package installation or startup needs more than the default 30 seconds. |
| A tool exceeds its deadline | Increase `timeoutMs` for that server; the default is 60 seconds. Timed-out requests are cancelled, not automatically replayed. |
| Server returns 401 | Use `/mcp login <server>` for OAuth, or correct its API key/header configuration. |
| OAuth registration is unavailable | Configure the service's registered `clientId`, or use a supported token/key authentication method. |
| Browser callback cannot reach the SSH host | Paste the complete final callback URL into the sign-in dialog. |
| Server redirects the MCP endpoint | Set `url` to the final endpoint. Transport redirects are refused to avoid forwarding credentials elsewhere. |
| Connection disappears | clai shares one reconnect among simultaneous failures. Read-only or idempotent calls can retry once; an ambiguous write is reported without replaying it, while the connection is repaired for later calls. |
| HTTP session expires | clai reinitializes the session before retrying the call rejected by the server. |
| Streamed HTTP response disconnects | When the server supplies event IDs, clai resumes using `Last-Event-ID` over GET rather than replaying the original POST. |
| Tool catalog changes during a turn | Inspect the current schema with `mcp.tools` and retry in a new turn. |

The MCP integration advertises the client capabilities it implements, including workspace roots. Unsupported server requests receive a protocol error promptly instead of leaving a tool call waiting indefinitely.

For the underlying protocols, see the [MCP transport specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports), [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization), and [OAuth device authorization grant](https://www.rfc-editor.org/rfc/rfc8628).
