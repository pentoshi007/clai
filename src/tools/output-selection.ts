export type ResponsePart = "full" | "headers" | "body";

export interface OutputSelection {
  topLines?: number | undefined;
  bottomLines?: number | undefined;
  maxOutputBytes?: number | undefined;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maxBytes) return text;
  if (maxBytes <= 0) return "";

  const marker = "\n... (output truncated by maxOutputBytes)";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const contentBudget = Math.max(0, maxBytes - markerBytes);
  let prefix = encoded.subarray(0, contentBudget).toString("utf8");
  const suffix = markerBytes <= maxBytes ? marker : "";

  // Buffer boundaries can bisect a multi-byte code point. Enforce the ceiling
  // after decoding as well, removing complete code points until it fits.
  while (Buffer.byteLength(prefix + suffix, "utf8") > maxBytes) {
    prefix = prefix.slice(0, -1);
  }
  if (suffix) return `${prefix}${suffix}`;

  let compact = encoded.subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(compact, "utf8") > maxBytes) {
    compact = compact.slice(0, -1);
  }
  return compact;
}

const BODY_REGION_MARKERS = ["\nBody:\n", "\n---\n", "\nContent:\n"] as const;

function bodyRegionSplit(
  text: string,
): { preamble: string; marker: string; body: string } | undefined {
  let best: { index: number; marker: string } | undefined;
  for (const marker of BODY_REGION_MARKERS) {
    const index = text.indexOf(marker);
    if (index < 0) continue;
    if (!best || index < best.index) best = { index, marker };
  }
  if (!best) return undefined;
  return {
    preamble: text.slice(0, best.index),
    marker: best.marker,
    body: text.slice(best.index + best.marker.length),
  };
}

function truncateUtf8PreservingBody(text: string, maxBytes: number): string {
  const regions = bodyRegionSplit(text);
  if (!regions) return truncateUtf8(text, maxBytes);
  const markerBytes = Buffer.byteLength(regions.marker, "utf8");
  const preambleBudget = Math.min(
    Buffer.byteLength(regions.preamble, "utf8"),
    Math.floor(maxBytes * 0.25),
  );
  const preamble = truncateUtf8(regions.preamble, preambleBudget);
  const bodyBudget =
    maxBytes - Buffer.byteLength(preamble, "utf8") - markerBytes;
  if (bodyBudget <= 0) return truncateUtf8(text, maxBytes);
  return `${preamble}${regions.marker}${truncateUtf8(regions.body, bodyBudget)}`;
}

/** Apply model-requested line windows, then a strict UTF-8 byte ceiling. */
export function selectOutput(
  text: string,
  selection: OutputSelection,
): string {
  const top = nonNegativeInteger(selection.topLines);
  const bottom = nonNegativeInteger(selection.bottomLines);
  let selected = text;

  if (top !== undefined || bottom !== undefined) {
    const lines = text.split("\n");
    if (top !== undefined && bottom !== undefined) {
      if (top + bottom >= lines.length) {
        selected = text;
      } else {
        selected = [
          ...lines.slice(0, top),
          `... (${lines.length - top - bottom} lines omitted)`,
          ...lines.slice(lines.length - bottom),
        ].join("\n");
      }
    } else if (top !== undefined) {
      selected =
        top >= lines.length
          ? text
          : [
              ...lines.slice(0, top),
              `... (${lines.length - top} lines omitted)`,
            ].join("\n");
    } else if (bottom !== undefined) {
      selected =
        bottom >= lines.length
          ? text
          : [
              `... (${lines.length - bottom} lines omitted)`,
              ...lines.slice(lines.length - bottom),
            ].join("\n");
    }
  }

  const maxBytes = nonNegativeInteger(selection.maxOutputBytes);
  return maxBytes === undefined
    ? selected
    : truncateUtf8PreservingBody(selected, maxBytes);
}
