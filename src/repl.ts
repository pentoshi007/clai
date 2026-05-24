import {
  clearLine,
  cursorTo,
  emitKeypressEvents,
  moveCursor,
} from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import { search } from "@inquirer/prompts";
import type { ChatMessage, Mode, ProviderId } from "./types.js";
import { runAskStream } from "./modes/ask.js";
import {
  runAgent,
  createSessionPolicy,
  type SessionPolicy,
} from "./modes/agent.js";
import {
  providerSwitcher,
  printProviderKeys,
  setProviderKey,
  unsetProviderKey,
  useProvider,
} from "./commands/providers.js";
import {
  getConfig,
  getProviderModel,
  setDefaultMode,
  setProviderModel,
  setThinking,
  updateConfig,
} from "./store/config.js";
import { listSessions, saveSession } from "./store/history.js";
import { assertProvider, defaultModels } from "./llm/provider.js";
import { providerIds } from "./types.js";
import {
  runUpdate,
  checkForUpdateSilent,
  getCurrentVersion,
} from "./commands/update.js";
import {
  renderBanner,
  renderSessionInfo,
  renderSuggestions,
  renderModeSwitch,
  renderProviderSwitch,
  PROMPT,
} from "./ui/banner.js";
import {
  clearThinking,
  createThinkingStreamParser,
  getLastThinking,
  rememberThinkingFromText,
  renderThinkingBlock,
  renderThinkingSummary,
  renderThinkingToggleMessage,
} from "./ui/thinking.js";
import { createMarkdownStreamWriter, renderMarkdown } from "./ui/markdown.js";
import { startThinkingSpinner } from "./ui/spinner.js";
import { modelSupportsThinking } from "./llm/capabilities.js";
import {
  getLastViewport,
  getViewport,
  isPagerActive,
  listViewports,
  openViewportPager,
  toggleViewport,
} from "./ui/output-pane.js";
import {
  compactMessages,
  estimateMessagesTokens,
} from "./agent/context-manager.js";
import { isCtrlC, isCtrlO, isCtrlT, isEscape } from "./ui/keys.js";

export interface ReplOptions {
  mode?: Mode | undefined;
  provider?: ProviderId | undefined;
  model?: string | undefined;
  noHistory?: boolean | undefined;
}

export interface SlashCommand {
  command: string;
  usage?: string;
  description: string;
}

interface KeypressKey {
  ctrl?: boolean;
  meta?: boolean;
  name?: string;
  sequence?: string;
}

const slashCommands: SlashCommand[] = [
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
  { command: "/set", usage: "<provider> [key]", description: "store API key" },
  { command: "/unset", usage: "<provider>", description: "remove key" },
  { command: "/keys", description: "list configured providers" },
  {
    command: "/variants",
    usage: "[on|off|low|medium|high]",
    description: "toggle thinking and effort for capable models",
  },
  {
    command: "/reasoning",
    usage: "[on|off|low|medium|high]",
    description: "alias for /variants",
  },
  { command: "/clear", description: "clear context" },
  { command: "/history", description: "show past sessions" },
  { command: "/save", usage: "<name>", description: "save session" },
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
    description: "try other configured providers after a failure (off by default)",
  },
  { command: "/compact", description: "compact session history now" },
  { command: "/context", description: "show estimated context size" },
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
  { command: "/exit", description: "quit" },
  { command: "/quit", description: "alias for /exit" },
  { command: "/help", description: "list commands" },
];

// ── Well-known models per provider (refreshed May 2026) ───────────────────
const knownModels: Record<string, string[]> = {
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
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4o",
    "gpt-4o-mini",
    "o3",
    "o3-mini",
    "o4-mini",
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
  nvidia: [
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "moonshotai/kimi-k2.6",
    "deepseek-ai/deepseek-v4-flash",
    "deepseek-ai/deepseek-v4-pro",
    "z-ai/glm-5.1",
    "minimaxai/minimax-m2.7",
    "google/gemma-4-31b-it",
    "nvidia/nemotron-3-nano-30b-a3b",
    "nvidia/nemotron-3-super-120b-a12b",
    "nvidia/llama-3.3-nemotron-super-49b-v1",
    "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    "meta/llama-3.3-70b-instruct",
    "meta/llama-4-maverick-17b-128e-instruct",
    "meta/llama-3.1-70b-instruct",
    "nvidia/llama-3.1-nemotron-70b-instruct",
    "qwen/qwen3-next-80b-a3b-instruct",
    "qwen/qwen3.5-122b-a10b",
    "mistralai/mistral-small-4-119b-2603",
    "mistralai/mistral-medium-3.5-128b",
    "mistralai/mistral-large-3-675b-instruct-2512",
    "mistralai/mistral-nemotron",
    "stepfun-ai/step-3.5-flash",
    "sarvamai/sarvam-m",
  ],
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
    "claude-haiku-4-5-20251001",
    "claude-opus-4-6",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "glm-5.1",
  ],
};

export function getKnownModels(provider: string): string[] {
  return [...(knownModels[provider] ?? [])];
}

// ── Abort controller for streaming cancellation ─────────────────────────────
let currentAbortController: AbortController | null = null;

class AbortRunError extends Error {
  constructor() {
    super("Aborted.");
    this.name = "AbortRunError";
  }
}

