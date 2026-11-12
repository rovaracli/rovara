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
  "learning.call": "Admission.admit for a lessons model call (local/app/lessons-model.ts)",
  "machine.start": "Admission.admit for a worker machine start (core/task-flow/dispatch.ts)",
};

export interface CoreAuditScan {
  /** Every action the core records on the audit sink, except the lessons library's (see `lessonActions`). */
  readonly actions: ReadonlySet<string>;
  /** `lesson.*` actions the scan met outside the library's own sink (listed so they can be compared with the library's list). */
  readonly lessonLiterals: ReadonlySet<string>;
  /** Admission actions found (so `NOT_AUDIT_ACTIONS` can be checked for stale entries). */
  readonly excludedFound: ReadonlySet<string>;
  /** An `action:` of an audit-shaped object (or `{ action }`) this file cannot resolve and no allowlisted resolver covers. Must be empty. */
  readonly unresolved: readonly string[];
  /** How many times each allowlisted resolver was used (a resolver used zero times is stale). */
  readonly resolverHits: Readonly<Record<string, number>>;
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

/**
 * `action:` values that are not a literal, each with the file it is in and why it is safe: a builder or relay that takes the action from its caller. Every call site of these builders passes an object with a
 * literal `action` that the scan reads like any other (they have `actor`, `subject`, `details` or `person` beside it). Each entry must be used (a stale one fails the test).
 */
const RESOLVERS: ReadonlyArray<{ readonly file: string; readonly text: string; readonly why: string }> = [
  { file: "core/script-tokens/store.ts", text: "input.action", why: "auditEvent(): every caller passes a literal action beside `actor` and `tokenId`" },
  { file: "core/second-review/mode.ts", text: "event.action", why: "stagedAudit(): every caller passes an object with a literal (or conditional literal) `action` beside `subject` and `details`" },
  { file: "core/sessions/control.ts", text: "audit.action", why: "commit(): every caller passes { action: <literal>, person }" },
  { file: "context-sources/audit.ts", text: "event.action", why: "mcpServerAudit() and contextSourceAudit() relay the action `told` was called with, a literal at each call site in mcp-servers.ts and settings.ts" },
];

/**
 * An object with an `action` is an audit event when it has an `eventId` (the port's `AuditEvent`), or when it is an argument of a call to one of the functions that record or stage an event (`stage`, `record`, the
 * task flow's `stageAudit` / `recordAudit`, second review's `stagedAudit`, the test environment's `stageAuditEvent` / `recordAuditEvent`, `told`, the script tokens' `auditEvent`, the session control's `commit`).
 * Not the file's text: a file with no word 'audit' in it is read the same.
 */
const AUDIT_CALLEES = new Set(["stage", "record", "stageAudit", "recordAudit", "stagedAudit", "stageAuditEvent", "recordAuditEvent", "told", "auditEvent", "commit", "commitOnce"]);

/** Files that ARE audit sinks (they take an event and store it), not places that record one. */
const SINK_IMPLEMENTATIONS: Readonly<Record<string, string>> = {
  "audit-event.ts": "Code's local audit trail: checks and stores an event it is given",
  "document-audit-sink.ts": "Code's default audit sink: stores the event it is given",
  "sqlite-audit-log.ts": "Code's append-only audit copy: stores the event it is given",
  "lessons/audit-sink.ts": "the lessons library's sink, run for real by lessonLibraryAuditActions()",
  "lessons/approve.ts": "the lessons library's own events (LessonAuditEvent), mapped by its sink and run for real by lessonLibraryAuditActions()",
};

const calleeName = (call: ts.CallExpression): string => {
  const expression = call.expression;
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : ts.isIdentifier(expression) ? expression.text : "";
};

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  return ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property) ? property.name.getText() : undefined;
}

