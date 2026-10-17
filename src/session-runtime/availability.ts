let unavailableReason: string | undefined;

export function setRuntimeDetachUnavailableReason(reason: string | undefined): void {
  unavailableReason = reason;
}

export function runtimeDetachUnavailableMessage(): string {
  const reason = unavailableReason ?? "this launch is running in foreground mode; restart clai from an interactive terminal with session history enabled";
  return `background detach is unavailable: ${reason}. Keep this terminal open to keep the session running`;
}
