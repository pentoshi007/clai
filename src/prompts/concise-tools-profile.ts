import type { ToolDefinition } from "../types.js";
import { getToolDefinitions } from "../tools/definitions.js";
import { conciseToolDefinitions } from "../tools/definitions/candidate-descriptions.js";
import { MIN_MAX_BYTES, MAX_MAX_BYTES, DEFAULT_MAX_BYTES } from "../tools/web/types.js";
import { legacyPromptProfile, profileDigest, type PromptProfile } from "./legacy-profile.js";
import { densityPromptProfile } from "./density-profile.js";
import type { RoutePromptBinding } from "./profile-state.js";

const profiles = new Map<string, PromptProfile>();
const textBounds = `web.fetch maxBytes is an integer in [${MIN_MAX_BYTES}, ${MAX_MAX_BYTES}] captured wire-body bytes (default ${DEFAULT_MAX_BYTES}); raise it on truncated=true only within these bounds.`;

export function conciseToolsProfile(id: "concise-tools-v1" | "density-tools-v1"): PromptProfile {
  const cached = profiles.get(id);
  if (cached) return cached;
  const base = id === "density-tools-v1" ? densityPromptProfile() : legacyPromptProfile();
  const definitions = conciseToolDefinitions(legacyPromptProfile().tools(getToolDefinitions().map((definition) => definition.name)));
  const profile: PromptProfile = Object.freeze({ ...base, id,
    digest: profileDigest(JSON.stringify({ version: 1, core: base.digest, definitions, textBounds })),
    render: (binding: RoutePromptBinding) => {
      const prompt = base.render(binding);
      return binding.native || !binding.toolNames.includes("web.fetch") ? prompt : `${prompt}\n\n${textBounds}`;
    },
    tools: (names: readonly string[]): ToolDefinition[] => structuredClone(definitions.filter((definition) => names.includes(definition.name))),
  });
  profiles.set(id, profile);
  return profile;
}
