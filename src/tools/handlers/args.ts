import { RESPONSE_MODES } from "../web/types.js";
import type { ResponseMode } from "../web/types.js";

export function requireString(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Tool argument "${key}" must be a non-empty string`);
  }
  return value;
}

export function requireStringAllowEmpty(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`Tool argument "${key}" must be a string`);
  }
  return value;
}

export function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function optionalNumber(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function requireNumber(
  args: Record<string, unknown>,
  key: string,
): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Tool argument "${key}" must be a finite number`);
  }
  return value;
}

export function optionalBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

export function optionalResponseMode(
  args: Record<string, unknown>,
  key: string,
): ResponseMode | undefined {
  const value = args[key];
  if (
    typeof value === "string" &&
    (RESPONSE_MODES as readonly string[]).includes(value)
  ) {
    return value as ResponseMode;
  }
  return undefined;
}
