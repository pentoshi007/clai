import type { ToolDefinition } from "../types.js";
import { profileDigest } from "./legacy-profile.js";
import { resolvePromptProfile } from "./profile-catalog.js";
import { freezePromptBinding, profileRecoveryError, type PromptProfileState, type RoutePromptBinding } from "./profile-state.js";

export interface ProfileShape {
  readonly compact: boolean;
  readonly slimNative: boolean;
  readonly imageView: boolean;
  readonly native: boolean;
  readonly toolNames: readonly string[];
}
interface BoundArtifacts {
  readonly binding: RoutePromptBinding;
  readonly prompt: string;
  readonly tools: readonly ToolDefinition[];
  readonly executionRulesInSystem: boolean;
}
const caches = new WeakMap<PromptProfileState, Map<string, BoundArtifacts>>();

function freezeTree<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freezeTree(nested);
    Object.freeze(value);
  }
  return value;
}

function bindingDigest(binding: Omit<RoutePromptBinding, "bindingDigest">): string {
  return profileDigest(JSON.stringify([binding.route, binding.profile, binding.profileDigest, binding.compact, binding.slimNative, binding.imageView,
    binding.native, binding.toolNames, binding.promptDigest, binding.toolsDigest]));
}

export function validateProfileArtifacts(state: PromptProfileState): void {
  resolvePromptProfile(state.defaultProfile);
  for (const binding of state.bindings) {
    bindPromptProfile(state, binding.route, binding);
  }
}

export function bindPromptProfile(state: PromptProfileState, route: string, shape: ProfileShape): BoundArtifacts {
  const stored = state.bindings.find((binding) => binding.route === route);
  if (stored && (stored.native !== shape.native || stored.bindingDigest !== bindingDigest(stored))) throw profileRecoveryError();
  const cache = caches.get(state) ?? new Map<string, BoundArtifacts>();
  caches.set(state, cache);
  const cached = cache.get(route);
  if (cached && cached.binding === stored) return cached;
  if (!stored && state.bindings.length >= 128) throw profileRecoveryError();
  const profile = resolvePromptProfile(stored?.profile ?? state.defaultProfile);
  const provisional = stored ?? { ...shape, route, profile: profile.id, profileDigest: profile.digest, promptDigest: "", toolsDigest: "", bindingDigest: "", toolNames: [...shape.toolNames] };
  const prompt = profile.render(provisional);
  const selected = profile.tools(provisional.toolNames);
  if (selected.length !== provisional.toolNames.length) throw profileRecoveryError();
  const tools = provisional.native ? selected : [];
  const promptDigest = profileDigest(prompt);
  const toolsDigest = profileDigest(JSON.stringify(tools));
  if (stored && (stored.profileDigest !== profile.digest || stored.promptDigest !== promptDigest || stored.toolsDigest !== toolsDigest)) throw profileRecoveryError();
  if (tools.some((definition) => !provisional.toolNames.includes(definition.name))) throw profileRecoveryError();
  const complete = { ...provisional, promptDigest, toolsDigest };
  const binding = freezePromptBinding({ ...complete, bindingDigest: bindingDigest(complete) });
  if (!stored) state.bindings.push(binding);
  freezeTree(tools);
  const artifacts = Object.freeze({ binding: stored ?? binding, prompt, tools, executionRulesInSystem: profile.executionRulesInSystem(binding.compact) });
  cache.set(route, artifacts);
  return artifacts;
}
