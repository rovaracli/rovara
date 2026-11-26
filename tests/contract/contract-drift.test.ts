// A Code change to an answer Cloud's web app reads must not silently break Cloud's strict parsers (Code 0.5.49 added `timeoutSeconds` to a setup item; Cloud's strict schema refused it).
// The pinned snapshot is Code's contract schemas as JSON Schema (tests/fixtures/code-contract-snapshot/code-contracts.json); scripts/contract-drift/ compares it with this
// repository's schemas of the same name. Refresh the snapshot and read the rules in scripts/contract-drift.ts.
import { readFileSync } from "node:fs";
import * as zod from "zod";
import { describe, expect, it } from "vitest";
import { compareDocuments, compareSchema, driftKey, groupDrifts, type SchemaDocument } from "../../scripts/contract-drift/compare.js";
import { check, extractCloud, parsedSchemaNames, readAccepted, readSnapshot, webSafeFiles } from "../../scripts/contract-drift/run.js";

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
