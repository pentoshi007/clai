import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

export const REPO_ROOT = process.cwd();
export const SRC_ROOT = join(REPO_ROOT, "src");

export const SOURCE_EXTENSIONS = [".ts", ".tsx"];

export const RENDERER_ROOTS = ["src/tui-v2", "src/classic", "src/ui"];

export const UI_CORE_ROOT = "src/ui-core";

export const RUNTIME_POLICY_ROOTS = ["src/llm", "src/agent"];

export const RUNTIME_POLICY_EXCEPTIONS = new Set([
  "src/agent/plan-decision.ts",
  "src/agent/project-root.ts",
  "src/agent/tool-call-parser.ts",
  "src/llm/capabilities.ts",
  "src/llm/custom-providers.ts",
  "src/llm/key-rotation.ts",
  "src/llm/provider.ts",
  "src/llm/reasoning-marker.ts",
  "src/llm/token-usage.ts",
  "src/llm/transport-events.ts",
  "src/llm/wire/responses-first.ts",
]);

export const NEW_FILE_MAX_LINES = 1000;

export function listSourceFiles(root: string): string[] {
  const absolute = resolve(REPO_ROOT, root);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(full);
        continue;
      }
      if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
      out.push(toRepoPath(full));
    }
  };
  if (!statSync(absolute).isDirectory()) return [toRepoPath(absolute)];
  walk(absolute);
  return out.sort();
}

export function toRepoPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split("\\").join("/");
}

export function countLines(repoPath: string): number {
  const text = readFileSync(join(REPO_ROOT, repoPath), "utf8");
  if (text.length === 0) return 0;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

export function importSpecifiersFromText(
  text: string,
  fileName = "source.ts",
): string[] {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      out.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

export function importedRepoModules(repoPath: string): string[] {
  const text = readFileSync(join(REPO_ROOT, repoPath), "utf8");
  const fromDir = join(REPO_ROOT, repoPath, "..");
  return importSpecifiersFromText(text, repoPath)
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) =>
      toRepoPath(resolve(fromDir, specifier)).replace(/\.js$/, ".ts"),
    );
}

export function isRuntimePolicyModule(repoPath: string): boolean {
  if (RUNTIME_POLICY_EXCEPTIONS.has(repoPath)) return false;
  return RUNTIME_POLICY_ROOTS.some(
    (root) => repoPath === root || repoPath.startsWith(`${root}/`),
  );
}
