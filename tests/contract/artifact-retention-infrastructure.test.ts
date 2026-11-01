import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { E2E_ARTIFACT_RETENTION_DAYS, E2E_ARTIFACT_RETENTION_TAG, E2E_ARTIFACT_RETENTION_TAG_KEY, E2E_ARTIFACT_RETENTION_TAG_VALUE } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

// M1.3 Task 3.7b, finding F8 and owner decision D4 ("reuse the existing private-artifact retention, else add a 30-day lifecycle rule"): no rule reached the current version of a
// screenshot, so one is added. S3 lifecycle filters match the start of a key, and a screenshot's key starts with `private/<owner>/<workspace>/` like every other private object, so
// the rule matches an object tag the broker puts on a screenshot (and on nothing else). It belongs on the bucket the broker is configured to write to (Review 3.7b finding 1).

skipLambdaBundling();
const stacksOf = (app: App) => app.node.children.filter((c): c is Stack => Stack.isStack(c));
type Rule = { Id?: string; Status: string; ExpirationInDays?: number; NoncurrentVersionExpiration?: { NoncurrentDays: number }; TagFilters?: Array<{ Key: string; Value: string }>; Prefix?: string };
type Bucket = { Properties: { LifecycleConfiguration?: { Rules: Rule[] }; VersioningConfiguration?: unknown } };

describe("the retention of workflow screenshots is a rule on the bucket the broker writes them to", () => {
  const controlPlane = Template.fromStack(new ControlPlaneStack(new App(), "RetentionBucketControlPlane", { naming: environmentNaming("live25d") }));
  const buckets = controlPlane.findResources("AWS::S3::Bucket") as Record<string, Bucket>;
  /**
   * The bucket the broker's ARTIFACT_BUCKET_NAME names: the one it stores screenshots in. A named environment passes the name inside the packed AGENTX_NAMES bag (ENV-ROOM: the
   * broker's environment is at Lambda's ceiling), so the bucket is the one that bag refers to; the plain variable is read first where an install still passes it.
   */
  const brokerBucketId = (() => {
    const functions = Object.entries(controlPlane.findResources("AWS::Lambda::Function") as Record<string, { Properties: { Environment?: { Variables?: Record<string, unknown> } } }>);
    const broker = functions.find(([id]) => /^Broker[0-9A-F]{8}$/.test(id));
    const variables = broker?.[1].Properties.Environment?.Variables ?? {};
    const direct = (variables.ARTIFACT_BUCKET_NAME as { Ref?: string } | undefined)?.Ref;
    if (direct !== undefined) return direct;
    const packed = JSON.stringify(variables.AGENTX_NAMES ?? null);
    return Object.keys(buckets).find((id) => packed.includes(`"Ref":"${id}"`) && id.startsWith("Artifacts"));
  })();

  it("names the tag once, in the contracts, with the 30-day period of the owner's decision", () => {
    expect(E2E_ARTIFACT_RETENTION_DAYS).toBe(30);
    expect(E2E_ARTIFACT_RETENTION_TAG).toBe(`${E2E_ARTIFACT_RETENTION_TAG_KEY}=${E2E_ARTIFACT_RETENTION_TAG_VALUE}`);
  });

  it("expires an object that carries the screenshot tag after 30 days on the bucket the broker is configured with, and only such an object", () => {
    expect(brokerBucketId, "the broker names its artifact bucket").toBeDefined();
    const rules = buckets[brokerBucketId!]?.Properties.LifecycleConfiguration?.Rules ?? [];
    // The screenshot rule first; proof and evidence P6 adds one rule per evidence class (tests/unit/evidence-artifact-store.test.ts pins those), each on its own tag value.
    expect(rules).toHaveLength(3);
    expect(rules[0]).toMatchObject({ Status: "Enabled", ExpirationInDays: E2E_ARTIFACT_RETENTION_DAYS,
      TagFilters: [{ Key: E2E_ARTIFACT_RETENTION_TAG_KEY, Value: E2E_ARTIFACT_RETENTION_TAG_VALUE }] });
    expect(rules.map((rule) => rule.TagFilters?.[0]?.Value)).toEqual([E2E_ARTIFACT_RETENTION_TAG_VALUE, "evidence-short", "evidence-std"]);
    // the screenshot rule is tag-only (as before); the evidence rules are prefix AND tag (an `And` filter), so a tagged object outside the private keys never matches
    expect(rules.map((rule) => rule.Prefix)).toEqual([undefined, "private/", "private/"]);
    // The bucket is not versioned, so expiry deletes the object and no rule for old versions is needed.
    expect(buckets[brokerBucketId!]!.Properties.VersioningConfiguration).toBeUndefined();
  });

  it("is on no other bucket of the control plane", () => {
    for (const [id, bucket] of Object.entries(buckets)) {
      if (id === brokerBucketId) continue;
      expect((bucket.Properties.LifecycleConfiguration?.Rules ?? []).filter((rule) => rule.TagFilters !== undefined), id).toEqual([]);
    }
  });

  it("is not added to the legacy production template, which stays as it is", () => {
    const legacy = Template.fromStack(new ControlPlaneStack(new App(), "RetentionLegacyControlPlane"));
    for (const bucket of Object.values(legacy.findResources("AWS::S3::Bucket") as Record<string, Bucket>)) {
      expect((bucket.Properties.LifecycleConfiguration?.Rules ?? []).filter((rule) => rule.TagFilters !== undefined)).toEqual([]);
    }
  });

  it("is not on the access stack's release-artifact bucket, which the broker never writes screenshots to", () => {
    const access = stacksOf(buildAgentXApp({ agentxEnv: "staging" })).find((stack) => stack.stackName === "agentx-staging-access")!;
    for (const bucket of Object.values(Template.fromStack(access).findResources("AWS::S3::Bucket") as Record<string, Bucket>)) {
      expect((bucket.Properties.LifecycleConfiguration?.Rules ?? []).filter((rule) => rule.TagFilters !== undefined || rule.ExpirationInDays !== undefined)).toEqual([]);
    }
  });
});

