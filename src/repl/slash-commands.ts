import { nvidiaFallbackModels } from "../llm/nvidia.js";

export interface SlashCommand {
  command: string;
  usage?: string;
  description: string;
}

/** Shared command catalogue used by both the classic REPL and the Ink TUI. */
export const slashCommands: SlashCommand[] = [
  { command: "/ask", description: "switch to ask mode" },
  { command: "/agent", description: "switch to agent mode" },
  {
    command: "/model",
    usage: "[name|#]",
    description:
      "open searchable picker (type/↑/↓ + Enter), or pass a name/number",
  },
  {
    command: "/provider",
    usage: "[name]",
    description: "switch provider or open picker",
  },
  {
    command: "/use",
    usage: "<provider>",
    description: "alias for /provider <name>",
  },
  { command: "/set", usage: "[provider] [key]", description: "store API key or open picker" },
  { command: "/unset", usage: "[provider]", description: "remove key or open picker" },
  { command: "/keys", description: "list configured providers" },
  {
    command: "/info",
    usage: "[provider]",
    description: "show info for the active or specified provider",
  },
  {
    command: "/search",
    usage: "[provider]",
    description: "switch web.search provider or open picker",
  },
  {
    command: "/search-provider",
    usage: "[provider]",
    description: "alias for /search",
  },
  {
    command: "/mouse",
    usage: "[on|off]",
    description: "toggle touchpad transcript scrolling vs native selection",
  },
  {
    command: "/variants",
    usage: "[on|off|none|minimal|low|medium|high|xhigh]",
    description: "toggle thinking/effort (interactive picker if no arg)",
  },
  {
    command: "/reasoning",
    usage: "[on|off|none|minimal|low|medium|high|xhigh]",
    description: "alias for /variants",
  },
  { command: "/clear", description: "clear context" },
  {
    command: "/new",
    description: "start a fresh session (clear context, no history carryover)",
  },
  {
    command: "/history",
    description: "browse & resume past sessions (interactive picker)",
  },
  { command: "/save", usage: "<name>", description: "save session" },
  { command: "/reset", description: "clear all saved history" },
  { command: "/cwd", usage: "<path>", description: "change working directory" },
  {
    command: "/allow",
    usage: "<tool>|list",
    description: "allow a tool for this session (not persisted)",
  },
  {
    command: "/disallow",
    usage: "<tool>",
    description: "revoke a session allow",
  },
  { command: "/think", description: "show thinking from last response" },
  { command: "/thinking", description: "alias for /think" },
  {
    command: "/output",
    usage: "[last|<id>|list]",
    description: "open full tool output (Ctrl+O); q closes the pager",
  },
  {
    command: "/freeonly",
    usage: "[on|off]",
    description: "skip paid providers when fallback is enabled",
  },
  {
    command: "/fallback",
    usage: "[on|off]",
    description:
      "try other configured providers after a failure (off by default)",
  },
  { command: "/compact", description: "compact session history now" },
  { command: "/context", description: "show estimated context size" },
  {
    command: "/plan",
    description: "view the current session plan (also Ctrl+P)",
  },
  {
    command: "/implement",
    description: "approve the current plan and have clai execute it",
  },
  {
    command: "/discard",
    description: "discard the current plan so later messages ignore it",
  },
  {
    command: "/scope",
    usage: "[show|clear|new|add <targets>]",
    description: "manage pentest engagement scope",
  },
  {
    command: "/privacy",
    usage: "[status|clear-history|clear-logs|clear-artifacts|clear-all|on|off]",
    description: "control retention and private mode (in-memory only)",
  },
  { command: "/update", description: "check for updates" },
  {
    command: "/clean",
    description: "clear screen and reset chat (fresh start)",
  },
  { command: "/exit", description: "quit" },
  { command: "/quit", description: "alias for /exit" },
  { command: "/help", description: "list commands" },
];

