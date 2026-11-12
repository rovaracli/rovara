import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { renderAll, renderTemplate } from "../../scripts/test-access/build-artifacts.js";
import { TEST_ACCESS_CALLBACK_TIMEOUT_SECONDS, TEST_ACCESS_TEMPLATE_PARAMETERS, TEST_ACCESS_TEMPLATE_VERSION } from "../../packages/cloud-contracts/src/test-access-connect.js";
import { buildTestAccessPolicies, buildTrustPolicy } from "../../packages/cloud-contracts/src/test-access-policy.js";

// The connect kit: the CloudFormation template, the Terraform module's policies and the copy-paste policy text are all made by scripts/test-access/build-artifacts.ts from one source.

type Json = Record<string, unknown>;
const ROOT = "environments/test-access";
const TEMPLATE = `${ROOT}/cloudformation/rovara-test-access.template.yaml`;

// cfn-yaml tags (!Ref, !Sub, !GetAtt) become the JSON form CloudFormation reads.
const tag = (name: string, prefix = "Fn::") => ({ identify: (value: unknown) => value === undefined, tag: `!${name}`, resolve: (value: unknown) => ({ [name === "Ref" ? "Ref" : `${prefix}${name}`]: value }) });
interface Template {
  Parameters: Record<string, Json>;
  Resources: Record<string, Json>;
  Outputs: Record<string, Json>;
  Metadata: Json;
}
const template = (text: string): Template => parse(text, { customTags: [tag("Ref"), tag("Sub"), tag("GetAtt")] }) as Template;
const current = template(readFileSync(TEMPLATE, "utf8"));
const roles = Object.entries(current.Resources).filter(([, resource]) => resource.Type === "AWS::IAM::Role");

function tool(candidates: readonly string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate) || spawnSync(candidate, ["--version"]).status === 0);
}
const CFN_GUARD = tool([process.env.CFN_GUARD ?? "", join(homedir(), ".local/share/rovara-tools/cfn-guard-3.2.1/cfn-guard"), "cfn-guard"].filter(Boolean));
const CFN_LINT = tool([join(homedir(), ".local/bin/cfn-lint"), "cfn-lint"]);

describe("the generated files are what the source makes", () => {
  it("matches every file on disk (run scripts/test-access/build-artifacts.ts after a change)", () => {
    for (const [path, content] of Object.entries(renderAll())) expect(readFileSync(path, "utf8"), path).toBe(content);
  });
  it("leaves no generated file behind that the source no longer makes", () => {
    const made = new Set(Object.keys(renderAll()));
    for (const folder of [`${ROOT}/terraform/policies`, `${ROOT}/policy`]) {
      for (const name of readdirSync(folder)) expect(made.has(`${folder}/${name}`), `${folder}/${name}`).toBe(true);
    }
  });
});

