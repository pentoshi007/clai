import { commandAvailable as hasExecutable } from "./command.js";

export interface PackageManager {
  id: "brew" | "apt" | "dnf" | "pacman" | "winget" | "choco" | "unknown";
  installCommand(tool: string): string;
}

const manager = (
  id: PackageManager["id"],
  installCommand: (tool: string) => string,
): PackageManager => ({ id, installCommand });

export async function detectPackageManager(): Promise<PackageManager> {
  if (process.platform === "darwin" && (await hasExecutable("brew"))) {
    return manager("brew", (tool) => `brew install ${tool}`);
  }
  if (process.platform === "win32") {
    if (await hasExecutable("winget")) {
      return manager(
        "winget",
        (tool) =>
          `winget install --exact --id ${tool} --accept-source-agreements --accept-package-agreements`,
      );
    }
    if (await hasExecutable("choco")) {
      return manager("choco", (tool) => `choco install -y ${tool}`);
    }
  }
  if (await hasExecutable("apt")) {
    return manager("apt", (tool) => `sudo apt-get update && sudo apt-get install -y ${tool}`);
  }
  if (await hasExecutable("dnf")) {
    return manager("dnf", (tool) => `sudo dnf install -y ${tool}`);
  }
  if (await hasExecutable("pacman")) {
    return manager("pacman", (tool) => `sudo pacman -S --needed --noconfirm ${tool}`);
  }
  return manager("unknown", (tool) => `install ${tool} with the OS package manager`);
}

export async function commandAvailable(command: string): Promise<boolean> {
  return hasExecutable(command);
}
