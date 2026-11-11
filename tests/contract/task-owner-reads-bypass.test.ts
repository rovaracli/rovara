// Plan 5 Task 12b, review fix I-1 of Task 12a: the owner-read guard (`task-owner-reads.test.ts`) must not be bypassed. Each test builds a small program that
// does what a careless change could do, runs the guard's own scan and checks over it, and expects the guard to report it.
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { guardedRoots, hitKey, problemsOf, rowsOf, scanProgram, type Hit, type Klass, type Root } from "../support/task-owner-scan.js";

const PACKAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages");
const BROKER = path.join(PACKAGES, "broker/src");
const CONTRACTS = path.join(PACKAGES, "cloud-contracts/src");
const options = (): ts.CompilerOptions => ({
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true, skipLibCheck: true, types: [],
});

/** Scans `source` as if it were `file` under `root` of the real source tree: it can import the real task types. */
function scanVirtual(root: Root, file: string, source: string): Hit[] {
  const virtual = path.join(root.dir, file);
  const opts = options();
  const host = ts.createCompilerHost(opts);
  const realGet = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, ...rest) => (name === virtual ? ts.createSourceFile(name, source, languageVersion, true) : realGet(name, languageVersion, ...rest));
  const realExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === virtual || realExists(name);
  const realRead = host.readFile.bind(host);
  host.readFile = (name) => (name === virtual ? source : realRead(name));
  // The program imports real files too; only the snippet's own hits are the case's.
  return scanProgram(ts.createProgram({ rootNames: [virtual], options: opts, host }), [root]).filter((found) => found.file === `${root.prefix}${file}`);
}

const BROKER_ROOT: Root = { dir: BROKER, prefix: "" };
const IMPORT = 'import type { DeveloperTaskRecord } from "../developer/task-records.js";';
const hit = (file: string, fn: string, field: string) => `${file}::${fn}::${field}`;

