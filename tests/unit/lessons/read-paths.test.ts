// Architecture guard (fix round 10, strengthened in round 11): lesson and record data reaches a person or an agent only through the access check. This builds a TypeScript program
// over the whole broker package and resolves every call by TYPE, so aliases (`const s = deps.store`), destructuring (`const { list } = store`), re-exports and renamed imports cannot
// hide a read, and comments are not code. A call that reads the lesson store (or the record's row readers) must sit in a top-level function that also calls `readVisible`
// (lessons) or `filterVisible` (rows), or in a file listed below as an internal worker that returns nothing to a viewer, with the reason. A stale list entry fails too.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../..");
const BROKER = join(ROOT, "packages/broker");

/** Files that read the lesson store and hand nothing back to a viewer (they act on a lesson: count, curate, delete, expire, promote, process). */
const INTERNAL_LESSON_FILES: Record<string, string> = {
  "lessons/counters.ts": "counts loads and outcomes on lessons; returns counters, never a lesson (feedback is gated: see recordFeedback)",
  "lessons/curate.ts": "merges drafts into lessons; returns the result to the pipeline",
  "lessons/deletion.ts": "withdraws and erases lessons; acts on them",
  "lessons/expiry.ts": "expires lessons; acts on them",
  "lessons/promote.ts": "promotes a lesson to a rule; refuses restricted ones",
  "lessons/process.ts": "the reflector pipeline; lessons go back into the store",
  "lessons/store.ts": "the store itself",
  "lessons/metric.ts": "the same-mistake-twice measure: reads lessons, their versions and load manifests only to count; returns numbers, never a lesson or any text (metric.test.ts pins that)",
  "lessons/sources.ts": "the cold-start rule counts the person-approved lessons that name a source (L7-2); it returns names and a yes or no, never a lesson",
  "lessons/approve.ts": "decisions (approve, reject, retire, roll back) act on a lesson after mayHandle; the lists use readVisible",
};
const LESSON_READS = new Set(["list", "get", "manifests", "listAllHeads", "getHead", "versions"]);

/** Files that read the record's rows and hand nothing back to a viewer. */
const INTERNAL_RECORD_FILES: Record<string, string> = {
  "team-record/erase.ts": "erases rows", "team-record/delete-worker.ts": "deletes rows", "team-record/hot-source.ts": "the archiver's and the statistics' sources (aggregates; no text)",
  "team-record/redistil.ts": "re-distils after a delete; writes facts", "team-record/text-expiry.ts": "removes expired text", "team-record/store.ts": "the store itself",
  "team-record/scope-work.ts": "rewrites audiences and hides rows", "team-record/purge.ts": "deletes rows and facts", "team-record/ingest.ts": "writes rows",
  "team-record/archiver.ts": "copies rows to the lake (no viewer)", "team-record/stats-templates.ts": "aggregate statistics over project-wide rows", "team-record/item-head.ts": "ordering of versions",
  "team-record/transient-distiller.ts": "distils; writes facts", "team-record/distill.ts": "distils; writes facts",
  "team-record/prior-edits.ts": "answers yes or no to a tap whether anyone else edited an item; returns no row",
  "team-record/sources/parent-lookup.ts": "answers yes or no to the ticket webhook whether a ticket is already recorded under a scope (an index read by source); returns no row and no text, and a failed or truncated read answers no (0.5.5 integration, team-record-sources)",
  "lessons/task-outcome-rows.ts": "the reflector's facts about a finished task (who sent it back, who reverted it); returns ids and counts to the pipeline, nothing to a viewer",
};
const RECORD_READS = new Set(["queryRecordEvents", "queryRecordFacts", "getRecordEvent", "getRecordFact", "byScope", "scopePage", "bySource", "byActor", "byActorSource"]);

interface Hit { file: string; kind: "lessons" | "rows"; text: string; guarded: boolean }

/** Bypass samples the guard must catch. They are served from memory (never written to disk) and analysed in the same program as the real broker. */
const PLANTED: Record<string, string> = {
  "alias.ts": 'import type { LessonStore } from "../lessons/store.js";\nexport const a = (deps: { store: LessonStore }) => { const st = deps.store; return st.list({ workspaceId: "w", project: "p" }); };\n',
  "destructure.ts": 'import type { LessonStore } from "../lessons/store.js";\nexport const b = ({ store: s }: { store: LessonStore }) => { const { get } = s; return get({ workspaceId: "w", project: "p" }, "x"); };\n',
  "comment.ts": 'import type { LessonStore } from "../lessons/store.js";\n// read-visible.js readVisible( filterVisible(\nexport const c = (s: LessonStore) => s.list({ workspaceId: "w", project: "p" });\n',
  "rows.ts": 'import { queryRecordEvents as q } from "../team-record/store.js";\nexport const d = q;\nexport const e = (t: Parameters<typeof q>[0]) => q(t, "o" as never, "p", {} as never);\n',
};
const PLANTED_DIR = "zzguard";

/**
 * Builds ONE program for the broker plus the planted samples. The analysis resolves calls by the types of the broker's own code, so third-party declaration files are served empty
 * (the AWS SDK, openai, zod and the rest are about 14 MB of declarations and took the program from about 1 GB to about 2.5 GB, enough to kill a CI worker). The broker's own
 * sources, the workspace packages (@agentx/contracts and the others, which resolve to their own dist files) and the TypeScript lib files stay real, so LessonStore and the team-record store resolve exactly as before.
 */
