import type { ChatImage, JsonSchemaObject, RiskLevel } from "../types.js";
import { canonicalToolName } from "./names.js";
import type {
  McpNormalizedImage,
  McpNormalizedResource,
  McpNormalizedResult,
  McpToolAnnotations,
  McpToolDescriptor,
  McpToolMetadata,
} from "./types.js";

function coerceSchema(schema: unknown): JsonSchemaObject {
  if (
    typeof schema === "object" &&
    schema !== null &&
    (schema as Record<string, unknown>).type === "object"
  ) {
    const record = schema as Record<string, unknown>;
    const properties =
      typeof record.properties === "object" && record.properties !== null
        ? (record.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(record.required)
      ? record.required.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    const additionalProperties =
      typeof record.additionalProperties === "boolean"
        ? record.additionalProperties
        : undefined;
    return {
      type: "object",
      properties,
      ...(required !== undefined ? { required } : {}),
      ...(additionalProperties !== undefined ? { additionalProperties } : {}),
    };
  }
  return { type: "object", properties: {} };
}

function readAnnotations(value: unknown): McpToolAnnotations {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const result: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  } = {};
  if (typeof record.title === "string") result.title = record.title;
  if (typeof record.readOnlyHint === "boolean") result.readOnlyHint = record.readOnlyHint;
  if (typeof record.destructiveHint === "boolean") result.destructiveHint = record.destructiveHint;
  if (typeof record.idempotentHint === "boolean") result.idempotentHint = record.idempotentHint;
  if (typeof record.openWorldHint === "boolean") result.openWorldHint = record.openWorldHint;
  return result;
}

export function deriveRisk(annotations: McpToolAnnotations): RiskLevel {
  if (annotations.readOnlyHint === true) return "safe";
  return "confirm";
}

export function parseToolDescriptor(value: unknown): McpToolDescriptor | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.length === 0) return undefined;
  const descriptor: {
    name: string;
    title?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    annotations?: McpToolAnnotations;
  } = { name: record.name };
  if (typeof record.title === "string") descriptor.title = record.title;
  if (typeof record.description === "string") descriptor.description = record.description;
  if (typeof record.inputSchema === "object" && record.inputSchema !== null) {
    descriptor.inputSchema = record.inputSchema as Record<string, unknown>;
  }
  if ("annotations" in record) descriptor.annotations = readAnnotations(record.annotations);
  return descriptor;
}

export function toToolMetadata(
  serverName: string,
  descriptor: McpToolDescriptor,
  wireName: string,
): McpToolMetadata {
  const annotations = descriptor.annotations ?? {};
  const readOnly = annotations.readOnlyHint === true;
  const destructive = readOnly ? false : annotations.destructiveHint ?? true;
  const idempotent = annotations.idempotentHint ?? false;
  const openWorld = annotations.openWorldHint ?? false;
  const title = descriptor.title ?? annotations.title;
  const base = {
    canonicalName: canonicalToolName(serverName, descriptor.name),
    wireName,
    serverName,
    toolName: descriptor.name,
    description: descriptor.description ?? "",
    inputSchema: coerceSchema(descriptor.inputSchema),
    risk: deriveRisk(annotations),
    readOnly,
    destructive,
    idempotent,
    openWorld,
    annotations,
  };
  return title !== undefined ? { ...base, title } : base;
}

function readContentImages(content: readonly unknown[]): McpNormalizedImage[] {
  const images: McpNormalizedImage[] = [];
  for (const entry of content) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "image") continue;
    const data = record.data;
    const mimeType = record.mimeType;
    if (typeof data === "string" && typeof mimeType === "string") {
      images.push({ mediaType: mimeType, dataBase64: data });
    }
  }
  return images;
}

function readContentResources(content: readonly unknown[]): McpNormalizedResource[] {
  const resources: McpNormalizedResource[] = [];
  for (const entry of content) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "resource") continue;
    const resource = record.resource;
    if (typeof resource !== "object" || resource === null) continue;
    const res = resource as Record<string, unknown>;
    const uri = typeof res.uri === "string" ? res.uri : "";
    const normalized: {
      uri: string;
      mimeType?: string;
      text?: string;
      blobBase64?: string;
    } = { uri };
    if (typeof res.mimeType === "string") normalized.mimeType = res.mimeType;
    if (typeof res.text === "string") normalized.text = res.text;
    if (typeof res.blob === "string") normalized.blobBase64 = res.blob;
    resources.push(normalized);
  }
  return resources;
}

function readContentText(content: readonly unknown[]): string {
  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    } else if (record.type === "resource") {
      const resource = record.resource as Record<string, unknown> | undefined;
      if (resource && typeof resource.text === "string") {
        const uri = typeof resource.uri === "string" ? resource.uri : "resource";
        parts.push(`[${uri}]\n${resource.text}`);
      } else if (resource && typeof resource.uri === "string") {
        parts.push(`[resource ${resource.uri}]`);
      }
    } else if (record.type === "image") {
      const mime = typeof record.mimeType === "string" ? record.mimeType : "image";
      parts.push(`[image ${mime}]`);
    } else if (record.type === "audio") {
      const mime = typeof record.mimeType === "string" ? record.mimeType : "audio";
      parts.push(`[audio ${mime}]`);
    }
  }
  return parts.join("\n");
}

export function normalizeToolResult(raw: unknown): McpNormalizedResult {
  const record =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const isError = record.isError === true;
  const content = Array.isArray(record.content) ? record.content : [];
  const images = readContentImages(content);
  const resources = readContentResources(content);
  const chatImages: ChatImage[] = images.map((image) => ({
    mediaType: image.mediaType,
    dataBase64: image.dataBase64,
  }));
  let text = readContentText(content);
  if (text.length === 0 && typeof record.structuredContent === "object" && record.structuredContent !== null) {
    text = JSON.stringify(record.structuredContent);
  }
  return {
    ok: !isError,
    isError,
    text,
    images,
    resources,
    chatImages,
    raw,
  };
}
