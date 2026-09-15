import type { ProviderId } from "../types.js";
import { currentIsolatedSessionAffinity } from "./session-affinity.js";

interface SessionRoute {
  keyId?: string;
  endpoint?: string;
}

const routes = new Map<string, SessionRoute>();
const MAX_ROUTES = 512;

export function isolatedSessionRoute(provider: ProviderId, model: string): SessionRoute | undefined {
  const session = currentIsolatedSessionAffinity();
  if (!session) return undefined;
  const key = JSON.stringify([session, provider, model]);
  const route = routes.get(key) ?? {};
  routes.delete(key);
  routes.set(key, route);
  while (routes.size > MAX_ROUTES) routes.delete(routes.keys().next().value!);
  return route;
}
