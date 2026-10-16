import { DENSITY_SECTIONS } from "./candidate-density-embedded.js";
import { legacyPromptProfile, profileDigest, type PromptProfile } from "./legacy-profile.js";
import type { RoutePromptBinding } from "./profile-state.js";

export function densitySections(value: string): ReadonlyMap<string, string> {
  return new Map([...value.matchAll(/^# ([^\n]+)\n([\s\S]*?)(?=^# |$(?![\s\S]))/gm)].map((match) => [match[1]!, match[0].trim()]));
}

const replacements = densitySections(DENSITY_SECTIONS);

export function densifyLegacyPrompt(prompt: string): string {
  return prompt.replace(/^# ([^\n]+)\n[\s\S]*?(?=^# |$(?![\s\S]))/gm, (section: string, heading: string) => {
    const replacement = replacements.get(heading);
    return replacement ? `${replacement}\n\n` : section;
  });
}

let profile: PromptProfile | undefined;
export function densityPromptProfile(): PromptProfile {
  if (profile) return profile;
  const legacy = legacyPromptProfile();
  profile = Object.freeze({ ...legacy, id: "density-v1", digest: profileDigest(JSON.stringify({ version: 1, legacy: legacy.digest, sections: DENSITY_SECTIONS })),
    render: (binding: RoutePromptBinding) => binding.compact ? legacy.render(binding) : densifyLegacyPrompt(legacy.render(binding)),
  });
  return profile;
}
