// Convergence A7: the audit events Rovara Code's core records, found in the pinned copy of Code (vendor/rovara-code), so a test can say whether Cloud's map covers every one.
//
// Code has no exported list of its audit actions: each is a string at the place the core records it. This reads the vendored broker's source (a syntax scan, no type checker) and finds:
//  - every dotted action that is the value of an `action` property (or a branch of a conditional in one), in a file that mentions the audit sink;
//  - every action built from a template (`decision.${...}`, `saved_env.${...}`, `mcp_server.${...}`), resolved from the literals it can take. A template this file cannot resolve is reported, so a new one
//    cannot slip through unseen;
//  - the lessons library's events by running its own audit sink over each action it names (the library maps to the ledger's names itself: `lessons/audit-sink.ts`).
// Admission requests also have an `action` property (`model.call`, `nightly.run`, ...): they are not audit events and are listed in `NOT_AUDIT_ACTIONS`, each with its reason. The test checks that every
// entry there is still found, so a stale entry fails.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { AuditEvent } from "@rovara-code/contracts";

const VENDOR = fileURLToPath(new URL("../../vendor/rovara-code/packages/", import.meta.url));
const SOURCE_ROOTS = [join(VENDOR, "broker/src"), join(VENDOR, "local-adapters/src")];
const SHAPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/u;

/** `action` values that are admission requests, not audit events. */
export const NOT_AUDIT_ACTIONS: Readonly<Record<string, string>> = {
  "model.call": "Admission.admit for a diagnosis or an Ask (core/diagnosis/service.ts, core/sessions/ask.ts)",
  "nightly.run": "Admission.admit for a nightly run (core/test-env/nightly-run.ts)",
  "automation.run": "Admission.admit for an automatic run (core/automation/run-seam.ts)",
  "task.start": "Admission stage for a task start (core/task-flow/start.ts)",
};

export interface CoreAuditScan {
  /** Every action the core records on the audit sink, except the lessons library's (see `lessonActions`). */
  readonly actions: ReadonlySet<string>;
  /** `lesson.*` actions the scan met outside the library's own sink (listed so they can be compared with the library's list). */
  readonly lessonLiterals: ReadonlySet<string>;
  /** Admission actions found (so `NOT_AUDIT_ACTIONS` can be checked for stale entries). */
  readonly excludedFound: ReadonlySet<string>;
  /** Templates in an `action` property this file has no way to resolve. Must be empty. */
  readonly unresolvedTemplates: readonly string[];
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "node_modules" && name !== "dist") walk(path);
      } else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) out.push(path);
    }
  };
  walk(root);
  return out;
}

const parse = (path: string): ts.SourceFile => ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);

/** The string literals an expression can take, through conditionals and parentheses; undefined if it can take anything else. */
function literalsOf(node: ts.Expression): string[] | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isParenthesizedExpression(node)) return literalsOf(node.expression);
  if (ts.isConditionalExpression(node)) {
    const whenTrue = literalsOf(node.whenTrue);
    const whenFalse = literalsOf(node.whenFalse);
    return whenTrue === undefined || whenFalse === undefined ? undefined : [...whenTrue, ...whenFalse];
  }
  return undefined;
}

/** The member names of a string-literal union type or enum-like list: `action: "a" | "b"` in an interface. */
function unionMembers(file: string, interfaceName: string, property: string): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name.getText() === property && member.type !== undefined) {
          const collect = (type: ts.TypeNode): void => {
            if (ts.isUnionTypeNode(type)) type.types.forEach(collect);
            else if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) out.push(type.literal.text);
          };
          collect(member.type);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file));
  return out;
}

