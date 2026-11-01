// Review S1 (Opus): an Enterprise install records its evidence retention as TEXT, and the infrastructure read it as an object, so the customer's days silently became the defaults (14 and 30):
// evidence kept for less time than the customer set. These tests carry the customer's value through the recorded settings into the bucket's lifecycle rules.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { SynthSettingsSchema, evidenceRetentionSetting, synthContext } from "@agentx/contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Rule = { Id?: string; ExpirationInDays?: number; TagFilters?: unknown };
const evidenceDays = (context: Record<string, unknown>): number[] => {
  const template = Template.fromStack(new ControlPlaneStack(new App({ context }), "EvidenceRetention", { naming: environmentNaming("live25d") }));
  const buckets = Object.values(template.findResources("AWS::S3::Bucket") as Record<string, { Properties: { LifecycleConfiguration?: { Rules: Rule[] } } }>);
  return buckets.flatMap((bucket) => bucket.Properties.LifecycleConfiguration?.Rules ?? []).filter((rule) => rule.Id === "ExpireEvidenceShort" || rule.Id === "ExpireEvidenceStd").map((rule) => rule.ExpirationInDays!);
};
const settings = (evidenceRetentionDays?: string) => SynthSettingsSchema.parse({
  schemaVersion: 1, edition: "enterprise", env: "ent", region: "us-east-1", identityMode: "cognito",
  context: { rovaraEnterpriseEgressCidrs: "10.20.0.0/16", agentxAuditTsa: "off", ...(evidenceRetentionDays === undefined ? {} : { evidenceRetentionDays }) },
});

describe("the evidence retention a customer records", () => {
  it("reaches the bucket's lifecycle rules: the recorded text, as the build at approval passes it", () => {
    const context = synthContext(settings('{"evidence-short": 60, "evidence-std": 90}'));
    expect(context.evidenceRetentionDays).toBe('{"evidence-short": 60, "evidence-std": 90}');
    expect(evidenceDays(context)).toEqual([60, 90]);
  });

  it("keeps the defaults when nothing is recorded, and still takes an object (cdk.json style)", () => {
    expect(evidenceDays(synthContext(settings()))).toEqual([14, 30]);
    expect(evidenceDays({ evidenceRetentionDays: { "evidence-short": 3, "evidence-std": 90 } })).toEqual([3, 90]);
  });

  it("stops the build on text that is not a JSON object, instead of using the defaults", () => {
    for (const bad of ["sixty", "[60, 90]", "null", "60", '{"evidence-short":']) {
      expect(() => evidenceDays({ evidenceRetentionDays: bad }), bad).toThrow(/evidenceRetentionDays must be a JSON object/);
    }
    expect(evidenceRetentionSetting(undefined)).toBeUndefined();
    expect(evidenceRetentionSetting("")).toBeUndefined();
  });

  it("is refused when it is recorded wrong: not JSON, another class, a value outside the range, not a whole number", () => {
    for (const bad of ["sixty", "[1]", '{"evidence-record": 30}', '{"evidence-short": 0}', '{"evidence-short": 91}', '{"evidence-std": 6}', '{"evidence-std": 181}', '{"evidence-short": 30.5}', '{"evidence-short": "30"}']) {
      expect(() => settings(bad), bad).toThrow();
    }
    expect(() => settings('{"evidence-short": 1, "evidence-std": 180}')).not.toThrow();
    expect(() => settings('{"evidence-std": 45}')).not.toThrow();
  });
});
