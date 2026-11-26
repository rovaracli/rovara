// DECOUPLE T2 Opus review (test-only): two pins the lane's own tests did not have.
// 1. Task money: in EVERY forward reader the contracts export, the money block is the caught TaskMoneyV1Schema (an unreadable block reads as no money, never refuses the whole answer,
//    and is never partly read). A re-wrapped or copied money schema (a new instance) would not be caught by the identity match in forward-reader.ts; this walk fails on it.
// 2. The drift gate: the hand-written exact readers whose strict schema has NO counterpart in Code's snapshot are compared with nothing. They are named here, so the loss is explicit
//    (as MIRRORED_NOT_COMPARABLE does for the mirrors), and the day one gains a counterpart this test says so.
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import * as web from "../../packages/contracts/src/web.js";
import { TaskMoneyV1Schema } from "../../packages/contracts/src/task-money-schema.js";
import { HAND_WRITTEN_EXACT_READERS, readSnapshot } from "../../scripts/contract-drift/run.js";

type Def = { type: string } & Record<string, unknown>;
const defOf = (schema: unknown): Def => (schema as { _zod: { def: Def } })._zod.def;
const readers = Object.entries(web).filter(([name, value]) => /ReaderSchema$/u.test(name) && !HAND_WRITTEN_EXACT_READERS.includes(name) && value !== null && typeof value === "object" && "_zod" in value);

describe("task money in every forward reader", () => {
  it("is only ever the caught TaskMoneyV1Schema: a `money` key holds nothing else, and the bare money schema never appears uncaught", () => {
    const caught: string[] = []; const offenders: string[] = [];
    const walk = (schema: unknown, path: string, seen: Set<unknown>, underCatch: boolean): void => {
      // The money schema is checked at every place it occurs (before the seen-set, which would skip a second, uncaught use).
      if (schema === TaskMoneyV1Schema) { (underCatch ? caught : offenders).push(path); return; }
      if (schema === undefined || seen.has(schema)) return;
      seen.add(schema);
      const def = defOf(schema);
      switch (def.type) {
        case "object":
          for (const [key, field] of Object.entries((schema as z.ZodObject).shape)) {
            if (key === "money") {
              // A money key must be (optional/nullable of) catch(TaskMoneyV1Schema).
              let current: unknown = field;
              while (["optional", "nullable"].includes(defOf(current).type)) current = defOf(current)["innerType"];
              if (!(defOf(current).type === "catch" && defOf(current)["innerType"] === TaskMoneyV1Schema)) offenders.push(`${path}.money is not the caught money schema (${defOf(current).type})`);
            }
            walk(field, `${path}.${key}`, seen, false);
          }
          return;
        case "catch": walk(def["innerType"], path, seen, true); return;
        case "array": walk(def["element"], `${path}[]`, seen, false); return;
        case "optional": case "nullable": case "default": case "readonly": case "nonoptional": case "prefault": walk(def["innerType"], path, seen, underCatch); return;
        case "union": for (const option of def["options"] as unknown[]) walk(option, `${path}|`, seen, false); return;
        case "record": walk(def["valueType"], `${path}{}`, seen, false); return;
        case "intersection": walk(def["left"], path, seen, false); walk(def["right"], path, seen, false); return;
        case "pipe": walk(def["in"], path, seen, false); walk(def["out"], path, seen, false); return;
        default: return;
      }
    };
    for (const [name, value] of readers) walk(value, name, new Set(), false);
    expect(offenders).toEqual([]);
    // The session views, the Live tile, the task view and the session messages all carry money; at least those are found and caught.
    expect(caught.length).toBeGreaterThanOrEqual(5);
  });
});

describe("drift gate: exact readers with nothing in Code to compare", () => {
  it("are named, so the gap is explicit; one that gains a Code counterpart fails here (it is then compared, remove it from this list)", () => {
    const ids = Object.keys(readSnapshot().schemas);
    const uncompared = HAND_WRITTEN_EXACT_READERS.filter((reader) => !ids.some((id) => id.endsWith(`#${reader.replace(/ReaderSchema$/u, "Schema")}`))).sort();
    expect(uncompared).toEqual([
      "JiraOrgAdminResultReaderSchema", "LoadedKnowledgeResponseReaderSchema", "LoadedKnowledgeTextReaderSchema", "OrgSlackWorkspaceEvidenceResponseReaderSchema",
      "ProjectAllowedWebsitesResultReaderSchema", "TrackerPeopleReaderSchema", "TrackerPeopleResultReaderSchema",
    ]);
  });
});
