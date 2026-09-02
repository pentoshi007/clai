

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
  const toolNameMatch = text.match(
    /\{\s*"name"\s*:\s*"fs\.(write|append)"\s*,\s*"args"\s*:\s*\{/,
  );
  if (toolNameMatch) {
    const operation: "write" | "append" =
      toolNameMatch[1] === "append" ? "append" : "write";
    const argsStart = text.indexOf(toolNameMatch[0]) + toolNameMatch[0].length;
    const afterArgs = text.slice(argsStart);

    const pathMatch = afterArgs.match(/"path"\s*:\s*"([^"]+)"/);
    if (!pathMatch?.[1]) return undefined;
    const path = pathMatch[1];

    const priorMatch = afterArgs.match(
      /"expectedPriorBytes"\s*:\s*(\d{1,15})(?!\d)/,
    );
    const expectedPriorBytes = priorMatch?.[1]
      ? Number(priorMatch[1])
      : undefined;

    const contentKeyMatch = afterArgs.match(/"content"\s*:\s*"/);
    if (!contentKeyMatch) return undefined;
    const contentStart = argsStart + afterArgs.indexOf(contentKeyMatch[0]) + contentKeyMatch[0].length;
    let raw = text.slice(contentStart);

    raw = raw.replace(/\\?$/, "");

    try {
      const unescaped = unescapeJsonStringPrefix(raw);

      const lastNewline = unescaped.lastIndexOf("\n");
      const content =
        lastNewline > 0 ? unescaped.slice(0, lastNewline + 1) : unescaped;

      if (content.trim().length < 50) return undefined;

      const lines = content.trimEnd().split("\n");
      const lastLine =
        lines[lines.length - 1]?.trim().slice(0, 80) ?? "(unknown)";

      return { operation, path, content, lastLine, expectedPriorBytes };
    } catch {
      return undefined;
    }
  }

  return undefined;
}
