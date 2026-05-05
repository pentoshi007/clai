import { execa } from 'execa';

export interface PackageManager {
  id: 'brew' | 'apt' | 'dnf' | 'pacman' | 'winget' | 'choco' | 'unknown';
  installCommand(tool: string): string;
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execa(process.platform === 'win32' ? 'where' : 'which', [command]);
    return true;
  } catch {
    return false;
  }
}

export async function detectPackageManager(): Promise<PackageManager> {
  if (process.platform === 'darwin' && (await commandExists('brew'))) {
    return { id: 'brew', installCommand: (tool) => `brew install ${tool}` };
  }

  if (process.platform === 'win32') {
    if (await commandExists('winget')) return { id: 'winget', installCommand: (tool) => `winget install ${tool}` };
    if (await commandExists('choco')) return { id: 'choco', installCommand: (tool) => `choco install ${tool}` };
  }

  if (await commandExists('apt')) return { id: 'apt', installCommand: (tool) => `sudo apt update && sudo apt install -y ${tool}` };
  if (await commandExists('dnf')) return { id: 'dnf', installCommand: (tool) => `sudo dnf install -y ${tool}` };
  if (await commandExists('pacman')) return { id: 'pacman', installCommand: (tool) => `sudo pacman -S --needed ${tool}` };

  return { id: 'unknown', installCommand: (tool) => `Install ${tool} with your OS package manager` };
}

export async function commandAvailable(command: string): Promise<boolean> {
  return commandExists(command);
}
