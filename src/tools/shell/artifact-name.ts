export function safeArtifactName(command: string): string {
  const head = command.trim().split(/\s+/)[0] ?? "shell";
  const clean = head.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "");
  return clean || "shell";
}
