export function formatComposerMeta(
  provider: string | undefined,
  model: string | undefined,
  permissions: string | undefined,
  effort?: string | undefined,
): string {
  const perm =
    permissions === "allow-all"
      ? "auto-allow"
      : permissions === "default"
        ? "default"
        : (permissions ?? "default");

  const parts: string[] = [];
  if (provider) parts.push(provider);
  if (model) {
    const modelShown =
      provider && model.startsWith(`${provider}/`)
        ? model.slice(provider.length + 1)
        : model;
    if (modelShown) {
      const withEffort = effort ? `${modelShown}(${effort})` : modelShown;
      parts.push(withEffort);
    }
  }
  if (perm) parts.push(perm);

  return parts.join(" · ");
}

export function clipComposerMeta(label: string, inputWidth: number): string {
  if (!label) return "";
  const max = Math.max(12, inputWidth - 6);
  if (label.length <= max) return label;
  return `${label.slice(0, Math.max(8, max - 1))}…`;
}
