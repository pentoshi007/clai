export interface UpdateStatus {
  readonly currentVersion: string;
  readonly latestVersion?: string | undefined;
  readonly updateAvailable: boolean;
}

/**
 * Update check (F-012 adjacent, `/update`). Kept as a port so the check runs
 * without corrupting TUI output and can be faked in tests.
 */
export interface UpdatesPort {
  check(): Promise<UpdateStatus>;
}
