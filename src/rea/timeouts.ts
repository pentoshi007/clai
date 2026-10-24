const MAX_TIMER_DELAY_MS = 2_147_483_647;

const STARTUP_DEFAULTS: Readonly<Record<string, number>> = {
  REA_GHIDRA_STARTUP_TIMEOUT_MS: 7_200_000,
  REA_HOPPER_STARTUP_TIMEOUT_MS: 7_200_000,
  REA_SWIFTC_COMPILE_TIMEOUT_MS: 600_000,
};

export function reaStartupEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const [name, defaultMs] of Object.entries(STARTUP_DEFAULTS)) {
    const value = env[name] ?? String(defaultMs);
    const timeoutMs = Number(value);
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(timeoutMs) || timeoutMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`${name} must be a positive integer from 1 to ${MAX_TIMER_DELAY_MS} milliseconds.`);
    }
    settings[name] = value;
  }
  return settings;
}
