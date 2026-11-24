import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

// Follow every runtime edge, including unused exports and lazy imports: a hidden
// write component/API must not remain importable by either mounted screen.
function runtimeGraph(entry: string): Map<string, ts.SourceFile> {
 const files = new Map<string, ts.SourceFile>();
 function visit(file: string) {
  if (files.has(file)) return;
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  files.set(file, source);
  function edge(name: string) {
   if (!name.startsWith(".")) return;
   const base = resolve(dirname(file), name).replace(/\.js$/u, "");
   const next = [base + ".ts", base + ".tsx"].find(candidate => existsSync(candidate));
   if (next !== undefined) visit(next);
  }
  function walk(node: ts.Node) {
   if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && !(ts.isExportDeclaration(node) && node.isTypeOnly) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
    if (ts.isImportDeclaration(node)) {
     if (node.importClause?.isTypeOnly === true) return;
     const bindings = node.importClause?.namedBindings;
     if (node.importClause?.name === undefined && bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.every(element => element.isTypeOnly)) return;
    }
    edge(node.moduleSpecifier.text);
   }
   if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0])) edge(node.arguments[0].text);
   ts.forEachChild(node, walk);
  }
  walk(source);
 }
 visit(resolve(entry));return files;
}
it("the rebuilt Work page reuses the exact live action components", () => {
 const graph = [...runtimeGraph("packages/ui/src/screens/work/WorkPreviewScreen.tsx").keys()];
 for (const file of ["TaskPane.tsx", "InlineQuestions.tsx", "LessonBatchCard.tsx", "LessonsUsedCard.tsx", "queue-action-host.ts"]) expect(graph.some(path => path.endsWith("/" + file))).toBe(true);
});
it("the Inbox route reuses the shared mark-read handler (the old InboxScreen was deleted in arch D3)", () => {
 for (const entry of ["InboxPreviewScreen"]) expect([...runtimeGraph("packages/ui/src/screens/inbox/" + entry + ".tsx").keys()].some(path => path.endsWith("/useInboxReadActions.ts"))).toBe(true);
});

it("the current task page cannot import the Work/Inbox send adapter", () => {
 const graph = runtimeGraph("packages/ui/src/screens/session/SessionScreen.tsx");
 expect([...graph.keys()].filter(file => file.endsWith("/work-safe-actions.ts"))).toEqual([]);
});