function analyse(root = BROKER): Hit[] {
  const config = ts.getParsedCommandLineOfConfigFile(join(root, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  if (config === undefined) throw new Error("no tsconfig");
  const options: ts.CompilerOptions = { ...config.options, noEmit: true, composite: false, incremental: false, skipLibCheck: true };
  const planted = new Map(Object.entries(PLANTED).map(([name, body]) => [join(root, "src", PLANTED_DIR, name), body]));
  const host = ts.createCompilerHost(options);
  const real = ts.createCompilerHost(options);
  host.fileExists = (name) => planted.has(name) || real.fileExists(name);
  host.readFile = (name) => planted.get(name) ?? real.readFile(name);
  host.getSourceFile = (name, languageVersion, ...rest) => {
    const body = planted.get(name);
    if (body !== undefined) return ts.createSourceFile(name, body, languageVersion);
    const empty = /[\\/]node_modules[\\/]/u.test(name) && !/[\\/]node_modules[\\/]typescript[\\/]lib[\\/]/u.test(name);
    return empty ? ts.createSourceFile(name, "", languageVersion) : real.getSourceFile(name, languageVersion, ...rest);
  };
  const program = ts.createProgram({ rootNames: [...config.fileNames, ...planted.keys()], options, host });
  const checker = program.getTypeChecker();
  const hits: Hit[] = [];
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || !source.fileName.startsWith(join(root, "src"))) continue;
    const file = relative(join(root, "src"), source.fileName);
    const visit = (node: ts.Node, top: ts.Node | undefined): void => {
      const unit = top ?? (node.parent !== undefined && ts.isSourceFile(node.parent) ? node : undefined);
      if (ts.isCallExpression(node)) {
        const kind = classify(node, checker);
        if (kind !== undefined && unit !== undefined) hits.push({ file, kind, text: node.getText(source).slice(0, 80), guarded: callsAccess(unit, kind === "lessons" ? "readVisible" : "filterVisible") });
      }
      ts.forEachChild(node, (child) => visit(child, unit));
    };
    visit(source, undefined);
  }
  return hits;
}

function classify(call: ts.CallExpression, checker: ts.TypeChecker): "lessons" | "rows" | undefined {
  const type = checker.getTypeAtLocation(call.expression);
  for (const declaration of type.symbol?.declarations ?? []) {
    const parent = declaration.parent;
    if ((ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration)) && declaration.name !== undefined && LESSON_READS.has(declaration.name.getText())
      && ((ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent)) && /LessonStore$/u.test(parent.name?.text ?? ""))) return "lessons";
  }
  let symbol = checker.getSymbolAtLocation(call.expression);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.[0];
  if (declaration !== undefined && symbol !== undefined && RECORD_READS.has(symbol.name) && /team-record\/store\.ts$/u.test(declaration.getSourceFile().fileName)) return "rows";
  return undefined;
}

function callsAccess(unit: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) found = true;
    ts.forEachChild(node, visit);
  };
  visit(unit);
  return found;
}

const allHits = analyse();

describe("every read path goes through the access check", () => {
  const hits = allHits.filter((hit) => !hit.file.startsWith(`${PLANTED_DIR}/`));

  it("the analysis sees the known readers (it is not vacuous)", () => {
    expect(new Set(hits.filter((hit) => hit.kind === "lessons").map((hit) => hit.file))).toEqual(expect.any(Set));
    for (const file of ["lessons/load.ts", "lessons/digest.ts", "lessons/panel.ts", "lessons/approve.ts", "lessons/counters.ts"]) expect(hits.some((hit) => hit.file === file && hit.kind === "lessons"), file).toBe(true);
    expect(hits.some((hit) => hit.file === "team-record/query.ts" && hit.kind === "rows")).toBe(true);
  });

  it("each lesson-store read is in a function that calls readVisible, or in a listed internal file", () => {
    const offenders = hits.filter((hit) => hit.kind === "lessons" && !hit.guarded && INTERNAL_LESSON_FILES[hit.file] === undefined).map((hit) => `${hit.file}: ${hit.text}`);
    expect(offenders).toEqual([]);
  });

  it("each row read is in a function that calls filterVisible, or in a listed internal file", () => {
    const offenders = hits.filter((hit) => hit.kind === "rows" && !hit.guarded && INTERNAL_RECORD_FILES[hit.file] === undefined).map((hit) => `${hit.file}: ${hit.text}`);
    expect(offenders).toEqual([]);
  });

  it("the viewer-facing lesson functions read only through readVisible (approve.ts lists, load, digest, panel)", () => {
    for (const file of ["lessons/load.ts", "lessons/digest.ts", "lessons/panel.ts"]) {
      const own = hits.filter((hit) => hit.file === file && hit.kind === "lessons");
      expect(own.length, file).toBeGreaterThan(0);
      expect(own.filter((hit) => !hit.guarded).map((hit) => hit.text), file).toEqual([]);
    }
    const approve = hits.filter((hit) => hit.file === "lessons/approve.ts" && hit.kind === "lessons");
    expect(approve.some((hit) => hit.guarded)).toBe(true); // listWaiting and listQueued
  });

  it("the internal lists name only files that exist (a stale entry fails)", () => {
    for (const file of [...Object.keys(INTERNAL_LESSON_FILES), ...Object.keys(INTERNAL_RECORD_FILES)]) expect(() => readFileSync(join(BROKER, "src", file), "utf8"), file).not.toThrow();
  });
});

describe("the guard catches the bypasses a text search misses", () => {
  it("an alias, a destructured method, a comment naming the filter, a subfolder and a new function in a guarded file all fail", () => {
    const found = allHits.filter((hit) => hit.file.startsWith(`${PLANTED_DIR}/`) && !hit.guarded).map((hit) => hit.file);
    expect(new Set(found)).toEqual(new Set(Object.keys(PLANTED).map((name) => `${PLANTED_DIR}/${name}`)));
  });
});
