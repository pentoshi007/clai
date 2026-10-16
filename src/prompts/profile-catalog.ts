import { densityPromptProfile } from "./density-profile.js";
import { legacyPromptProfile, type PromptProfile } from "./legacy-profile.js";
import { profileRecoveryError } from "./profile-state.js";

export function resolvePromptProfile(id: string): PromptProfile {
  if (id === "legacy-v1") return legacyPromptProfile();
  if (id === "density-v1") return densityPromptProfile();
  throw profileRecoveryError();
}
