import {
  fetchLatestVersion,
  getCurrentVersion,
  updateCheckDisabledReason,
} from "../../commands/update.js";
import type { UpdatesPort, UpdateStatus } from "../ports/updates-port.js";

import { compareVersions, releaseVersion } from "../../commands/update/verification.js";

export function createCurrentUpdatesPort(
  fetchLatest: (signal?: AbortSignal) => Promise<string | undefined> = fetchLatestVersion,
  disabledReason: () => string | undefined = updateCheckDisabledReason,
): UpdatesPort {
  return {
    async check(signal?: AbortSignal): Promise<UpdateStatus> {
      const currentVersion = getCurrentVersion();
      const blocked = disabledReason();
      if (blocked) {
        return {
          state: "unknown",
          currentVersion,
          updateAvailable: false,
          detail: blocked,
        };
      }
      let latestVersion: string | undefined;
      try {
        latestVersion = releaseVersion(await fetchLatest(signal));
      } catch (error) {
        return {
          state: "error",
          currentVersion,
          updateAvailable: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      if (!latestVersion) {
        return {
          state: "unknown",
          currentVersion,
          updateAvailable: false,
          detail: "the release feed did not return a version",
        };
      }
      const updateAvailable = compareVersions(currentVersion, latestVersion) < 0;
      return {
        state: updateAvailable ? "update-available" : "current",
        currentVersion,
        latestVersion,
        updateAvailable,
      };
    },
  };
}
