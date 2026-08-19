import type { CustomProviderProfileSpec } from "./custom-provider-profile.js";

type CustomProfileSpecResolver = (
  provider: string,
) => CustomProviderProfileSpec | undefined;

const state: { resolver?: CustomProfileSpecResolver } = {};

export function setCustomProfileSpecResolver(
  resolver: CustomProfileSpecResolver,
): void {
  state.resolver = resolver;
}

export function customProfileSpecFor(
  provider: string,
): CustomProviderProfileSpec | undefined {
  return state.resolver?.(provider);
}
