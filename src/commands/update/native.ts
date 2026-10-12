import { createHash, randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { evictSudoSession, formatSudoStdinPassword, looksLikeSudoAuthError, obtainSudoPassword } from "../../tools/sudo-session.js";
import { canonicalPath } from "./detection.js";
import { downloadBinary } from "./download.js";
import { currentPlatformTarget, ELEVATION_TIMEOUT_MS, mirrorBaseUrl, REPO, type PerformUpdateOptions, type UpdateElevation, type UpdateInstallResult } from "./installers.js";
import { runUpdateCommand, throwIfCancelled } from "./process.js";
import { verifyExecutable } from "./verification.js";
import { stageWindowsUpdate } from "./windows-stage.js";

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function writableDirectory(path: string, platform = process.platform): boolean {
  try {
    if (platform === "win32") {
      const probe = mkdtempSync(join(path, ".clai-write-probe-"));
      rmSync(probe, { recursive: true });
    } else accessSync(path, constants.W_OK | constants.X_OK);
    return true;
  } catch { return false; }
}

async function binaryChecksum(urls: readonly string[], options: PerformUpdateOptions): Promise<string> {
  for (const url of urls) {
    try {
      const value = (await downloadBinary(url, 20_000, undefined, options.signal, 4096)).toString("utf8").trim().split(/\s+/)[0];
      if (value && /^[a-f\d]{64}$/i.test(value)) return value.toLowerCase();
    } catch (error) { if (options.signal?.aborted) throw error; }
  }
  throw new Error("could not obtain a valid release checksum; existing installation was kept");
}

async function verifiedDownload(urls: readonly string[], expected: string, options: PerformUpdateOptions): Promise<Buffer> {
  let failure: Error = new Error("update download failed");
  for (const [index, url] of urls.entries()) {
    try {
      const bytes = await downloadBinary(url, 120_000, (progress) => options.onProgress?.({ phase: "downloading", ...progress }), options.signal);
      options.onProgress?.({ phase: "verifying" });
      if (digest(bytes) !== expected) throw new Error("checksum mismatch for update download");
      return bytes;
    } catch (error) {
      throwIfCancelled(options.signal);
      failure = error instanceof Error ? error : new Error(String(error));
      if (index + 1 < urls.length) options.log?.("Mirror unavailable or invalid; trying GitHub releases…");
    }
  }
  throw failure;
}

async function authorizeReplacement(destination: string, options: PerformUpdateOptions): Promise<UpdateElevation | undefined> {
  if (options.elevation?.auth.status === "cancelled") throw new Error("update cancelled before replacing the executable");
  if (options.elevation?.auth.status === "failed") throw new Error("sudo authentication failed");
  if (options.elevation || writableDirectory(dirname(destination)) || !options.requestSecret) return options.elevation;
  const auth = await obtainSudoPassword({
    requestSecret: options.requestSecret,
    operation: { name: "clai.update", args: { version: options.version, destination, elevation: "sudo", action: "install verified update atomically" } },
    title: "Administrator access",
    prompt: `Updating clai needs admin permission to replace ${destination}. Enter your sudo password; it is sent only to sudo stdin. Esc cancels.`,
    ...(options.signal ? { signal: options.signal } : {}),
  }, {});
  if (auth.status === "failed") throw new Error(`sudo authentication failed — could not replace ${destination}`);
  if (auth.status === "cancelled") throw new Error("update cancelled before replacing the executable");
  return { auth };
}

async function promote(source: string, destination: string, options: PerformUpdateOptions, elevation?: UpdateElevation): Promise<void> {
  const pending = `${destination}.update-${randomUUID()}`;
  try {
    copyFileSync(source, pending, constants.COPYFILE_EXCL);
    chmodSync(pending, 0o755);
    renameSync(pending, destination);
    return;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code !== "EACCES" && code !== "EPERM") throw error;
  } finally { rmSync(pending, { force: true }); }
  if (elevation?.auth.status === "cancelled") throw new Error("update cancelled before replacing the executable");
  const password = elevation?.auth.status === "granted" ? elevation.auth.password : undefined;
  const args = password === undefined ? ["-n"] : ["-S", "-p", ""];
  const script = 'set -eu; stage=$(mktemp "$2.update.XXXXXX"); trap \'rm -f "$stage"\' EXIT; install -m 755 "$1" "$stage"; mv -f "$stage" "$2"';
  try {
    await runUpdateCommand({ file: "sudo", args: [...args, "--", "sh", "-c", script, "clai-update", source, destination] }, {
      signal: options.signal,
      timeoutMs: password === undefined ? ELEVATION_TIMEOUT_MS : 30_000,
      ...(password === undefined ? {} : { input: formatSudoStdinPassword(password) }),
    });
  } catch (error) {
    if (password && error instanceof Error && looksLikeSudoAuthError(error.message)) evictSudoSession(password);
    throwIfCancelled(options.signal);
    throw new Error(`needs elevated permission to replace ${destination} — run \`sudo clai update\` using this installation, or retry the admin prompt`);
  }
}

