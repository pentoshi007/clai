import { createRequire } from "node:module";

const ENV_KEY = "NODE_ENV";

const REACT_RUNTIME_MODULES = [
  "react",
  "react/jsx-runtime",
  "react-reconciler",
  "react-reconciler/constants",
  "scheduler",
] as const;

export function loadProductionReact(moduleUrl: string = import.meta.url): boolean {
  if (process.env.NODE_ENV === "production" || moduleUrl.endsWith(".ts")) return false;
  const env = process.env;
  const previous = env[ENV_KEY];
  env[ENV_KEY] = "production";
  try {
    const load = createRequire(moduleUrl);
    for (const name of REACT_RUNTIME_MODULES) load(name);
    return true;
  } catch {
    return false;
  } finally {
    if (previous === undefined) delete env[ENV_KEY];
    else env[ENV_KEY] = previous;
  }
}
