// NH-1 fix 11: the nightly coverage maps (`nightly-maps/<company>/<project>/<digest>.json`) go with the project when it is archived and with the company when it closes, whether or not any evidence was ever kept; a
// person's erase touches none; and the bucket expires the prefix after 30 days.
import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();
import type { OrgId } from "@rovara-code/contracts";
import { createEvidenceErase } from "../../packages/broker/src/rovara-code/evidence-erase.js";
import { nightlyMapKey, nightlyMapsOfOrg, nightlyMapsOfProject } from "../../packages/broker/src/test-env/map-keys.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const D1 = "1".repeat(64);
const D2 = "2".repeat(64);

function world(options: { marked: boolean }) {
  const objects = new Set<string>([nightlyMapKey(ORG, "web", D1), nightlyMapKey(ORG, "web", D2), nightlyMapKey(ORG, "api", D1), nightlyMapKey(OTHER, "web", D1), `private/own1/ws1/evidence/t/${D1}`]);
  const s3 = { async send(command: unknown) {
    if (command instanceof ListObjectsV2Command) return { Contents: [...objects].filter((k) => k.startsWith(command.input.Prefix!)).slice(0, 2).map((Key) => ({ Key })) };
    if (command instanceof DeleteObjectsCommand) { for (const { Key } of command.input.Delete!.Objects!) objects.delete(Key!); return {}; }
    throw new Error("unexpected command");
  } } as unknown as S3Client;
  const items = new Map<string, Record<string, unknown>>();
  if (options.marked) items.set(`EVIDENCE_STORED#${ORG}|META`, { pk: `EVIDENCE_STORED#${ORG}`, sk: "META" });
  const documentClient = { async send(command: unknown) {
    if (command instanceof GetCommand) { const at = `${String(command.input.Key!.pk)}|${String(command.input.Key!.sk)}`; return { Item: items.get(at) }; }
    if (command instanceof PutCommand) { items.set(`${String(command.input.Item!.pk)}|${String(command.input.Item!.sk)}`, command.input.Item!); return {}; }
    if (command instanceof DeleteCommand) { items.delete(`${String(command.input.Key!.pk)}|${String(command.input.Key!.sk)}`); return {}; }
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues as Record<string, string>;
      if (values[":prefix"] === "PROJECT#") return { Items: [{ sk: "PROJECT#web" }, { sk: "PROJECT#api" }] };
      return { Items: [] };
    }
    throw new Error("unexpected command");
  } };
  return { objects, items, erase: createEvidenceErase({ s3, artifactBucketName: "bucket", documentClient, tableName: "t" }) };
}

describe("nightly maps are erased with their project and company", () => {
  it("the keys: a project's maps are one prefix inside its company's, and nobody else's", () => {
    expect(nightlyMapKey(ORG, "web", D1).startsWith(nightlyMapsOfProject(ORG, "web"))).toBe(true);
    expect(nightlyMapsOfProject(ORG, "web").startsWith(nightlyMapsOfOrg(ORG))).toBe(true);
    expect(nightlyMapsOfProject(ORG, "web")).not.toBe(nightlyMapsOfProject(ORG, "api"));
    expect(nightlyMapsOfOrg(ORG)).not.toBe(nightlyMapsOfOrg(OTHER));
    expect(nightlyMapsOfProject(ORG, "web")).toMatch(/^nightly-maps\/[0-9a-f]{40}\/[0-9a-f]{40}\/$/u);
  });
  for (const marked of [false, true]) {
    it(`archiving a project deletes its maps and only its maps${marked ? "" : " (no evidence was ever kept)"}`, async () => {
      const w = world({ marked });
      await w.erase.project(ORG, "web");
      expect([...w.objects].filter((k) => k.startsWith("nightly-maps/")).sort()).toEqual([nightlyMapKey(ORG, "api", D1), nightlyMapKey(OTHER, "web", D1)].sort());
      expect(w.items.size).toBe(marked ? 1 : 0);
    });
    it(`closing a company deletes every map of the company and no other company's${marked ? "" : " (no evidence was ever kept)"}`, async () => {
      const w = world({ marked });
      await w.erase.workspace(ORG);
      expect([...w.objects].filter((k) => k.startsWith("nightly-maps/"))).toEqual([nightlyMapKey(OTHER, "web", D1)]);
    });
  }
  it("a person's erase deletes no map", async () => {
    const w = world({ marked: true });
    await w.erase.person(ORG, "d".repeat(64));
    expect([...w.objects].filter((k) => k.startsWith("nightly-maps/"))).toHaveLength(4);
  });
});

describe("the bucket", () => {
  it("expires nightly-maps/ after 30 days in a named environment", () => {
    const template = Template.fromStack(new ControlPlaneStack(new App(), "NightlyMaps-staging", { env: { account: "944937319445", region: "us-east-1" }, naming: environmentNaming("staging") })).toJSON() as { Resources: Record<string, { Type: string; Properties?: { LifecycleConfiguration?: { Rules: Array<Record<string, unknown>> } } }> };
    const rules = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::S3::Bucket").flatMap((resource) => resource.Properties?.LifecycleConfiguration?.Rules ?? []);
    expect(rules.find((rule) => rule["Id"] === "ExpireNightlyMaps")).toMatchObject({ Prefix: "nightly-maps/", ExpirationInDays: 30, Status: "Enabled" });
  });
});
