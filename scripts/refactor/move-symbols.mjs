/**
 * Mechanical symbol mover for the behavior-preserving refactor program.
 *
 * `analyze` prints every top-level declaration in a module with its physical
 * size and its intra-module dependencies, which is how cohesive extraction
 * groups are chosen. `move` relocates a set of top-level declarations into a
 * new module verbatim, derives the new module's imports from the source's own
 * import table, and leaves a re-export in the source so every existing caller
 * and the public contract inventory keep working.
 *
 * The mover never edits declaration bodies: a moved declaration's text is
 * copied byte for byte, including its leading documentation comments.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";

const scriptKind = (file) =>
  file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;

const parse = (file) => {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ES2022,
    true,
    scriptKind(file),
  );
  return { text, source };
};

const declaredNames = (statement) => {
  const names = [];
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  ) {
    if (statement.name && ts.isIdentifier(statement.name)) {
      names.push(statement.name.text);
    }
    return names;
  }
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      else {
        const walk = (binding) => {
          for (const element of binding.elements) {
            if (ts.isOmittedExpression(element)) continue;
            if (ts.isIdentifier(element.name)) names.push(element.name.text);
            else walk(element.name);
          }
        };
        walk(declaration.name);
      }
    }
  }
  return names;
};

const isTypeOnlyDeclaration = (statement) =>
  ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);

const isExported = (statement) =>
  Boolean(
    ts.canHaveModifiers(statement) &&
      ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );

/**
 * Start offset that includes the declaration's own leading comment block.
 * A comment is treated as the declaration's own when no blank line separates
 * it from the declaration, which is the convention used throughout `src/`.
 */
const ownStart = (statement, text, previousEnd) => {
  const full = statement.getFullStart();
  const ranges = ts.getLeadingCommentRanges(text, full) ?? [];
  const usable = ranges.filter((range) => range.pos >= previousEnd);
  let start = statement.getStart();
  for (let index = usable.length - 1; index >= 0; index -= 1) {
    const range = usable[index];
    const between = text.slice(range.end, start);
    if (/\n[ \t]*\n/.test(between)) break;
    start = range.pos;
  }
  return start;
};

const topLevel = (source, text) => {
  const entries = [];
  let previousEnd = 0;
  for (const statement of source.statements) {
    const names = declaredNames(statement);
    if (names.length > 0) {
      entries.push({
        statement,
        names,
        start: ownStart(statement, text, previousEnd),
        end: statement.getEnd(),
        exported: isExported(statement),
        typeOnly: isTypeOnlyDeclaration(statement),
      });
    }
    previousEnd = statement.getEnd();
  }
  return entries;
};

const importTable = (source) => {
  const table = new Map();
  const statements = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier.text;
    statements.push(statement);
    const clause = statement.importClause;
    if (!clause) continue;
    const typeOnlyClause = clause.isTypeOnly;
    if (clause.name) {
      table.set(clause.name.text, {
        specifier,
        kind: "default",
        typeOnly: typeOnlyClause,
        local: clause.name.text,
      });
    }
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        table.set(clause.namedBindings.name.text, {
          specifier,
          kind: "namespace",
          typeOnly: typeOnlyClause,
          local: clause.namedBindings.name.text,
        });
      } else {
        for (const element of clause.namedBindings.elements) {
          table.set(element.name.text, {
            specifier,
            kind: "named",
            typeOnly: typeOnlyClause || element.isTypeOnly,
            imported: (element.propertyName ?? element.name).text,
            local: element.name.text,
          });
        }
      }
    }
  }
  return { table, statements };
};

