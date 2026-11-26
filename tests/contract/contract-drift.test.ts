// A Code change to an answer Cloud's web app reads must not silently break Cloud's strict parsers (Code 0.5.49 added `timeoutSeconds` to a setup item; Cloud's strict schema refused it).
// The pinned snapshot is Code's contract schemas as JSON Schema (tests/fixtures/code-contract-snapshot/code-contracts.json); scripts/contract-drift/ compares it with this
// repository's schemas of the same name. Refresh the snapshot and read the rules in scripts/contract-drift.ts.
import { readFileSync } from "node:fs";
import * as zod from "zod";
import { describe, expect, it } from "vitest";
import { compareDocuments, compareSchema, driftKey, groupDrifts, type SchemaDocument } from "../../scripts/contract-drift/compare.js";
import { check, extractCloud, HAND_WRITTEN_EXACT_READERS, MIRRORED_NOT_COMPARABLE, MIRRORED_SCHEMA_NAMES, parsedSchemaNames, readAccepted, readSnapshot, webSafeFiles } from "../../scripts/contract-drift/run.js";

const doc = (schemas: Record<string, unknown>, aliases: Record<string, string> = {}): SchemaDocument => ({ schemas: schemas as SchemaDocument["schemas"], aliases });
const obj = (properties: Record<string, unknown>, required: string[] = [], closed = true) => ({ type: "object", properties, required, ...(closed ? { additionalProperties: false } : {}) });
const kinds = (code: unknown, cloud: unknown): string[] => compareSchema("a.ts#S", doc({ "a.ts#S": code }), doc({ "a.ts#S": cloud })).map((drift) => `${drift.kind} ${drift.path}`);

describe("contract drift comparison", () => {
  it("accepts a schema that equals Cloud's, and one Cloud has widened", () => {
    expect(kinds(obj({ a: { type: "string", maxLength: 5 } }, ["a"]), obj({ a: { type: "string", maxLength: 9 }, b: { type: "number" } }, ["a"]))).toEqual([]);
  });
  it("names a field Code sends that Cloud's strict object does not list, and ignores it when Cloud's object is open", () => {
    expect(kinds(obj({ a: { type: "string" }, extra: { type: "integer" } }), obj({ a: { type: "string" } }))).toEqual(["unknown-field extra"]);
    expect(kinds(obj({ a: { type: "string" }, extra: { type: "integer" } }), obj({ a: { type: "string" } }, [], false))).toEqual([]);
  });
  it("walks arrays, unions, references and cycles to the nested field", () => {
    const code = { "a.ts#S": obj({ list: { type: "array", items: { anyOf: [obj({ kind: { const: "x" }, deep: { $ref: "#/schemas/a.ts#Inner" } }, ["kind"]), { type: "null" }] } } }, ["list"]), "a.ts#Inner": obj({ n: { type: "integer" }, self: { $ref: "#/schemas/a.ts#Inner" } }) };
    const cloud = { "a.ts#S": obj({ list: { type: "array", items: { anyOf: [obj({ kind: { const: "x" }, deep: { $ref: "#/schemas/a.ts#Inner" } }, ["kind"]), { type: "null" }] } } }, ["list"]), "a.ts#Inner": obj({ n: { type: "integer" }, self: { $ref: "#/schemas/a.ts#Inner" } }) };
    expect(compareSchema("a.ts#S", doc(code), doc(cloud))).toEqual([]);
    cloud["a.ts#Inner"] = obj({ n: { type: "integer" } });
    expect(compareSchema("a.ts#S", doc(code), doc(cloud)).map((drift) => drift.path)).toContain("list[](1).deep.self");
  });
  it("reports a value Cloud's enum or literal refuses, a type Cloud refuses, and a field Cloud requires that Code may omit", () => {
    expect(kinds(obj({ s: { enum: ["a", "b"] } }, ["s"]), obj({ s: { enum: ["a"] } }, ["s"]))).toEqual(["enum s"]);
    expect(kinds(obj({ s: { type: "string" } }, ["s"]), obj({ s: { type: "number" } }, ["s"]))).toEqual(["type s"]);
    expect(kinds(obj({ s: { type: "string" } }), obj({ s: { type: "string" } }, ["s"]))).toEqual(["missing-required s"]);
  });
  it("reports a wider length, count or number range and a pattern Code does not promise", () => {
    expect(kinds(obj({ s: { type: "string", maxLength: 500 } }), obj({ s: { type: "string", maxLength: 100 } }))).toEqual(["limit s"]);
    expect(kinds(obj({ l: { type: "array", items: { type: "string" } } }), obj({ l: { type: "array", maxItems: 3, items: { type: "string" } } }))).toEqual(["limit l"]);
    expect(kinds(obj({ n: { type: "integer", maximum: 9 } }), obj({ n: { type: "integer", minimum: 1, maximum: 5 } }))).toEqual(["limit n", "limit n"]);
    expect(kinds(obj({ s: { type: "string" } }), obj({ s: { type: "string", pattern: "^a$" } }))).toEqual(["pattern s"]);
  });
  it("follows an alias in either document", () => {
    const code = doc({ "a.ts#S": obj({ a: { type: "string" }, extra: { type: "string" } }) }, { "b.ts#T": "a.ts#S" });
    const cloud = doc({ "b.ts#T": obj({ a: { type: "string" } }) });
    expect(compareDocuments(code, cloud).drifts.map(driftKey)).toEqual(['b.ts#T extra unknown-field: Code sends "extra"; Cloud\'s object is strict and does not list it']);
  });
});

