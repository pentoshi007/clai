import { densityPromptProfile } from "./density-profile.js";
import { legacyPromptProfile, type PromptProfile } from "./legacy-profile.js";
import { profileRecoveryError } from "./profile-state.js";
import { conciseToolsProfile } from "./concise-tools-profile.js";

export function resolvePromptProfile(id: string): PromptProfile {
  if (id === "legacy-v1") return legacyPromptProfile();
  if (id === "density-v1") return densityPromptProfile();
  if (id === "concise-tools-v1" || id === "density-tools-v1") return conciseToolsProfile(id);
  throw profileRecoveryError();
}
