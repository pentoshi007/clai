import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager } from "../src/mcp/manager.js";
import { McpRuntime } from "../src/mcp/runtime.js";
import { detectRea, runReaMaintenance } from "../src/rea/install.js";
import { runReaNode } from "../src/rea/node.js";
import { reaTools } from "../src/rea/connection.js";
import { manageRea } from "../src/rea/runtime.js";
import { REA_SERVER } from "../src/rea/workflow.js";

const work = await mkdtemp(join(process.env.CLAI_REA_SMOKE_ROOT ?? tmpdir(), "clai-rea-smoke-"));
const previousData = process.env.CLAI_DATA_DIR;
process.env.CLAI_DATA_DIR = join(work, "data");
const workspace = join(work, "workspace");
await mkdir(workspace);
const runtime = new McpRuntime({ manager: new McpManager({ discovery: {
  workspaceFolder: workspace, homeDir: join(work, "home"), env: {}, platform: process.platform,
} }) });

try {
  const started = performance.now();
  const installed = await runReaMaintenance("install", { portableRuntime: true });
  if (!installed.ok) throw new Error(installed.reason);
  console.log(JSON.stringify({ phase: "install", rea: installed.installation.version, node: await runReaNode(installed.installation.node, ["--version"]), ms: Math.round(performance.now() - started) }));
  const status = await manageRea(runtime, "status");
  if (!status.ok || runtime.getState().snapshot.statuses.length !== 0) throw new Error("Status unexpectedly started a server");
  const enabled = await manageRea(runtime, "enable");
  if (!enabled.ok) throw new Error(enabled.output);
  const tools = reaTools(runtime);
  const index = enabled.output.slice(enabled.output.indexOf("REA TOOLS ("));
  const unlisted = tools.filter((tool) => !new RegExp(`(?:^|[ :])${tool.toolName}(?=[ (!~#^%\\n]|$)`).test(index));
  if (tools.length < 100 || unlisted.length > 0) throw new Error(`Tool index lists ${tools.length - unlisted.length} of ${tools.length} tools`);
  const catalog = await runtime.agentTools(REA_SERVER, { query: "inspect_go_binary" });
  const name = `mcp.${REA_SERVER}.inspect_go_binary`;
  if (!catalog.ok || !catalog.output.includes(name) || (catalog.output.match(/^- mcp\./gm) ?? []).length !== 1) throw new Error(catalog.output);
  const rejected = await runtime.callTool(name, { path: installed.installation.node, remembered_option: true });
  if (rejected.ok || !rejected.output.includes(`Accepted arguments for ${name}`)) throw new Error(rejected.output);
  const analysis = await runtime.callTool(name, { path: installed.installation.node });
  await writeFile(join(work, "evidence.txt"), analysis.output);
  if (!analysis.ok) throw new Error(analysis.output);
  console.log(JSON.stringify({ phase: "analysis", tools: runtime.getState().activeToolCount, indexChars: index.length, contextChars: runtime.promptContext({ nativeTools: true })?.length, evidenceBytes: Buffer.byteLength(analysis.output), sample: analysis.output.slice(0, 350) }));
  const disabled = await manageRea(runtime, "disable");
  if (!disabled.ok || runtime.getState().activeToolCount !== 0) throw new Error("Disable did not stop REA");
  if ((await detectRea()).state !== "ready") throw new Error("Disable removed the installation");
  console.log(JSON.stringify({ phase: "complete", ok: true, ms: Math.round(performance.now() - started) }));
} finally {
  await runtime.closeAll();
  if (previousData === undefined) delete process.env.CLAI_DATA_DIR;
  else process.env.CLAI_DATA_DIR = previousData;
  if (process.env.CLAI_REA_SMOKE_KEEP !== "1") await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  else console.log(`Artifacts: ${work}`);
}
