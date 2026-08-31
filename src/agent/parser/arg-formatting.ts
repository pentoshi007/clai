import { safeCwd } from "../../os/cwd.js";
import type { ToolCall } from "../../types.js";

/** Compact line window for fs.read card headers, e.g. "11–20" or "1–10". */
export function formatFsReadLineRange(
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!args) return undefined;
  const startRaw =
    typeof args.startLine === "number"
      ? args.startLine
      : typeof args.offset === "number"
        ? args.offset
        : undefined;
  const endRaw = typeof args.endLine === "number" ? args.endLine : undefined;
  const limitRaw = typeof args.limit === "number" ? args.limit : undefined;
  const start =
    typeof startRaw === "number" && Number.isFinite(startRaw)
      ? Math.max(1, Math.floor(startRaw) || 1)
      : undefined;
  const end =
    typeof endRaw === "number" && Number.isFinite(endRaw)
      ? Math.floor(endRaw)
      : undefined;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.floor(limitRaw)
      : undefined;

  if (start !== undefined && end !== undefined && end >= start) {
    return start === end ? `${start}` : `${start}–${end}`;
  }
  if (start !== undefined && limit !== undefined) {
    const last = start + limit - 1;
    return start === last ? `${start}` : `${start}–${last}`;
  }
  if (start !== undefined) return `${start}+`;
  if (end !== undefined && end >= 1) return `1–${end}`;
  if (limit !== undefined) return `1–${limit}`;
  return undefined;
}

export function formatToolArgs(call: ToolCall): string {
  if (call.name === "terminal.send") {
    return `id=${String(call.args.id ?? "")} kind=${String(call.args.kind ?? "")}`;
  }
  if (call.name === "shell.exec") return String(call.args.command ?? "");
  if (call.name === "net.scan")
    return `${call.args.target ?? ""}${call.args.ports ? ` -p ${call.args.ports}` : ""}${call.args.flags ? ` ${call.args.flags}` : ""}`;
  if (call.name === "pentest.recon") return String(call.args.target ?? "");
  if (call.name === "dns.lookup")
    return `${call.args.target ?? ""}${call.args.record ? ` ${call.args.record}` : " A"}`;
  if (call.name === "whois.lookup") return String(call.args.target ?? "");
  if (call.name === "fs.read") {
    const path = String(call.args.path ?? "");
    const range = formatFsReadLineRange(call.args);
    return range ? `${path}  lines ${range}` : path;
  }
  if (
    call.name === "fs.write" ||
    call.name === "fs.append" ||
    call.name === "fs.edit" ||
    call.name === "fs.replaceLines" ||
    call.name === "fs.delete"
  ) {
    return String(call.args.path ?? "");
  }
  if (call.name === "fs.writeMany") {
    const files = Array.isArray(call.args.files) ? call.args.files : [];
    const names = files
      .map((f) =>
        f && typeof f === "object"
          ? String((f as { path?: unknown }).path ?? "")
          : "",
      )
      .filter(Boolean);
    const preview = names.slice(0, 4).join(", ");
    return `${names.length} file(s)${preview ? `: ${preview}${names.length > 4 ? ", …" : ""}` : ""}`;
  }
  if (call.name === "fs.search") return String(call.args.pattern ?? "");
  if (call.name === "image.ocr" || call.name === "pdf.read")
    return String(call.args.path ?? "");
  if (call.name === "http.fetch" || call.name === "web.fetch")
    return String(call.args.url ?? "");
  if (call.name === "web.search") return String(call.args.query ?? "");
  if (call.name === "pkg.install") return String(call.args.tool ?? "");
  if (call.name === "fs.list") return String(call.args.path ?? safeCwd());
  if (call.name === "tool.batch") {
    // Compact summary — never dump the full nested JSON into the card header.
    const raw = call.args.calls;
    const list = Array.isArray(raw) ? raw : [];
    const names = list
      .map((entry) =>
        entry && typeof entry === "object"
          ? String((entry as { name?: unknown }).name ?? "")
          : "",
      )
      .filter(Boolean);
    if (names.length === 0) return `${list.length || 0} call(s)`;
    const preview = names.slice(0, 4).join(", ");
    return `${names.length} call(s): ${preview}${names.length > 4 ? ", …" : ""}`;
  }
  return JSON.stringify(call.args);
}