describe("the broker may put the tag on the object it stores", () => {
  type Statement = { Action: string | string[]; Resource: unknown };
  type Policy = { Properties: { PolicyDocument: { Statement: Statement[] }; Roles: Array<{ Ref?: string }> } };
  it("holds s3:PutObjectTagging on the artifact bucket, so no new IAM statement is needed", () => {
    const template = Template.fromStack(new ControlPlaneStack(new App(), "RetentionControlPlane", { naming: environmentNaming("live25d") }));
    // The broker's grants are in managed policies of its role at the merged control plane (the role is split to stay under IAM's size limit), or an inline policy where it is not.
    const statements = ([...Object.values(template.findResources("AWS::IAM::Policy")), ...Object.values(template.findResources("AWS::IAM::ManagedPolicy"))] as Policy[])
      .filter((policy) => policy.Properties.Roles.some((role) => role.Ref?.startsWith("BrokerServiceRole"))).flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    expect(statements.some((statement) => [statement.Action].flat().includes("s3:PutObjectTagging"))).toBe(true);
  });
});

describe("the broker tags a screenshot, and only a screenshot, with that retention tag", () => {
  const artifacts = readFileSync("packages/broker/src/aws/workflow-e2e-artifacts.ts", "utf8");

  it("puts the tag on the screenshot object it stores", () => {
    expect(artifacts).toContain("Tagging: E2E_ARTIFACT_RETENTION_TAG");
  });

  it("names the tag nowhere else in the broker, so no other object can expire on it", () => {
    const found = execFileSync("grep", ["-rl", "E2E_ARTIFACT_RETENTION_TAG\\|Tagging:", "packages", "--include=*.ts", "--exclude-dir=dist", "--exclude-dir=node_modules"], { encoding: "utf8" })
      .trim().split("\n").filter((file) => file !== "");
    // P6: the evidence store tags with the same KEY and the evidence classes' own values; it must never carry the screenshot tag.
    // wire-proof (fix round 1): the evidence pack is tagged with the evidence classes' own value (`evidence-std`) through evidence-keep.ts, never the screenshot tag.
    expect(found.sort()).toEqual(["packages/broker/src/aws/evidence-artifacts.ts", "packages/broker/src/aws/workflow-e2e-artifacts.ts", "packages/broker/src/rovara-code/evidence-keep.ts", "packages/contracts/src/e2e-view-node.ts"]);
  });

  it("keeps the evidence store off the screenshot's tag value, so an evidence object never expires as a screenshot", () => {
    for (const file of ["packages/broker/src/aws/evidence-artifacts.ts", "packages/broker/src/rovara-code/evidence-keep.ts"]) {
      const evidence = readFileSync(file, "utf8");
      expect(evidence, file).not.toMatch(/E2E_ARTIFACT_RETENTION_TAG(?!_KEY)/u);
      expect(evidence, file).not.toContain("e2e-screenshot");
    }
  });
});
