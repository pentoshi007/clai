import { notify } from "../../ui-core/notify.js";
import type { WiringHost } from "./wiring-types.js";

export const WHEEL_SCROLL_ROWS = 3;

function moveFeed(host: WiringHost, delta: number): boolean {
  const limit = host.feedLayoutPending && delta > 0 ? Number.MAX_SAFE_INTEGER : host.maxLiveOffset;
  const next = Math.max(0, Math.min(limit, host.liveOffsetValue + delta));
  host.feedNavigationVersion += 1;
  if (next !== host.liveOffsetValue) {
    host.liveOffsetValue = next;
    return true;
  }
  if (delta > 0 && !host.scrollToastShown) {
    host.scrollToastShown = true;
    notify(host.services, "transcript is already at the top · Ctrl+R to search", {
      key: "transcript-scroll",
      durationMs: 3200,
    });
  }
  return false;
}

export function scrollFeed(host: WiringHost, delta: number): void {
  host.wheel.stop();
  moveFeed(host, delta);
  host.schedulePaint(true);
}

export function stepWheelFeed(host: WiringHost): boolean {
  if (!host.wheel.active) return false;
  if (!moveFeed(host, host.wheel.step(host.now()))) host.wheel.stop();
  return host.wheel.active;
}

export function showTranscriptTopHint(host: WiringHost): void {
  host.wheel.stop();
  host.liveOffsetValue = host.feedLayoutPending ? Number.MAX_SAFE_INTEGER : host.maxLiveOffset;
  host.feedNavigationVersion += 1;
  host.schedulePaint();
  notify(
    host.services,
    "transcript top · Ctrl+D returns to the latest response",
    { key: "transcript-top", durationMs: 2200 },
  );
}
