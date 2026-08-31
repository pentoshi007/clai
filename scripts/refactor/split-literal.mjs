/**
 * Splits one large array or object literal into family modules without changing
 * the aggregate it produces. Elements keep their original text and their original
 * order: the aggregate is rebuilt as spreads of contiguous segments, so the
 * emitted order is identical by construction rather than by review.
 *
 *   node scripts/refactor/split-literal.mjs --file src/tools/definitions.ts \
 *     --symbol TOOL_DEFINITIONS --out-dir src/tools/definitions \
 *     --groups "files:^fs\\.;shell:^(shell|pkg)\\." [--dry]
 *
 * An element whose key matches no group stays in the source module.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const file = flag("file");
const symbol = flag("symbol");
const outDir = flag("out-dir");
const dry = args.includes("--dry");
const groups = (flag("groups") ?? "")
  .split(";")
  .filter(Boolean)
  .map((entry) => {
    const at = entry.indexOf(":");
    return { name: entry.slice(0, at), pattern: new RegExp(entry.slice(at + 1)) };
  });
if (!file || !symbol || !outDir || groups.length === 0) {
  console.error(
    'usage: split-literal.mjs --file <f> --symbol <name> --out-dir <dir> --groups "name:regex;..."',
  );
  process.exit(2);
}

const text = readFileSync(file, "utf8");
const source = ts.createSourceFile(
  file,
  text,
  ts.ScriptTarget.ES2022,
  true,
  file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
);

let literal;
let declaration;
const findLiteral = (node) => {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === symbol
  ) {
    declaration = node;
    literal = node.initializer;
  }
  node.forEachChild(findLiteral);
};
source.forEachChild(findLiteral);
if (!literal) throw new Error(`${symbol} not found in ${file}`);

/** Key used for grouping: the first string argument of a call, or a property name. */
const keyOf = (element) => {
  if (ts.isCallExpression(element)) {
    const first = element.arguments[0];
    if (first && ts.isStringLiteralLike(first)) return first.text;
    return undefined;
  }
  if (
    ts.isPropertyAssignment(element) ||
    ts.isMethodDeclaration(element) ||
    ts.isShorthandPropertyAssignment(element)
  ) {
    const name = element.name;
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
    return undefined;
  }
  return undefined;
};

const elements = ts.isArrayLiteralExpression(literal)
  ? literal.elements
  : ts.isObjectLiteralExpression(literal)
    ? literal.properties
    : undefined;
if (!elements) throw new Error(`${symbol} is not an array or object literal`);
const isArray = ts.isArrayLiteralExpression(literal);

/**
 * Contiguous runs of elements that belong to the same group. Segmenting rather
 * than bucketing is what makes the rebuilt aggregate order-identical even when a
 * family appears in several places in the original literal.
 */
const segments = [];
let previousEnd = elements.pos;
for (const element of elements) {
  const key = keyOf(element);
  const group = key
    ? groups.find((candidate) => candidate.pattern.test(key))?.name
    : undefined;
  const start = (() => {
    const ranges = ts.getLeadingCommentRanges(text, element.getFullStart()) ?? [];
    const usable = ranges.filter((range) => range.pos >= previousEnd);
    let at = element.getStart();
    for (let index = usable.length - 1; index >= 0; index -= 1) {
      const range = usable[index];
      if (/\n[ \t]*\n/.test(text.slice(range.end, at))) break;
      at = range.pos;
    }
    return at;
  })();
  const end = element.getEnd();
  previousEnd = end;
  const last = segments.at(-1);
  if (last && last.group === group) {
    last.elements.push({ start, end, key });
    last.end = end;
  } else {
    segments.push({ group, start, end, elements: [{ start, end, key }] });
  }
}

const counts = new Map();
const moduleFor = (group) => {
  const index = (counts.get(group) ?? 0) + 1;
  counts.set(group, index);
  const total = segments.filter((segment) => segment.group === group).length;
  return total > 1 ? `${group}-${index}` : group;
};

const imports = source.statements
  .filter((statement) => ts.isImportDeclaration(statement))
  .map((statement) => text.slice(statement.getFullStart(), statement.getEnd()).trim());

const rewritePath = (line) =>
  line.replace(/from "(\.[^"]+)"/g, (match, specifier) => {
    const target = resolve(dirname(file), specifier);
    let rewritten = relative(outDir, target).split(sep).join("/");
    if (!rewritten.startsWith(".")) rewritten = `./${rewritten}`;
    return `from "${rewritten}"`;
  });

