/**
 * Type-syntax report (Phase 0, P0-04 capability 7; enforced in Phase 7).
 *
 * Token-aware, not regex-based, so string literals and comments cannot create
 * false findings. Classifies:
 *
 *   explicitAny        — every `any` type annotation in production source.
 *   unknownBoundary    — `unknown` at an untrusted boundary (JSON/provider/MCP
 *                        payload decoding, `catch` bindings, env/config input).
 *                        Valid by policy; retained and classified, not counted
 *                        as debt.
 *   unknownNarrowing   — `unknown` that still needs a predicate/decoder before
 *                        domain use.
 *   unknownInternal    — `unknown` in purely internal positions: imprecision.
 *   doubleAssertion    — `x as unknown as T` and `as any as T`.
 *   broadCast          — `as any`, `as object`, `as Function`, non-null on a cast.
 *   suppression        — `@ts-ignore`, `@ts-expect-error`, `eslint-disable`.
 *
 * The enforced gate is zero unsafe/unjustified cases, never a blindly minimized
 * raw `unknown` count.
 */
import ts from "typescript";

/**
 * `unknown` is classified by syntactic position, never by identifier name — see
 * `classifyUnknown` for the rationale and the audit finding that motivated it.
 */
const SUPPRESSION_PATTERNS = [
  { id: "ts-ignore", pattern: /@ts-ignore/ },
  { id: "ts-expect-error", pattern: /@ts-expect-error/ },
  { id: "ts-nocheck", pattern: /@ts-nocheck/ },
  { id: "eslint-disable", pattern: /eslint-disable/ },
];

function contextName(node) {
  let current = node.parent;
  while (current) {
    if (
      ts.isParameter(current) ||
      ts.isVariableDeclaration(current) ||
      ts.isPropertyDeclaration(current) ||
      ts.isPropertySignature(current)
    ) {
      return current.name && typeof current.name.getText === "function"
        ? current.name.getText()
        : "";
    }
    if (ts.isFunctionLike(current)) {
      return current.name && typeof current.name.getText === "function"
        ? current.name.getText()
        : "";
    }
    current = current.parent;
  }
  return "";
}

/**
 * Classifies one `unknown` keyword occurrence by its **syntactic position**.
 *
 * An earlier revision matched identifier names against a hint list
 * ("value", "result", "payload", …). An independent audit showed that this let
 * genuinely internal imprecision such as `const cachedResult: unknown` be
 * classified boundary-valid — and because boundary `unknown` is deliberately not
 * ratcheted, a variable could escape the Phase 7 gate purely by being named
 * well. Position is decidable and cannot be gamed by naming:
 *
 *   catch binding                        -> unknownBoundary (always correct)
 *   type argument / index-signature value
 *     / array element inside a type       -> unknownBoundary (a decode target shape)
 *   function or method parameter          -> unknownNarrowing (must be narrowed)
 *   anything else (variable, property,
 *     return type, internal alias)        -> unknownInternal
 *
 * A reviewer may still judge a specific `unknownInternal` finding to be a valid
 * boundary; that judgement belongs in the phase evidence, not in a name match.
 */
function classifyUnknown(node) {
  // `catch (e: unknown)` — the canonical boundary case.
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isCatchClause(current)) return "unknownBoundary";
    // Stop at the enclosing function so an outer catch cannot capture it.
    if (ts.isFunctionLike(current)) break;
  }

  const parent = node.parent;
  if (!parent) return "unknownInternal";

  // Data-shape positions: Record<string, unknown>, Array<unknown>, unknown[],
  // and `[key: string]: unknown`. These describe externally supplied payloads.
  if (ts.isTypeReferenceNode(parent) || ts.isArrayTypeNode(parent)) {
    return "unknownBoundary";
  }
  if (ts.isIndexSignatureDeclaration(parent)) return "unknownBoundary";
  if (
    (ts.isUnionTypeNode(parent) || ts.isTupleTypeNode(parent)) &&
    parent.parent &&
    (ts.isTypeReferenceNode(parent.parent) || ts.isArrayTypeNode(parent.parent))
  ) {
    return "unknownBoundary";
  }

  // Parameters receive external data but must be narrowed before domain use.
  if (ts.isParameter(parent)) return "unknownNarrowing";

  return "unknownInternal";
}

