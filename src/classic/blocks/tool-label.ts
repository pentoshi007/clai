import { isFileMutationTool } from "../../tools/file-diff.js";
import { presentTool } from "../../ui-core/rendering/tool-presenter.js";
import { toolUsageLabel } from "../../ui-core/rendering/tool-usage-label.js";
import type { ToolItem } from "../../ui-core/state/transcript-types.js";

export function classicToolLabel(item: ToolItem): string {
  const fallback = presentTool(item).name;
  return isFileMutationTool(item.name) ? fallback : toolUsageLabel(item.name, fallback);
}