export async function installDirectBinary(options: PerformUpdateOptions): Promise<UpdateInstallResult> {
  throwIfCancelled(options.signal);
  const target = options.target ?? currentPlatformTarget();
  const destination = canonicalPath(options.execPath ?? options.method.executablePath ?? process.execPath);
  const base = `https://github.com/${options.repo ?? REPO}/releases/download/v${options.version}`;
  const mirror = `${mirrorBaseUrl()}/v${options.version}`;
  const useMirror = process.env.CLAI_NO_MIRROR !== "1";
  const binaryUrls = useMirror ? [`${mirror}/${target.file}`, `${base}/${target.file}`] : [`${base}/${target.file}`];
  const sums = useMirror ? [`${base}/${target.file}.sha256`, `${mirror}/${target.file}.sha256`] : [`${base}/${target.file}.sha256`];
  const elevation = process.platform === "win32" ? undefined : await authorizeReplacement(destination, options);
  const previous = readFileSync(destination);
  const previousDigest = digest(previous);
  const expected = await binaryChecksum(sums, options);
  options.log?.(`Downloading ${target.file} (v${options.version})…`);
  const bytes = await verifiedDownload(binaryUrls, expected, options);
  const stage = mkdtempSync(join(tmpdir(), "clai-update-"));
  let preserve = false;
  try {
    const source = join(stage, target.file);
    const backup = join(stage, "previous-clai");
    writeFileSync(source, bytes, { mode: 0o755 });
    writeFileSync(backup, previous, { mode: 0o755 });
    await verifyExecutable(source, options.version, { signal: options.signal });
    if (digest(readFileSync(destination)) !== previousDigest) throw new Error("installation changed during update; retry without other update processes");
    throwIfCancelled(options.signal);
    options.onProgress?.({ phase: "installing", detail: destination });
    if (process.platform === "win32") {
      const statusFile = await stageWindowsUpdate({ kind: "binary", source, destination, digest: expected, previousDigest, version: options.version }, { signal: options.signal, ...(options.lockFile ? { lockFile: options.lockFile, lockToken: options.lockToken } : {}) }, !writableDirectory(dirname(destination)));
      return { ok: true, method: "binary", outcome: "staged", needsRestart: true, statusFile, message: `verified update staged; close this installation to apply it. Result: ${statusFile}` };
    }
    throwIfCancelled(options.signal);
    try {
      await promote(source, destination, { ...options, signal: undefined }, elevation);
      if (digest(readFileSync(destination)) !== expected) throw new Error("installed binary checksum mismatch");
      const installedVersion = await verifyExecutable(destination, options.version);
      return { ok: true, method: "binary", outcome: "applied", installedVersion, needsRestart: true, message: `installed and verified v${installedVersion} → ${destination}` };
    } catch (error) {
      let unchanged = false;
      try { unchanged = digest(readFileSync(destination)) === previousDigest; } catch {}
      if (unchanged) throw error;
      try { await promote(backup, destination, { ...options, signal: undefined }, elevation); }
      catch { preserve = true; throw new Error(`update verification and rollback failed for ${destination}; recovery executable retained at ${backup}`); }
      throw new Error(`update verification failed; previous executable restored: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally { if (!preserve) rmSync(stage, { recursive: true, force: true }); }
}
