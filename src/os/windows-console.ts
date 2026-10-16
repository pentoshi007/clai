import { spawn } from "node:child_process";

const MINIMISE_TIMEOUT_MS = 3_000;

const MINIMISE_SCRIPT = [
  "Add-Type -Namespace Clai -Name Window -MemberDefinition '",
  '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); ',
  '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd); ',
  '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd); ',
  '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); ',
  '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();',
  "';",
  "$console = [Clai.Window]::GetConsoleWindow();",
  "$target = if ($console -ne [IntPtr]::Zero -and [Clai.Window]::IsWindowVisible($console)) { $console } else { [Clai.Window]::GetForegroundWindow() };",
  "if ($target -eq [IntPtr]::Zero) { exit 1 };",
  "[Clai.Window]::ShowWindow($target, 6) | Out-Null;",
  "if ([Clai.Window]::IsIconic($target)) { exit 0 };",
  "exit 1",
].join(" ");

export async function minimiseWindowsConsoleWindow(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    try {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", MINIMISE_SCRIPT],
        { stdio: "ignore", windowsHide: true },
      );
      child.once("error", () => finish(false));
      child.once("exit", (code) => finish(code === 0));
      timer = setTimeout(() => {
        child.kill();
        finish(false);
      }, MINIMISE_TIMEOUT_MS);
      timer.unref();
      child.unref();
    } catch {
      finish(false);
    }
  });
}