describe("contract drift against Code's pinned snapshot", () => {
  const snapshot = readSnapshot();

  it("is a snapshot of a real Code commit, taken with the zod this repository pins", () => {
    expect(snapshot.source.sha).toMatch(/^[a-f0-9]{40}$/u);
    expect(snapshot.source.zod).toBe((JSON.parse(readFileSync("node_modules/zod/package.json", "utf8")) as { version: string }).version);
    expect(Object.keys(snapshot.schemas).length).toBeGreaterThan(500);
    expect(snapshot.files).toEqual(webSafeFiles());
  });

  it("reads the schemas Cloud's app and server name in code, not in a comment or a string, and those include the setup draft the break was found in", () => {
    const parsed = parsedSchemaNames();
    expect(parsed.size).toBeGreaterThan(100);
    expect(parsed.has("SetupDraftResponseSchema")).toBe(true);
    // #1516: cloud-server/src/session-view.ts names `SessionViewSchema` in a comment only; the app reads a session with SessionViewReaderSchema. A comment is not a parser.
    expect(parsed.has("SessionViewSchema")).toBe(false);
    expect(parsed.has("SessionViewReaderSchema")).toBe(true);
  });

  // Pre-review S4: a hand-written exact reader is read as `XReaderSchema` but is as strict as `XSchema`, so Code is compared with `XSchema`.
  it("compares Code with the strict schema of every hand-written exact reader Cloud reads with, though code writes only its ReaderSchema name", () => {
    const parsed = parsedSchemaNames();
    expect(HAND_WRITTEN_EXACT_READERS).toHaveLength(25);
    const snapshot = readSnapshot();
    const inCode = (name: string) => Object.keys(snapshot.schemas).some((id) => id.endsWith(`#${name}`));
    for (const reader of HAND_WRITTEN_EXACT_READERS) {
      expect(reader.endsWith("ReaderSchema")).toBe(true);
      const strict = reader.replace(/ReaderSchema$/u, "Schema");
      // The reader is named in code (or the entry is dead), and its strict schema is compared whenever it is.
      expect(parsed.has(reader), `${reader} is named in the app or server`).toBe(true);
      expect(parsed.has(strict), `${strict} is compared`).toBe(true);
    }
    // The destructive-confirmation readers are compared against Code's own schema (the snapshot has them), so a drift in them is seen.
    for (const name of ["ReviewedProjectArchivePreviewSchema", "ReviewedProjectArchiveOutcomeSchema", "ReviewedProjectRestorePreviewSchema", "ReviewedProjectRestoreOutcomeSchema", "DecisionOutcomeSchema", "OrgServiceStatusSchema"]) expect(inCode(name), `${name} in Code's snapshot`).toBe(true);
    // A forward reader's strict schema is NOT compared just because the reader is named (that is the #1516 failure).
    expect(parsed.has("SessionViewReaderSchema")).toBe(true);
    expect(parsed.has("SessionViewSchema")).toBe(false);
  });
  // The 5 drifts the exact readers surfaced (expectedProjectIncarnation x4, teamRecord) were fixed in Cloud's contract files (STRICT-READERS-KNOWN-FIELDS), not accepted: with the exact readers compared against Code, these
  // schemas show NO drift against an EMPTY accepted list (a regression in the readers, or a Code field they lack, fails here and not only in the whole-gate test).
  it("compares the 5 schemas the exact readers once surfaced and finds no drift in them, with nothing accepted", async () => {
    const schemas = ["ReviewedProjectArchivePreviewSchema", "ReviewedProjectArchiveOutcomeSchema", "ReviewedProjectRestorePreviewSchema", "ReviewedProjectRestoreOutcomeSchema", "OrgServiceStatusSchema"];
    const parsed = parsedSchemaNames();
    for (const name of schemas) expect(parsed.has(name), `${name} is compared`).toBe(true);
    const snapshot = readSnapshot();
    for (const name of schemas) expect(Object.keys(snapshot.schemas).some((id) => id.endsWith(`#${name}`)), `${name} is in Code's snapshot`).toBe(true);
    const result = check(snapshot, await extractCloud(zod as never), []);
    expect(result.report.drifts.filter((drift) => schemas.some((name) => drift.schema.endsWith(`#${name}`)))).toEqual([]);
    expect(readAccepted().filter((entry) => schemas.some((name) => entry.key.includes(`#${name} `)))).toEqual([]);
  });
  // Pre-review S5: names that only a comment mentions, whose schema a server route or the app checks Code's answer against by hand, stay compared (the identifier scan alone would drop them).
  it("keeps the named mirrored schemas compared, each one real in Code's snapshot, and still leaves the #1516 schemas out", () => {
    const parsed = parsedSchemaNames();
    const snapshot = readSnapshot();
    expect(MIRRORED_SCHEMA_NAMES).toHaveLength(7);
    expect(new Set(MIRRORED_SCHEMA_NAMES).size).toBe(MIRRORED_SCHEMA_NAMES.length);
    for (const name of MIRRORED_SCHEMA_NAMES) { expect(parsed.has(name), `${name} is compared`).toBe(true); expect(Object.keys(snapshot.schemas).some((id) => id.endsWith(`#${name}`)), `${name} is in Code's snapshot`).toBe(true); }
    for (const name of ["SavedEnvPanelSchema", "HowWeWorkViewSchema", "AppMeResponseSchema"]) expect(MIRRORED_SCHEMA_NAMES).toContain(name);
    // The mirrors the gate cannot compare (no schema of that name in Code's snapshot: the contract file is not web-safe): named, so the loss is explicit. The day one is in the snapshot it must move to MIRRORED_SCHEMA_NAMES.
    expect(MIRRORED_NOT_COMPARABLE).toHaveLength(11);
    for (const name of MIRRORED_NOT_COMPARABLE) { expect(Object.keys(snapshot.schemas).some((id) => id.endsWith(`#${name}`)), `${name} has no schema to compare (move it to MIRRORED_SCHEMA_NAMES if it does)`).toBe(false); expect(MIRRORED_SCHEMA_NAMES).not.toContain(name); }
    for (const name of ["SessionViewSchema", "SessionMessageSchema", "WorkflowSnapshotShapeSchema", "ProjectOverviewSchema"]) { expect(MIRRORED_SCHEMA_NAMES).not.toContain(name); expect(parsed.has(name), `${name} stays out`).toBe(false); }
  });

  it("finds the Code 0.5.49 break: a setup item's timeoutSeconds against a strict Cloud schema, and passes once Cloud takes the field", () => {
    const withoutField = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(withoutField);
      if (typeof value !== "object" || value === null) return value;
      const own: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) if (key !== "timeoutSeconds" || typeof inner !== "object" || (inner as { type?: unknown }).type !== "integer") own[key] = withoutField(inner);
      return own;
    };
    const behind: SchemaDocument = { ...snapshot, schemas: withoutField(snapshot.schemas) as SchemaDocument["schemas"] };
    const drifts = compareDocuments(snapshot, behind).drifts.filter((drift) => drift.path.endsWith("timeoutSeconds"));
    expect(drifts.length).toBeGreaterThan(0);
    expect(drifts.every((drift) => drift.kind === "unknown-field")).toBe(true);
    expect(compareDocuments(snapshot, snapshot).drifts).toEqual([]);
  });

  it("has no drift in a schema Cloud parses that is not accepted in tests/fixtures/code-contract-snapshot/accepted-drift.json", async () => {
    const cloud = await extractCloud(zod as never);
    expect(cloud.loadErrors).toEqual([]);
    const result = check(snapshot, cloud, readAccepted());
    expect(result.report.compared).toBeGreaterThan(60);
    // Each line is one break: fix Cloud's schema (add the field, value or limit Code now sends), or, for a drift Cloud will live with, accept it with a reason (npx tsx scripts/contract-drift.ts accept).
    expect(groupDrifts(result.unaccepted).map((group) => `${driftKey(group.example)} (reaches ${group.schemas.join(", ")})`)).toEqual([]);
  });
});
