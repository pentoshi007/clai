/**
 * Per-function complexity metrics over the TypeScript AST (Phase 0, P0-04/P0-05).
 *
 * Implemented in-repository rather than delegated to a third-party plugin so
 * that `.ts` and `.tsx` are handled by the same compiler the build uses, that
 * function attribution is stable across refactors, and that no source content
 * leaves the machine.
 *
 * Definitions (see refactor/quality-metrics.md):
 *   cyclomatic — 1 + decision points (if / loop / non-default case / catch /
 *                conditional expression / && / || / ??).
 *   cognitive  — SonarSource-style: structural increments carry the current
 *                nesting depth; `else`/`else if` add 1 without nesting; each
 *                sequence of like logical operators adds 1; nested functions
 *                increase nesting.
 *   halstead   — n1/n2 distinct operators/operands, N1/N2 totals,
 *                difficulty D = (n1 / 2) * (N2 / n2).
 */
import ts from "typescript";

/** Node kinds treated as measurable function-like units. */
const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

export function isFunctionLike(node) {
  return FUNCTION_KINDS.has(node.kind);
}

/** Stable, human-readable name for a function-like node. */
export function functionName(node) {
  if (node.kind === ts.SyntaxKind.Constructor) {
    const parentName = node.parent && node.parent.name ? node.parent.name.getText() : "anonymous";
    return `${parentName}.constructor`;
  }
  if (node.name && typeof node.name.getText === "function") {
    const own = node.name.getText();
    if (
      node.parent &&
      (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent)) &&
      node.parent.name
    ) {
      return `${node.parent.name.getText()}.${own}`;
    }
    return own;
  }
  // Anonymous function/arrow: attribute to its declaration or property target,
  // which is what a reviewer actually greps for.
  const parent = node.parent;
  if (parent) {
    if (ts.isVariableDeclaration(parent) && parent.name) return parent.name.getText();
    if (ts.isPropertyAssignment(parent) && parent.name) return parent.name.getText();
    if (ts.isPropertyDeclaration(parent) && parent.name) return parent.name.getText();
    if (ts.isExportAssignment(parent)) return "default";
  }
  return "<anonymous>";
}

function isLogicalOperator(kind) {
  return (
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken
  );
}

/** Counts cyclomatic decision points inside one function body. */
function cyclomaticOf(node) {
  let complexity = 1;
  const visit = (current) => {
    if (current !== node && isFunctionLike(current)) return; // nested fns measured separately
    switch (current.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.CatchClause:
        complexity += 1;
        break;
      case ts.SyntaxKind.CaseClause:
        complexity += 1;
        break;
      case ts.SyntaxKind.BinaryExpression:
        if (isLogicalOperator(current.operatorToken.kind)) complexity += 1;
        break;
      default:
        break;
    }
    ts.forEachChild(current, visit);
  };
  ts.forEachChild(node, visit);
  return complexity;
}

/** Counts SonarSource-style cognitive complexity inside one function body. */
function cognitiveOf(node) {
  let score = 0;

  const walk = (current, nesting) => {
    if (current !== node && isFunctionLike(current)) {
      // A nested function's own body is measured separately, but its presence
      // increases the nesting level of structures declared inside it.
      ts.forEachChild(current, (child) => walk(child, nesting + 1));
      return;
    }

    let nextNesting = nesting;

    switch (current.kind) {
      case ts.SyntaxKind.IfStatement: {
        const parent = current.parent;
        const isElseIf =
          parent && ts.isIfStatement(parent) && parent.elseStatement === current;
        if (isElseIf) {
          score += 1; // `else if` — +1, no nesting penalty
        } else {
          score += 1 + nesting;
          nextNesting = nesting + 1;
        }
        if (current.elseStatement && !ts.isIfStatement(current.elseStatement)) {
          score += 1; // plain `else`
        }
        break;
      }
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.SwitchStatement:
        score += 1 + nesting;
        nextNesting = nesting + 1;
        break;
      case ts.SyntaxKind.ConditionalExpression:
        score += 1 + nesting;
        nextNesting = nesting + 1;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        if (isLogicalOperator(current.operatorToken.kind)) {
          // One increment per *sequence* of the same operator: only count when
          // the parent is not the same operator.
          const parent = current.parent;
          const parentSame =
            parent &&
            ts.isBinaryExpression(parent) &&
            parent.operatorToken.kind === current.operatorToken.kind;
          if (!parentSame) score += 1;
        }
        break;
      }
      case ts.SyntaxKind.BreakStatement:
      case ts.SyntaxKind.ContinueStatement:
        if (current.label) score += 1; // jump to label
        break;
      default:
        break;
    }

    ts.forEachChild(current, (child) => walk(child, nextNesting));
  };

  ts.forEachChild(node, (child) => walk(child, 0));
  return score;
}

