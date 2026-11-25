// The Cloud IAM gate's opt-in AWS step (infra/lib/cloud-iam-validate.ts, infra/bin/cloud-iam-validate.ts): reads synthesized templates and judges Access Analyzer findings.
// No AWS here: the analyzer call is injected; a real run is `infra/bin/cloud-iam-validate.ts --aws` (PH-S3-IAM-FIX-DONE.md has the before and after).
import { App, Aspects } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { RequireCloudBoundary } from "../../infra/lib/cloud-boundary.js";
import type { CfnTemplate } from "../../infra/lib/cloud-boundary-check.js";
import { CLOUD_RELEASE_ACTIONS_STACK_NAME, CloudReleaseActionsStack } from "../../infra/lib/cloud-release-actions.js";
import { DEFAULT_BLOCKING, blockingFindings, parseFindings, policyFiles, unresolvedIntrinsics, validateAll, validatePolicyArguments, type Finding } from "../../infra/lib/cloud-iam-validate.js";

const scope = { partition: "aws", region: "us-east-1", account: "123456789012" };
const app = new App();
Aspects.of(app).add(new RequireCloudBoundary());
const stack = new CloudReleaseActionsStack(app, "RovaraCloudReleaseActions", { environmentName: "production", stackName: CLOUD_RELEASE_ACTIONS_STACK_NAME, env: { region: scope.region } });
const template = Template.fromStack(stack).toJSON() as CfnTemplate;
const finding = (findingType: string, issueCode: string): Finding => ({ findingType, issueCode, findingDetails: "x" });

describe("Cloud IAM gate: Access Analyzer validation of the synthesized policies", () => {
  it("reads every identity policy, the boundary and every role's trust policy of a stack, with no intrinsic left", () => {
    const files = policyFiles(CLOUD_RELEASE_ACTIONS_STACK_NAME, template, scope);
    expect(files.map((f) => `${f.kind}:${f.name.replace(/[0-9A-F]{8}(\/trust)?$/u, "")}${f.kind === "trust" ? "/trust" : ""}`).sort()).toEqual([
      `identity:${CLOUD_RELEASE_ACTIONS_STACK_NAME}/BetaBuildRoleDefaultPolicy`, `identity:${CLOUD_RELEASE_ACTIONS_STACK_NAME}/ProductionBuildRoleDefaultPolicy`, `identity:${CLOUD_RELEASE_ACTIONS_STACK_NAME}/RoleBoundary`,
      `trust:${CLOUD_RELEASE_ACTIONS_STACK_NAME}/BetaBuildRole/trust`, `trust:${CLOUD_RELEASE_ACTIONS_STACK_NAME}/ProductionBuildRole/trust`,
    ]);
    for (const file of files) expect(unresolvedIntrinsics(file.document), file.name).toEqual([]);
    // The sample account is the one given, never another.
    expect(JSON.stringify(files.map((f) => f.document))).toContain('"arn:aws:ecs:us-east-1:123456789012:cluster/rovara-cloud-production-gateway-*"');
  });

  it("an intrinsic the gate cannot replace is an error, never a document validated with the wrong text", () => {
    expect(() => validateAll([{ name: "x", kind: "identity", document: { Statement: [{ Resource: { "Fn::Cidr": [] } }] } }], () => [])).toThrow(/Fn::Cidr/u);
  });

  it("zero documents is a failed run, never a pass (an empty synth or a mistyped context checked nothing)", () => {
    let calls = 0;
    expect(() => validateAll([], () => { calls += 1; return []; })).toThrow(/no IAM policy documents.*not a pass/u);
    expect(calls).toBe(0);
    expect(policyFiles("empty", { Resources: {} }, scope)).toEqual([]);
  });

  it("fails on ERROR, SECURITY_WARNING and a TYPE_MISMATCH warning, and not on other warnings or suggestions", () => {
    expect(DEFAULT_BLOCKING).toEqual(["ERROR", "SECURITY_WARNING", "TYPE_MISMATCH"]);
    const findings = [finding("ERROR", "INVALID_ACTION"), finding("SECURITY_WARNING", "STRING_LIKE_OPERATOR_WITH_ARN_CONDITION_KEYS"), finding("WARNING", "TYPE_MISMATCH"), finding("WARNING", "MISSING_VERSION"), finding("SUGGESTION", "REDUNDANT_RESOURCE")];
    expect(blockingFindings(findings).map((f) => f.issueCode)).toEqual(["INVALID_ACTION", "STRING_LIKE_OPERATOR_WITH_ARN_CONDITION_KEYS", "TYPE_MISMATCH"]);
    expect(blockingFindings(findings, ["SUGGESTION"]).map((f) => f.issueCode)).toEqual(["REDUNDANT_RESOURCE"]);
  });

  it("judges each file by the analyzer's findings for that document (a fake analyzer here)", () => {
    const files = policyFiles(CLOUD_RELEASE_ACTIONS_STACK_NAME, template, scope);
    // A fake analyzer that flags the one thing the first real pass found: a Bool operator and a StringLike on ecs:cluster.
    const fake = (file: { document: unknown }): Finding[] => {
      const text = JSON.stringify(file.document);
      return [...(text.includes('"Bool"') ? [finding("WARNING", "TYPE_MISMATCH")] : []), ...(/"StringLike":\{"ecs:cluster"/u.test(text) ? [finding("SECURITY_WARNING", "STRING_LIKE_OPERATOR_WITH_ARN_CONDITION_KEYS")] : [])];
    };
    expect(validateAll(files, fake).filter((r) => r.blocking.length > 0)).toEqual([]);
  });

  it("reads the analyzer's JSON after a wrapper's notes, and builds the read-only call (a trust policy is a resource policy of its own type)", () => {
    const out = `beta-aws.sh: account x, read-only\n${JSON.stringify({ findings: [{ findingType: "WARNING", issueCode: "TYPE_MISMATCH", findingDetails: "d", locations: [{ span: { start: { line: 192 } } }] }] })}`;
    expect(parseFindings(out)).toEqual([{ findingType: "WARNING", issueCode: "TYPE_MISMATCH", findingDetails: "d", line: 192 }]);
    expect(() => parseFindings("no json")).toThrow(/no JSON/u);
    expect(validatePolicyArguments("identity", "/p.json")).toEqual(["accessanalyzer", "validate-policy", "--policy-type", "IDENTITY_POLICY", "--policy-document", "file:///p.json", "--output", "json"]);
    expect(validatePolicyArguments("trust", "/t.json").slice(2, 6)).toEqual(["--policy-type", "RESOURCE_POLICY", "--validate-policy-resource-type", "AWS::IAM::AssumeRolePolicyDocument"]);
  });
});
