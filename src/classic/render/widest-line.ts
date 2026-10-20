import { widestLineWidth } from "../../ui-core/rendering/text-width.js";

export default function widestLine(text: string): number {
  return widestLineWidth(text);
}
