// Test services, slice 3 (M3): a company close deletes the company's answer sets (rows, then objects) whether or not any evidence was ever kept; a person's erase replaces their id in `submittedBy`, `decidedBy` and
// `withdrawnBy`; a project archive keeps the sets; and the registry (PERSON_FIELDS) names the fields and the step that erases them.
import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import type { OrgId } from "../../packages/contracts/src/index.js";
import { createEvidenceErase } from "../../packages/broker/src/rovara-code/evidence-erase.js";
import { FIXTURE_ERASED_ACTOR, fixtureObjectsOfOrg } from "../../packages/broker/src/test-env/fixture-erase.js";
import { fixtureObjectKey, type FixtureRecord } from "../../packages/broker/src/test-env/fixture-store.js";
import { ERASE_HANDLED_STEPS } from "../../packages/broker/src/team-record/erase.js";
import { PERSON_FIELDS, REQUIRED_ERASE_STEPS } from "../../packages/broker/src/team-record/person-fields.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const D1 = "1".repeat(64);
const D2 = "2".repeat(64);
const row = (orgId: string, project: string, digest: string, over: Partial<FixtureRecord> = {}): Record<string, unknown> => ({
  pk: `ORG#${orgId}`, sk: `FIXTURE#${project}#${digest}`, entity: "FIXTURE_SET", storeId: `fxs:${orgId}:${project}:${digest}`, orgId, project, digest, dependencyId: "payments-api", status: "approved", submittedBy: "dev_maya",
  submittedAt: "2026-11-03T00:00:00.000Z", decidedBy: "dev_omar", decidedAt: "2026-11-03T01:00:00.000Z", version: 2, ...over,
});

function world(options: { marked?: boolean; failUpdateOnce?: boolean } = {}) {
  let failed = options.failUpdateOnce !== true;
  const objects = new Set<string>([
    fixtureObjectKey(ORG, "web", D1), fixtureObjectKey(ORG, "api", D1), fixtureObjectKey(ORG, "api", D2), fixtureObjectKey(OTHER, "web", D1),
    `private/own1/ws1/evidence/t/${D1}`, `private/${ORG}/fixtures-not/${D1}`,
  ]);
  const s3 = { async send(command: unknown) {
    if (command instanceof ListObjectsV2Command) return { Contents: [...objects].filter((k) => k.startsWith(command.input.Prefix!)).slice(0, 2).map((Key) => ({ Key })) };
    if (command instanceof DeleteObjectsCommand) { for (const { Key } of command.input.Delete!.Objects!) objects.delete(Key!); return {}; }
    throw new Error("unexpected s3 command");
  } } as unknown as S3Client;
  const items = new Map<string, Record<string, unknown>>();
  const at = (pk: unknown, sk: unknown) => `${String(pk)}|${String(sk)}`;
  if (options.marked === true) items.set(at(`EVIDENCE_STORED#${ORG}`, "META"), { pk: `EVIDENCE_STORED#${ORG}`, sk: "META" });
  for (const item of [row(ORG, "web", D1), row(ORG, "api", D1, { status: "withdrawn", withdrawnBy: "dev_maya" }), row(ORG, "api", D2, { submittedBy: "dev_omar", decidedBy: "dev_maya" }), row(OTHER, "web", D1, { submittedBy: "dev_maya" })]) items.set(at(item.pk, item.sk), item);
  const documentClient = { async send(command: unknown) {
    if (command instanceof GetCommand) return { Item: items.get(at(command.input.Key!.pk, command.input.Key!.sk)) };
    if (command instanceof PutCommand) { items.set(at(command.input.Item!.pk, command.input.Item!.sk), command.input.Item!); return {}; }
    if (command instanceof DeleteCommand) { items.delete(at(command.input.Key!.pk, command.input.Key!.sk)); return {}; }
    if (command instanceof UpdateCommand) {
      if (!failed) { failed = true; throw Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" }); }
      const key = at(command.input.Key!.pk, command.input.Key!.sk);
      const current = items.get(key);
      const names = command.input.ExpressionAttributeNames as Record<string, string>;
      const values = command.input.ExpressionAttributeValues as Record<string, unknown>;
      const field = names["#field"]!;
      if (current === undefined || current[field] !== values[":developer"]) throw Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" });
      items.set(key, { ...current, [field]: values[":stand"], version: (current["version"] as number) + (values[":one"] as number) });
      return {};
    }
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues as Record<string, string>;
      if (values[":prefix"] === "PROJECT#") return { Items: [{ sk: "PROJECT#web" }, { sk: "PROJECT#api" }] };
      if (values[":pk"] !== undefined && values[":sk"] !== undefined) return { Items: [...items.values()].filter((item) => item["pk"] === values[":pk"] && String(item["sk"]).startsWith(values[":sk"]!)) };
      return { Items: [] };
    }
    throw new Error("unexpected dynamo command");
  } };
  const fixtureKeys = () => [...objects].filter((key) => key.includes("/fixtures/")).sort();
  const rows = () => [...items.values()].filter((item) => String(item["sk"]).startsWith("FIXTURE#"));
  return { objects, items, rows, fixtureKeys, erase: createEvidenceErase({ s3, artifactBucketName: "bucket", documentClient, tableName: "t" }) };
}

