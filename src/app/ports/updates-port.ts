export type UpdateState = "update-available" | "current" | "unknown" | "error";

export interface UpdateStatus {
  readonly state: UpdateState;
  readonly currentVersion: string;
  readonly latestVersion?: string | undefined;
  readonly updateAvailable: boolean;
  readonly detail?: string | undefined;
}

export interface UpdatesPort {
  check(): Promise<UpdateStatus>;
}
