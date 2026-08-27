import type { McpInputDefinition } from "./types.js";

export interface McpSubstitutionContext {
  readonly workspaceFolder?: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly inputs: ReadonlyMap<string, McpInputDefinition>;
}

export interface McpSubstitutionResult {
  readonly value: string;
  readonly secretValues: readonly string[];
  readonly missing: readonly string[];
}

const VARIABLE_PATTERN = /\$\{([^}]+)\}/g;

const MAX_RESOLUTION_DEPTH = 8;

function resolveInputValue(
  input: McpInputDefinition,
  context: McpSubstitutionContext,
  depth: number,
  secretSink: Set<string>,
  missingSink: Set<string>,
): string {
  const fromEnv = context.env[input.id];
  const rawDefault = typeof input.default === "string" ? input.default : undefined;
  const rawValue = fromEnv ?? rawDefault;
  if (rawValue === undefined) {
    missingSink.add(`\${input:${input.id}}`);
    return "";
  }
  const resolved = resolveTemplate(rawValue, context, depth + 1, secretSink, missingSink);
  if (input.password === true && resolved.length > 0) secretSink.add(resolved);
  return resolved;
}

function resolveToken(
  token: string,
  context: McpSubstitutionContext,
  depth: number,
  secretSink: Set<string>,
  missingSink: Set<string>,
): string {
  const trimmed = token.trim();
  if (trimmed === "workspaceFolder") {
    if (context.workspaceFolder === undefined || context.workspaceFolder.length === 0) {
      missingSink.add("${workspaceFolder}");
      return "";
    }
    return context.workspaceFolder;
  }
  const envMatch = /^env[:.](.+)$/.exec(trimmed);
  if (envMatch) {
    const key = envMatch[1]!.trim();
    const value = context.env[key];
    if (value === undefined) {
      missingSink.add(`\${env:${key}}`);
      return "";
    }
    if (value.length > 0) secretSink.add(value);
    return value;
  }
  const inputMatch = /^input:(.+)$/.exec(trimmed);
  if (inputMatch) {
    const id = inputMatch[1]!.trim();
    const input = context.inputs.get(id);
    if (!input) {
      missingSink.add(`\${input:${id}}`);
      return "";
    }
    return resolveInputValue(input, context, depth, secretSink, missingSink);
  }
  missingSink.add(`\${${trimmed}}`);
  return "";
}

function resolveTemplate(
  template: string,
  context: McpSubstitutionContext,
  depth: number,
  secretSink: Set<string>,
  missingSink: Set<string>,
): string {
  if (depth > MAX_RESOLUTION_DEPTH) return template;
  return template.replace(VARIABLE_PATTERN, (_full, token: string) =>
    resolveToken(token, context, depth, secretSink, missingSink),
  );
}

export function substituteVariables(
  template: string,
  context: McpSubstitutionContext,
): McpSubstitutionResult {
  const secretSink = new Set<string>();
  const missingSink = new Set<string>();
  const value = resolveTemplate(template, context, 0, secretSink, missingSink);
  return {
    value,
    secretValues: [...secretSink],
    missing: [...missingSink],
  };
}

export function buildInputMap(
  inputs: readonly McpInputDefinition[] | undefined,
): Map<string, McpInputDefinition> {
  const map = new Map<string, McpInputDefinition>();
  for (const input of inputs ?? []) {
    if (input && typeof input.id === "string" && input.id.length > 0) {
      map.set(input.id, input);
    }
  }
  return map;
}