const OPERAND_KINDS = new Set([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PrivateIdentifier,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.SuperKeyword,
]);

/** Halstead metrics from the token stream of one function body. */
function halsteadOf(node, sourceFile) {
  const operators = new Map();
  const operands = new Map();

  const record = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

  const visit = (current) => {
    if (current !== node && isFunctionLike(current)) return;
    current.forEachChild(visit);
    // Leaf tokens carry the operator/operand signal.
    for (const token of tokensOf(current, sourceFile)) {
      if (OPERAND_KINDS.has(token.kind)) {
        record(operands, token.getText(sourceFile));
      } else {
        record(operators, ts.SyntaxKind[token.kind]);
      }
    }
  };

  visit(node);

  const n1 = operators.size;
  const n2 = operands.size;
  let N1 = 0;
  let N2 = 0;
  for (const count of operators.values()) N1 += count;
  for (const count of operands.values()) N2 += count;

  const vocabulary = n1 + n2;
  const length = N1 + N2;
  const volume = vocabulary > 0 ? length * Math.log2(vocabulary) : 0;
  const difficulty = n2 > 0 ? (n1 / 2) * (N2 / n2) : 0;

  return {
    distinctOperators: n1,
    distinctOperands: n2,
    totalOperators: N1,
    totalOperands: N2,
    volume: round(volume),
    difficulty: round(difficulty),
    effort: round(difficulty * volume),
  };
}

/** Direct child tokens of a node (excluding nested composite children). */
function tokensOf(node, sourceFile) {
  const out = [];
  node.getChildren(sourceFile).forEach((child) => {
    if (child.getChildCount(sourceFile) === 0 && child.kind !== ts.SyntaxKind.EndOfFileToken) {
      out.push(child);
    }
  });
  return out;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Measures every function-like unit in a source file.
 *
 * @param {ts.SourceFile} sourceFile
 * @returns {Array<{name: string, line: number, endLine: number, cyclomatic: number, cognitive: number, halstead: object}>}
 */
export function measureFunctions(sourceFile) {
  const results = [];
  const visit = (node) => {
    if (isFunctionLike(node)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const { line: endLine } = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
      results.push({
        name: functionName(node),
        line: line + 1,
        endLine: endLine + 1,
        cyclomatic: cyclomaticOf(node),
        cognitive: cognitiveOf(node),
        halstead: halsteadOf(node, sourceFile),
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  // Deterministic ordering: source position, then name.
  results.sort((left, right) =>
    left.line - right.line || left.name.localeCompare(right.name, "en-US"),
  );
  return results;
}

/**
 * CRAP score: `comp^2 * (1 - coverage)^3 + comp`.
 *
 * @param {number} cyclomatic
 * @param {number} coverage fraction in [0, 1]
 */
export function crapScore(cyclomatic, coverage) {
  const bounded = Math.min(1, Math.max(0, coverage));
  return round(cyclomatic ** 2 * (1 - bounded) ** 3 + cyclomatic);
}
