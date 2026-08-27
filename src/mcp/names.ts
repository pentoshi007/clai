import { createHash } from "node:crypto";

export const MCP_CANONICAL_PREFIX = "mcp." as const;
export const MCP_WIRE_PREFIX = "mcp_" as const;
export const MCP_WIRE_MAX_LENGTH = 64;

const MIN_HASH_LENGTH = 8;
const NON_WIRE_CHAR = /[^A-Za-z0-9]+/g;
const IDENTITY_SEPARATOR = "\u0000";

export function canonicalToolName(serverName: string, toolName: string): string {
  return `${MCP_CANONICAL_PREFIX}${serverName}.${toolName}`;
}

export function isCanonicalToolName(value: string): boolean {
  return value.startsWith(MCP_CANONICAL_PREFIX) && value.length > MCP_CANONICAL_PREFIX.length;
}

export function toolIdentity(serverName: string, toolName: string): string {
  return `${serverName}${IDENTITY_SEPARATOR}${toolName}`;
}

export interface WireNameInput {
  readonly serverName: string;
  readonly toolName: string;
}

interface SanitizedSegment {
  readonly value: string;
  readonly normalized: boolean;
}

function sanitizeSegment(raw: string): SanitizedSegment {
  const replaced = raw.replace(NON_WIRE_CHAR, "_").replace(/^_+|_+$/g, "");
  const value = replaced.length > 0 ? replaced : "x";
  return { value, normalized: value !== raw };
}

function hashFor(identity: string, length: number): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, length);
}

function withHash(base: string, identity: string, length: number): string {
  const suffix = `_${hashFor(identity, length)}`;
  const room = Math.max(MCP_WIRE_PREFIX.length, MCP_WIRE_MAX_LENGTH - suffix.length);
  const head = base.length > room ? base.slice(0, room) : base;
  return `${head}${suffix}`;
}

export class WireNameAllocator {
  private readonly used = new Map<string, string>();

  assign(input: WireNameInput): string {
    const identity = toolIdentity(input.serverName, input.toolName);
    const server = sanitizeSegment(input.serverName);
    const tool = sanitizeSegment(input.toolName);
    const base = `${MCP_WIRE_PREFIX}${server.value}_${tool.value}`;
    const collides = this.used.has(base) && this.used.get(base) !== identity;
    const mustHash =
      server.normalized || tool.normalized || base.length > MCP_WIRE_MAX_LENGTH || collides;
    let hashLength = MIN_HASH_LENGTH;
    let candidate = mustHash ? withHash(base, identity, hashLength) : base;
    while (this.used.has(candidate) && this.used.get(candidate) !== identity) {
      hashLength += 4;
      candidate = withHash(base, identity, hashLength);
    }
    this.used.set(candidate, identity);
    return candidate;
  }
}

export function allocateWireNames(inputs: readonly WireNameInput[]): Map<string, string> {
  const sorted = [...inputs].sort((a, b) =>
    toolIdentity(a.serverName, a.toolName).localeCompare(toolIdentity(b.serverName, b.toolName)),
  );
  const allocator = new WireNameAllocator();
  const byIdentity = new Map<string, string>();
  for (const input of sorted) {
    byIdentity.set(toolIdentity(input.serverName, input.toolName), allocator.assign(input));
  }
  return byIdentity;
}
