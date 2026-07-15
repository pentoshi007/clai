/**
 * Command context = the focused surface a command is allowed to run in
 * (PICK-002, CMD-002). `global` commands run anywhere the focused surface
 * permits; others are scoped.
 */
export type CommandContext =
  | "global"
  | "composer"
  | "picker"
  | "modal"
  | "secret"
  | "plan"
  | "transcript"
  | "transcript-search";

export interface CommandDefinition {
  /** Canonical name without the leading slash, e.g. "model". */
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly usage?: string | undefined;
  readonly description: string;
  /** Surfaces this command is available in; defaults to ["global"]. */
  readonly contexts?: readonly CommandContext[];
}

export interface CommandInvocation {
  /** Canonical resolved name (aliases are already resolved). */
  readonly name: string;
  /** Raw argument string, trimmed. */
  readonly args: string;
  readonly context: CommandContext;
}

export type CommandHandler = (
  invocation: CommandInvocation,
) => void | Promise<void>;

export function normalizeCommandName(nameOrAlias: string): string {
  return nameOrAlias.trim().replace(/^\/+/, "").toLowerCase();
}
