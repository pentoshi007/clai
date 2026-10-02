export type PermissionMode = "default" | "allow-all" | "full-access";

export const DEFAULT_PERMISSION_MODE: PermissionMode = "allow-all";

export function parsePermissionMode(value: string): PermissionMode | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto-allow") return "allow-all";
  if (normalized === "default" || normalized === "allow-all" || normalized === "full-access") {
    return normalized;
  }
  return undefined;
}

export function permissionModeLabel(value: string | undefined): string {
  const mode = value ?? DEFAULT_PERMISSION_MODE;
  return mode === "allow-all" ? "auto-allow" : mode;
}

export function configuredPermissionMode(value: unknown): PermissionMode {
  if (value === undefined) return DEFAULT_PERMISSION_MODE;
  if (typeof value !== "string") return "default";
  return parsePermissionMode(value) ?? "default";
}