/** Identifiers a node references, ignoring positions that cannot be free names. */
const referencedNames = (node) => {
  const names = new Set();
  const visit = (current) => {
    if (ts.isPropertyAccessExpression(current)) {
      visit(current.expression);
      return;
    }
    if (ts.isQualifiedName(current)) {
      visit(current.left);
      return;
    }
    if (ts.isPropertyAssignment(current)) {
      if (ts.isComputedPropertyName(current.name)) visit(current.name);
      visit(current.initializer);
      return;
    }
    if (
      ts.isPropertySignature(current) ||
      ts.isMethodSignature(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isPropertyDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isEnumMember(current)
    ) {
      if (current.name && ts.isComputedPropertyName(current.name)) {
        visit(current.name);
      }
      for (const child of current.getChildren()) {
        if (child === current.name) continue;
        visit(child);
      }
      return;
    }
    if (ts.isIdentifier(current)) {
      names.add(current.text);
      return;
    }
    current.forEachChild(visit);
  };
  node.forEachChild(visit);
  if (ts.isIdentifier(node)) names.add(node.text);
  return names;
};

const specifierFor = (fromFile, toFile, specifier) => {
  if (!specifier.startsWith(".")) return specifier;
  const target = resolve(dirname(fromFile), specifier);
  let rewritten = relative(dirname(toFile), target).split(sep).join("/");
  if (!rewritten.startsWith(".")) rewritten = `./${rewritten}`;
  return rewritten;
};

const moduleSpecifierBetween = (fromFile, toFile) => {
  const target = toFile.replace(/\.tsx?$/, ".js");
  let rewritten = relative(dirname(fromFile), target).split(sep).join("/");
  if (!rewritten.startsWith(".")) rewritten = `./${rewritten}`;
  return rewritten;
};

const renderImports = (groups) => {
  const lines = [];
  for (const [specifier, entry] of groups) {
    if (entry.namespace) {
      lines.push(
        `import ${entry.namespace.typeOnly ? "type " : ""}* as ${entry.namespace.local} from "${specifier}";`,
      );
    }
    if (entry.default) {
      lines.push(
        `import ${entry.default.typeOnly ? "type " : ""}${entry.default.local} from "${specifier}";`,
      );
    }
    const named = entry.named ?? [];
    const values = named.filter((item) => !item.typeOnly);
    const types = named.filter((item) => item.typeOnly);
    const render = (items, prefix) => {
      if (items.length === 0) return;
      const parts = items
        .map((item) =>
          item.imported === item.local
            ? item.local
            : `${item.imported} as ${item.local}`,
        )
        .sort((a, b) => a.localeCompare(b));
      lines.push(`import ${prefix}{ ${parts.join(", ")} } from "${specifier}";`);
    };
    render(values, "");
    render(types, "type ");
  }
  return lines;
};

/** Remove import specifiers whose local name no longer appears in the body. */
const pruneImports = (text) => {
  const { source } = {
    source: ts.createSourceFile(
      "prune.ts",
      text,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TSX,
    ),
  };
  const body = source.statements
    .filter((statement) => !ts.isImportDeclaration(statement))
    .map((statement) => text.slice(statement.getFullStart(), statement.getEnd()))
    .join("\n");
  const used = new Set();
  const bodySource = ts.createSourceFile(
    "body.tsx",
    body,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
  const collect = (node) => {
    if (ts.isIdentifier(node)) used.add(node.text);
    node.forEachChild(collect);
  };
  bodySource.forEachChild(collect);
  const edits = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    const keepDefault = clause.name ? used.has(clause.name.text) : false;
    let namedBindings = clause.namedBindings;
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      if (!used.has(namedBindings.name.text)) namedBindings = undefined;
    } else if (namedBindings) {
      const kept = namedBindings.elements.filter((element) =>
        used.has(element.name.text),
      );
      if (kept.length === 0) namedBindings = undefined;
      else if (kept.length !== namedBindings.elements.length) {
        const parts = kept.map((element) => element.getText());
        const prefix = clause.isTypeOnly ? "import type " : "import ";
        edits.push({
          start: statement.getStart(),
          end: statement.getEnd(),
          text: `${prefix}{ ${parts.join(", ")} } from ${statement.moduleSpecifier.getText()};`,
        });
        continue;
      }
    }
    if (!keepDefault && !namedBindings) {
      edits.push({
        start: statement.getFullStart(),
        end: statement.getEnd(),
        text: "",
      });
    }
  }
  let out = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out.replace(/\n{3,}/g, "\n\n");
};