describe("the CloudFormation template", () => {
  it("takes the parameters the quick-create link fills, and no others", () => {
    expect(Object.keys(current.Parameters).sort()).toEqual(Object.values(TEST_ACCESS_TEMPLATE_PARAMETERS).sort());
    expect(current.Parameters.ConnectToken?.NoEcho).toBe(true);
    for (const parameter of Object.values(current.Parameters)) expect(parameter.AllowedPattern).toBeTypeOf("string");
  });

  it("carries the version the callback reports", () => {
    expect(current.Metadata.RovaraTemplateVersion).toBe(TEST_ACCESS_TEMPLATE_VERSION);
    const callback = current.Resources.RovaraCallback as { Properties: Json };
    expect(callback.Properties.TemplateVersion).toBe(TEST_ACCESS_TEMPLATE_VERSION);
    expect(current.Outputs.TemplateVersion?.Value).toBe(TEST_ACCESS_TEMPLATE_VERSION);
  });

  it("trusts Rovara's role with the external id, in the shape the policy builder makes", () => {
    expect(roles.map(([name]) => name).sort()).toEqual(["RovaraTestCleanupRole", "RovaraTestRole"]);
    const expected = buildTrustPolicy({ principalArn: "PRINCIPAL", externalId: "EXTERNAL" });
    for (const [name, role] of roles) {
      const trust = (role.Properties as { AssumeRolePolicyDocument: { Statement: Json[] } }).AssumeRolePolicyDocument;
      expect(trust.Statement.length, name).toBe(2);
      const text = JSON.stringify(trust).replaceAll(JSON.stringify({ Ref: "RovaraPrincipal" }), '"PRINCIPAL"').replaceAll(JSON.stringify({ Ref: "ExternalId" }), '"EXTERNAL"');
      expect(JSON.parse(text), name).toEqual(JSON.parse(JSON.stringify(expected)));
    }
  });

  it("attaches the boundary to every role, and at most 10 managed policies to a role", () => {
    for (const [name, role] of roles) {
      const properties = role.Properties as { PermissionsBoundary: unknown; ManagedPolicyArns: unknown[] };
      expect(properties.PermissionsBoundary, name).toEqual({ Ref: "RovaraTestBoundary" });
      expect(properties.ManagedPolicyArns.length, name).toBe(1);
      expect(properties.ManagedPolicyArns.length, name).toBeLessThanOrEqual(10);
      for (const arn of properties.ManagedPolicyArns) expect(current.Resources[(arn as { Ref: string }).Ref]?.Type).toBe("AWS::IAM::ManagedPolicy");
    }
  });

  it("holds the same policies the builder makes, in the same number", () => {
    const managed = Object.keys(current.Resources).filter((name) => current.Resources[name]?.Type === "AWS::IAM::ManagedPolicy");
    expect(managed.sort()).toEqual(["RovaraTestBoundary", "RovaraTestCleanupPolicy", "RovaraTestPolicy"]);
    const policies = buildTestAccessPolicies();
    const boundary = (current.Resources.RovaraTestBoundary as { Properties: { PolicyDocument: { Statement: { Sid: string }[] } } }).Properties.PolicyDocument.Statement;
    expect(boundary.map((statement) => statement.Sid)).toEqual(policies.boundary.Statement.map((statement) => statement.Sid));
  });

  it("reports to the topic the parameter names, with a timeout, and never creates keys or users", () => {
    const callback = current.Resources.RovaraCallback as { Type: string; Properties: Json };
    expect(callback.Type).toBe("Custom::RovaraTestAccess");
    expect(callback.Properties.ServiceToken).toEqual({ Ref: "CallbackTopicArn" });
    expect(callback.Properties.ServiceTimeout).toBe(String(TEST_ACCESS_CALLBACK_TIMEOUT_SECONDS));
    expect(TEST_ACCESS_CALLBACK_TIMEOUT_SECONDS).toBeLessThanOrEqual(120);
    expect(Object.values(current.Resources).filter((resource) => /^AWS::IAM::(AccessKey|User|LoginProfile)$/u.test(String(resource.Type)))).toEqual([]);
  });

  it("is small enough to host in S3 for quick-create (1 MB) and is rebuilt identically", () => {
    expect(readFileSync(TEMPLATE, "utf8").length).toBeLessThan(1_000_000);
    expect(renderTemplate()).toBe(readFileSync(TEMPLATE, "utf8"));
  });
});