describe("the owner-read guard cannot be bypassed", () => {
  it("does not count the name of an owner function in a comment, a string or an unused reference as going through it; a real call does", () => {
    const named = scanVirtual(BROKER_ROOT, "__bypass__/named.ts", `${IMPORT}
export function whoOwns(task: DeveloperTaskRecord): string {
  // effectiveTaskOwner(task) would be the right call here
  const note = "effectiveTaskOwner(task)";
  const unused = effectiveTaskOwner;
  return task.developerId + note + String(unused);
}
declare function effectiveTaskOwner(task: unknown): { developerId: string };`);
    const rows = rowsOf([["__bypass__/named.ts", "whoOwns", "authority", ".developerId"]]);
    expect(named.map(hitKey)).toEqual([hit("__bypass__/named.ts", "whoOwns", ".developerId")]);
    expect(problemsOf(named, rows).notRouted).toHaveLength(1);

    const called = scanVirtual(BROKER_ROOT, "__bypass__/called.ts", `${IMPORT}
declare function effectiveTaskOwner(task: unknown): { developerId: string };
export function whoOwns(task: DeveloperTaskRecord): string {
  return effectiveTaskOwner(task).developerId + task.developerId;
}`);
    expect(problemsOf(called, rowsOf([["__bypass__/called.ts", "whoOwns", "authority", ".developerId"]])).notRouted).toEqual([]);
  });

  it("does not let a row for one function cover a second function of the same name, or a function nested in another", () => {
    const hits = scanVirtual(BROKER_ROOT, "__bypass__/twins.ts", `${IMPORT}
export const handlers = {
  check: (task: DeveloperTaskRecord) => task.developerId,
};
export function check(task: DeveloperTaskRecord) { return task.developerId; }
export function outer(task: DeveloperTaskRecord) {
  const inner = () => task.developerName;
  return inner();
}`);
    const keys = hits.map(hitKey);
    expect(keys).toContain(hit("__bypass__/twins.ts", "check", ".developerId"));
    expect(keys).toContain(hit("__bypass__/twins.ts", "check#2", ".developerId"));
    expect(keys).toContain(hit("__bypass__/twins.ts", "outer>inner", ".developerName"));
    // A row written for `check` covers only the first of that name: the second is a read of its own.
    const only = rowsOf([["__bypass__/twins.ts", "check", "principal", ".developerId"]]);
    expect(problemsOf(hits, only).unclassified).toEqual([
      hit("__bypass__/twins.ts", "check#2", ".developerId"),
      hit("__bypass__/twins.ts", "outer>inner", ".developerName"),
    ]);
  });

  it("tells two functions of one name in a file apart", () => {
    const hits = scanVirtual(BROKER_ROOT, "__bypass__/same.ts", `${IMPORT}
export function pick(task: DeveloperTaskRecord) { return task.developerId; }
export namespace Later {
  export function pick(task: DeveloperTaskRecord) { return task.developerId; }
}`);
    expect(hits.map(hitKey)).toEqual([hit("__bypass__/same.ts", "pick", ".developerId"), hit("__bypass__/same.ts", "pick#2", ".developerId")]);
    const first = rowsOf([["__bypass__/same.ts", "pick", "principal", ".developerId"]]);
    expect(problemsOf(hits, first).unclassified).toHaveLength(1);
  });

  it("finds a read of `startedBy` on a task", () => {
    const hits = scanVirtual(BROKER_ROOT, "__bypass__/started.ts", `${IMPORT}
export function starter(task: DeveloperTaskRecord) { return task.startedBy?.developerId; }`);
    expect(problemsOf(hits, new Map<string, Klass>()).unclassified).toEqual([hit("__bypass__/started.ts", "starter", ".startedBy")]);
  });

  it("finds a read through an item or a cast that hides the task's type", () => {
    const hits = scanVirtual(BROKER_ROOT, "__bypass__/cast.ts", `
declare function getItem(key: unknown): Promise<Record<string, unknown>>;
declare function taskKey(taskId: string): unknown;
export async function viaItem(taskId: string) {
  const taskRow = await getItem(taskKey(taskId));
  return taskRow["developerId"];
}
export async function viaCast(taskId: string) {
  const taskRow = await getItem(taskKey(taskId));
  return (taskRow as unknown as { developerId: string }).developerId;
}
export async function viaAny(taskId: string) {
  const taskRow: any = await getItem(taskKey(taskId));
  const { slackUserId } = taskRow;
  return [taskRow.ownerKey, slackUserId];
}`);
    expect(problemsOf(hits, new Map<string, Klass>()).unclassified).toEqual([
      hit("__bypass__/cast.ts", "viaAny", ".ownerKey"),
      hit("__bypass__/cast.ts", "viaAny", ".slackUserId"),
      hit("__bypass__/cast.ts", "viaCast", ".developerId"),
      hit("__bypass__/cast.ts", "viaItem", ".developerId"),
    ]);
  });

  it("leaves alone a record that is no task, so a row is never asked for it", () => {
    const hits = scanVirtual(BROKER_ROOT, "__bypass__/other.ts", `
declare function getItem(key: unknown): Promise<Record<string, unknown>>;
export async function profile(personId: string) {
  const row = await getItem(personId);
  return row["developerId"];
}`);
    expect(hits).toEqual([]);
  });

  it("scans the contracts package too, and a read there is reported", () => {
    expect(guardedRoots(PACKAGES).map((root) => root.prefix)).toEqual(["", "contracts/"]);
    expect(guardedRoots(PACKAGES).map((root) => root.dir)).toContain(CONTRACTS);
    const hits = scanVirtual({ dir: CONTRACTS, prefix: "contracts/" }, "__bypass__/c.ts", `
declare function getItem(key: unknown): Promise<Record<string, unknown>>;
export async function ownerOf(taskId: string) {
  const taskItem = await getItem(taskId);
  return taskItem["developerName"];
}`);
    expect(problemsOf(hits, new Map<string, Klass>()).unclassified).toEqual([hit("contracts/__bypass__/c.ts", "ownerOf", ".developerName")]);
  });

  it("finds a read on a structural type with an owner field, such as `{ developerId: string }`, when it is named for a task or carries the task's id", () => {
    const hits = scanVirtual(BROKER_ROOT, "__bypass__/structural.ts", `
export function viaLiteral(task: { developerId: string }) { return task.developerId; }
export function viaPick(record: { taskId: string; developerName: string; workspaceId: string }) { return record.developerName; }
export function viaDestructuring({ slackUserId }: { taskId: string; slackUserId?: string }) { return slackUserId; }
export function aPerson(person: { developerId: string }) { return person.developerId; }`);
    expect(problemsOf(hits, new Map<string, Klass>()).unclassified).toEqual([
      hit("__bypass__/structural.ts", "viaDestructuring", ".slackUserId"),
      hit("__bypass__/structural.ts", "viaLiteral", ".developerId"),
      hit("__bypass__/structural.ts", "viaPick", ".developerName"),
    ]);
  });

  it("finds a read on a NAMED interface or alias with an owner field, such as `TaskLike`, under the same rules as a literal type (13 review)", () => {
    const hits = scanVirtual(BROKER_ROOT, "__bypass__/named-interface.ts", `
interface TaskLike { developerId: string; developerName: string }
interface RunLike { taskId: string; slackUserId?: string }
type OwnerAlias = { taskId: string; developerId: string };
interface PersonLike { developerId: string }
export function viaName(task: TaskLike) { return task.developerId; }
export function viaShape(record: RunLike) { return record.slackUserId; }
export function viaAlias(record: OwnerAlias) { return record.developerId; }
export function aPerson(person: PersonLike) { return person.developerId; }`);
    expect(problemsOf(hits, new Map<string, Klass>()).unclassified).toEqual([
      hit("__bypass__/named-interface.ts", "viaAlias", ".developerId"),
      hit("__bypass__/named-interface.ts", "viaName", ".developerId"),
      hit("__bypass__/named-interface.ts", "viaShape", ".slackUserId"),
    ]);
  });

  it("does not let a row cover a second read of the same field in the same function: each read is a row of its own", () => {
    const source = `${IMPORT}
export function owns(task: DeveloperTaskRecord, other: DeveloperTaskRecord) {
  const first = task.developerId;
  return first === other.developerId;
}`;
    const hits = scanVirtual(BROKER_ROOT, "__bypass__/second.ts", source);
    expect(hits).toHaveLength(2);
    const one = rowsOf([["__bypass__/second.ts", "owns", "principal", ".developerId"]]);
    expect(problemsOf(hits, one).unclassified).toEqual([hit("__bypass__/second.ts", "owns", ".developerId@2")]);
    // A row that says how many reads it covers covers exactly that many.
    expect(problemsOf(hits, rowsOf([["__bypass__/second.ts", "owns", "principal", ".developerId*2"]]))).toEqual({ unclassified: [], stale: [], notRouted: [] });
    expect(problemsOf(hits.slice(0, 1), rowsOf([["__bypass__/second.ts", "owns", "principal", ".developerId*2"]])).stale).toEqual([hit("__bypass__/second.ts", "owns", ".developerId@2")]);
  });
});