function splitCommand(line: string): string[] {
  return (
    line
      .match(/(?:[^\s"]+|"[^"]*")+/g)
      ?.map((part) => part.replace(/^"|"$/g, "")) ?? []
  );
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function isAbortLikeError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object") {
    const err = error as { name?: string; code?: string; message?: string };
    if (err.name === "AbortError") return true;
    if (err.code === "ABORT_ERR") return true;
    if (typeof err.message === "string" && /abort/i.test(err.message))
      return true;
  }
  return false;
}

function slashCommandLabel(command: SlashCommand): string {
  return command.usage
    ? `${command.command} ${command.usage}`
    : command.command;
}

function slashCommandFilter(line: string): string | null {
  if (!line.startsWith("/") || /\s/.test(line)) return null;
  return line.slice(1).toLowerCase();
}

export function getSlashCommandSuggestions(line: string): SlashCommand[] {
  const filter = slashCommandFilter(line);
  if (filter === null) return [];
  return slashCommands.filter((command) =>
    command.command.slice(1).toLowerCase().startsWith(filter),
  );
}

function renderSlashCommandMenu(
  line: string,
  suggestions: SlashCommand[],
  selectedIndex: number,
): string[] {
  if (suggestions.length === 0) {
    return [chalk.dim(`  no commands matching ${line}`)];
  }

  const maxCommandLength = Math.max(
    ...suggestions.map((command) => slashCommandLabel(command).length),
  );

  return suggestions.map((command, index) => {
    const marker = index === selectedIndex ? chalk.magenta("›") : " ";
    const label = slashCommandLabel(command).padEnd(maxCommandLength + 2);
    return `  ${marker} ${chalk.cyan(label)}${chalk.dim(command.description)}`;
  });
}

function isPrintableSequence(sequence: string | undefined): sequence is string {
  return sequence !== undefined && /^[^\x00-\x1f\x7f]+$/u.test(sequence);
}

async function readPromptLine(options: {
  history: string[];
  onThinkingShortcut: () => void;
  onOutputShortcut: () => Promise<void>;
}): Promise<string> {
  return new Promise((resolve) => {
    let line = "";
    let cursor = 0;
    let selectedIndex = 0;
    let renderedMenuLines = 0;
    let dismissedSlashLine: string | null = null;
    let historyIndex: number | null = null;
    let historyDraft = "";
    let lastCtrlCAt = 0;

    const promptColumns = stripAnsi(PROMPT).length;

    const getMenuState = (): {
      visible: boolean;
      suggestions: SlashCommand[];
    } => {
      const filter = slashCommandFilter(line);
      if (filter === null || dismissedSlashLine === line) {
        return { visible: false, suggestions: [] };
      }
      const suggestions = getSlashCommandSuggestions(line);
      if (selectedIndex >= suggestions.length) selectedIndex = 0;
      return { visible: true, suggestions };
    };

    const refresh = (): void => {
      const menu = getMenuState();
      const menuLines = menu.visible
        ? renderSlashCommandMenu(line, menu.suggestions, selectedIndex)
        : [];
      const linesToClear = Math.max(renderedMenuLines, menuLines.length);

      cursorTo(output, 0);
      clearLine(output, 0);
      output.write(`${PROMPT}${line}`);

      for (let i = 0; i < linesToClear; i += 1) {
        output.write("\n");
        clearLine(output, 0);
        const menuLine = menuLines[i];
        if (menuLine) output.write(menuLine);
      }

      if (linesToClear > 0) moveCursor(output, 0, -linesToClear);
      cursorTo(output, promptColumns + cursor);
      renderedMenuLines = menuLines.length;
    };

    const editLine = (nextLine: string, nextCursor: number): void => {
      line = nextLine;
      cursor = Math.max(0, Math.min(nextCursor, line.length));
      selectedIndex = 0;
      dismissedSlashLine = null;
      historyIndex = null;
      refresh();
    };

    const cleanup = (): void => {
      input.off("keypress", handleKeypress);
      if (input.isTTY) input.setRawMode(false);
    };

    const clearPromptDisplay = (): void => {
      const previousMenuLines = renderedMenuLines;
      cursorTo(output, 0);
      clearLine(output, 0);
      for (let i = 0; i < previousMenuLines; i += 1) {
        output.write("\n");
        clearLine(output, 0);
      }
      if (previousMenuLines > 0) moveCursor(output, 0, -previousMenuLines);
      renderedMenuLines = 0;
    };

    const submit = (submittedLine: string): void => {
      const previousMenuLines = renderedMenuLines;
      line = submittedLine;
      cursor = line.length;
      renderedMenuLines = 0;

      cursorTo(output, 0);
      clearLine(output, 0);
      output.write(`${PROMPT}${line}`);
      for (let i = 0; i < previousMenuLines; i += 1) {
        output.write("\n");
        clearLine(output, 0);
      }
      if (previousMenuLines > 0) moveCursor(output, 0, -previousMenuLines);
      cursorTo(output, promptColumns + cursor);
      output.write("\n");

      cleanup();
      resolve(submittedLine);
    };

    function handleKeypress(sequence: string, key: KeypressKey): void {
      // The alt-screen pager owns the terminal while open; ignore everything
      // here so the user's navigation keys don't bleed into the input line.
      if (isPagerActive()) return;
      const menu = getMenuState();

      // Cmd+C on macOS terminals is handled by the OS (it never reaches us),
      // but some Linux terminals forward Meta+C. Treat that as a no-op so
      // selecting + copying never breaks the REPL.
      if (key.meta && !key.ctrl && key.name === "c") return;

      if (isCtrlC(key)) {
        // First press: clear the current line. Second press within 1s: exit.
        // This mirrors bash / Claude Code and avoids killing the REPL by
        // accident when users habitually press Ctrl+C to copy in some
        // terminals.
        const now = Date.now();
        if (line.length > 0) {
          editLine("", 0);
          lastCtrlCAt = now;
          return;
        }
        if (now - lastCtrlCAt < 1_000) {
          cleanup();
          output.write("\n");
          process.exit(0);
        }
        lastCtrlCAt = now;
        output.write("\n");
        output.write(chalk.dim("  (press Ctrl+C again to exit)\n"));
        output.write(PROMPT);
        renderedMenuLines = 0;
        return;
      }

      if (isCtrlT(key)) {
        options.onThinkingShortcut();
        refresh();
        return;
      }

      if (isCtrlO(key)) {
        clearPromptDisplay();
        output.write("\n");
        void options.onOutputShortcut().finally(refresh);
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        const selectedCommand = menu.visible
          ? menu.suggestions[selectedIndex]
          : undefined;
        submit(selectedCommand?.command ?? line);
        return;
      }

      if (key.name === "tab") {
        if (menu.visible && menu.suggestions.length > 0) {
          const target =
            menu.suggestions[selectedIndex] ?? menu.suggestions[0]!;
          editLine(target.command, target.command.length);
        }
        return;
      }

      if (isEscape(key)) {
        if (menu.visible) {
          dismissedSlashLine = line;
          refresh();
        }
        return;
      }

      if (key.name === "up") {
        if (menu.visible && menu.suggestions.length > 0) {
          selectedIndex =
            (selectedIndex - 1 + menu.suggestions.length) %
            menu.suggestions.length;
          refresh();
          return;
        }
        if (options.history.length > 0) {
          if (historyIndex === null) {
            historyDraft = line;
            historyIndex = options.history.length - 1;
          } else {
            historyIndex = Math.max(0, historyIndex - 1);
          }
          line = options.history[historyIndex] ?? "";
          cursor = line.length;
          selectedIndex = 0;
          dismissedSlashLine = null;
          refresh();
        }
        return;
      }

      if (key.name === "down") {
        if (menu.visible && menu.suggestions.length > 0) {
          selectedIndex = (selectedIndex + 1) % menu.suggestions.length;
          refresh();
          return;
        }
        if (historyIndex !== null) {
          if (historyIndex < options.history.length - 1) {
            historyIndex += 1;
            line = options.history[historyIndex] ?? "";
          } else {
            historyIndex = null;
            line = historyDraft;
          }
          cursor = line.length;
          selectedIndex = 0;
          dismissedSlashLine = null;
          refresh();
        }
        return;
      }

      if (key.name === "left") {
        if (cursor > 0) {
          cursor -= 1;
          refresh();
        }
        return;
      }

      if (key.name === "right") {
        if (cursor < line.length) {
          cursor += 1;
          refresh();
        }
        return;
      }

      if (key.name === "home" || (key.ctrl && key.name === "a")) {
        cursor = 0;
        refresh();
        return;
      }

      if (key.name === "end" || (key.ctrl && key.name === "e")) {
        cursor = line.length;
        refresh();
        return;
      }

      if (key.name === "backspace") {
        if (cursor > 0) {
          editLine(line.slice(0, cursor - 1) + line.slice(cursor), cursor - 1);
        }
        return;
      }

      if (key.name === "delete") {
        if (cursor < line.length) {
          editLine(line.slice(0, cursor) + line.slice(cursor + 1), cursor);
        }
        return;
      }

      if (key.ctrl && key.name === "u") {
        editLine(line.slice(cursor), 0);
        return;
      }

      if (key.ctrl && key.name === "k") {
        editLine(line.slice(0, cursor), cursor);
        return;
      }

      if (isPrintableSequence(sequence) && !key.ctrl && !key.meta) {
        editLine(
          line.slice(0, cursor) + sequence + line.slice(cursor),
          cursor + sequence.length,
        );
      }
    }

    output.write(PROMPT);
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    input.on("keypress", handleKeypress);
  });
}

// Stream a response while hiding <think> blocks and handling ESC abort
async function streamWithAbort(
  run: (signal: AbortSignal, onToken: (t: string) => void) => Promise<string>,
  signal: AbortSignal,
): Promise<string> {
  let sawToken = false;
  const spinner = startThinkingSpinner("waiting for model", signal);
  const markdown = createMarkdownStreamWriter((chunk) =>
    process.stdout.write(chunk),
  );
  const parser = createThinkingStreamParser(
    (text) => {
      // Visible content arriving — drop the spinner so output isn't stomped on.
      spinner.stop();
      markdown.push(text);
    },
    (reasoning) => {
      // Reasoning tokens are hidden by default; show progress so users see
      // something is happening even when the model spends a minute thinking.
      spinner.setLabel("thinking");
      spinner.pushPreview(reasoning);
      const approx = reasoning.split(/\s+/).filter(Boolean).length;
      if (approx > 0) spinner.bumpReasoning(approx);
    },
  );

  const onToken = (token: string): void => {
    if (!sawToken) {
      // First raw token from the provider — still hold the spinner if it
      // turns out to be a reasoning token; the parser's callbacks above
      // decide which label to show.
      sawToken = true;
    }
    parser.push(token);
  };

  try {
    const raw = await run(signal, onToken);
    spinner.stop();
    const result = sawToken ? parser.finish() : rememberThinkingFromText(raw);
    if (sawToken) {
      markdown.finish();
    } else if (result.visible) {
      process.stdout.write(renderMarkdown(result.visible));
    }
    if (result.hasThinking) {
      const prefix =
        result.visible && !result.visible.endsWith("\n") ? "\n" : "";
      process.stdout.write(
        `${prefix}${renderThinkingSummary(result.thinkContent)}\n`,
      );
    }
    return result.visible;
  } catch (err) {
    const result = parser.finish();
    if (sawToken) markdown.finish();
    if (signal.aborted) {
      process.stdout.write(chalk.yellow("\n  ⏹ Aborted.\n"));
      return result.visible;
    }
    throw err;
  } finally {
    // Belt and braces: spinner already self-stops on abort, but make sure
    // any other exit path (success, network error) clears it too.
    spinner.stop();
  }
}

async function withAbortableInput<T>(
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ac = new AbortController();
  currentAbortController = ac;
  if (input.isTTY) input.setRawMode(true);
  try {
    return await run(ac.signal);
  } catch (error) {
    if (
      ac.signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      throw new AbortRunError();
    }
    throw error;
  } finally {
    if (input.isTTY) input.setRawMode(false);
    currentAbortController = null;
  }
}

function help(): string {
  const maxCmd = Math.max(
    ...slashCommands.map((command) => slashCommandLabel(command).length),
  );
  const lines = slashCommands
    .map((command) => {
      const label = slashCommandLabel(command).padEnd(maxCmd + 2);
      return `  ${chalk.cyan(label)}${chalk.dim(command.description)}`;
    })
    .join("\n");
  return (
    lines +
    chalk.dim(
      "\n\n  ESC abort  │  Ctrl+C clears input (twice to exit)  │  Ctrl+T toggle thinking  │  Ctrl+O opens tool output pager (q to close)",
    )
  );
}

async function pickModelInteractively(
  provider: ProviderId,
  currentModel: string,
): Promise<string | undefined> {
  const models = knownModels[provider] ?? [];
  const def = defaultModels[provider] ?? "";
  if (models.length === 0) {
    console.log(
      chalk.dim(
        "  No known models for this provider. Type /model <name> to set manually.",
      ),
    );
    return undefined;
  }

  console.log(
    chalk.dim(
      `  ↑/↓ to navigate · type to filter (name or number) · Enter to select · ESC to cancel`,
    ),
  );

  const labelFor = (model: string, index: number): string => {
    const tags: string[] = [];
    if (model === currentModel) tags.push(chalk.green("active"));
    if (model === def) tags.push(chalk.yellow("default"));
    const suffix = tags.length > 0 ? `  ${chalk.dim(tags.join(" · "))}` : "";
    return `${chalk.dim(`${(index + 1).toString().padStart(2)}.`)} ${model}${suffix}`;
  };

  try {
    const picked = await search<string>({
      message: `Select model for ${chalk.cyan(provider)}:`,
      pageSize: Math.min(15, models.length),
      source: (term) => {
        const needle = (term ?? "").trim().toLowerCase();
        const filtered = needle
          ? models
              .map((model, index) => ({ model, index }))
              .filter(({ model, index }) => {
                if (model.toLowerCase().includes(needle)) return true;
                // Allow filtering by number prefix ("1", "10", etc.)
                return (index + 1).toString().startsWith(needle);
              })
          : models.map((model, index) => ({ model, index }));
        return filtered.map(({ model, index }) => ({
          name: labelFor(model, index),
          value: model,
        }));
      },
    });
    return picked;
  } catch {
    // User pressed ESC / Ctrl+C inside the inquirer prompt.
    return undefined;
  }
}

function showModelList(provider: string, currentModel: string): void {
  const models = knownModels[provider] ?? [];
  const def = defaultModels[provider as ProviderId] ?? "";
  if (models.length === 0) {
    console.log(
      chalk.dim(
        "  No known models for this provider. Type /model <name> to set manually.",
      ),
    );
    return;
  }
  console.log(chalk.dim(`  Available models for ${chalk.cyan(provider)}:`));
  models.forEach((m, i) => {
    const tags: string[] = [];
    if (m === currentModel) tags.push("active");
    if (m === def) tags.push("default");
    const tag = tags.length > 0 ? chalk.dim(`  (${tags.join(" · ")})`) : "";
    console.log(`  ${chalk.dim(`${i + 1}.`)} ${chalk.white(m)}${tag}`);
  });
  console.log(chalk.dim("  Use /model <name> or /model <#> to select."));
}

function maybePrintThinkingTip(provider: ProviderId, model: string): void {
  if (getConfig().thinking.enabled) return;
  if (!modelSupportsThinking(provider, model)) return;
  console.log(
    chalk.dim("  💡 ") +
      chalk.dim(`${model} supports reasoning. Run `) +
      chalk.cyan("/variants on") +
      chalk.dim(" (or ") +
      chalk.cyan("low|medium|high") +
      chalk.dim(") to enable it."),
  );
}

async function handleSlash(
  line: string,
  state: {
    mode: Mode;
    provider: ProviderId;
    model: string;
    messages: ChatMessage[];
    session: SessionPolicy;
  },
): Promise<boolean> {
  const [command, ...args] = splitCommand(line);
  switch (command) {
    case "/ask":
      state.mode = "ask";
      setDefaultMode("ask");
      console.log(renderModeSwitch("ask"));
      return true;
    case "/agent":
      state.mode = "agent";
      setDefaultMode("agent");
      console.log(renderModeSwitch("agent"));
      return true;
    case "/model": {
      const arg = args.join(" ").trim();
      if (!arg) {
        // No arg → interactive picker (up/down, Enter to select)
        const picked = await pickModelInteractively(
          state.provider,
          state.model,
        );
        if (!picked) {
          console.log(chalk.dim("  model unchanged"));
          return true;
        }
        state.model = picked;
        setProviderModel(state.provider, picked);
        console.log(renderProviderSwitch(state.provider, picked));
        maybePrintThinkingTip(state.provider, picked);
        return true;
      }
      if (arg === "list" || arg === "ls") {
        showModelList(state.provider, state.model);
        return true;
      }
      // Numeric → pick from known list
      const num = parseInt(arg, 10);
      const models = knownModels[state.provider] ?? [];
      if (!isNaN(num) && num >= 1 && num <= models.length) {
        const picked = models[num - 1]!;
        state.model = picked;
        setProviderModel(state.provider, picked);
        console.log(renderProviderSwitch(state.provider, picked));
        maybePrintThinkingTip(state.provider, picked);
      } else {
        // Name → set directly
        state.model = arg;
        setProviderModel(state.provider, arg);
        console.log(renderProviderSwitch(state.provider, arg));
        maybePrintThinkingTip(state.provider, arg);
      }
      return true;
    }
    case "/provider":
    case "/use": {
      await providerSwitcher(args[0]);
      const config = getConfig();
      state.provider = config.defaultProvider;
      state.model = getProviderModel(state.provider);
      console.log(renderProviderSwitch(state.provider, state.model));
      maybePrintThinkingTip(state.provider, state.model);
      return true;
    }
    case "/set": {
      if (!args[0]) console.log(chalk.dim("usage: /set <provider> [key]"));
      else await setProviderKey(args[0], args[1], {});
      return true;
    }
    case "/unset": {
      if (!args[0]) console.log(chalk.dim("usage: /unset <provider>"));
      else await unsetProviderKey(args[0]);
      return true;
    }
    case "/keys":
      await printProviderKeys();
      return true;
    case "/variants":
    case "/reasoning": {
      const arg = (args[0] ?? "").toLowerCase().trim();
      const current = getConfig().thinking;
      const supported = modelSupportsThinking(state.provider, state.model);

      if (!arg) {
        const status = current.enabled ? chalk.green("on") : chalk.dim("off");
        const support = supported
          ? chalk.green("supported")
          : chalk.yellow("not advertised by this model");
        console.log(
          chalk.dim("  thinking: ") +
            status +
            chalk.dim("  effort: ") +
            chalk.cyan(current.effort) +
            chalk.dim("  · ") +
            support,
        );
        console.log(chalk.dim("  usage: /variants on|off|low|medium|high"));
        return true;
      }

      if (arg === "on" || arg === "enable" || arg === "true") {
        setThinking({ enabled: true });
        console.log(
          chalk.dim(
            `  thinking: ${chalk.green("on")} (effort=${getConfig().thinking.effort})`,
          ),
        );
        if (!supported) {
          console.log(
            chalk.yellow("  note: current model may ignore the thinking flag."),
          );
        }
        return true;
      }
      if (arg === "off" || arg === "disable" || arg === "false") {
        setThinking({ enabled: false });
        console.log(chalk.dim(`  thinking: ${chalk.dim("off")}`));
        return true;
      }
      if (arg === "low" || arg === "medium" || arg === "high") {
        setThinking({ enabled: true, effort: arg });
        console.log(
          chalk.dim(
            `  thinking: ${chalk.green("on")}  effort: ${chalk.cyan(arg)}`,
          ),
        );
        if (!supported) {
          console.log(
            chalk.yellow("  note: current model may ignore the thinking flag."),
          );
        }
        return true;
      }

      console.log(chalk.dim("  usage: /variants on|off|low|medium|high"));
      return true;
    }
    case "/clear":
      state.messages.length = 0;
      console.log(chalk.dim("  context cleared"));
      return true;
    case "/history": {
      const sessions = await listSessions();
      if (sessions.length === 0) console.log(chalk.dim("  no saved sessions"));
      for (const session of sessions) {
        console.log(
          chalk.dim("  ") +
            `${session.createdAt} ${session.name ?? session.id} ${chalk.dim(`(${session.messages.length} msgs)`)}`,
        );
      }
      return true;
    }
    case "/save": {
      const record = await saveSession(
        state.messages,
        args.join(" ") || undefined,
      );
      console.log(chalk.dim(`  saved session ${record.id}`));
      return true;
    }
    case "/cwd": {
      const dir = args.join(" ");
      if (!dir) console.log(chalk.dim(`  ${process.cwd()}`));
      else {
        process.chdir(dir);
        const config = getConfig();
        updateConfig({
          sandboxRoots: Array.from(
            new Set([...config.sandboxRoots, process.cwd()]),
          ),
        });
        console.log(chalk.dim(`  cwd → ${process.cwd()}`));
      }
      return true;
    }
    case "/allow": {
      const tool = args[0];
      if (!tool) {
        console.log(chalk.dim("usage: /allow <tool>|list"));
        return true;
      }
      if (tool === "list" || tool === "ls") {
        if (state.session.allow.size === 0) {
          console.log(chalk.dim("  no session allows"));
        } else {
          for (const allowed of state.session.allow) {
            console.log(chalk.dim(`  ✓ ${allowed}`));
          }
        }
        return true;
      }
      state.session.allow.add(tool);
      console.log(chalk.dim(`  allowed ${tool} for this session only ✓`));
      return true;
    }
    case "/disallow": {
      const tool = args[0];
      if (!tool) {
        console.log(chalk.dim("usage: /disallow <tool>"));
        return true;
      }
      if (state.session.allow.delete(tool)) {
        console.log(chalk.dim(`  revoked ${tool} ✓`));
      } else {
        console.log(chalk.dim(`  ${tool} was not in the session allow list`));
      }
      return true;
    }
    case "/context": {
      const tokens = estimateMessagesTokens(state.messages);
      console.log(
        chalk.dim(
          `  ${state.messages.length} message(s), ~${tokens.toLocaleString()} tokens estimated`,
        ),
      );
      return true;
    }
    case "/compact": {
      const before = state.messages.length;
      const compacted = compactMessages(state.messages, { budgetTokens: 0 });
      state.messages.splice(0, state.messages.length, ...compacted);
      console.log(
        chalk.dim(
          `  compacted ${before} → ${state.messages.length} messages (~${estimateMessagesTokens(state.messages).toLocaleString()} tokens)`,
        ),
      );
      return true;
    }
    case "/scope": {
      const sub = (args[0] ?? "show").toLowerCase();
      const {
        loadScope,
        saveScope,
        addScopeTargets,
        clearScope,
        isScopeActive,
        getScopePath,
        resetScopeCache,
      } = await import("./store/scope.js");
      if (sub === "show" || sub === "ls" || sub === "list") {
        resetScopeCache();
        const scope = await loadScope();
        if (!scope) {
          console.log(chalk.dim("  no engagement scope configured"));
          console.log(
            chalk.dim(`  expected at: ${getScopePath()}`),
          );
          console.log(
            chalk.dim(
              "  create one with: /scope add domain1,domain2 or `clai scope add --targets ...`",
            ),
          );
          return true;
        }
        const status = isScopeActive(scope)
          ? chalk.green("active")
          : chalk.yellow("expired or empty");
        console.log(
          chalk.dim(`  scope: ${scope.name ?? "(unnamed)"} [${status}]`),
        );
        console.log(
          chalk.dim(`  authorized: ${scope.authorizedTargets.join(", ")}`),
        );
        if (scope.excludedTargets && scope.excludedTargets.length > 0) {
          console.log(
            chalk.dim(`  excluded:   ${scope.excludedTargets.join(", ")}`),
          );
        }
        if (scope.expiresAt) {
          console.log(chalk.dim(`  expires:    ${scope.expiresAt}`));
        }
        return true;
      }
      if (sub === "clear" || sub === "reset" || sub === "off") {
        await clearScope();
        console.log(chalk.dim("  engagement scope cleared"));
        return true;
      }
      if (sub === "add") {
        const rest = args.slice(1).join(" ").trim();
        if (!rest) {
          console.log(chalk.dim("  usage: /scope add <target1,target2,...>"));
          return true;
        }
        const targets = rest
          .split(/\s+/)[0]!
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        if (targets.length === 0) {
          console.log(chalk.dim("  no targets parsed"));
          return true;
        }
        const scope = await addScopeTargets(targets);
        console.log(
          chalk.dim(
            `  added ${targets.length} target(s); scope now has ${scope.authorizedTargets.length}`,
          ),
        );
        return true;
      }
      if (sub === "new" || sub === "set") {
        const rest = args.slice(1).join(" ").trim();
        if (!rest) {
          console.log(
            chalk.dim(
              "  usage: /scope new <target1,target2,...> [name=<engagement>] [expires=<iso>]",
            ),
          );
          return true;
        }
        // Parse: first whitespace-delimited token is the targets list,
        // remaining `key=value` pairs configure name/expires/note.
        const tokens = rest.split(/\s+/);
        const targetsRaw = tokens[0] ?? "";
        const targets = targetsRaw
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        if (targets.length === 0) {
          console.log(chalk.dim("  no targets parsed"));
          return true;
        }
        let name: string | undefined;
        let expires: string | undefined;
        let note: string | undefined;
        let exclude: string[] | undefined;
        for (const token of tokens.slice(1)) {
          const eq = token.indexOf("=");
          if (eq < 0) continue;
          const key = token.slice(0, eq).toLowerCase();
          const value = token.slice(eq + 1);
          if (key === "name") name = value;
          else if (key === "expires") expires = value;
          else if (key === "note") note = value;
          else if (key === "exclude")
            exclude = value
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean);
        }
        const scope = {
          name,
          authorizedTargets: targets,
          excludedTargets: exclude,
          authorizationNote: note,
          createdAt: new Date().toISOString(),
          expiresAt: expires,
        };
        await saveScope(scope);
        console.log(
          chalk.dim(
            `  saved scope${name ? ` "${name}"` : ""} with ${targets.length} target(s)`,
          ),
        );
        return true;
      }
      console.log(
        chalk.dim("  usage: /scope [show|clear|new <targets>|add <targets> [key=value]...]"),
      );
      return true;
    }
    case "/privacy": {
      const sub = (args[0] ?? "status").toLowerCase();
      if (sub === "on" || sub === "enable") {
        updateConfig({ privateMode: true });
        console.log(
          chalk.dim(
            "  privateMode: " +
              chalk.green("on") +
              "  (history not written; in-memory only)",
          ),
        );
        return true;
      }
      if (sub === "off" || sub === "disable") {
        updateConfig({ privateMode: false });
        console.log(chalk.dim("  privateMode: " + chalk.dim("off")));
        return true;
      }
      if (sub === "status" || sub === "show") {
        const cfg = getConfig();
        console.log(
          chalk.dim(
            `  privateMode: ${cfg.privateMode ? chalk.green("on") : chalk.dim("off")}  retention: ${cfg.historyRetentionLimit || "unlimited"}`,
          ),
        );
        return true;
      }
      const { clearAllHistory } = await import("./store/history.js");
      const { clearAuditLogs, clearArtifacts } = await import(
        "./store/logs.js"
      );
      if (sub === "clear-history") {
        const r = await clearAllHistory();
        console.log(chalk.dim(`  history cleared (${r.detail || "ok"})`));
        return true;
      }
      if (sub === "clear-logs") {
        const r = await clearAuditLogs();
        console.log(chalk.dim(`  audit logs cleared (${r.removed} files)`));
        return true;
      }
      if (sub === "clear-artifacts") {
        const r = await clearArtifacts();
        console.log(chalk.dim(`  artifacts cleared (${r.removed} files)`));
        return true;
      }
      if (sub === "clear-all") {
        const a = await clearAllHistory();
        const b = await clearAuditLogs();
        const c = await clearArtifacts();
        console.log(
          chalk.dim(
            `  history (${a.detail || "ok"}); logs (${b.removed}); artifacts (${c.removed})`,
          ),
        );
        return true;
      }
      console.log(
        chalk.dim(
          "  usage: /privacy [status|on|off|clear-history|clear-logs|clear-artifacts|clear-all]",
        ),
      );
      return true;
    }
    case "/freeonly": {
      const arg = (args[0] ?? "").toLowerCase().trim();
      if (!arg) {
        const value = getConfig().freeOnly;
        console.log(
          chalk.dim(
            `  freeOnly: ${value ? chalk.green("on") : chalk.dim("off")}  (applies when /fallback is on)`,
          ),
        );
        return true;
      }
      if (arg === "on" || arg === "true" || arg === "enable") {
        updateConfig({ freeOnly: true });
        console.log(chalk.dim("  freeOnly: " + chalk.green("on")));
        return true;
      }
      if (arg === "off" || arg === "false" || arg === "disable") {
        updateConfig({ freeOnly: false });
        console.log(chalk.dim("  freeOnly: " + chalk.dim("off")));
        return true;
      }
      console.log(chalk.dim("  usage: /freeonly [on|off]"));
      return true;
    }
    case "/fallback": {
      const arg = (args[0] ?? "").toLowerCase().trim();
      if (!arg) {
        const value = getConfig().providerFallback;
        console.log(
          chalk.dim(
            `  fallback: ${value ? chalk.green("on") : chalk.dim("off")}  (selected provider/model only when off)`,
          ),
        );
        return true;
      }
      if (arg === "on" || arg === "true" || arg === "enable") {
        updateConfig({ providerFallback: true });
        console.log(chalk.dim("  fallback: " + chalk.green("on")));
        return true;
      }
      if (arg === "off" || arg === "false" || arg === "disable") {
        updateConfig({ providerFallback: false });
        console.log(chalk.dim("  fallback: " + chalk.dim("off")));
        return true;
      }
      console.log(chalk.dim("  usage: /fallback [on|off]"));
      return true;
    }
    case "/output": {
      const target = args[0] ?? "last";
      if (target === "list" || target === "ls") {
        const all = listViewports();
        if (all.length === 0) {
          console.log(chalk.dim("  no tool outputs recorded yet"));
        } else {
          for (const v of all) {
            console.log(
              chalk.dim(
                `  ${v.id} — ${v.toolName} ${v.argsDisplay}${v.artifactPath ? ` (${v.artifactPath})` : ""}`,
              ),
            );
          }
        }
        return true;
      }
      const viewport =
        target === "last" ? getLastViewport() : getViewport(target);
      if (!viewport) {
        console.log(chalk.dim(`  no viewport: ${target}`));
        return true;
      }
      // On a TTY, open the alternate-screen pager so users can scroll long
      // outputs and close with q / Ctrl+O. In non-TTY contexts (piped or
      // CI), fall back to the inline toggle so the artifact still lands in
      // the captured stdout.
      if (process.stdout.isTTY) {
        await openViewportPager(viewport.id);
      } else {
        await toggleViewport(viewport.id);
      }
      return true;
    }
    case "/think":
    case "/thinking": {
      const thinking = getLastThinking();
      if (thinking) {
        console.log(renderThinkingBlock(thinking));
      } else {
        console.log(chalk.dim("  No thinking from last response."));
      }
      return true;
    }
    case "/exit":
    case "/quit":
      return false;
    case "/update":
      await runUpdate();
      return true;
    case "/help":
      console.log(help());
      return true;
    default:
      console.log(chalk.dim(`  unknown command: ${command}. Try /help`));
      return true;
  }
}