/** The `type` literals of the MCP controller's events (`type: z.literal("task_started")` inside `McpControllerEventSchema`). */
function mcpControllerEventTypes(): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === "McpControllerEventSchema" && node.initializer !== undefined) {
      const inner = (n: ts.Node): void => {
        if (ts.isPropertyAssignment(n) && n.name.getText() === "type" && ts.isCallExpression(n.initializer) && n.initializer.expression.getText() === "z.literal") {
          const argument = n.initializer.arguments[0];
          if (argument !== undefined && ts.isStringLiteral(argument)) out.push(argument.text);
        }
        ts.forEachChild(n, inner);
      };
      inner(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(join(VENDOR, "contracts/src/mcp-servers.ts")));
  return out;
}

/** How each known template becomes actions, by the template's source text. */
const TEMPLATES: Readonly<Record<string, () => string[]>> = {
  "`mcp_server.${event.type}`": () => mcpControllerEventTypes().map((type) => `mcp_server.${type}`),
  "`saved_env.${entry.action}`": () => unionMembers(join(VENDOR, "broker/src/core/test-env/saved-env.ts"), "SavedEnvAuditEntry", "action").filter((action) => action !== "activity").map((action) => `saved_env.${action}`),
};

export function scanCoreAuditActions(): CoreAuditScan {
  const actions = new Set<string>();
  const lessonLiterals = new Set<string>();
  const excludedFound = new Set<string>();
  const unresolvedTemplates: string[] = [];
  const add = (action: string, file: string): void => {
    if (!SHAPE.test(action)) return;
    if (Object.hasOwn(NOT_AUDIT_ACTIONS, action)) excludedFound.add(action);
    else if (action.startsWith("lesson.")) lessonLiterals.add(action);
    else actions.add(action);
    void file;
  };
  for (const root of SOURCE_ROOTS) {
    for (const file of sourceFiles(root)) {
      const sf = parse(file);
      if (!/audit/iu.test(sf.text)) continue;
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && node.name.getText() === "action") {
          const init = node.initializer;
          const literals = literalsOf(init);
          if (literals !== undefined) literals.forEach((literal) => add(literal, file));
          else if (ts.isTemplateExpression(init)) {
            const resolver = TEMPLATES[init.getText()];
            if (resolver !== undefined) resolver().forEach((action) => add(action, file));
            else {
              // A template of literals only (`decision.${a ? "x" : "y"}`): every combination.
              let combos: string[] | undefined = [init.head.text];
              for (const span of init.templateSpans) {
                const options = literalsOf(span.expression);
                if (options === undefined || combos === undefined) { combos = undefined; break; }
                combos = combos.flatMap((prefix) => options.map((option) => `${prefix}${option}${span.literal.text}`));
              }
              if (combos === undefined) unresolvedTemplates.push(`${file.slice(VENDOR.length)}: ${init.getText().slice(0, 80)}`);
              else combos.forEach((action) => add(action, file));
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  return { actions, lessonLiterals, excludedFound, unresolvedTemplates };
}

/** The lessons library's own list of the actions it names, and the actions its audit sink actually records for them (it maps to the ledger's names). */
export async function lessonLibraryAuditActions(): Promise<{ named: readonly string[]; recorded: ReadonlySet<string> }> {
  const sinkModule = (await import("../../vendor/rovara-code/packages/broker/dist/lessons/audit-sink.js")) as unknown as {
    lessonAuditSink(sink: { stage(event: AuditEvent): readonly never[]; record(event: AuditEvent): Promise<void> }, now: () => number, companyId: string): { emit(event: Record<string, unknown>, options?: { required?: boolean }): Promise<void> };
    LEDGERED: readonly string[];
  };
  const typesModule = (await import("../../vendor/rovara-code/packages/broker/dist/lessons/types.js")) as { LESSON_AUDIT_ACTIONS: readonly string[] };
  const recorded = new Set<string>();
  const sink = sinkModule.lessonAuditSink({ stage: () => [], async record(event) { recorded.add(event.action); } }, () => Date.parse("2026-11-10T10:00:00.000Z"), "org_00000000000000000000");
  for (const action of sinkModule.LEDGERED) await sink.emit({ action, workspaceId: "ws", project: "web", facts: {} });
  return { named: typesModule.LESSON_AUDIT_ACTIONS, recorded };
}