/** `extraSources` (relative file name to source text) is scanned as if it were part of the core: a test uses it to show a new kind of `action:` is noticed. */
export function scanCoreAuditActions(extraSources: Readonly<Record<string, string>> = {}): CoreAuditScan {
  const actions = new Set<string>();
  const lessonLiterals = new Set<string>();
  const excludedFound = new Set<string>();
  const unresolved: string[] = [];
  const resolverHits: Record<string, number> = Object.fromEntries(RESOLVERS.map((resolver) => [`${resolver.file} ${resolver.text}`, 0]));
  const add = (action: string): void => {
    if (!SHAPE.test(action)) return;
    if (Object.hasOwn(NOT_AUDIT_ACTIONS, action)) excludedFound.add(action);
    else if (action.startsWith("lesson.")) lessonLiterals.add(action);
    else actions.add(action);
  };
  const sources: Array<{ relative: string; sf: ts.SourceFile }> = [
    ...SOURCE_ROOTS.flatMap((root) => sourceFiles(root).map((file) => ({ relative: file.slice(VENDOR.length).replace(/^[^/]+\/src\//u, ""), sf: parse(file) }))),
    ...Object.entries(extraSources).map(([relative, text]) => ({ relative, sf: ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true) })),
  ];
  {
    for (const { relative, sf } of sources) {
      if (Object.hasOwn(SINK_IMPLEMENTATIONS, relative)) continue;
      const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
          const names = node.properties.map(propertyName);
          const argumentOfAuditCall = ts.isCallExpression(node.parent) && node.parent.arguments.includes(node) && AUDIT_CALLEES.has(calleeName(node.parent));
          // Not every object with an `action` is an audit event: an admission request has an `idempotencyKey`. An audit event has an `eventId` or is the argument of a recording call (AUDIT_CALLEES).
          const actionProperty = node.properties.find((property) => propertyName(property) === "action");
          const admission = names.includes("idempotencyKey");
          if (actionProperty !== undefined && (admission || argumentOfAuditCall || names.includes("eventId"))) {
            const where = `${relative}:${String(sf.getLineAndCharacterOfPosition(actionProperty.getStart()).line + 1)}`;
            if (admission) {
              // An admission request (not an audit event): its literal action must be one `NOT_AUDIT_ACTIONS` names, so a new kind of request is looked at.
              if (ts.isPropertyAssignment(actionProperty)) literalsOf(actionProperty.initializer)?.forEach(add);
            } else if (ts.isShorthandPropertyAssignment(actionProperty)) unresolved.push(`${where}: shorthand { action }`);
            else if (ts.isPropertyAssignment(actionProperty)) {
              const init = actionProperty.initializer;
              const literals = literalsOf(init);
              const initText = init.getText().replace(/\s+/gu, " ");
              if (literals !== undefined) literals.forEach(add);
              else if (ts.isTemplateExpression(init) && TEMPLATES[init.getText()] !== undefined) TEMPLATES[init.getText()]!().forEach(add);
              else if (ts.isTemplateExpression(init)) {
                // A template of literals only (`decision.${a ? "x" : "y"}`): every combination.
                let combos: string[] | undefined = [init.head.text];
                for (const span of init.templateSpans) {
                  const options = literalsOf(span.expression);
                  if (options === undefined || combos === undefined) { combos = undefined; break; }
                  combos = combos.flatMap((prefix) => options.map((option) => `${prefix}${option}${span.literal.text}`));
                }
                if (combos === undefined) unresolved.push(`${where}: ${initText.slice(0, 80)}`);
                else combos.forEach(add);
              } else {
                const resolver = RESOLVERS.find((candidate) => relative === candidate.file && initText === candidate.text);
                if (resolver === undefined) unresolved.push(`${where}: ${initText.slice(0, 80)}`);
                else resolverHits[`${resolver.file} ${resolver.text}`] = (resolverHits[`${resolver.file} ${resolver.text}`] ?? 0) + 1;
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  return { actions, lessonLiterals, excludedFound, unresolved, resolverHits };
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

/** The core events the lessons library really records for each action it names, for a lesson (`lessonId` set) or for the whole project (`lessonId` undefined: the library names the project in the subject's id). */
export async function lessonLibraryEvents(options: { lessonId: string | undefined }): Promise<AuditEvent[]> {
  const sinkModule = (await import("../../vendor/rovara-code/packages/broker/dist/lessons/audit-sink.js")) as unknown as {
    lessonAuditSink(sink: { stage(event: AuditEvent): readonly never[]; record(event: AuditEvent): Promise<void> }, now: () => number, companyId: string): { emit(event: Record<string, unknown>, options?: { required?: boolean }): Promise<void> };
    LEDGERED: readonly string[];
  };
  const recorded: AuditEvent[] = [];
  const sink = sinkModule.lessonAuditSink({ stage: () => [], async record(event) { recorded.push(event); } }, () => Date.parse("2026-11-10T10:00:00.000Z"), "org_00000000000000000000");
  for (const action of sinkModule.LEDGERED) {
    await sink.emit({ action, workspaceId: "ws", project: "payments-web", ...(options.lessonId === undefined ? {} : { lessonId: options.lessonId }), actor: "a".repeat(64), facts: { tier: 1, count: 2, scope: "project", from: "one", to: "auto", mode: "second_person", type: "convention", cause: "person", reason: "refused", enabled: true } });
  }
  return recorded;
}