const analyze = (file) => {
  const { text, source } = parse(file);
  const entries = topLevel(source, text);
  const owned = new Set(entries.flatMap((entry) => entry.names));
  const lineOf = (pos) =>
    source.getLineAndCharacterOfPosition(pos).line + 1;
  const rows = entries.map((entry) => {
    const refs = referencedNames(entry.statement);
    const internal = [...refs].filter(
      (name) => owned.has(name) && !entry.names.includes(name),
    );
    return {
      names: entry.names,
      exported: entry.exported,
      typeOnly: entry.typeOnly,
      startLine: lineOf(entry.start),
      endLine: lineOf(entry.end),
      lines: lineOf(entry.end) - lineOf(entry.start) + 1,
      internal,
    };
  });
  const usedBy = new Map();
  for (const row of rows) {
    for (const dependency of row.internal) {
      if (!usedBy.has(dependency)) usedBy.set(dependency, []);
      usedBy.get(dependency).push(row.names[0]);
    }
  }
  console.log(`${file}: ${text.split("\n").length} lines`);
  for (const row of rows.sort((a, b) => b.lines - a.lines)) {
    const consumers = usedBy.get(row.names[0]) ?? [];
    console.log(
      [
        String(row.lines).padStart(5),
        row.exported ? "exp" : "loc",
        row.typeOnly ? "type" : "val ",
        `${row.startLine}-${row.endLine}`.padEnd(11),
        row.names.join(","),
        `uses[${row.internal.join(" ")}]`,
        `usedBy[${consumers.join(" ")}]`,
      ].join(" "),
    );
  }
};