export async function startRepl(options: ReplOptions = {}): Promise<void> {
  const config = getConfig();
  const provider = options.provider
    ? assertProvider(options.provider)
    : config.defaultProvider;
  const state = {
    mode: options.mode ?? config.defaultMode,
    provider,
    model: options.model ?? getProviderModel(provider),
    messages: [] as ChatMessage[],
    session: createSessionPolicy(),
  };

  const promptHistory: string[] = [];
  let isReadingPrompt = false;
  let outputShortcutBusy = false;
  let lastOutputShortcutAt = 0;

  emitKeypressEvents(input);

  // Survive stray promise rejections (eg AbortError from a cancelled
  // SSE reader) without killing the REPL. Anything that ends up here
  // is a bug — log it dim and keep the prompt alive so the user
  // doesn't lose their session over a transient network hiccup.
  const handleUnhandledRejection = (reason: unknown): void => {
    if (isAbortLikeError(reason)) return; // expected during ESC/abort
    const message = reason instanceof Error ? reason.message : String(reason);
    process.stderr.write(
      chalk.dim(`\n  ⚠ background error suppressed: ${message}\n`),
    );
  };
  const handleUncaughtException = (error: unknown): void => {
    if (isAbortLikeError(error)) return;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      chalk.dim(`\n  ⚠ uncaught error suppressed: ${message}\n`),
    );
  };
  process.on("unhandledRejection", handleUnhandledRejection);
  process.on("uncaughtException", handleUncaughtException);

  // ── ESC / Ctrl+C abort; Ctrl+T toggles hidden thinking ──────────────────
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  const handleThinkingShortcut = (): void => {
    process.stdout.write(`\n${renderThinkingToggleMessage()}\n`);
  };
  const handleOutputShortcut = async (): Promise<void> => {
    if (outputShortcutBusy) return;
    const now = Date.now();
    if (now - lastOutputShortcutAt < 400) return;
    lastOutputShortcutAt = now;
    outputShortcutBusy = true;
    try {
      const v = getLastViewport();
      if (!v) {
        process.stdout.write(chalk.dim("\n  (no tool output to expand yet)\n"));
        return;
      }
      // While a stream is in flight, opening the alt-screen pager would
      // collide with incoming tokens — drop a hint instead so the user
      // knows the pager is available once the run completes. Hitting
      // Ctrl+O at the prompt afterward will then open it.
      if (currentAbortController) {
        process.stdout.write(
          chalk.dim(
            `\n  (stream in progress — press Ctrl+O at the prompt after it finishes to open ${v.toolName})\n`,
          ),
        );
        return;
      }
      // Idle path: open the full output in the alternate-screen pager.
      // Keys (q / ESC / Ctrl+O) inside the pager close it and return here.
      await openViewportPager(v.id);
    } finally {
      outputShortcutBusy = false;
    }
  };
  const handleKeypress = (
    _sequence: string,
    key: { ctrl?: boolean; name?: string },
  ): void => {
    if (isPagerActive()) return;
    if (isCtrlT(key) && !isReadingPrompt)
      handleThinkingShortcut();
    if (isCtrlO(key) && !isReadingPrompt) {
      void handleOutputShortcut();
    }
    if (
      (isEscape(key) || isCtrlC(key)) &&
      currentAbortController
    ) {
      currentAbortController.abort();
    }
  };
  input.on("keypress", handleKeypress);
  const siginfo = "SIGINFO" as NodeJS.Signals;
  let siginfoRegistered = false;
  try {
    process.on(siginfo, handleThinkingShortcut);
    siginfoRegistered = true;
  } catch {
    // SIGINFO is macOS/BSD-specific; other platforms can still use /think.
  }
  let lastSigintAt = 0;
  // Ctrl+C while streaming → abort. While idle at a prompt, the
  // readPromptLine handler clears the line on first press and exits on
  // second press within 1s; so SIGINT here only acts as a fallback for
  // the rare case where no prompt or stream is active.
  const handleSigint = (): void => {
    if (currentAbortController) {
      currentAbortController.abort();
      return;
    }
    if (isReadingPrompt) {
      // readPromptLine's keypress handler owns the prompt-level Ctrl+C
      // semantics; do nothing here so the two paths never fight.
      return;
    }
    const now = Date.now();
    if (now - lastSigintAt < 1_000) {
      console.log();
      process.exit(0);
    }
    lastSigintAt = now;
    console.log(chalk.dim("\n  (press Ctrl+C again to exit)"));
  };
  process.on("SIGINT", handleSigint);

  // ── Startup banner ──────────────────────────────────────────────────────
  console.log(renderBanner(getCurrentVersion()));
  console.log(
    renderSessionInfo({
      workdir: process.cwd(),
      model: state.model,
      provider: state.provider,
      mode: state.mode,
    }),
  );
  console.log(renderSuggestions());
  console.log(
    chalk.dim(
      "  ESC abort  │  Ctrl+C clears input  │  Ctrl+T or /think for thinking  │  Ctrl+O opens full tool output (q to close)\n",
    ),
  );

  // Hint thinking-capable users that the toggle exists. We default it to
  // off for speed, since on NIM many models route through a much slower
  // chat-template path when reasoning is enabled.
  if (
    !getConfig().thinking.enabled &&
    modelSupportsThinking(state.provider, state.model)
  ) {
    console.log(
      chalk.dim("  💡 ") +
        chalk.dim(`${state.model} supports reasoning. Run `) +
        chalk.cyan("/variants on") +
        chalk.dim(" (or ") +
        chalk.cyan("low|medium|high") +
        chalk.dim(") to enable it.\n"),
    );
  }

  // Non-blocking update check
  checkForUpdateSilent();

  try {
    while (true) {
      isReadingPrompt = true;
      const line = (
        await readPromptLine({
          history: promptHistory,
          onThinkingShortcut: handleThinkingShortcut,
          onOutputShortcut: handleOutputShortcut,
        })
      ).trim();
      isReadingPrompt = false;
      if (!line) continue;
      // Only remember real prompts in the history ring. Slash commands
      // are operational toggles (eg /model, /provider) and surfacing them
      // when the user presses ↑ to recall a past prompt is just noise.
      if (
        !line.startsWith("/") &&
        promptHistory[promptHistory.length - 1] !== line
      ) {
        promptHistory.push(line);
      }
      if (line.startsWith("/")) {
        const shouldContinue = await handleSlash(line, state);
        if (!shouldContinue) break;
        continue;
      }

      try {
        clearThinking();
        let assistantContent = "";
        if (state.mode === "ask") {
          assistantContent = await withAbortableInput(async (signal) =>
            streamWithAbort(async (runSignal, onToken) => {
              return await runAskStream(line, onToken, {
                provider: state.provider,
                model: state.model,
                history: state.messages,
                signal: runSignal,
              });
            }, signal),
          );
          process.stdout.write("\n");
        } else {
          assistantContent = await withAbortableInput(async (signal) =>
            runAgent(line, {
              provider: state.provider,
              model: state.model,
              history: state.messages,
              signal,
              session: state.session,
            }),
          );
        }
        console.log();
        state.messages.push(
          { role: "user", content: line },
          { role: "assistant", content: assistantContent },
        );
      } catch (error) {
        if (error instanceof AbortRunError) {
          process.stdout.write(chalk.yellow("\n  ⏹ Aborted.\n"));
          continue;
        }
        console.error(
          chalk.red(error instanceof Error ? error.message : String(error)),
        );
      }
    }
  } finally {
    isReadingPrompt = false;
    input.off("keypress", handleKeypress);
    process.off("SIGINT", handleSigint);
    process.off("unhandledRejection", handleUnhandledRejection);
    process.off("uncaughtException", handleUncaughtException);
    if (siginfoRegistered) process.off(siginfo, handleThinkingShortcut);
    if (state.messages.length > 0) {
      // Honor `--no-history` and the persistent privateMode setting.
      // The session.allow set is already in-memory only; saveSession itself
      // also bails early when privateMode is on, but checking here keeps
      // intent obvious in the call site.
      if (!options.noHistory && !getConfig().privateMode) {
        await saveSession(state.messages, `repl-${new Date().toISOString()}`);
      }
    }
    if (input.isTTY) input.setRawMode(false);
  }
}
