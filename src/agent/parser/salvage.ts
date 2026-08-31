

/**
 * Attempt to extract usable content from a truncated fs.write / fs.append
 * tool call. When the model's output is cut off mid-JSON, the tool call fails
 * to parse — but typically a large chunk of the intended file content is
 * already present in the raw text. This function extracts:
 *   - operation: which mutation the model actually asked for
 *   - path: the target file path
 *   - content: the partial file content (up to the truncation point)
 *   - lastLine: the last complete line (for telling the model where to resume)
 *   - expectedPriorBytes: the append precondition when the model supplied one
 *
 * Returns undefined when the text does not look like an unambiguous single
 * write/append call. `fs.writeMany` is never salvaged: a truncated multi-file
 * payload cannot be attributed to one file safely.
 */
/**
 * Single-pass JSON string unescape for salvaged (possibly truncated) content.
 * Order matters: a chained `.replace` sequence turns the escaped Windows path
 * `C:\\new` into `C:` + newline + `ew`. Unknown escapes are kept verbatim, and
 * a trailing incomplete escape is dropped.
 */
function unescapeJsonStringPrefix(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    switch (next) {
      case "n":
        out += "\n";
        i += 1;
        break;
      case "r":
        out += "\r";
        i += 1;
        break;
      case "t":
        out += "\t";
        i += 1;
        break;
      case "b":
        out += "\b";
        i += 1;
        break;
      case "f":
        out += "\f";
        i += 1;
        break;
      case '"':
        out += '"';
        i += 1;
        break;
      case "/":
        out += "/";
        i += 1;
        break;
      case "\\":
        out += "\\";
        i += 1;
        break;
      case "u": {
        const hex = raw.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 5;
        } else {
          // Truncated \uXXXX at the cut point — drop it.
          i = raw.length;
        }
        break;
      }
      default:
        out += `\\${next}`;
        i += 1;
        break;
    }
  }
  return out;
}

export interface SalvagedWrite {
  operation: "write" | "append";
  path: string;
  content: string;
  lastLine: string;
  expectedPriorBytes?: number | undefined;
}

export function salvageTruncatedWrite(text: string): SalvagedWrite | undefined {
  // Match fs.write or fs.append: {"name":"fs.write","args":{"path":"...","content":"...
  // Also handle "fs.append" and cases where content comes before path.
  const toolNameMatch = text.match(
    /\{\s*"name"\s*:\s*"fs\.(write|append)"\s*,\s*"args"\s*:\s*\{/,
  );
  if (toolNameMatch) {
    const operation: "write" | "append" =
      toolNameMatch[1] === "append" ? "append" : "write";
    const argsStart = text.indexOf(toolNameMatch[0]) + toolNameMatch[0].length;
    const afterArgs = text.slice(argsStart);

    // Extract path value
    const pathMatch = afterArgs.match(/"path"\s*:\s*"([^"]+)"/);
    if (!pathMatch?.[1]) return undefined;
    const path = pathMatch[1];

    const priorMatch = afterArgs.match(
      /"expectedPriorBytes"\s*:\s*(\d{1,15})(?!\d)/,
    );
    const expectedPriorBytes = priorMatch?.[1]
      ? Number(priorMatch[1])
      : undefined;

    // Find where "content":" starts and extract everything after its opening quote
    const contentKeyMatch = afterArgs.match(/"content"\s*:\s*"/);
    if (!contentKeyMatch) return undefined;
    const contentStart = argsStart + afterArgs.indexOf(contentKeyMatch[0]) + contentKeyMatch[0].length;
    let raw = text.slice(contentStart);

    // The content is JSON-encoded (escaped). Unescape in one pass so a
    // literal backslash sequence is not re-interpreted.
    raw = raw.replace(/\\?$/, "");

    try {
      const unescaped = unescapeJsonStringPrefix(raw);

      // Trim to the last complete line
      const lastNewline = unescaped.lastIndexOf("\n");
      const content =
        lastNewline > 0 ? unescaped.slice(0, lastNewline + 1) : unescaped;

      if (content.trim().length < 50) return undefined; // Too little to salvage

      const lines = content.trimEnd().split("\n");
      const lastLine =
        lines[lines.length - 1]?.trim().slice(0, 80) ?? "(unknown)";

      return { operation, path, content, lastLine, expectedPriorBytes };
    } catch {
      return undefined;
    }
  }

  // fs.writeMany is intentionally NOT salvaged: a truncated multi-file payload
  // is ambiguous about which files were meant to be written, and guessing the
  // first entry can silently overwrite a different file than intended.
  return undefined;
}
