import { bundlesDecompiler, currentHost, decompilerBuildTarget, missingBuildTools } from "../src/rea/ghidra.js";
import { isMuslLinux, resolveJdkRelease } from "../src/rea/jdk.js";

const host = currentHost();
const jdk = await resolveJdkRelease(host).catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }));
console.log(JSON.stringify({
  host,
  node: process.version,
  musl: isMuslLinux(),
  jdk: jdk.ok ? jdk.release.name : jdk.reason,
  ghidraBuildTarget: decompilerBuildTarget(host)?.directory ?? null,
  decompilerShipsInRelease: bundlesDecompiler(host),
  missingBuildTools: await missingBuildTools(host),
}, null, 2));
