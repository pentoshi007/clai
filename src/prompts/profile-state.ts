export interface RoutePromptBinding {
  readonly route: string;
  readonly profile: string;
  readonly profileDigest: string;
  readonly compact: boolean;
  readonly slimNative: boolean;
  readonly imageView: boolean;
  readonly native: boolean;
  readonly toolNames: readonly string[];
  readonly promptDigest: string;
  readonly toolsDigest: string;
  readonly bindingDigest: string;
}

export interface PromptProfileState {
  readonly version: 1;
  readonly defaultProfile: string;
  readonly bindings: RoutePromptBinding[];
}

export function profileRecoveryError(): Error {
  return new Error("Prompt profile is missing, corrupt or unsupported. Keep this history; use a build containing its exact profile artifacts, or explicitly start a new session. No replacement profile was selected.");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function binding(value: unknown): value is RoutePromptBinding {
  if (!record(value)) return false;
  const keys = ["route", "profile", "profileDigest", "compact", "slimNative", "imageView", "native", "toolNames", "promptDigest", "toolsDigest", "bindingDigest"];
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)) &&
    typeof value.route === "string" && value.route.length > 0 && value.route.length <= 2048 &&
    typeof value.profile === "string" && value.profile.length > 0 && value.profile.length <= 128 &&
    [value.compact, value.slimNative, value.imageView, value.native].every((entry) => typeof entry === "boolean") &&
    [value.profileDigest, value.promptDigest, value.toolsDigest, value.bindingDigest].every(digest) &&
    Array.isArray(value.toolNames) && value.toolNames.length > 0 && value.toolNames.length <= 64 &&
    value.toolNames.every((name: unknown) => typeof name === "string" && name.length > 0 && name.length <= 128) &&
    new Set(value.toolNames).size === value.toolNames.length;
}

export function freezePromptBinding(value: RoutePromptBinding): RoutePromptBinding {
  Object.freeze(value.toolNames);
  return Object.freeze(value);
}

export function parsePromptProfiles(value: unknown): PromptProfileState | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || value.version !== 1 || typeof value.defaultProfile !== "string" || !value.defaultProfile || value.defaultProfile.length > 128 ||
    Object.keys(value).length !== 3 || !Array.isArray(value.bindings) || value.bindings.length > 128 || !value.bindings.every(binding)) throw profileRecoveryError();
  const bindings = value.bindings.map((entry) => freezePromptBinding(structuredClone(entry)));
  if (new Set(bindings.map((entry) => entry.route)).size !== bindings.length) throw profileRecoveryError();
  return Object.freeze({ version: 1, defaultProfile: value.defaultProfile, bindings });
}

export function createPromptProfiles(defaultProfile = "legacy-v1"): PromptProfileState {
  return Object.freeze({ version: 1, defaultProfile, bindings: [] });
}
