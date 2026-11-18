import type { ProviderId } from "../types.js";

export type ModelImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

const MODEL_IMAGE_MEDIA_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function isModelImageMediaType(mediaType: string): boolean {
  return MODEL_IMAGE_MEDIA_TYPES.has(mediaType.toLowerCase());
}

export function detectModelImageMediaType(
  bytes: Uint8Array,
): ModelImageMediaType | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

export type ConvertibleImageFormat =
  | ModelImageMediaType
  | "image/bmp"
  | "image/tiff"
  | "image/heic"
  | "image/avif"
  | "image/x-icon";

export function detectConvertibleImageFormat(
  bytes: Uint8Array,
): ConvertibleImageFormat | undefined {
  const native = detectModelImageMediaType(bytes);
  if (native) return native;
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image/bmp";
  }
  if (bytes.length >= 4) {
    const isLittleEndianTiff =
      bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00;
    const isBigEndianTiff =
      bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a;
    if (isLittleEndianTiff || isBigEndianTiff) return "image/tiff";
    if (
      bytes[0] === 0x00 &&
      bytes[1] === 0x00 &&
      bytes[2] === 0x01 &&
      bytes[3] === 0x00
    ) {
      return "image/x-icon";
    }
  }
  if (bytes.length >= 12) {
    const boxType = String.fromCharCode(
      bytes[4]!,
      bytes[5]!,
      bytes[6]!,
      bytes[7]!,
    );
    if (boxType === "ftyp") {
      const brand = String.fromCharCode(
        bytes[8]!,
        bytes[9]!,
        bytes[10]!,
        bytes[11]!,
      ).toLowerCase();
      if (brand.startsWith("av")) return "image/avif";
      return "image/heic";
    }
  }
  return undefined;
}

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 24) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 10) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = bytes[offset + 1]!;
    while (marker === 0xff && offset + 2 < bytes.length) {
      offset += 1;
      marker = bytes[offset + 1]!;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = view.getUint16(offset + 2, false);
    if (length < 2) return undefined;
    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isStartOfFrame) {
      if (offset + 9 >= bytes.length) return undefined;
      const height = view.getUint16(offset + 5, false);
      const width = view.getUint16(offset + 7, false);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 30) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunk = String.fromCharCode(
    bytes[12]!,
    bytes[13]!,
    bytes[14]!,
    bytes[15]!,
  );
  if (chunk === "VP8X") {
    const width =
      1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const height =
      1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    return width > 1 && height > 1 ? { width, height } : undefined;
  }
  if (chunk === "VP8 ") {
    if (bytes.length < 30) return undefined;
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return undefined;
    }
    const width = view.getUint16(26, true) & 0x3fff;
    const height = view.getUint16(28, true) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (chunk === "VP8L") {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return undefined;
    const packed =
      bytes[21]! |
      (bytes[22]! << 8) |
      (bytes[23]! << 16) |
      (bytes[24]! << 24);
    const width = (packed & 0x3fff) + 1;
    const height = ((packed >>> 14) & 0x3fff) + 1;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  return undefined;
}

export function readImageDimensions(
  bytes: Uint8Array,
): ImageDimensions | undefined {
  switch (detectModelImageMediaType(bytes)) {
    case "image/png":
      return pngDimensions(bytes);
    case "image/gif":
      return gifDimensions(bytes);
    case "image/jpeg":
      return jpegDimensions(bytes);
    case "image/webp":
      return webpDimensions(bytes);
    default:
      return undefined;
  }
}

export interface ImageBudget {
  readonly maxBytes: number;
  readonly hardMaxBytes: number;
  readonly maxDimension: number;
  readonly maxCount: number;
  readonly maxTotalBytes: number;
  readonly label: string;
}

const ANTHROPIC_BUDGET: ImageBudget = {
  maxBytes: 3_600_000,
  hardMaxBytes: 3_900_000,
  maxDimension: 1568,
  maxCount: 20,
  maxTotalBytes: 12_000_000,
  label: "Anthropic",
};

const OPENAI_BUDGET: ImageBudget = {
  maxBytes: 4_500_000,
  hardMaxBytes: 18_000_000,
  maxDimension: 2048,
  maxCount: 10,
  maxTotalBytes: 15_000_000,
  label: "OpenAI",
};

const GEMINI_BUDGET: ImageBudget = {
  maxBytes: 4_500_000,
  hardMaxBytes: 14_000_000,
  maxDimension: 3072,
  maxCount: 12,
  maxTotalBytes: 15_000_000,
  label: "Gemini",
};

const LOCAL_BUDGET: ImageBudget = {
  maxBytes: 6_000_000,
  hardMaxBytes: 40_000_000,
  maxDimension: 2048,
  maxCount: 8,
  maxTotalBytes: 24_000_000,
  label: "Ollama",
};

const GATEWAY_BUDGET: ImageBudget = {
  maxBytes: 3_600_000,
  hardMaxBytes: 5_000_000,
  maxDimension: 2048,
  maxCount: 8,
  maxTotalBytes: 10_000_000,
  label: "gateway",
};

const SARVAM_BUDGET: ImageBudget = {
  ...GATEWAY_BUDGET,
  maxTotalBytes: 6_000_000,
  label: "Sarvam Token Factory",
};

function budgetForModelFamily(model: string): ImageBudget | undefined {
  if (/claude|anthropic/i.test(model)) return ANTHROPIC_BUDGET;
  if (/gemini|gemma/i.test(model)) return GEMINI_BUDGET;
  if (/gpt-|^o[134]|openai/i.test(model)) return OPENAI_BUDGET;
  return undefined;
}

export function imageBudgetFor(
  provider: ProviderId | string,
  model = "",
): ImageBudget {
  switch (provider) {
    case "anthropic":
      return ANTHROPIC_BUDGET;
    case "openai":
      return OPENAI_BUDGET;
    case "gemini":
      return GEMINI_BUDGET;
    case "ollama":
      return LOCAL_BUDGET;
    case "sarvam":
      return SARVAM_BUDGET;
    default:
      return budgetForModelFamily(model) ?? GATEWAY_BUDGET;
  }
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