const move = ({ from, to, symbols, dry, pullDeps, append }) => {
  const { text, source } = parse(from);
  const entries = topLevel(source, text);
  const wanted = new Set(symbols);
  let moving = entries.filter((entry) =>
    entry.names.some((name) => wanted.has(name)),
  );
  if (pullDeps) {
    // Pull the transitive closure of source-local helpers the moved code needs.
    // Leaving them behind would force the new module to import back from its
    // source, which turns every extraction into an import cycle.
    const byName = new Map();
    for (const entry of entries) {
      for (const name of entry.names) byName.set(name, entry);
    }
    const publicApi = new Set(pullDeps === "keep-exports" ? [] : []);
    const included = new Set(moving);
    const queue = [...moving];
    while (queue.length > 0) {
      const entry = queue.pop();
      for (const name of referencedNames(entry.statement)) {
        const owner = byName.get(name);
        if (!owner || included.has(owner)) continue;
        if (owner.exported && publicApi.has(name)) continue;
        included.add(owner);
        queue.push(owner);
      }
    }
    moving = entries.filter((entry) => included.has(entry));
  }
  const movingNames = new Set(moving.flatMap((entry) => entry.names));
  const missing = [...wanted].filter((name) => !movingNames.has(name));
  if (missing.length > 0) {
    throw new Error(`not top-level in ${from}: ${missing.join(", ")}`);
  }
  const staying = entries.filter((entry) => !moving.includes(entry));
  const stayingNames = new Set(staying.flatMap((entry) => entry.names));
  const { table } = importTable(source);

  const needed = new Set();
  for (const entry of moving) {
    for (const name of referencedNames(entry.statement)) needed.add(name);
  }
  const groups = new Map();
  const addImport = (specifier, record) => {
    if (!groups.has(specifier)) groups.set(specifier, { named: [] });
    const group = groups.get(specifier);
    if (record.kind === "default") group.default = record;
    else if (record.kind === "namespace") group.namespace = record;
    else group.named.push(record);
  };
  const backImports = [];
  for (const name of [...needed].sort()) {
    if (movingNames.has(name)) continue;
    const record = table.get(name);
    if (record) {
      addImport(specifierFor(from, to, record.specifier), {
        ...record,
        imported: record.imported ?? record.local,
      });
      continue;
    }
    if (stayingNames.has(name)) backImports.push(name);
  }
  // A moved declaration may reference a helper that stays behind. Widening that
  // helper to an export is the minimum edit that keeps the move verbatim.
  const widenInSource = new Set();
  for (const name of backImports) {
    const owner = staying.find((entry) => entry.names.includes(name));
    if (owner && !owner.exported) widenInSource.add(name);
  }
  if (backImports.length > 0) {
    const specifier = moduleSpecifierBetween(to, from);
    const typeOnly = new Set(
      staying
        .filter((entry) => entry.typeOnly)
        .flatMap((entry) => entry.names),
    );
    for (const name of backImports) {
      addImport(specifier, {
        kind: "named",
        imported: name,
        local: name,
        typeOnly: typeOnly.has(name),
      });
    }
  }

  const header = renderImports(
    [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  );
  const remainingText = (() => {
    let out = text;
    for (const entry of [...moving].sort((a, b) => b.start - a.start)) {
      out = out.slice(0, entry.start) + out.slice(entry.end + 1);
    }
    return out;
  })();
  const neededBySource = new Set();
  {
    const probe = ts.createSourceFile(
      from,
      remainingText,
      ts.ScriptTarget.ES2022,
      true,
      scriptKind(from),
    );
    const visit = (node) => {
      if (ts.isIdentifier(node) && movingNames.has(node.text)) {
        neededBySource.add(node.text);
      }
      node.forEachChild(visit);
    };
    probe.forEachChild(visit);
  }
  const bodies = moving
    .sort((a, b) => a.start - b.start)
    .map((entry) => {
      const body = text.slice(entry.start, entry.end);
      if (entry.exported) return body;
      if (!entry.names.some((name) => neededBySource.has(name))) return body;
      const declarationStart = entry.statement.getStart() - entry.start;
      return `${body.slice(0, declarationStart)}export ${body.slice(declarationStart)}`;
    });
  const rewriteInlineSpecifiers = (body) =>
    body.replace(
      /import\((\s*)("|')(\.[^"']*)\2/g,
      (match, space, quote, specifier) =>
        `import(${space}${quote}${specifierFor(from, to, specifier)}${quote}`,
    );
  // A moved `let` that the source still assigns needs an explicit setter: an
  // imported binding cannot be assigned. The generated setter keeps a single
  // owner for the value instead of copying it into both modules.
  const movedMutable = moving.filter(
    (entry) =>
      ts.isVariableStatement(entry.statement) &&
      (entry.statement.declarationList.flags & ts.NodeFlags.Let) !== 0,
  );
  const setters = [];
  for (const entry of movedMutable) {
    for (const name of entry.names) {
      const assignment = new RegExp(
        `(?<![\\w$.])${name}\\s*(=[^=]|\\+\\+|--|\\+=|-=)`,
      );
      if (!assignment.test(remainingText)) continue;
      const declaration = entry.statement.declarationList.declarations.find(
        (item) => ts.isIdentifier(item.name) && item.name.text === name,
      );
      const typeText = declaration?.type?.getText();
      const setter = `set${name[0].toUpperCase()}${name.slice(1)}`;
      setters.push({ name, setter, typeText });
    }
  }

  const setterSource = setters
    .map(
      ({ name, setter, typeText }) =>
        `export function ${setter}(value${typeText ? `: ${typeText}` : ""}): void {\n  ${name} = value;\n}`,
    )
    .join("\n\n");
  const newText = `${header.join("\n")}\n\n${bodies.map(rewriteInlineSpecifiers).join("\n\n")}${setterSource ? `\n\n${setterSource}` : ""}\n`;

  // Removals and visibility widenings are applied as one descending edit list;
  // interleaving two independently ordered passes would corrupt later offsets.
  const sourceEdits = [
    ...moving.map((entry) => ({
      start: entry.start,
      end: entry.end + 1,
      text: "",
    })),
    ...staying
      .filter((entry) => entry.names.some((name) => widenInSource.has(name)))
      .map((entry) => ({
        start: entry.statement.getStart(),
        end: entry.statement.getStart(),
        text: "export ",
      })),
  ].sort((a, b) => b.start - a.start);
  let sourceText = text;
  for (const edit of sourceEdits) {
    sourceText =
      sourceText.slice(0, edit.start) + edit.text + sourceText.slice(edit.end);
  }
  const specifier = moduleSpecifierBetween(from, to);
  for (const { name, setter } of setters) {
    sourceText = sourceText.replace(
      new RegExp(`(?<![\\w$.])${name}\\s*\\+\\+;`, "g"),
      `${setter}(${name} + 1);`,
    );
    // Assignments are rewritten by scanning to the terminating `;` at depth zero
    // so multi-line object and template values are captured whole.
    const pattern = new RegExp(`(?<![\\w$.])${name}\\s*=\\s*`, "g");
    let match;
    const edits = [];
    while ((match = pattern.exec(sourceText)) !== null) {
      let cursor = match.index + match[0].length;
      let depth = 0;
      while (cursor < sourceText.length) {
        const character = sourceText[cursor];
        if ("([{`".includes(character)) depth += 1;
        else if (")]}`".includes(character)) depth -= 1;
        else if (character === ";" && depth <= 0) break;
        cursor += 1;
      }
      if (cursor >= sourceText.length) continue;
      edits.push({
        start: match.index,
        end: cursor + 1,
        value: sourceText.slice(match.index + match[0].length, cursor).trim(),
      });
    }
    for (const edit of edits.reverse()) {
      sourceText = `${sourceText.slice(0, edit.start)}${setter}(${edit.value});${sourceText.slice(edit.end)}`;
    }
  }
  const stillUsed = new Set();
  const remaining = ts.createSourceFile(
    from,
    sourceText,
    ts.ScriptTarget.ES2022,
    true,
    scriptKind(from),
  );
  const collect = (node) => {
    if (ts.isIdentifier(node) && movingNames.has(node.text))
      stillUsed.add(node.text);
    node.forEachChild(collect);
  };
  remaining.forEachChild(collect);
  const exportedMoved = moving.filter((entry) => entry.exported);
  const exportedValueNames = exportedMoved
    .filter((entry) => !entry.typeOnly)
    .flatMap((entry) => entry.names)
    .sort();
  const exportedTypeNames = exportedMoved
    .filter((entry) => entry.typeOnly)
    .flatMap((entry) => entry.names)
    .sort();
  const bridge = [];
  for (const { setter } of setters) stillUsed.add(setter);
  const importBack = [...stillUsed].sort();
  if (importBack.length > 0) {
    bridge.push(`import { ${importBack.join(", ")} } from "${specifier}";`);
  }
  const reexportValues = exportedValueNames.filter(
    (name) => !importBack.includes(name),
  );
  if (reexportValues.length > 0) {
    bridge.push(`export { ${reexportValues.join(", ")} } from "${specifier}";`);
  }
  const alreadyImported = exportedValueNames.filter((name) =>
    importBack.includes(name),
  );
  if (alreadyImported.length > 0) {
    bridge.push(`export { ${alreadyImported.join(", ")} };`);
  }
  if (exportedTypeNames.length > 0) {
    bridge.push(
      `export type { ${exportedTypeNames.join(", ")} } from "${specifier}";`,
    );
  }
  const lastImport = [...remaining.statements]
    .filter((statement) => ts.isImportDeclaration(statement))
    .pop();
  const insertAt = lastImport ? lastImport.getEnd() : 0;
  sourceText = `${sourceText.slice(0, insertAt)}\n${bridge.join("\n")}${sourceText.slice(insertAt)}`;
  sourceText = pruneImports(sourceText);

  if (dry) {
    console.log(`--- ${to} (${newText.split("\n").length} lines)`);
    console.log(newText.split("\n").slice(0, 40).join("\n"));
    console.log(`--- ${from} → ${sourceText.split("\n").length} lines`);
    console.log(`bridge:\n${bridge.join("\n")}`);
    return;
  }
  mkdirSync(dirname(to), { recursive: true });
  if (existsSync(to) && !append) throw new Error(`refusing to overwrite ${to}`);
  if (existsSync(to)) {
    const existing = readFileSync(to, "utf8");
    const addedImports = header.filter((line) => !existing.includes(line));
    const lastImportEnd = (() => {
      const lines = existing.split("\n");
      let index = 0;
      for (let cursor = 0; cursor < lines.length; cursor += 1) {
        if (/^\s*(import|export)\b.*from\s+"/.test(lines[cursor])) index = cursor + 1;
      }
      return index;
    })();
    const lines = existing.split("\n");
    const merged = [
      ...lines.slice(0, lastImportEnd),
      ...addedImports,
      ...lines.slice(lastImportEnd),
      "",
      ...bodies.map(rewriteInlineSpecifiers),
      "",
    ].join("\n");
    writeFileSync(to, pruneImports(merged));
  } else {
    writeFileSync(to, pruneImports(newText));
  }
  writeFileSync(from, sourceText);
  console.log(
    `moved ${movingNames.size} declaration(s) → ${to}; ${from} now ${sourceText.split("\n").length} lines`,
  );
  for (const entry of [to, from]) {
    const cycle = findCycle(entry);
    if (cycle) {
      console.error(
        `CYCLE: evaluation-time import cycle introduced:\n  ${cycle.map((file) => relative(process.cwd(), file)).join("\n  → ")}`,
      );
      process.exitCode = 1;
      return;
    }
  }
};

/**
 * Value-level import cycle detector. A cycle between modules that only exchange
 * types is harmless, but a cycle where a moved `const` table is evaluated before
 * its dependency is initialized silently produces undefined data at runtime, so
 * a new cycle must fail the move loudly instead of reaching the test suite.
 */
const findCycle = (entry) => {
  const seen = new Map();
  const resolveFile = (specifier, fromFile) => {
    if (!specifier.startsWith(".")) return undefined;
    const base = resolve(dirname(fromFile), specifier).replace(/\.js$/, "");
    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  };
  /**
   * Names a module reads while its own body is evaluating. Only these make a
   * cycle dangerous: a reference inside a function body is resolved when the
   * function is called, long after both modules finished initializing.
   */
  const evalTimeNames = (source) => {
    const names = new Set();
    const collect = (node) => {
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node)
      ) {
        return;
      }
      if (ts.isIdentifier(node)) names.add(node.text);
      node.forEachChild(collect);
    };
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) continue;
      if (ts.isInterfaceDeclaration(statement)) continue;
      if (ts.isTypeAliasDeclaration(statement)) continue;
      collect(statement);
    }
    return names;
  };
  const valueEdges = (file) => {
    if (seen.has(file)) return seen.get(file);
    const { source } = parse(file);
    const evalNames = evalTimeNames(source);
    const edges = [];
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      if (statement.importClause?.isTypeOnly) continue;
      const clause = statement.importClause;
      const imported = [];
      if (clause?.name) imported.push(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          imported.push(clause.namedBindings.name.text);
        } else {
          for (const element of clause.namedBindings.elements) {
            if (!element.isTypeOnly) imported.push(element.name.text);
          }
        }
      }
      if (imported.length === 0) continue;
      const target = resolveFile(statement.moduleSpecifier.text, file);
      if (!target) continue;
      if (!imported.some((name) => evalNames.has(name))) continue;
      edges.push(target);
    }
    seen.set(file, edges);
    return edges;
  };
  const stack = [];
  const visiting = new Set();
  const done = new Set();
  const walk = (file) => {
    if (done.has(file)) return undefined;
    if (visiting.has(file)) return [...stack.slice(stack.indexOf(file)), file];
    visiting.add(file);
    stack.push(file);
    for (const next of valueEdges(file)) {
      const cycle = walk(next);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(file);
    done.add(file);
    return undefined;
  };
  return walk(entry);
};

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const command = args[0];
if (command === "analyze") {
  analyze(flag("from"));
} else if (command === "move") {
  move({
    from: flag("from"),
    to: flag("to"),
    symbols: (flag("symbols") ?? "").split(",").filter(Boolean),
    dry: args.includes("--dry"),
    pullDeps: args.includes("--pull-deps"),
    append: args.includes("--append"),
  });
} else {
  console.error(
    "usage: move-symbols.mjs analyze --from <file> | move --from <file> --to <file> --symbols a,b [--dry]",
  );
  process.exit(2);
}
