// Reviewer probe (L1b Opus review): dumps the synthesized roles and projects for reading; asserts the facts the review relies on.
import { App, Aspects } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RequireCloudBoundary } from "../../infra/lib/cloud-boundary.js";
import { CLOUD_RELEASE_ACTIONS_STACK_NAME, CloudReleaseActionsStack } from "../../infra/lib/cloud-release-actions.js";

describe("review probe", () => {
  it("dumps the template and pins the facts the review uses", () => {
    const app = new App();
    Aspects.of(app).add(new RequireCloudBoundary());
    const stack = new CloudReleaseActionsStack(app, "RovaraCloudReleaseActions", { environmentName: "production", stackName: CLOUD_RELEASE_ACTIONS_STACK_NAME, env: { region: "us-east-1" } });
    const t = Template.fromStack(stack).toJSON() as { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }> };
    if (process.env.REVIEW_DUMP) writeFileSync(process.env.REVIEW_DUMP, JSON.stringify(t, null, 1));
    const projects = Object.values(t.Resources).filter((r) => r.Type === "AWS::CodeBuild::Project");
    // EncryptionKey alias/aws/s3 (CDK default): CodeBuild encrypts output artifacts with the AWS managed aws/s3 KMS key (SSE-KMS), which needs kms:GenerateDataKey/Decrypt
    // by the service role; the boundary must not deny that path.
    for (const p of projects) expect(p.Properties.EncryptionKey).toBe("alias/aws/s3");
    const boundary = Object.values(t.Resources).find((r) => r.Type === "AWS::IAM::ManagedPolicy")!;
    const denies = (boundary.Properties.PolicyDocument as { Statement: Array<{ Sid?: string; Effect: string; Action: string[]; Condition?: unknown }> }).Statement.filter((s) => s.Effect === "Deny");
    // M1 (fixed): the artifacts' KMS use goes through S3, so no UNCONDITIONAL Deny may cover kms:Decrypt or kms:GenerateDataKey; the direct use stays denied by a conditional one.
    const kmsDenies = denies.filter((s) => s.Action.some((a) => a.startsWith("kms:Decrypt") || a.startsWith("kms:GenerateDataKey")));
    expect(kmsDenies.filter((s) => s.Condition === undefined)).toEqual([]);
    expect(kmsDenies.map((s) => s.Sid)).toEqual(["DenyKeyUseOutsideS3"]);
    // Nothing in either role or the boundary mentions codepipeline.
    expect(JSON.stringify(t)).not.toMatch(/codepipeline:/u);
  });
});
