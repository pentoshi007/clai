import { existsSync } from "node:fs";
import { slashCommands } from "./catalog.js";
import {
  isCommandShapedToken,
  isSlashLookalike,
  splitCommandInput,
} from "./command-input.js";
import {
  normalizeCommandName,
  type CommandContext,
  type CommandDefinition,
  type CommandHandler,
  type CommandInvocation,
} from "./command.js";


const ALIAS_GROUPS: Record<string, readonly string[]> = {
  orchestrator: ["orchestration", "orchastrator"],
  search: ["search-provider"],
  effort: ["efforts", "reasoning"],
  think: ["thinking"],
  minimise: ["minimize", "minmize"],
  redraw: ["refresh"],
  exit: ["quit"],
};

export interface CommandHelpEntry {
  readonly command: string;
  readonly usage?: string | undefined;
  readonly description: string;
  readonly aliases: readonly string[];
}


export interface CommandRegistryOptions {
  readonly pathExists?: ((path: string) => boolean) | undefined;
}

export class CommandRegistry {
  private readonly byName = new Map<string, CommandDefinition>();
  private readonly aliasToName = new Map<string, string>();
  private readonly handlers = new Map<string, CommandHandler>();

  constructor(private readonly options: CommandRegistryOptions = {}) {}

  register(definition: CommandDefinition): void {
    const name = normalizeCommandName(definition.name);
    if (this.byName.has(name) || this.aliasToName.has(name)) {
      throw new Error(`duplicate command name: ${name}`);
    }
    this.byName.set(name, { ...definition, name });
    for (const alias of definition.aliases ?? []) {
      const normalized = normalizeCommandName(alias);
      if (this.aliasToName.has(normalized) || this.byName.has(normalized)) {
        throw new Error(`duplicate command alias: ${normalized}`);
      }
      this.aliasToName.set(normalized, name);
    }
  }

  resolve(nameOrAlias: string): string | undefined {
    const name = normalizeCommandName(nameOrAlias);
    if (this.byName.has(name)) return name;
    return this.aliasToName.get(name);
  }

  has(nameOrAlias: string): boolean {
    return this.resolve(nameOrAlias) !== undefined;
  }

  get(nameOrAlias: string): CommandDefinition | undefined {
    const name = this.resolve(nameOrAlias);
    return name ? this.byName.get(name) : undefined;
  }

  all(): CommandDefinition[] {
    return [...this.byName.values()];
  }

  setHandler(nameOrAlias: string, handler: CommandHandler): void {
    const name = this.resolve(nameOrAlias);
    if (!name) throw new Error(`unknown command: ${nameOrAlias}`);
    this.handlers.set(name, handler);
  }

  suggestions(prefix: string): CommandDefinition[] {
    const needle = normalizeCommandName(prefix);
    const matches: CommandDefinition[] = [];
    for (const def of this.byName.values()) {
      const names = [def.name, ...(def.aliases ?? [])];
      if (names.some((n) => n.startsWith(needle))) matches.push(def);
    }
    return matches;
  }

  help(): CommandHelpEntry[] {
    return this.all().map((def) => ({
      command: `/${def.name}`,
      usage: def.usage,
      description: def.description,
      aliases: (def.aliases ?? []).map((a) => `/${a}`),
    }));
  }

  parse(
    line: string,
    context: CommandContext = "global",
  ): CommandInvocation | undefined {
    const parts = this.commandParts(line);
    if (!parts) return undefined;
    const { token: rawName, args } = parts;
    const exact = this.resolve(rawName);
    if (exact) return { name: exact, args, context };
    const matches = this.suggestions(rawName);
    if (matches.length === 1) {
      return { name: matches[0]!.name, args, context };
    }
    if (matches.length > 1) {
      const shortest = matches.reduce((best, candidate) =>
        candidate.name.length < best.name.length ? candidate : best,
      );
      const tied = matches.filter(
        (candidate) => candidate.name.length === shortest.name.length,
      );
      if (tied.length === 1) return { name: shortest.name, args, context };
    }
    return undefined;
  }

  looksLikeCommand(line: string): boolean {
    const parts = this.commandParts(line);
    if (!parts) return false;
    if (this.knows(parts.token)) return true;
    if (!isCommandShapedToken(parts.token)) return false;
    return this.options.pathExists?.(`/${parts.token}`) !== true;
  }

  private knows(token: string): boolean {
    return this.resolve(token) !== undefined || this.suggestions(token).length > 0;
  }

  private commandParts(line: string): { readonly token: string; readonly args: string } | undefined {
    const parts = splitCommandInput(line);
    if (!parts) return undefined;
    const { slash, token, rest } = parts;
    if (!token || token.includes("/") || token.includes("\\")) return undefined;
    if (isSlashLookalike(slash) && !this.knows(token)) return undefined;
    return { token, args: rest.trim() };
  }

  async dispatch(invocation: {
    name: string;
    args?: string | undefined;
    context?: CommandContext | undefined;
  }): Promise<boolean> {
    const name = this.resolve(invocation.name);
    if (!name) return false;
    const handler = this.handlers.get(name);
    if (!handler) return false;
    await handler({
      name,
      args: invocation.args ?? "",
      context: invocation.context ?? "global",
    });
    return true;
  }
}


export function buildDefaultCommandRegistry(
  options: CommandRegistryOptions = { pathExists: existsSync },
): CommandRegistry {
  const registry = new CommandRegistry(options);
  const aliasNames = new Set<string>();
  for (const aliases of Object.values(ALIAS_GROUPS)) {
    for (const alias of aliases) aliasNames.add(alias);
  }

  for (const command of slashCommands) {
    const name = normalizeCommandName(command.command);
    if (aliasNames.has(name)) continue;
    const aliases = ALIAS_GROUPS[name];
    registry.register({
      name,
      description: command.description,
      usage: command.usage,
      ...(aliases ? { aliases } : {}),
    });
  }

  return registry;
}
