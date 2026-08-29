import { execFile } from "node:child_process";

const GITHUB_HOSTS = ["github.com", "githubcopilot.com"] as const;

const GITHUB_TOKEN_VARS = [
  "GITHUB_MCP_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
] as const;

const CLI_TIMEOUT_MS = 4_000;

export interface HostCredential {
  readonly token: string;
  readonly source: string;
}

export interface HostCredentialDeps {
  readonly env?: Record<string, string | undefined> | undefined;
  readonly readCliToken?: (() => Promise<string | undefined>) | undefined;
}

export function isGithubHost(serverUrl: string): boolean {
  let host: string;
  try {
    host = new URL(serverUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return GITHUB_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
}

function fromEnv(env: Record<string, string | undefined>): HostCredential | undefined {
  for (const name of GITHUB_TOKEN_VARS) {
    const value = env[name]?.trim();
    if (value) return { token: value, source: `$${name}` };
  }
  return undefined;
}

function readGhCliToken(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["auth", "token"],
      { timeout: CLI_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const token = String(stdout).trim();
        resolve(token.length > 0 ? token : undefined);
      },
    );
  });
}

export async function findGithubCredential(
  serverUrl: string,
  deps: HostCredentialDeps = {},
): Promise<HostCredential | undefined> {
  if (!isGithubHost(serverUrl)) return undefined;
  const env = deps.env ?? process.env;
  const fromEnvironment = fromEnv(env);
  if (fromEnvironment) return fromEnvironment;
  const readCliToken = deps.readCliToken ?? readGhCliToken;
  const cliToken = await readCliToken().catch(() => undefined);
  return cliToken ? { token: cliToken, source: "gh auth token" } : undefined;
}

export function githubCredentialHint(): string {
  return (
    `set ${GITHUB_TOKEN_VARS[2]} (or run "gh auth login" so "gh auth token" works)`
  );
}
