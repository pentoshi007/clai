import { isAbsolute, resolve } from "node:path";
import type { ProviderId, ReasoningEffort } from "../src/types.js";

const evaluationProviders: readonly ProviderId[] = ["nvidia", "openai", "anthropic", "gemini"];

export interface EvaluationRoute {
  readonly provider: ProviderId;
  readonly model: string;
  readonly toolCalling: "native" | "text";
  readonly thinking: { readonly enabled: boolean; readonly effort: ReasoningEffort };
}
export interface EvaluationConfig {
  readonly version: 1;
  readonly routes: readonly EvaluationRoute[];
  readonly fixtures: readonly string[];
  readonly repeats: number;
  readonly maxCalls: number;
  readonly scratchRoot: string;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected evaluation configuration object");
  return Object.fromEntries(Object.entries(value));
}
function integer(value: unknown, name: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer in [1, ${maximum}]`);
  return value;
}
function route(value: unknown): EvaluationRoute {
  const raw = object(value);
  const provider = evaluationProviders.find((id) => id === raw.provider);
  if (!provider || typeof raw.model !== "string" || !raw.model.trim()) throw new Error("Each route needs an explicitly supported evaluation provider (nvidia/openai/anthropic/gemini) and model; other collectors remain unimplemented");
  if (raw.toolCalling !== "native" && raw.toolCalling !== "text") throw new Error("Each route needs native or text toolCalling");
  const thinking = object(raw.thinking);
  const efforts: readonly ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  const effort = efforts.find((entry) => entry === thinking.effort);
  if (!effort || typeof thinking.enabled !== "boolean") throw new Error("Each route needs explicit thinking.enabled and effort");
  const allowed = new Set(["provider", "model", "toolCalling", "thinking"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new Error("Unknown or credential-bearing route fields are not permitted");
  return { provider, model: raw.model.trim(), toolCalling: raw.toolCalling, thinking: { enabled: thinking.enabled, effort } };
}
export function parseEvaluationConfig(value: unknown, knownFixtures: readonly string[]): EvaluationConfig {
  const raw = object(value);
  if (raw.version !== 1 || !Array.isArray(raw.routes) || raw.routes.length === 0) throw new Error("Evaluation requires version 1 and explicit routes");
  if (!Array.isArray(raw.fixtures) || raw.fixtures.length === 0) throw new Error("Evaluation requires explicit fixtures");
  const fixtures = raw.fixtures.map((name: unknown) => {
    if (typeof name !== "string" || !knownFixtures.includes(name)) throw new Error("Unknown evaluation fixture");
    return name;
  });
  if (typeof raw.scratchRoot !== "string" || !isAbsolute(raw.scratchRoot)) throw new Error("scratchRoot must be the absolute active session scratch path");
  const allowed = new Set(["version", "routes", "fixtures", "repeats", "maxCalls", "scratchRoot"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new Error("Unknown or credential-bearing evaluation fields are not permitted");
  const routes = raw.routes.map(route);
  const identities = routes.map((entry) => JSON.stringify(entry));
  if (new Set(identities).size !== routes.length || new Set(fixtures).size !== fixtures.length) throw new Error("Duplicate routes or fixtures are not permitted");
  return { version: 1, routes, fixtures, repeats: integer(raw.repeats, "repeats", 100), maxCalls: integer(raw.maxCalls, "maxCalls", 100_000), scratchRoot: resolve(raw.scratchRoot) };
}
export function counterbalancedVariants(repeat: number): readonly ["before" | "after", "before" | "after"] {
  return repeat % 2 === 1 ? ["before", "after"] : ["after", "before"];
}
