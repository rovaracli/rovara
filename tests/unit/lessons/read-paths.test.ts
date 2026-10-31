// Architecture guard (fix round 10, R9-1): lesson and record data reaches a person or an agent only through the access check. Every file that reads the lesson store or the record's
// rows must either import the one read path (`readVisible` for lessons, `filterVisible` for rows) or be listed below as an internal worker that returns nothing to a caller, with
// the reason. A new file that reads and is in neither place fails here, so a new read path cannot skip the check by accident.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../../../packages/broker/src");
const filesOf = (dir: string): string[] => readdirSync(join(SRC, dir)).filter((name) => name.endsWith(".ts")).map((name) => `${dir}/${name}`);
const text = (file: string): string => readFileSync(join(SRC, file), "utf8");

/** Files that read the lesson store and hand nothing back to a viewer (they act on a lesson: count, curate, delete, expire, promote, process). */
const INTERNAL_LESSON_FILES: Record<string, string> = {
  "lessons/counters.ts": "counts loads and outcomes on lessons; returns counters, never a lesson",
  "lessons/curate.ts": "merges drafts into lessons; returns the result to the pipeline",
  "lessons/deletion.ts": "withdraws and erases lessons; acts on them",
  "lessons/expiry.ts": "expires lessons; acts on them",
  "lessons/promote.ts": "promotes a lesson to a rule; refuses restricted ones",
  "lessons/process.ts": "the reflector pipeline; lessons go back into the store",
  "lessons/store.ts": "the store itself",
};
const LESSON_READS = /\bstore\.(list|get|manifests|listAllHeads|getHead|versions)\(/u;

/** Files that read the record's rows and hand nothing back to a viewer. */
const INTERNAL_RECORD_FILES: Record<string, string> = {
  "team-record/erase.ts": "erases rows",
  "team-record/delete-worker.ts": "deletes rows",
  "team-record/hot-source.ts": "the archiver's and the statistics' sources (aggregates; no text)",
  "team-record/redistil.ts": "re-distils after a delete; writes facts",
  "team-record/text-expiry.ts": "removes expired text",
  "team-record/store.ts": "the store itself",
  "team-record/scope-work.ts": "rewrites audiences and hides rows",
  "team-record/routes.ts": "calls query.ts only",
};
const RECORD_READS = /\b(queryRecordEvents|queryRecordFacts|getRecordEvent|getRecordFact|eventFromItem|factFromItem|byScope|scopePage|bySource|byActor|byActorSource)\b/u;

describe("every read path goes through the access check", () => {
  it("each file that reads the lesson store imports readVisible or is a listed internal writer", () => {
    const offenders = filesOf("lessons").filter((file) => LESSON_READS.test(text(file)) && !text(file).includes("read-visible.js") && INTERNAL_LESSON_FILES[file] === undefined);
    expect(offenders).toEqual([]);
  });

  it("each file that reads the record's rows imports filterVisible or is a listed internal worker", () => {
    const offenders = filesOf("team-record").filter((file) => RECORD_READS.test(text(file)) && !/\bfilterVisible\b/u.test(text(file)) && INTERNAL_RECORD_FILES[file] === undefined);
    expect(offenders).toEqual([]);
  });

  it("the internal lists name only files that exist and still read (a stale entry fails)", () => {
    for (const file of Object.keys(INTERNAL_LESSON_FILES)) expect(LESSON_READS.test(text(file)) || file.endsWith("store.ts"), file).toBe(true);
    for (const file of Object.keys(INTERNAL_RECORD_FILES)) expect(RECORD_READS.test(text(file)) || file.endsWith("routes.ts"), file).toBe(true);
  });

  it("the files that return lessons to a viewer all use readVisible, and none reads the snapshot alone", () => {
    for (const file of ["lessons/load.ts", "lessons/digest.ts", "lessons/panel.ts", "lessons/approve.ts"]) expect(text(file), file).toContain("readVisible");
    for (const file of filesOf("lessons")) {
      if (file.endsWith("read-visible.ts") || file.endsWith("types.ts") || file.endsWith("approve.ts") || file.endsWith("load.ts")) continue;
      // satisfiesAcl on a lesson's provenance outside the read path is the old bypass shape
      expect(/satisfiesAcl\(\s*\w+,\s*\w+\.provenance/u.test(text(file)), file).toBe(false);
    }
  });
});
