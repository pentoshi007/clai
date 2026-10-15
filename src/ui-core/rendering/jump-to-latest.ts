export function jumpToLatestLabel(width: number, unicode: boolean): string {
  const labels = unicode
    ? ["[↓ Jump to latest]", "[↓ Latest]", "[↓]"]
    : ["[Jump to latest]", "[Latest]", "[v]"];
  return labels.find(label => label.length <= width) ?? "";
}
