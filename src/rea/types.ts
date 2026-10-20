export interface ReaInstallation {
  readonly version: string;
  readonly node: string;
  readonly entry: string;
  readonly directory: string;
}

export type ReaStatus =
  | { readonly state: "missing" }
  | { readonly state: "broken"; readonly reason: string }
  | { readonly state: "ready"; readonly installation: ReaInstallation };

export type ReaMaintenanceAction = "install" | "update";

export interface ReaProgress {
  readonly phase: "resolving" | "runtime" | "downloading" | "installing" | "verifying";
  readonly message: string;
  readonly receivedBytes?: number;
  readonly totalBytes?: number;
}

export type ReaMaintenanceResult =
  | { readonly ok: true; readonly installation: ReaInstallation; readonly changed: boolean }
  | { readonly ok: false; readonly reason: string };

export interface ReaInstallOptions {
  readonly root?: string;
  readonly portableRuntime?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ReaProgress) => void;
}
