import { getConfig, updateConfig } from "../../store/config.js";
import { UPDATE_CHECK_INTERVAL_MS } from "../../commands/update.js";
import { notify } from "../notify.js";
import type { AppServices } from "../bootstrap/composition-root.js";

export async function maybeShowUpdateToast(
  services: AppServices,
  isCancelled: () => boolean = () => false,
): Promise<void> {
  const cfg = getConfig();
  if (
    cfg.offline ||
    process.env.CLAI_OFFLINE === "1" ||
    process.env.CLAI_NO_UPDATE_CHECK === "1"
  )
    return;
  if (
    cfg.lastUpdateCheck &&
    Date.now() - cfg.lastUpdateCheck < UPDATE_CHECK_INTERVAL_MS
  )
    return;

  const status = await services.ports.updates.check();
  if (isCancelled()) return;
  updateConfig({ lastUpdateCheck: Date.now() });
  if (status.state === "update-available" && status.latestVersion) {
    notify(
      services,
      `Update available: ${status.currentVersion} → ${status.latestVersion} · /update`,
      { key: "update", durationMs: 6500 },
    );
  }
}