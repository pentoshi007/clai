const META_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function metaSupportsMaxEffort(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (m.includes("contributor")) return false;
  return /muse-spark-1\.3(?![\d.])/.test(m);
}

export function metaAcceptedEfforts(model: string): readonly string[] {
  return metaSupportsMaxEffort(model)
    ? META_EFFORTS
    : META_EFFORTS.filter((effort) => effort !== "max");
}

export function metaReasoningEffort(effort: string, model: string): string {
  const e = effort.trim().toLowerCase();
  if (e === "none") return "minimal";
  if (e === "max") return metaSupportsMaxEffort(model) ? "max" : "xhigh";
  return (META_EFFORTS as readonly string[]).includes(e) ? e : "medium";
}

export function metaReasoningSummary(effort: string): string {
  if (effort === "max" || effort === "xhigh" || effort === "high") {
    return "detailed";
  }
  if (effort === "medium") return "concise";
  return "auto";
}
