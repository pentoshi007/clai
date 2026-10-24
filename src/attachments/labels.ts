import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".ico", ".heic", ".avif"]);
const FILE_REFERENCE = /file:\/\/[^\s)\]}>]+/gi;

export function attachmentLabel(reference: string, imageNumber: number): { readonly image: boolean; readonly label: string } | undefined {
  try {
    const path = fileURLToPath(reference);
    const image = IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
    const name = basename(path).replace(/[\[\]\r\n\x00-\x1f\x7f]/g, "_");
    return { image, label: image ? `Image ${imageNumber}` : name || "file" };
  } catch {
    return undefined;
  }
}

export function mapAttachmentReferences(text: string, replace: (reference: string) => string): string {
  return text.replace(FILE_REFERENCE, replace);
}

export function attachmentDisplayText(text: string): string {
  let imageNumber = 0;
  return mapAttachmentReferences(text, (reference) => {
    const attachment = attachmentLabel(reference, imageNumber + 1);
    if (!attachment) return reference;
    if (attachment.image) imageNumber += 1;
    return `[${attachment.label}]`;
  });
}
