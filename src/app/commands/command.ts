
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
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly usage?: string | undefined;
  readonly description: string;
  readonly contexts?: readonly CommandContext[];
}

export interface CommandInvocation {
  readonly name: string;
  readonly args: string;
  readonly context: CommandContext;
}

export type CommandHandler = (
  invocation: CommandInvocation,
) => void | Promise<void>;

export function normalizeCommandName(nameOrAlias: string): string {
  return nameOrAlias.trim().replace(/^\/+/, "").toLowerCase();
}
