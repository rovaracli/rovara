// The guard for the erasure inventory (fix round 11): a schema field that can hold a person's id must be named in PERSON_FIELDS, so the erase has a step for it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERASE_HANDLED_STEPS } from "../../../packages/broker/src/team-record/erase.js";
import { ACTOR_STRUCTURED_FIELDS, ERASE_STEPS, PERSON_FIELDS, REQUIRED_ERASE_STEPS } from "../../../packages/broker/src/team-record/person-fields.js";

const ROOT = join(__dirname, "../../..");
const SCHEMA_FILES = [
  "packages/contracts/src/team-record.ts", "packages/contracts/src/team-record-sources.ts", "packages/contracts/src/lessons.ts", "packages/contracts/src/learned-context.ts", "packages/contracts/src/audit.ts",
  "packages/broker/src/lessons/types.ts", "packages/broker/src/team-record/types.ts", "packages/broker/src/team-record/shared-types.ts",
];
/** A field name that looks like it holds a person. */
const PERSONISH = /(developer|principal|author|approv|actor|user|member|owner|updatedBy|revertedBy|createdBy|assignee|reporter|mergedBy|[a-z]By$|\bby\b|^by$|erased)/u;
/** Person-looking names that hold no person's id, with the reason. */
const NOT_A_PERSON: Record<string, string> = {
  ownerIds: "the project's owners as the approvals directory returns them; read, never stored on a record or lesson",
  eligibleIds: "approval directory output, never stored",
  erasedBy: "the audit actor of an erase is the system or an admin id in the audit ledger, which has its own retention",
  actor: "audit event actor: the audit ledger's own field (see docs/audit-ledger/personal-data.md)",
  authorsMax: "a limit, not a field",
  userVisible: "a flag",
  approval: "the approval policy of a tier (one, two, auto), not a person",
  soleOwnerException: "a flag that a sole owner approved alone; the approver is in approvals[].by",
  membershipDigest: "a one-way hash of the approvers membership version and ids, taken when a source change was proposed; it holds no id",
  soleApprover: "a flag: the viewer is the only person who could approve; the id is not shown",
  memberSignal: "a flag that a member asked for the lesson; the member is in provenance.authors",
};

function fieldNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\??\s*:\s*(?:z\.|[A-Za-z]*Schema\b|readonly |string|number|boolean|Array<|\[)/gmu)) names.add(match[1] as string);
  return [...names];
}

describe("every field that can hold a person's id is in the erase registry", () => {
  const registered = new Set(PERSON_FIELDS.flatMap((field) => field.names));

  it("no schema field that looks like a person id is missing from PERSON_FIELDS", () => {
    const missing: string[] = [];
    for (const file of SCHEMA_FILES) {
      for (const name of fieldNames(readFileSync(join(ROOT, file), "utf8"))) {
        if (PERSONISH.test(name) && !registered.has(name) && NOT_A_PERSON[name] === undefined) missing.push(`${file}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the guard can fail: a new person-looking field is caught", () => {
    expect(fieldNames("  reviewedBy: z.string(),\n  taskId: z.string(),").filter((name) => PERSONISH.test(name) && !registered.has(name))).toEqual(["reviewedBy"]);
  });

  it("every step the registry names has a handler in the erase, and every actor field is listed for ingest to drop", () => {
    for (const step of REQUIRED_ERASE_STEPS) expect(ERASE_HANDLED_STEPS, step).toContain(step);
    for (const field of PERSON_FIELDS) expect(["never_stored", ...ERASE_STEPS], field.path).toContain(field.step);
    for (const field of PERSON_FIELDS.filter((entry) => entry.path.startsWith("event.structured"))) for (const name of field.names.filter((n) => n.endsWith("By"))) expect(ACTOR_STRUCTURED_FIELDS).toContain(name);
  });
});

// ERASE-NAME-1: the name a person chose (State item DEVELOPER_NAME#<id>) and the name their sign-in record holds are in the registry, erased by the `names` step, and nothing else writes the item.
describe("the chosen name is in the erase registry", () => {
  const sourceFiles = (directory: string): string[] => readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });

  it("names the item and the sign-in name, with the names step, and the erase has a handler for it", () => {
    const field = PERSON_FIELDS.find((entry) => entry.path.includes("DEVELOPER_NAME#"));
    expect(field).toMatchObject({ step: "names", store: "hot" });
    expect(field?.path).toContain("sign-in record");
    expect(REQUIRED_ERASE_STEPS).toContain("names");
    expect(ERASE_HANDLED_STEPS).toContain("names");
  });

  it("only the chosen-name module and the sign-in store write the item, so a new writer cannot appear without this test being read", () => {
    const writers = sourceFiles(join(ROOT, "packages/broker/src")).filter((file) => /entityType:\s*"DEVELOPER_NAME"/u.test(readFileSync(file, "utf8"))).map((file) => file.slice(join(ROOT, "packages/broker/src").length + 1)).sort();
    expect(writers).toEqual(["developer/chosen-name.ts", "developer/store.ts"]);
  });
});
