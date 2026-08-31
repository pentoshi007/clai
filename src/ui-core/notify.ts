
import type { ToastController, ToastLevel } from "./controllers/toast-controller.js";

export interface NotifyTarget {
  readonly toast: ToastController;
}

export interface NotifyOptions {
  readonly level?: ToastLevel | undefined;
  readonly durationMs?: number | undefined;
  readonly key?: string | undefined;
}

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
