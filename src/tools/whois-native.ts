import { createConnection } from "node:net";
import type { ToolResult } from "../types.js";

const MAX_WHOIS_BYTES = 256 * 1024;
const SOCKET_TIMEOUT_MS = 12_000;
const RDAP_TIMEOUT_MS = 12_000;

async function query(server: string, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: server, port: 43 });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(
      () => socket.destroy(new Error(`WHOIS query to ${server} timed out`)),
      SOCKET_TIMEOUT_MS,
    );
    socket.once("connect", () => socket.write(`${target}\r\n`));
    socket.on("data", (chunk: Buffer) => {
      if (bytes >= MAX_WHOIS_BYTES) return;
      const kept = chunk.subarray(0, MAX_WHOIS_BYTES - bytes);
      chunks.push(kept);
      bytes += kept.length;
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function referral(body: string): string | undefined {
  const match = body.match(
    /^\s*(?:refer|whois server)\s*:\s*(?:whois:\/\/)?([^\s/]+)(?:\/.*)?\s*$/im,
  );
  return match?.[1]?.trim();
}

export async function nativeWhoisLookup(target: string): Promise<ToolResult> {
  let rdapFailure: string | undefined;
  try {
    const kind = netLooksLikeIp(target) ? "ip" : "domain";
    const response = await fetch(
      `https://rdap.org/${kind}/${encodeURIComponent(target)}`,
      {
        headers: { accept: "application/rdap+json, application/json" },
        signal: AbortSignal.timeout(RDAP_TIMEOUT_MS),
      },
    );
    if (response.ok) {
      const body = await response.text();
      return {
        ok: true,
        exitCode: 0,
        output: `RDAP registration lookup for ${target}\n${body.slice(0, MAX_WHOIS_BYTES)}`,
        truncated: Buffer.byteLength(body) >= MAX_WHOIS_BYTES,
      };
    }
    rdapFailure = `RDAP returned HTTP ${response.status}`;
  } catch (error) {
    rdapFailure = error instanceof Error ? error.message : String(error);
  }

  try {
    const first = await query("whois.iana.org", target);
    const server = referral(first);
    const body = server ? await query(server, target) : first;
    return {
      ok: true,
      exitCode: 0,
      output: `WHOIS ${target}${server ? ` (via ${server})` : ""}\n${body.slice(0, MAX_WHOIS_BYTES) || "(empty response)"}`,
      truncated: Buffer.byteLength(body) >= MAX_WHOIS_BYTES,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      exitCode: 1,
      output: `Registration lookup failed for ${target}: ${message}${
        rdapFailure ? `\nRDAP also failed: ${rdapFailure}` : ""
      }`,
    };
  }
}

function netLooksLikeIp(value: string): boolean {
  return /^[\d.]+$/.test(value) || value.includes(":");
}
