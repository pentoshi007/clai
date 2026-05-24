import { execa } from "execa";

export interface PackageManager {
  id: "brew" | "apt" | "dnf" | "pacman" | "winget" | "choco" | "unknown";
  installCommand(tool: string): string;
  installArgv(
    tool: string,
  ): { command: string; argv: string[]; needsSudo: boolean } | undefined;
}

/**
 * Strict allowlist for package names. Lets common upstream identifiers
 * through (alphanum, dot, dash, underscore, slash for cask paths, colon for
 * winget IDs and apt versioned packages, plus @ for npm-style scopes), but
 * blocks shell metacharacters.
 */
const PACKAGE_NAME_RE = /^[A-Za-z0-9_.@:/+-]+$/;

export function assertSafePackageName(tool: string): string {
  const value = tool.trim();
  if (!value) throw new Error("Package name is empty");
  if (!PACKAGE_NAME_RE.test(value)) {
    throw new Error(`Invalid package name: ${tool}`);
  }
  return value;
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execa(process.platform === "win32" ? "where" : "which", [command]);
    return true;
  } catch {
    return false;
  }
}

export async function detectPackageManager(): Promise<PackageManager> {
  if (process.platform === "darwin" && (await commandExists("brew"))) {
    return {
      id: "brew",
      installCommand: (tool) => `brew install ${tool}`,
      installArgv: (tool) => ({
        command: "brew",
        argv: ["install", assertSafePackageName(tool)],
        needsSudo: false,
      }),
    };
  }

  if (process.platform === "win32") {
    if (await commandExists("winget")) {
      return {
        id: "winget",
        installCommand: (tool) => `winget install ${tool}`,
        installArgv: (tool) => ({
          command: "winget",
          argv: ["install", assertSafePackageName(tool)],
          needsSudo: false,
        }),
      };
    }
    if (await commandExists("choco")) {
      return {
        id: "choco",
        installCommand: (tool) => `choco install ${tool}`,
        installArgv: (tool) => ({
          command: "choco",
          argv: ["install", "-y", assertSafePackageName(tool)],
          needsSudo: false,
        }),
      };
    }
  }

  if (await commandExists("apt")) {
    return {
      id: "apt",
      installCommand: (tool) =>
        `sudo apt update && sudo apt install -y ${tool}`,
      installArgv: (tool) => ({
        command: "sudo",
        argv: ["apt", "install", "-y", assertSafePackageName(tool)],
        needsSudo: true,
      }),
    };
  }
  if (await commandExists("dnf")) {
    return {
      id: "dnf",
      installCommand: (tool) => `sudo dnf install -y ${tool}`,
      installArgv: (tool) => ({
        command: "sudo",
        argv: ["dnf", "install", "-y", assertSafePackageName(tool)],
        needsSudo: true,
      }),
    };
  }
  if (await commandExists("pacman")) {
    return {
      id: "pacman",
      installCommand: (tool) => `sudo pacman -S --needed ${tool}`,
      installArgv: (tool) => ({
        command: "sudo",
        argv: [
          "pacman",
          "-S",
          "--needed",
          "--noconfirm",
          assertSafePackageName(tool),
        ],
        needsSudo: true,
      }),
    };
  }

  return {
    id: "unknown",
    installCommand: (tool) => `Install ${tool} with your OS package manager`,
    installArgv: () => undefined,
  };
}

export async function commandAvailable(command: string): Promise<boolean> {
  return commandExists(command);
}
