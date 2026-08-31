import * as dns from "node:dns/promises";
import type { ToolResult } from "../types.js";

export type DnsRecordType =
  | "A"
  | "AAAA"
  | "ANY"
  | "CAA"
  | "CNAME"
  | "MX"
  | "NS"
  | "PTR"
  | "SOA"
  | "SRV"
  | "TXT";

const RESOLVER_TIMEOUT_MS = 8_000;
const DOH_TIMEOUT_MS = 10_000;

const DOH_TYPE: Record<DnsRecordType, number | string> = {
  A: 1,
  AAAA: 28,
  CNAME: 5,
  MX: 15,
  NS: 2,
  PTR: 12,
  SOA: 6,
  SRV: 33,
  TXT: 16,
  CAA: 257,
  ANY: 255,
};

function render(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.join(" ");
  }
  return JSON.stringify(value);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function resolveViaSystem(host: string, record: DnsRecordType): Promise<unknown[]> {
  switch (record) {
    case "A":
      return dns.resolve4(host);
    case "AAAA":
      return dns.resolve6(host);
    case "CAA":
      return dns.resolveCaa(host);
    case "CNAME":
      return dns.resolveCname(host);
    case "MX":
      return dns.resolveMx(host);
    case "NS":
      return dns.resolveNs(host);
    case "PTR":
      return dns.resolvePtr(host);
    case "SOA":
      return [await dns.resolveSoa(host)];
    case "SRV":
      return dns.resolveSrv(host);
    case "TXT":
      return dns.resolveTxt(host);
    case "ANY":
      return dns.resolveAny(host);
    default: {
      const _exhaustive: never = record;
      throw new Error(`unsupported record type: ${_exhaustive}`);
    }
  }
}

async function resolveAnyComposite(host: string): Promise<string[]> {
  const types: DnsRecordType[] = ["A", "AAAA", "MX", "NS", "TXT", "CNAME"];
  const lines: string[] = [];
  await Promise.all(
    types.map(async (type) => {
      try {
        const values = await withTimeout(
          resolveViaSystem(host, type),
          RESOLVER_TIMEOUT_MS,
          `DNS ${type}`,
        );
        for (const value of values) {
          lines.push(`${type}\t${render(value)}`);
        }
      } catch {
      }
    }),
  );
  return lines;
}

async function resolveViaDoh(host: string, record: DnsRecordType): Promise<string[]> {
  if (record === "ANY") {
    const composite: string[] = [];
    const types: DnsRecordType[] = ["A", "AAAA", "MX", "NS", "TXT", "CNAME"];
    await Promise.all(
      types.map(async (type) => {
        try {
          const rows = await resolveViaDoh(host, type);
          for (const row of rows) composite.push(`${type}\t${row}`);
        } catch {
        }
      }),
    );
    return composite;
  }

  const url = new URL("https://dns.google/resolve");
  url.searchParams.set("name", host);
  url.searchParams.set("type", String(DOH_TYPE[record]));
  const response = await fetch(url, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
  });
  const payload = (await response.json()) as {
    Status?: number;
    Answer?: Array<{ name?: string; type?: number; TTL?: number; data?: string }>;
  };
  if (!response.ok || payload.Status !== 0) {
    throw new Error(
      `DoH returned HTTP ${response.status}, DNS status ${payload.Status ?? "unknown"}`,
    );
  }
  return (payload.Answer ?? []).map((answer) => answer.data ?? JSON.stringify(answer));
}

export async function nativeDnsLookup(
  host: string,
  record: DnsRecordType,
): Promise<ToolResult> {
  const label = `DNS ${record} records for ${host}`;
  let systemError: string | undefined;

  try {
    if (record === "ANY") {
      try {
        const values = await withTimeout(
          resolveViaSystem(host, "ANY"),
          RESOLVER_TIMEOUT_MS,
          "DNS ANY",
        );
        return {
          ok: true,
          exitCode: 0,
          output: `${label}\n${values.length ? values.map(render).join("\n") : "(no records returned)"}`,
        };
      } catch {
        const composite = await resolveAnyComposite(host);
        if (composite.length > 0) {
          return {
            ok: true,
            exitCode: 0,
            output: `${label} (composite A/AAAA/MX/NS/TXT/CNAME)\n${composite.join("\n")}`,
          };
        }
        throw new Error("ANY unsupported and composite set empty");
      }
    }

    const values = await withTimeout(
      resolveViaSystem(host, record),
      RESOLVER_TIMEOUT_MS,
      `DNS ${record}`,
    );
    return {
      ok: true,
      exitCode: 0,
      output: `${label}\n${values.length ? values.map(render).join("\n") : "(no records returned)"}`,
    };
  } catch (error) {
    systemError = error instanceof Error ? error.message : String(error);
  }

  try {
    const answers = await resolveViaDoh(host, record);
    return {
      ok: true,
      exitCode: 0,
      output: `${label} (DNS-over-HTTPS fallback)\n${answers.length ? answers.join("\n") : "(no records returned)"}`,
    };
  } catch (fallbackError) {
    const fallbackMessage =
      fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
    return {
      ok: false,
      exitCode: 1,
      output: `DNS lookup failed for ${host} (${record}): ${systemError}\nDNS-over-HTTPS fallback also failed: ${fallbackMessage}`,
    };
  }
}