function positionOf(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return { line: line + 1, column: character + 1 };
}

/**
 * Analyzes one source file.
 *
 * @param {ts.SourceFile} sourceFile
 * @param {string} repoPath
 * @returns {{ findings: Array }}
 */
export function analyzeTypeSyntax(sourceFile, repoPath) {
  const findings = [];
  const push = (category, node, detail) => {
    const { line, column } = positionOf(sourceFile, node);
    findings.push({ file: repoPath, category, line, column, detail });
  };

  const visit = (node) => {
    switch (node.kind) {
      case ts.SyntaxKind.AnyKeyword:
        push("explicitAny", node, contextName(node) || "any");
        break;
      case ts.SyntaxKind.UnknownKeyword:
        push(classifyUnknown(node), node, contextName(node) || "unknown");
        break;
      case ts.SyntaxKind.AsExpression:
      case ts.SyntaxKind.TypeAssertionExpression: {
        const typeNode = node.type;
        const text = typeNode ? typeNode.getText(sourceFile) : "";
        const inner = node.expression;
        const innerIsAssertion =
          inner &&
          (ts.isAsExpression(inner) || inner.kind === ts.SyntaxKind.TypeAssertionExpression);
        if (
          innerIsAssertion &&
          inner.type &&
          /^(unknown|any)$/.test(inner.type.getText(sourceFile).trim())
        ) {
          push("doubleAssertion", node, `as ${inner.type.getText(sourceFile)} as ${text}`);
        } else if (/^(any|object|Function)$/.test(text.trim())) {
          push("broadCast", node, `as ${text}`);
        }
        break;
      }
      default:
        break;
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);

  // Suppressions live in comment trivia, which the AST walk above skips.
  const text = sourceFile.getFullText();
  const lines = text.split("\n");
  lines.forEach((lineText, index) => {
    for (const { id, pattern } of SUPPRESSION_PATTERNS) {
      if (!pattern.test(lineText)) continue;
      // Only count it when the marker is inside real comment trivia.
      const offset = lines.slice(0, index).reduce((sum, l) => sum + l.length + 1, 0);
      const column = lineText.search(pattern);
      if (!isInsideComment(sourceFile, offset + Math.max(0, column))) continue;
      findings.push({
        file: repoPath,
        category: "suppression",
        line: index + 1,
        column: Math.max(1, column + 1),
        detail: id,
      });
    }
  });

  findings.sort(
    (left, right) =>
      left.line - right.line ||
      left.column - right.column ||
      left.category.localeCompare(right.category, "en-US"),
  );
  return { findings };
}

/** True when `position` lies inside a comment in the file. */
function isInsideComment(sourceFile, position) {
  const text = sourceFile.getFullText();
  let index = 0;
  let inLine = false;
  let inBlock = false;
  let inString = null;
  while (index < text.length && index <= position) {
    const char = text[index];
    const next = text[index + 1];
    if (inLine) {
      if (char === "\n") inLine = false;
    } else if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        index += 1;
      }
    } else if (inString) {
      if (char === "\\") index += 1;
      else if (char === inString) inString = null;
    } else if (char === "/" && next === "/") {
      if (index <= position && position < indexOfLineEnd(text, index)) return true;
      inLine = true;
      index += 1;
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      if (position >= index && (end === -1 || position <= end + 1)) return true;
      inBlock = true;
      index += 1;
    } else if (char === '"' || char === "'" || char === "`") {
      inString = char;
    }
    index += 1;
  }
  return false;
}

function indexOfLineEnd(text, from) {
  const newline = text.indexOf("\n", from);
  return newline === -1 ? text.length : newline;
}

/** Aggregates findings into deterministic per-category counts. */
export function summarizeTypeSyntax(findings) {
  const counts = {
    explicitAny: 0,
    unknownBoundary: 0,
    unknownNarrowing: 0,
    unknownInternal: 0,
    doubleAssertion: 0,
    broadCast: 0,
    suppression: 0,
  };
  for (const finding of findings) {
    if (counts[finding.category] === undefined) counts[finding.category] = 0;
    counts[finding.category] += 1;
  }
  return counts;
}
