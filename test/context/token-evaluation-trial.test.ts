import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runEvaluationTrial } from "../../scripts/token-evaluation-trial.js";

const root = resolve(import.meta.dirname, "../..");
const originalCwd = process.cwd();
const originalEnv = { ...process.env };
const owned: string[] = [];
afterEach(async () => {
  process.chdir(originalCwd);
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules();
  await Promise.all(owned.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it.each([
  { variant: "before", candidateProfile: undefined, expectedProfile: "legacy" },
  { variant: "before", candidateProfile: "density-v1", expectedProfile: "legacy-v1" },
  { variant: "after", candidateProfile: "density-v1", expectedProfile: "density-v1" },
])("collects redacted actual-runner evidence for $expectedProfile without a remote request", async ({ variant, candidateProfile, expectedProfile }) => {
  const parent = process.env.CLAI_DATA_DIR!;
  await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(join(parent, "eval-trial-"));
  owned.push(workspace);
  const configFile = join(workspace, "configuration.json");
  await writeFile(configFile, JSON.stringify({ version: 1, routes: [{ provider: "nvidia", model: "openai/gpt-oss-20b", toolCalling: "native", thinking: { enabled: false, effort: "medium" } }], fixtures: ["independent-reads-natural"], repeats: 1, maxCalls: 6, scratchRoot: workspace, candidateProfile }));
  process.env.NVIDIA_API_KEY = "synthetic-not-a-real-key";
  let admissions = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/responses")) return new Response('{"error":{"message":"unsupported endpoint"}}', { status: 404, headers: { "content-type": "application/json" } });
    if (!url.includes("/chat/completions")) return new Response('{"data":[]}', { headers: { "content-type": "application/json" } });
    admissions += 1;
    const body = String(init?.body ?? "");
    expect(body.includes("working feature, not a starter/scaffold")).toBe(expectedProfile === "density-v1");
    const readDone = body.includes("call_read_alpha") && body.includes("call_read_beta");
    const delta = readDone ? { content: "alpha port 4123 enabled true; beta port 5124 enabled false; synthetic-not-a-real-key" } : {
      tool_calls: [
        { index: 0, id: "call_read_alpha", type: "function", function: { name: "fs_read", arguments: '{"path":"alpha.json"}' } },
        { index: 1, id: "call_read_beta", type: "function", function: { name: "fs_read", arguments: '{"path":"beta.json"}' } },
      ],
    };
    const frames = [
      { id: "synthetic-completion", model: "openai/gpt-oss-20b", choices: [{ index: 0, delta, finish_reason: readDone ? "stop" : "tool_calls" }], usage: { prompt_tokens: 25000, completion_tokens: 50, total_tokens: 25050 } },
    ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(frames, { headers: { "content-type": "text/event-stream" } });
  }));
  await runEvaluationTrial([root, workspace, variant, "independent-reads-natural", "1", configFile, "0", "6"]);
  const serialized = await readFile(join(workspace, ".evaluation", "report.json"), "utf8");
  const report: unknown = JSON.parse(serialized);
  expect(report).toMatchObject({ passed: true, error: false, toolCalls: 2, toolErrors: 0, blockedCalls: 0, modelRounds: 2, firstAttemptValidity: 1, repairCalls: 0,
    assembly: { samples: 3 }, route: { provider: "nvidia" }, cache: { knownCacheHitRate: null } });
  expect(report).toMatchObject({ provenance: { profile: expectedProfile, profileDigest: candidateProfile ? expect.stringMatching(/^[a-f0-9]{64}$/) : null } });
  expect(admissions).toBe(2);
  expect(serialized).not.toContain("synthetic-not-a-real-key");
  expect(serialized).not.toContain("alpha port 4123");
  expect(serialized).toContain('"promptTokens":25000');
  expect(serialized).toContain('"fingerprint":{');
  const diagnostics = await readFile(join(workspace, ".evaluation", "fixture-diagnostics.json"), "utf8");
  expect(diagnostics).not.toContain("synthetic-not-a-real-key");
  expect(JSON.parse(diagnostics)).toMatchObject({ answer: expect.stringContaining("alpha port 4123") });
  expect(report).toMatchObject({ snapshot: { stable: true, harnessSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
}, 30_000);
