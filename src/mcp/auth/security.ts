import { classifyHost } from "../../tools/web/ssrf-guard.js";
import { McpTransportError } from "../transport.js";

export function assertSafeDiscoveryUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpTransportError("protocol", `MCP OAuth discovery URL is not parseable: ${raw}`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const classification = classifyHost(hostname);
  const isLoopback = classification?.class === "loopback";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new McpTransportError(
      "protocol",
      `MCP OAuth discovery refuses ${url.protocol} for ${url.host}; https is required except on loopback.`,
    );
  }
  if (classification && classification.class !== "loopback") {
    throw new McpTransportError(
      "protocol",
      `MCP OAuth discovery refuses ${classification.class} address ${url.host}.`,
    );
  }
  return url;
}

export function canonicalResourceUri(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  if (url.pathname === "/" && url.search.length === 0) return url.origin;
  return url.toString();
}
