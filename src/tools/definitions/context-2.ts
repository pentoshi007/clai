import type { ToolDefinition } from "../../types.js";
import { def, emptyObject } from "./define.js";

export const TOOL_DEFINITIONS_CONTEXT_2: ToolDefinition[] = [
  def(
    "image.ocr",
    "OCR text from an image file (fallback when vision is unavailable).",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        lang: {
          type: "string",
          description:
            "tesseract language code, or codes joined with + (default eng).",
        },
        psm: {
          type: "integer",
          minimum: 0,
          maximum: 13,
          description:
            "tesseract page-segmentation mode. Omit to try 6, 3 and 11 and keep the best result.",
        },
        preprocess: {
          type: "boolean",
          description:
            "Upscale and grayscale small images before OCR (default true). Set false to OCR the raw file.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "image.view",
    "Look at an image yourself. Attaches the real image bytes to your next turn so you see the actual pixels — use this for screenshots, renders, charts, diagrams and photos, and to verify UI work you just produced. Prefer this over image.ocr whenever you need to see anything other than plain text.",
    {
      type: "object",
      properties: {
        path: { type: "string", description: "Image file to look at." },
        paths: {
          type: "array",
          items: { type: "string" },
          maxItems: 4,
          description:
            "Several images to look at in one call (e.g. before/after screenshots). Use instead of path.",
        },
      },
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "pdf.read",
    "Extract text from a PDF. Uses the embedded text layer per page and OCRs only the pages that have none.",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        firstPage: {
          type: "integer",
          minimum: 1,
          description: "First page to read (1-based, default 1).",
        },
        lastPage: {
          type: "integer",
          minimum: 1,
          description: "Last page to read, inclusive.",
        },
        maxPages: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description:
            "Maximum pages to read from firstPage. OCR costs up to 120s per scanned page, so bound this for long scans.",
        },
        ocr: {
          type: "string",
          enum: ["auto", "never", "always"],
          description:
            "auto (default) OCRs only pages with no text layer; never returns the text layer alone; always re-OCRs every page.",
        },
        lang: {
          type: "string",
          description: "tesseract language code for OCR pages (default eng).",
        },
        dpi: {
          type: "integer",
          minimum: 72,
          maximum: 600,
          description: "Render resolution for OCR pages (default 300).",
        },
        psm: {
          type: "integer",
          minimum: 0,
          maximum: 13,
          description:
            "tesseract page-segmentation mode. Omit to try 3, 6 and 11 and keep the best result.",
        },
        maxChars: {
          type: "integer",
          minimum: 1000,
          maximum: 1000000,
          description: "Cap on returned characters (default 200000).",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
];
