#!/usr/bin/env node
/**
 * Postinstall script for @pentoshi/clai.
 * Automatically checks for Bun (required by OpenTUI) and installs it into
 * ~/.clai/bin/bun across Linux and macOS if missing.
 */
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { shouldSkipBunInstall } from "./postinstall-policy.mjs";

function findBun() {
  const binName = process.platform === "win32" ? "bun.exe" : "bun";
  const fromEnv = process.env.BUN_INSTALL
    ? join(process.env.BUN_INSTALL, "bin", binName)
    : undefined;
  const targetDir = join(homedir(), ".clai");
  const candidates = [
    fromEnv,
    join(targetDir, "bin", binName),
    join(homedir(), ".bun", "bin", binName),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "bun", binName) : undefined,
    process.env.APPDATA ? join(process.env.APPDATA, "bun", "bin", binName) : undefined,
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, binName)),
  ].filter(Boolean);

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

const skipBunInstall = shouldSkipBunInstall();

if (!skipBunInstall && !findBun() && process.env.CLAI_NO_BUN_AUTO_INSTALL !== "1") {
  const targetDir = join(homedir(), ".clai");
  const binName = process.platform === "win32" ? "bun.exe" : "bun";
  const targetBin = join(targetDir, "bin", binName);

  mkdirSync(join(targetDir, "bin"), { recursive: true });

  const env = {
    ...process.env,
    BUN_INSTALL: targetDir,
  };

  console.log("Setting up Bun runtime for OpenTUI (~/.clai/bin)...");
  try {
    if (process.platform === "win32") {
      spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://bun.sh/install.ps1 | iex",
        ],
        { env, stdio: "inherit", windowsHide: true },
      );
    } else {
      const res = spawnSync(
        "sh",
        ["-c", "curl -fsSL https://bun.sh/install | bash"],
        { env, stdio: "inherit" },
      );

      if (res.status !== 0) {
        spawnSync(
          "sh",
          ["-c", "wget -qO- https://bun.sh/install | bash"],
          { env, stdio: "inherit" },
        );
      }
    }

    if (existsSync(targetBin) && process.platform !== "win32") {
      try {
        chmodSync(targetBin, 0o755);
      } catch {
        // ignore
      }
    }

    try {
      const verify = spawnSync(targetBin, ["--version"], { encoding: "utf8", timeout: 10000 });
      if (verify.status === 0 && verify.stdout) {
        console.log(`  ✓ Bun ${verify.stdout.trim()} installed to ${targetBin}`);
      } else {
        console.log(`  Note: Could not verify Bun installation.`);
      }
    } catch (e) {
      console.log(`  Note: Could not verify Bun installation.`);
    }
  } catch (err) {
    console.log(`  ⚠ Automatic Bun setup skipped: ${err?.message || err}`);
    console.log(`    clai will retry on first launch, or use: clai --classic`);
  }
}

if (!skipBunInstall && !findBun()) {
  console.log(`
  Note: Bun was not installed during postinstall.
  clai will automatically install Bun on first launch.
  To skip the full-screen UI, run: clai --classic
  `);
}