describe("a company close deletes the company's answer sets", () => {
  for (const marked of [false, true]) {
    it(`rows and objects of that company only${marked ? "" : " (no evidence was ever kept)"}`, async () => {
      const w = world({ marked });
      await w.erase.workspace(ORG);
      expect(w.rows().map((item) => item["orgId"])).toEqual([OTHER]);
      expect(w.fixtureKeys()).toEqual([fixtureObjectKey(OTHER, "web", D1)]);
      // another prefix of the same company, and evidence, are not the fixtures' to delete here
      expect(w.objects.has(`private/${ORG}/fixtures-not/${D1}`)).toBe(true);
      expect(w.objects.has(`private/own1/ws1/evidence/t/${D1}`)).toBe(true);
    });
  }
  it("the prefix is the company's fixtures and nothing wider", () => {
    expect(fixtureObjectsOfOrg(ORG)).toBe(`private/${ORG}/fixtures/`);
    expect(fixtureObjectKey(ORG, "web", D1).startsWith(fixtureObjectsOfOrg(ORG))).toBe(true);
    expect(fixtureObjectKey(OTHER, "web", D1).startsWith(fixtureObjectsOfOrg(ORG))).toBe(false);
    expect(() => fixtureObjectsOfOrg("org_x/../")).toThrow();
  });
  it("a project archive keeps the sets (a project can come back; the company's close removes them)", async () => {
    const w = world();
    await w.erase.project(ORG, "web");
    expect(w.rows()).toHaveLength(4);
    expect(w.fixtureKeys()).toHaveLength(4);
  });
});

describe("a person's erase replaces their id in the answer-set rows", () => {
  it("submittedBy, decidedBy and withdrawnBy become the stand-in; the set, its digest and its status stay; the row's version moves", async () => {
    const w = world();
    await w.erase.person(ORG, "dev_maya");
    const mine = w.rows().filter((item) => item["orgId"] === ORG);
    expect(JSON.stringify(mine)).not.toContain("dev_maya");
    const byKey = Object.fromEntries(mine.map((item) => [`${String(item["project"])}/${String(item["digest"]).slice(0, 1)}`, item]));
    expect(byKey["web/1"]).toMatchObject({ submittedBy: FIXTURE_ERASED_ACTOR, decidedBy: "dev_omar", status: "approved", version: 3 });
    expect(byKey["api/1"]).toMatchObject({ submittedBy: FIXTURE_ERASED_ACTOR, withdrawnBy: FIXTURE_ERASED_ACTOR, status: "withdrawn", version: 4 });
    expect(byKey["api/2"]).toMatchObject({ submittedBy: "dev_omar", decidedBy: FIXTURE_ERASED_ACTOR, version: 3 });
    // another company's row names the same id and is not this company's to change; the objects stay
    expect(w.rows().find((item) => item["orgId"] === OTHER)).toMatchObject({ submittedBy: "dev_maya", version: 2 });
    expect(w.fixtureKeys()).toHaveLength(4);
  });
  it("a person with no answer sets changes nothing, and another person's rows are not touched", async () => {
    const w = world();
    const before = JSON.stringify(w.rows());
    await w.erase.person(ORG, "dev_nobody");
    expect(JSON.stringify(w.rows())).toBe(before);
  });
  it("is repeated, not skipped, when a row changed under the walk: the erase throws, the next request finishes it", async () => {
    const w = world({ failUpdateOnce: true });
    await expect(w.erase.person(ORG, "dev_maya")).rejects.toThrow();
    expect(JSON.stringify(w.rows().filter((item) => item["orgId"] === ORG))).toContain("dev_maya");
    await w.erase.person(ORG, "dev_maya");
    expect(JSON.stringify(w.rows().filter((item) => item["orgId"] === ORG))).not.toContain("dev_maya");
  });
});

describe("the registry names the fields and the step", () => {
  it("PERSON_FIELDS lists the three fields under an erase step that has a handler", () => {
    const entry = PERSON_FIELDS.find((field) => field.names.includes("submittedBy"))!;
    expect(entry.names).toEqual(["submittedBy", "decidedBy", "withdrawnBy"]);
    expect(entry.step).toBe("fixtures");
    expect(REQUIRED_ERASE_STEPS).toContain("fixtures");
    expect(ERASE_HANDLED_STEPS).toContain("fixtures");
  });
});