describe("the Terraform module and the copy-paste text", () => {
  it("has a policy file for every managed policy of the template", () => {
    expect(readdirSync(`${ROOT}/terraform/policies`).sort()).toEqual(["access.json.tftpl", "boundary.json.tftpl", "cleanup.json.tftpl"]);
    expect(readdirSync(`${ROOT}/policy`).sort()).toEqual(["cleanup-role-access.json", "permissions-boundary.json", "test-role-access.json", "trust-policy.json"]);
  });

  it("does the same as the template: trust with the external id, the boundary on both roles, no keys", () => {
    const main = readFileSync(`${ROOT}/terraform/main.tf`, "utf8");
    expect(main).toContain('test     = "StringEquals"');
    expect(main).toContain('variable = "sts:ExternalId"');
    expect(main.match(/permissions_boundary = aws_iam_policy\.boundary\.arn/gu)?.length).toBe(2);
    expect(main).toContain('values   = ["????????"]');
    expect(main).not.toMatch(/aws_iam_access_key|aws_iam_user/u);
    expect(readFileSync(`${ROOT}/terraform/variables.tf`, "utf8")).toContain("rovara-run");
  });

  it("gives the copy-paste text with placeholders, and no concrete account", () => {
    const boundary = readFileSync(`${ROOT}/policy/permissions-boundary.json`, "utf8");
    expect(boundary).toContain("<ACCOUNT_ID>");
    expect(boundary).toContain('"aws:RequestedRegion": "<REGION>"');
    expect(boundary).toContain("policy/rovara-test-boundary-<EXTERNAL_ID>");
    const trust = JSON.parse(readFileSync(`${ROOT}/policy/trust-policy.json`, "utf8")) as { Statement: { Condition: { StringEquals?: Record<string, string> } }[] };
    expect(trust.Statement[0]?.Condition.StringEquals?.["sts:ExternalId"]).toBe("<EXTERNAL_ID>");
    for (const name of readdirSync(`${ROOT}/policy`).filter((file) => file.endsWith(".json"))) {
      expect(() => void (JSON.parse(readFileSync(`${ROOT}/policy/${name}`, "utf8")) as unknown), name).not.toThrow();
      expect(readFileSync(`${ROOT}/policy/${name}`, "utf8"), name).not.toMatch(/\{\{|\bAWS::/u);
    }
  });
});

// The lint and the rules. The tools are pinned (cfn-lint 1.58.0, cfn-guard 3.2.1; scripts/test-access/check-templates.sh) and run with no AWS call. A machine without them skips these.
describe.skipIf(CFN_GUARD === undefined || CFN_LINT === undefined)("cfn-lint and cfn-guard", () => {
  const dir = mkdtempSync(join(tmpdir(), "test-access-"));
  const guard = (path: string, rules = "rovara-test-access.guard") => spawnSync(CFN_GUARD as string, ["validate", "--rules", `${ROOT}/rules/${rules}`, "--data", path, "--show-summary", "fail"], { encoding: "utf8" });
  /** The template with one change, written to a file. */
  const mutated = (name: string, change: (parsed: Template) => void): string => {
    const parsed = template(readFileSync(TEMPLATE, "utf8"));
    change(parsed);
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify(parsed));
    return path;
  };
  const role = (parsed: Template) => (parsed.Resources.RovaraTestRole as { Properties: { AssumeRolePolicyDocument: { Statement: Json[] } } }).Properties;

  it("passes cfn-lint (errors and warnings, except the unknown-action warning the generated policies cause)", () => {
    const result = spawnSync(CFN_LINT as string, ["--ignore-checks", "W3037", "--", TEMPLATE], { encoding: "utf8" });
    expect(result.stdout + result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("passes every rule", () => {
    const result = guard(TEMPLATE);
    expect(result.stdout + result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  // Each rule must fail on the thing it is for (the passing run above shows they do not fail on nothing).
  type Change = (parsed: Template) => void;
  const statementOf = (parsed: Template, index: number): Record<string, unknown> => role(parsed).AssumeRolePolicyDocument.Statement[index] as Record<string, unknown>;
  const policyStatements = (parsed: Template, name: string): Json[] => (parsed.Resources[name] as { Properties: { PolicyDocument: { Statement: Json[] } } }).Properties.PolicyDocument.Statement;
  const cases: readonly { readonly when: string; readonly rule: string; readonly change: Change }[] = [
    { when: "the external id condition is missing", rule: "assume_role_requires_external_id", change: (p) => void delete statementOf(p, 0).Condition },
    { when: "the principal is a wildcard", rule: "trust_principal_is_the_rovara_parameter", change: (p) => void (statementOf(p, 0).Principal = { AWS: "*" }) },
    { when: "the principal is the whole of a service", rule: "trust_has_no_wildcard_principal", change: (p) => void (statementOf(p, 0).Principal = { Service: "lambda.amazonaws.com" }) },
    { when: "the principal is a bare star", rule: "trust_has_no_wildcard_principal", change: (p) => void (statementOf(p, 0).Principal = "*") },
    { when: "a trust statement allows another action", rule: "trust_policy_has_only_the_two_actions", change: (p) => void (statementOf(p, 1).Action = "sts:*") },
    { when: "the session may carry any tag", rule: "tag_session_only_with_the_run_tag", change: (p) => void delete statementOf(p, 1).Condition },
    { when: "the boundary is not attached", rule: "every_role_has_the_boundary", change: (p) => void delete (p.Resources.RovaraTestCleanupRole as { Properties: Record<string, unknown> }).Properties.PermissionsBoundary },
    { when: "an access key is created", rule: "no_long_lived_keys", change: (p) => void (p.Resources.Key = { Type: "AWS::IAM::AccessKey", Properties: { UserName: "x" } }) },
    { when: "an IAM user is created", rule: "no_long_lived_keys", change: (p) => void (p.Resources.User = { Type: "AWS::IAM::User", Properties: {} }) },
    { when: "a policy allows everything", rule: "no_allow_everything", change: (p) => void policyStatements(p, "RovaraTestPolicy").push({ Effect: "Allow", Action: "*", Resource: "*" }) },
    { when: "the boundary lets a session with no run tag act", rule: "the_boundary_requires_the_run_tag", change: (p) => void (policyStatements(p, "RovaraTestBoundary").length = 0) },
    { when: "the callback goes somewhere fixed", rule: "callback_goes_to_the_topic_parameter", change: (p) => void ((p.Resources.RovaraCallback as { Properties: Json }).Properties.ServiceToken = "arn:aws:sns:us-west-2:123456789012:other") },
    { when: "the boundary allows a service on every resource", rule: "boundary_allows_are_scoped", change: (p) => void policyStatements(p, "RovaraTestBoundary").push({ Sid: "AllowEverything", Effect: "Allow", Action: ["s3:*"], Resource: "*" }) },
    { when: "the boundary allows a service on a starred list", rule: "boundary_allows_are_scoped", change: (p) => void policyStatements(p, "RovaraTestBoundary").push({ Sid: "AllowEverything", Effect: "Allow", Action: ["kms:*"], Resource: ["*"] }) },
    { when: "reads are open to a role a run creates", rule: "boundary_reads_are_for_rovaras_roles_only", change: (p) => void delete (policyStatements(p, "RovaraTestBoundary").find((statement) => statement.Sid === "AllowReads") as { Condition?: unknown }).Condition },
    { when: "a whole service is allowed by tag for IAM", rule: "boundary_does_not_allow_a_whole_service_by_tag_for_iam_or_s3", change: (p) => void ((policyStatements(p, "RovaraTestBoundary").find((statement) => statement.Sid === "AllowRunTagged") as { Action: string[] }).Action.push("iam:*")) },
    { when: "a run may tag an existing resource with its own tag", rule: "boundary_has_no_tagging_by_request_tag", change: (p) => void policyStatements(p, "RovaraTestBoundary").push({ Sid: "AllowClaim", Effect: "Allow", Action: ["ssm:AddTagsToResource"], Resource: ["*"], Condition: { StringEquals: { "aws:RequestTag/rovara-run": "x" } } }) },
    { when: "the S3 fence forgets the account", rule: "boundary_s3_names_are_checked_against_the_account", change: (p) => void delete (policyStatements(p, "RovaraTestBoundary").find((statement) => statement.Sid === "AllowRunNamedS3") as { Condition?: unknown }).Condition },
    { when: "secret reads are not denied", rule: "boundary_denies_secret_reads_outside_the_run", change: (p) => void (p.Resources.RovaraTestBoundary as { Properties: { PolicyDocument: { Statement: Json[] } } }).Properties.PolicyDocument.Statement.splice(policyStatements(p, "RovaraTestBoundary").findIndex((statement) => statement.Sid === "DenySecretReadsOutsideRun"), 1) },
    { when: "any service may be passed a role", rule: "boundary_limits_pass_role", change: (p) => void delete (policyStatements(p, "RovaraTestBoundary").find((statement) => statement.Sid === "DenyPassRoleToOtherServices") as { Condition?: unknown }).Condition },
    { when: "a created role needs no run tag", rule: "boundary_fences_the_roles_a_run_creates", change: (p) => void (p.Resources.RovaraTestBoundary as { Properties: { PolicyDocument: { Statement: Json[] } } }).Properties.PolicyDocument.Statement.splice(policyStatements(p, "RovaraTestBoundary").findIndex((statement) => statement.Sid === "DenyRoleWithoutRunTag"), 1) },
    { when: "the run tag may be changed", rule: "boundary_keeps_the_run_tag_and_the_region", change: (p) => void (p.Resources.RovaraTestBoundary as { Properties: { PolicyDocument: { Statement: Json[] } } }).Properties.PolicyDocument.Statement.splice(policyStatements(p, "RovaraTestBoundary").findIndex((statement) => statement.Sid === "DenyRunTagChange"), 1) },
    { when: "the external id has no pattern", rule: "external_id_is_checked_by_pattern", change: (p) => void delete p.Parameters.ExternalId?.AllowedPattern },
  ];
  it.each(cases)("fails when $when", ({ rule, change }) => {
    const result = guard(mutated(rule, change));
    expect(result.status, result.stdout).not.toBe(0);
    expect(result.stdout).toContain(rule);
  });
});
