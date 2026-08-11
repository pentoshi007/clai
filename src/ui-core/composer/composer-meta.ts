/**
 * Compact session meta for the input-box top border
 * (e.g. `bynara · glm-5.2 · always-approve`).
 *
 * Always prefers showing provider when known — never model alone.
 */

export function formatComposerMeta(
  provider: string | undefined,
  model: string | undefined,
  permissions: string | undefined,
): string {
  const perm =
    permissions === "allow-all"
      ? "always-approve"
      : permissions === "default"
        ? "default"
        : (permissions ?? "default");

  const parts: string[] = [];
  if (provider) parts.push(provider);
  if (model) {
    // Avoid "bynara · bynara/glm…" if model already embeds provider.
    const modelShown =
      provider && model.startsWith(`${provider}/`)
        ? model.slice(provider.length + 1)
        : model;
    if (modelShown) parts.push(modelShown);
  }
  if (perm) parts.push(perm);

  return parts.join(" · ");
}

/** Clip the meta label so it never overflows the input width. */
export function clipComposerMeta(label: string, inputWidth: number): string {
  if (!label) return "";
  // Leave room for border glyphs and spaces around bottomTitle.
  const max = Math.max(12, inputWidth - 6);
  if (label.length <= max) return label;
  return `${label.slice(0, Math.max(8, max - 1))}…`;
}
