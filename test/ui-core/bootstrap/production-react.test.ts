import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const modulePath = new URL("../../../src/ui-core/bootstrap/production-react.ts", import.meta.url).href;
const compiledModuleUrl = new URL("../../../dist-entry.js", import.meta.url).href;
const nodeModules = fileURLToPath(new URL("../../../node_modules/", import.meta.url));

function probe(script: string, env: Record<string, string | undefined> = {}): Record<string, unknown> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete childEnv[key];
  const source = `
    const { loadProductionReact } = await import(${JSON.stringify(modulePath)});
    ${script}
  `;
  const stripTypes = process.features.typescript ? [] : ["--experimental-strip-types"];
  const output = execFileSync(process.execPath, [...stripTypes, "--no-warnings", "--input-type=module", "-e", source], {
    encoding: "utf8",
    env: childEnv,
  });
  return JSON.parse(output) as Record<string, unknown>;
}

const inspectReact = `
  const { createRequire } = await import("node:module");
  const load = createRequire(${JSON.stringify(compiledModuleUrl)});
  const modules = {
    react: "react/cjs/react.production.js",
    "react/jsx-runtime": "react/cjs/react-jsx-runtime.production.js",
    "react-reconciler": "react-reconciler/cjs/react-reconciler.production.js",
    "react-reconciler/constants.js": "react-reconciler/cjs/react-reconciler-constants.production.js",
    scheduler: "scheduler/cjs/scheduler.production.js",
  };
  const builds = {};
  for (const [name, production] of Object.entries(modules)) {
    const imported = await import(name);
    builds[name] = (imported.default ?? imported) === load(${JSON.stringify(nodeModules)} + production) ? "production" : "development";
  }
  console.log(JSON.stringify({ loaded, nodeEnv: process.env.NODE_ENV ?? null, hasNodeEnv: "NODE_ENV" in process.env, builds }));
`;

function everyBuild(build: "production" | "development"): Record<string, string> {
  return Object.fromEntries(["react", "react/jsx-runtime", "react-reconciler", "react-reconciler/constants.js", "scheduler"].map((name) => [name, build]));
}

describe("loadProductionReact", () => {
  it("selects the production React builds for compiled entry points and restores an unset NODE_ENV", () => {
    const result = probe(`const loaded = loadProductionReact(${JSON.stringify(compiledModuleUrl)});${inspectReact}`, { NODE_ENV: undefined });
    expect(result).toEqual({ loaded: true, nodeEnv: null, hasNodeEnv: false, builds: everyBuild("production") });
  });

  it("overrides a development NODE_ENV for React only and hands the original value back", () => {
    const result = probe(`const loaded = loadProductionReact(${JSON.stringify(compiledModuleUrl)});${inspectReact}`, { NODE_ENV: "development" });
    expect(result).toEqual({ loaded: true, nodeEnv: "development", hasNodeEnv: true, builds: everyBuild("production") });
  });

  it("leaves TypeScript sources on the development builds their JSX transform expects", () => {
    const result = probe(`const loaded = loadProductionReact(${JSON.stringify(modulePath)});${inspectReact}`, { NODE_ENV: undefined });
    expect(result).toEqual({ loaded: false, nodeEnv: null, hasNodeEnv: false, builds: everyBuild("development") });
  });

  it("does nothing when the process already runs in production", () => {
    const result = probe(`const loaded = loadProductionReact(${JSON.stringify(compiledModuleUrl)});${inspectReact}`, { NODE_ENV: "production" });
    expect(result).toEqual({ loaded: false, nodeEnv: "production", hasNodeEnv: true, builds: everyBuild("production") });
  });
});
