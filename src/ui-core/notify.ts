/**
 * Ephemeral UI notifications via the toast stack.
 *
 * session.notice also routes here (via composition-root) and no longer
 * appends INFO/WARN rows into the transcript. Prefer `notify` / session.notice
 * for chrome only — never for durable conversation content.
 */

import type { ToastController, ToastLevel } from "./controllers/toast-controller.js";

export interface NotifyTarget {
  readonly toast: ToastController;
}

export interface NotifyOptions {
  readonly level?: ToastLevel | undefined;
  readonly durationMs?: number | undefined;
  readonly key?: string | undefined;
}

/** Show a short toast. Empty messages are no-ops. */
export function notify(
  services: NotifyTarget,
  message: string,
  options: NotifyOptions = {},
): void {
  services.toast.show(message, {
    level: options.level ?? "info",
    ...(options.durationMs !== undefined
      ? { durationMs: options.durationMs }
      : {}),
    ...(options.key !== undefined ? { key: options.key } : {}),
  });
}

export function notifySuccess(
  services: NotifyTarget,
  message: string,
  options: Omit<NotifyOptions, "level"> = {},
): void {
  notify(services, message, { ...options, level: "success" });
}

export function notifyWarn(
  services: NotifyTarget,
  message: string,
  options: Omit<NotifyOptions, "level"> = {},
): void {
  notify(services, message, { ...options, level: "warn" });
}

export function notifyError(
  services: NotifyTarget,
  message: string,
  options: Omit<NotifyOptions, "level"> = {},
): void {
  notify(services, message, { ...options, level: "error" });
}
