import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { evaluationEnvironment } from "../../scripts/token-evaluation-environment.js";
import type { EvaluationRoute } from "../../scripts/token-evaluation-config.js";

const owned: string[] = [];
afterEach(async () => { await Promise.all(owned.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const route: EvaluationRoute = { provider: "nvidia", model: "synthetic", toolCalling: "native", thinking: { enabled: false, effort: "medium" } };

it("isolates home, keychain, endpoint overrides and all unselected credentials before imports", async () => {
  await mkdir(process.env.CLAI_DATA_DIR!, { recursive: true });
  const root = await mkdtemp(join(process.env.CLAI_DATA_DIR!, "eval-env-"));
  owned.push(root);
  const env = evaluationEnvironment(route, root, { ...process.env, HOME: "/real-private-home", NVIDIA_BASE_URL: "https://unintended.test", OPENAI_API_KEY: "unselected-private-value" }, { value: "selected-synthetic-value" });
  await Promise.all([env.HOME!, env.TMPDIR!, env.CLAI_CONFIG_DIR!].map((path) => mkdir(path, { recursive: true })));
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.NVIDIA_BASE_URL).toBeUndefined();
  expect(env.NODE_OPTIONS).toBeUndefined();
  const probe = 'import {getFallbackKeysPath,getProviderSecret} from "./src/store/keys.ts"; const selected=await getProviderSecret("nvidia"); const other=await getProviderSecret("openai"); console.log(JSON.stringify({path:getFallbackKeysPath(),selected:selected.source,other:other.source,valueMatches:selected.value==="selected-synthetic-value"}));';
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], { cwd: resolve(import.meta.dirname, "../.."), env, timeout: 20_000 });
  expect(JSON.parse(stdout)).toEqual({ path: join(env.HOME!, ".clai", "keys.json"), selected: "env", other: "missing", valueMatches: true });
  expect(stdout).not.toContain("selected-synthetic-value");
}, 30_000);

it("allows explicit local/keyless and subscription environment collectors without implicit fallback", () => {
  const local = evaluationEnvironment({ ...route, provider: "ollama", auth: "none", endpoint: "http://127.0.0.1:11434" }, "/synthetic", {}, undefined);
  expect(local.OLLAMA_HOST).toBe("http://127.0.0.1:11434");
  const subscription = evaluationEnvironment({ ...route, provider: "codex", auth: "stored" }, "/synthetic", {}, { value: "synthetic", refreshToken: "synthetic-refresh", expiresAt: 100 });
  expect(subscription.CODEX_API_KEY).toBe("synthetic");
  expect(subscription.CLAI_EVALUATION_REFRESH_TOKEN).toBe("synthetic-refresh");
});
