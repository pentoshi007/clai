import type { RiskDecision } from "../safety/classifier.js";
import type { ToolResult } from "../types.js";

export interface ExternalToolCallOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface ExternalToolDispatcher {
  toolNames(): readonly string[];
  hasTool(name: string): boolean;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: ExternalToolCallOptions,
  ): Promise<ToolResult>;
  canonicalizeToolName?(name: string): string;
  classify?(name: string): RiskDecision | undefined;
  isParallelSafe?(name: string): boolean;
  unavailableToolMessage?(name: string): string;
}

let active: ExternalToolDispatcher | undefined;

export function registerExternalToolDispatcher(
  dispatcher: ExternalToolDispatcher,
): () => void {
  active = dispatcher;
  return () => {
    if (active === dispatcher) active = undefined;
  };
}

export function externalToolDispatcher(): ExternalToolDispatcher | undefined {
  return active;
}

export function externalToolNames(): readonly string[] {
  try {
    return active?.toolNames() ?? [];
  } catch {
    return [];
  }
}

export function isExternalToolName(name: string): boolean {
  try {
    return active?.hasTool(name) === true;
  } catch {
    return false;
  }
}

export function externalToolRisk(name: string): RiskDecision | undefined {
  try {
    return active?.classify?.(name);
  } catch {
    return undefined;
  }
}

export function isExternalToolParallelSafe(name: string): boolean {
  try {
    return active?.isParallelSafe?.(name) === true;
  } catch {
    return false;
  }
}

export function canonicalizeExternalToolName(name: string): string {
  try {
    return active?.canonicalizeToolName?.(name) ?? name;
  } catch {
    return name;
  }
}
