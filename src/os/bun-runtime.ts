/**
 * OpenTUI requires Bun's native FFI. Node/tsx cannot initialize the renderer.
 * Prefer re-exec under Bun when available; otherwise fall back with a clear hint.
 */

import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";

import { homedir } from "node:os";

export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/** Resolve `bun` on PATH or local clai/bun bin dirs (cross-platform). */
export function findBunExecutable(): string | undefined {
  const binName = process.platform === "win32" ? "bun.exe" : "bun";
  const fromEnv = process.env.BUN_INSTALL
    ? join(process.env.BUN_INSTALL, "bin", binName)
    : undefined;
  const claiBin = join(homedir(), ".clai", "bin", binName);
  const bunHomeBin = join(homedir(), ".bun", "bin", binName);

  // Windows-specific: Bun's official installer puts bun.exe in LOCALAPPDATA\bun
  // or APPDATA\bun\bin depending on the installer variant.
  const localAppData = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "bun", binName)
    : undefined;
  const appData = process.env.APPDATA
    ? join(process.env.APPDATA, "bun", "bin", binName)
    : undefined;

  const candidates = [
    fromEnv,
    claiBin,
    bunHomeBin,
    localAppData,
    appData,
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, binName)),
  ].filter((p): p is string => Boolean(p));

  const checkMode = process.platform === "win32" ? constants.F_OK : constants.X_OK;

  for (const path of candidates) {
    try {
      accessSync(path, checkMode);
      return path;
    } catch {
      // try next
    }
  }
  return undefined;
}

/**
 * Verify a Bun binary works by running `bun --version`.
 * Returns the version string on success, undefined on failure.
 */
function verifyBun(bunPath: string): string | undefined {
  try {
    const result = spawnSync(bunPath, ["--version"], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
  } catch {
    // verification failed
  }
  return undefined;
}

/** Automatically install Bun into ~/.clai/bin if missing (cross-platform). */
export function autoInstallBun(): string | undefined {
  if (process.env.CLAI_NO_BUN_AUTO_INSTALL === "1") return undefined;
  const targetDir = join(homedir(), ".clai");
  const binName = process.platform === "win32" ? "bun.exe" : "bun";
  const targetBin = join(targetDir, "bin", binName);

  mkdirSync(join(targetDir, "bin"), { recursive: true });

  const env = {
    ...process.env,
    BUN_INSTALL: targetDir,
  };

  console.log("  [clai] Installing Bun runtime for full-screen UI...");
  let installed = false;

  try {
    if (process.platform === "win32") {
      // Try PowerShell first (official Bun installer)
      const psResult = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://bun.sh/install.ps1 | iex",
        ],
        { env, stdio: "inherit", windowsHide: true, timeout: 120000 },
      );

      if (psResult.status !== 0 && psResult.status !== null) {
        // PowerShell failed — try npm as fallback
        console.log("  [clai] PowerShell install failed, trying npm...");
        const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
        spawnSync(npmCmd, ["install", "-g", "bun"], {
          stdio: "inherit",
          timeout: 120000,
          windowsHide: true,
        });
      }
    } else {
      const res = spawnSync(
        "sh",
        ["-c", "curl -fsSL https://bun.sh/install | bash"],
        { env, stdio: "inherit", timeout: 120000 },
      );

      if (res.status !== 0) {
        spawnSync(
          "sh",
          ["-c", "wget -qO- https://bun.sh/install | bash"],
          { env, stdio: "inherit", timeout: 120000 },
        );
      }
    }

    // Check the target location first, then fall back to findBunExecutable
    const bunPath = existsSync(targetBin) ? targetBin : findBunExecutable();
    if (bunPath) {
      if (process.platform !== "win32" && bunPath === targetBin) {
        try {
          chmodSync(targetBin, 0o755);
        } catch {
          // ignore
        }
      }
      // Verify the binary actually works
      const version = verifyBun(bunPath);
      if (version) {
        console.log(`  [clai] ✓ Bun ${version} installed successfully`);
        installed = true;
        return bunPath;
      }
      // Binary exists but doesn't run correctly
      console.log("  [clai] ⚠ Bun binary found but could not verify. Trying anyway...");
      installed = true;
      return bunPath;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [clai] ⚠ Bun auto-install error: ${msg}`);
  }

  if (!installed) {
    console.log("  [clai] ⚠ Bun auto-install could not complete. Using classic REPL instead.");
    console.log("  [clai]   Manual install: https://bun.sh");
  }

  return findBunExecutable();
}

export function openTuiRuntimeHint(): string {
  return [
    "OpenTUI needs the Bun runtime to render the full-screen UI.",
    "clai will try to install Bun automatically on the next launch.",
    "  • Manual install: https://bun.sh",
    "  • Skip the TUI:  clai --classic  (uses the line-based REPL instead)",
  ].join("\n");
}

/**
 * If we are not already under Bun, re-launch this process with Bun using the
 * given entry module (usually `import.meta.url` of index.ts) + original CLI
 * args, then exit with the child status. Returns false when re-exec is not
 * possible (caller should fall back / print the hint).
 *
 * Pass `entryPath` explicitly — under `tsx`/`npx`, `process.argv[1]` is the
 * loader, not clai's entry.
 */
export function reexecWithBunIfNeeded(entryPath: string): boolean {
  if (isBunRuntime()) return false;
  if (process.env.CLAI_NO_BUN_REEXEC === "1") return false;
  if (process.env.CLAI_FORCE_NODE === "1") return false;

  let bun = findBunExecutable();
  if (!bun) {
    bun = autoInstallBun();
  }
  if (!bun) return false;
  if (!entryPath) return false;

  // Keep user flags (after the entry). Drop node/tsx/bun loader path noise.
  // process.argv: [node, loader?, entry?, ...flags] — simplest reliable form
  // is to re-run only the entry + flags that look like CLI options/args.
  const userArgs = process.argv.slice(2).filter((a) => {
    // Drop accidental duplicate of the entry path if present.
    if (a === entryPath) return false;
    if (a.endsWith("src/index.ts") || a.endsWith("dist/index.js")) return false;
    return true;
  });

  const result = spawnSync(bun, [entryPath, ...userArgs], {
    stdio: "inherit",
    env: {
      ...process.env,
      CLAI_NO_BUN_REEXEC: "1",
      CLAI_BUN_REEXEC: "1",
    },
    windowsHide: true,
  });

  if (result.error) return false;
  process.exit(result.status ?? 1);
  return true;
}

export function isOpenTuiFfiError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /OpenTUI native FFI|native FFI is not available|Bun-only|@opentui\/core|Failed to initialize OpenTUI/i.test(
    msg,
  );
}
