import { imageOcr, imageView } from "../image.js";
import { pdfRead } from "../pdf.js";
import { type ToolRunOptions, type ToolHandler } from "../tool-types.js";
import {
  optionalBoolean,
  optionalNumber,
  optionalResponseMode,
  optionalString,
  requireNumber,
  requireString,
  requireStringAllowEmpty,
} from "./args.js";

export const toolRegistry_CONTEXT_2: Record<string, ToolHandler> = {
  async "image.ocr"(args, options) {
    return imageOcr(args, options);
  },
  async "image.view"(args, options) {
    return imageView(args, options);
  },
  async "pdf.read"(args, options) {
    return pdfRead(args, options);
  },
};