// ── Well-known models per provider (refreshed May 2026) ───────────────────
/** Curated model choices used by both frontends. */
export const knownModels: Record<string, string[]> = {
  groq: [
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-safeguard-20b",
    "qwen/qwen3-32b",
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "groq/compound-mini",
    "groq/compound",
  ],
  gemini: [
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite",
    "gemini-3-pro-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
  ],
  openrouter: [
    "meta-llama/llama-3.3-70b-instruct:free",
    "deepseek/deepseek-v4-flash:free",
    "openai/gpt-oss-20b:free",
    "qwen/qwen3-coder:free",
    "qwen/qwen3-next-80b-a3b-instruct:free",
    "google/gemma-4-31b-it:free",
    "nvidia/nemotron-3-nano-30b-a3b:free",
    "z-ai/glm-4.5-air:free",
    "moonshotai/kimi-k2.6",
    "meta-llama/llama-4-maverick",
    "google/gemini-2.5-flash",
  ],
  openai: [
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.4",
    "gpt-5.4-pro",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-rosalind",
    "gpt-realtime-2",
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-4o-mini",
    "gpt-4o",
  ],
  anthropic: [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-opus-4-6",
    "claude-sonnet-4-5",
    "claude-3-5-sonnet-latest",
    "claude-3-5-haiku-latest",
  ],
  nvidia: nvidiaFallbackModels,
  ollama: [
    "llama3.3:70b",
    "llama3.2:3b",
    "llama3.1:8b",
    "qwen2.5:7b",
    "qwen2.5-coder:7b",
    "deepseek-r1:7b",
    "mistral:7b",
    "gemma3:9b",
    "phi4:14b",
    "codellama:7b",
  ],
  agentrouter: [
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "glm-5.2",
    "gpt-5.5",
  ],
  kimchi: [
    "kimi-k2.6",
    "minimax-m2.7",
    "nemotron-3-super-fp4",
  ],
  "aws-mantle": [],
  bynara: [
    // Free tier models
    "mimo-v2.5-free",
    "mimo-v2.5-pro-free",
    "mistral-large",
    "mistral-medium-3-5",
    // Pay-as-you-go / subscription models (from https://router.bynara.id/pricing)
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "mimo-v2.5-hermes",
    "mimo-v2.5-pro-hermes",
    "mimo-v2.5-pro-ultraspeed",
    "claude-opus-4.7",
    "claude-opus-4.8",
    "claude-sonnet-4.6",
    "claude-sonnet-4.5",
    "claude-haiku-4.5",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "gemini-3-flash",
    "gemini-3.1-pro",
    "gemini-3.5-flash",
    "gemini-2.5-flash",
    "glm-5.1",
    "glm-5.2",
    "gpt-5.4",
    "gpt-5.5",
    "kimi-k2.6",
    "kimi-k2.7-code",
    "minimax-m3",
    "qwen-3.7-max",
    "qwen-3.7-plus",
    "qwen-3.7-plus-1m",
    "bynara-max",
  ],
};

export function getKnownModels(provider: string): string[] {
  return [...(knownModels[provider] ?? [])];
}

/** Set of known slash-command names (without the leading "/"). */
const knownSlashNames = new Set(
  slashCommands.map((c) => c.command.slice(1).toLowerCase()),
);

/**
 * Decide whether a line that starts with "/" is actually a slash command
 * versus an absolute filesystem path the user typed or drag-dropped (e.g.
 * `/Users/me/Desktop/Screenshot.png`). A real command is "/" + a single
 * known command word (optionally followed by arguments). An absolute path
 * has extra "/" segments in its first token and won't match a known command,
 * so we route it to the normal prompt path where expandMentions() turns it
 * into a file attachment.
 */
export function looksLikeSlashCommand(line: string): boolean {
  if (!line.startsWith("/") || line.length < 2) return false;
  // First whitespace-delimited token, minus the leading slash.
  const firstToken = line.slice(1).split(/\s/)[0] ?? "";
  // A path-like first token (contains another "/" or a backslash escape, or
  // looks like a filename with an extension) is never a command.
  if (firstToken.includes("/") || firstToken.includes("\\")) return false;
  const name = firstToken.toLowerCase();
  // Exact match against a known command, or a unique prefix of one (so
  // partial typing like "/imp" still routes to the command handler, which
  // already resolves abbreviations). Unknown words like a single-segment
  // path token still fall through to handleSlash's "unknown command" help,
  // which is the historical behavior for genuine typos.
  if (knownSlashNames.has(name)) return true;
  // Only treat as a (mistyped) command when it has no path/extension shape.
  // "Users" alone (from "/Users") would be caught above by the "/" check,
  // so here we accept bare alpha words as command attempts.
  return /^[a-z][a-z0-9-]*$/i.test(firstToken);
}

export function slashCommandLabel(command: SlashCommand): string {
  return command.usage
    ? `${command.command} ${command.usage}`
    : command.command;
}

export function slashCommandFilter(line: string): string | null {
  // Show the menu immediately on '/' so the user can see available commands,
  // but let Enter submit a raw '/' unless they explicitly navigate the menu.
  if (!line.startsWith("/") || line.length < 1 || /\s/.test(line)) return null;
  // Don't show the command menu for an absolute path the user is typing or
  // drag-dropped (e.g. "/Users/me/file.png"): a path's first token has more
  // "/" or backslash escapes in it. Those go to the normal prompt path.
  const firstToken = line.slice(1).split(/\s/)[0] ?? "";
  if (firstToken.includes("/") || firstToken.includes("\\")) return null;
  return line.slice(1).toLowerCase();
}

export function getSlashCommandSuggestions(line: string): SlashCommand[] {
  const filter = slashCommandFilter(line);
  if (filter === null) return [];
  return slashCommands.filter((command) =>
    command.command.slice(1).toLowerCase().startsWith(filter),
  );
}

export function isKnownSlashCommand(command: string): boolean {
  const normalized = command.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return slashCommands.some((item) => item.command === normalized);
}