const declaredType = declaration.type ? declaration.type.getText() : undefined;
const elementType = (() => {
  if (!declaredType) return undefined;
  if (isArray) return declaredType.replace(/\[\]$/, "");
  return declaredType;
})();

const created = [];
const pieces = [];
for (const segment of segments) {
  if (!segment.group) {
    pieces.push({ inline: text.slice(segment.start, segment.end) });
    continue;
  }
  const name = moduleFor(segment.group);
  const constant = `${symbol}_${name.replace(/-/g, "_").toUpperCase()}`;
  const body = segment.elements
    .map((element) => text.slice(element.start, element.end))
    .join(",\n  ");
  const annotation = elementType
    ? `: ${isArray ? `${elementType}[]` : elementType}`
    : "";
  const content = isArray
    ? `export const ${constant}${annotation} = [\n  ${body},\n];\n`
    : `export const ${constant}${annotation} = {\n  ${body},\n};\n`;
  const target = `${outDir}/${name}.ts`;
  created.push({ target, content, constant });
  pieces.push({ spread: constant, target });
}

const usedImports = (content) => {
  const body = ts.createSourceFile(
    "body.ts",
    content,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const used = new Set();
  const visit = (node) => {
    if (ts.isIdentifier(node)) used.add(node.text);
    node.forEachChild(visit);
  };
  body.forEachChild(visit);
  return imports
    .map(rewritePath)
    .filter((line) => {
      const names = line.match(/[A-Za-z_$][\w$]*/g) ?? [];
      return names.some(
        (name) =>
          used.has(name) && !["import", "from", "type", "as"].includes(name),
      );
    })
    .join("\n");
};

const aggregate = `${isArray ? "[" : "{"}\n${pieces
  .map((piece) =>
    piece.spread ? `  ...${piece.spread},` : `  ${piece.inline},`,
  )
  .join("\n")}\n${isArray ? "]" : "}"}`;

const localHelpers = new Set();
for (const statement of source.statements) {
  if (ts.isFunctionDeclaration(statement) && statement.name) {
    localHelpers.add(statement.name.text);
  }
  if (ts.isVariableStatement(statement)) {
    for (const item of statement.declarationList.declarations) {
      if (ts.isIdentifier(item.name)) localHelpers.add(item.name.text);
    }
  }
}

const sourceSpecifier = (target) => {
  let rewritten = relative(dirname(file), target.replace(/\.ts$/, ".js"))
    .split(sep)
    .join("/");
  if (!rewritten.startsWith(".")) rewritten = `./${rewritten}`;
  return rewritten;
};

const backSpecifier = () => {
  let rewritten = relative(outDir, file.replace(/\.ts$/, ".js"))
    .split(sep)
    .join("/");
  if (!rewritten.startsWith(".")) rewritten = `./${rewritten}`;
  return rewritten;
};

const finalModules = created.map((entry) => {
  const needed = [...localHelpers].filter((name) =>
    new RegExp(`(?<![.\\w$])${name}(?![\\w$])`).test(entry.content),
  );
  const back =
    needed.length > 0
      ? `import { ${needed.sort().join(", ")} } from "${backSpecifier()}";\n`
      : "";
  return {
    ...entry,
    needed,
    content: `${usedImports(entry.content)}\n${back}\n${entry.content}`,
  };
});

if (dry) {
  console.log(`segments: ${segments.length}; modules: ${created.length}`);
  for (const entry of finalModules) {
    console.log(
      `  ${entry.target}: ${entry.content.split("\n").length} lines, back-imports [${entry.needed.join(" ")}]`,
    );
  }
  console.log(`aggregate:\n${aggregate.split("\n").slice(0, 12).join("\n")}`);
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
for (const entry of finalModules) writeFileSync(entry.target, entry.content);
let updated =
  text.slice(0, literal.getStart()) + aggregate + text.slice(literal.getEnd());
const importLines = created
  .map((entry) => `import { ${entry.constant} } from "${sourceSpecifier(entry.target)}";`)
  .join("\n");
const lastImport = [...source.statements]
  .filter((statement) => ts.isImportDeclaration(statement))
  .pop();
const insertAt = lastImport ? lastImport.getEnd() : 0;
updated = `${updated.slice(0, insertAt)}\n${importLines}${updated.slice(insertAt)}`;
writeFileSync(file, updated);
console.log(
  `split ${symbol} into ${created.length} module(s); ${file} now ${updated.split("\n").length} lines`,
);
