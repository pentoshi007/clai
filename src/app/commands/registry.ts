import { slashCommands } from "./catalog.js";
import {
  normalizeCommandName,
  type CommandContext,
  type CommandDefinition,
  type CommandHandler,
  type CommandInvocation,
} from "./command.js";


const ALIAS_GROUPS: Record<string, readonly string[]> = {
  search: ["search-provider"],
  effort: ["reasoning"],
  think: ["thinking"],
  exit: ["quit"],
};

export interface CommandHelpEntry {
  readonly command: string;
  readonly usage?: string | undefined;
  readonly description: string;
  readonly aliases: readonly string[];
}


export class CommandRegistry {
  private readonly byName = new Map<string, CommandDefinition>();
  private readonly aliasToName = new Map<string, string>();
  private readonly handlers = new Map<string, CommandHandler>();

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

  /** Prefix match over canonical names and aliases (for completion menus). */
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

  /** Parse a raw `/name args` line into a resolved invocation, or undefined. */
  parse(
    line: string,
    context: CommandContext = "global",
  ): CommandInvocation | undefined {
    if (!line.startsWith("/")) return undefined;
    const rest = line.slice(1);
    const boundary = rest.search(/\s/);
    const rawName = boundary === -1 ? rest : rest.slice(0, boundary);
    const args = boundary === -1 ? "" : rest.slice(boundary + 1).trim();
    // Absolute paths (/Users/..., /tmp/foo) are prompts, not commands.
    if (!rawName || rawName.includes("/") || rawName.includes("\\")) {
      return undefined;
    }
    const exact = this.resolve(rawName);
    if (exact) return { name: exact, args, context };
    // Unique prefix match so a broken completion menu still dispatches
    // "/mod" → /model, "/imp" → /implement, etc.
    if (rawName.length === 0) return undefined;
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
    if (!line.startsWith("/") || line.length < 2) return false;
    const firstToken = line.slice(1).split(/\s/)[0] ?? "";
    if (!firstToken || firstToken.includes("/") || firstToken.includes("\\")) {
      return false;
    }
    if (this.resolve(firstToken)) return true;
    if (this.suggestions(firstToken).length > 0) return true;
    return /^[a-z][a-z0-9-]*$/i.test(firstToken);
  }

  /** Resolve + run the registered handler. Returns false if unknown/unhandled. */
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


export function buildDefaultCommandRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  const aliasNames = new Set<string>();
  for (const aliases of Object.values(ALIAS_GROUPS)) {
    for (const alias of aliases) aliasNames.add(alias);
  }

  for (const command of slashCommands) {
    const name = normalizeCommandName(command.command);
    if (aliasNames.has(name)) continue; // attached to its canonical below
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
