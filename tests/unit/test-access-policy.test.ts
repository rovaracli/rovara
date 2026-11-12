import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEST_ACCESS_SERVICES,
  IAM_MANAGED_POLICY_MAX_CHARS,
  RUN_NAME_PATTERN,
  RUN_TAG_VARIABLE,
  buildTestAccessPolicies,
  buildTrustPolicy,
  chunkStatements,
  cloudFormationPolicy,
  compressActions,
  policySize,
  renderPolicyTokens,
  terraformPolicyTemplate,
  type PolicyDocument,
  type PolicyStatement,
} from "../../packages/cloud-contracts/src/test-access-policy.js";
import { scopedActionsOf } from "../../packages/cloud-contracts/src/test-access-scoping.js";

const policies = buildTestAccessPolicies();
const statement = (document: PolicyDocument, sid: string): PolicyStatement => {
  const found = document.Statement.find((candidate) => candidate.Sid === sid);
  if (found === undefined) throw new Error(`no statement ${sid}`);
  return found;
};
const allStatements = (documents: readonly PolicyDocument[]): PolicyStatement[] => documents.flatMap((document) => [...document.Statement]);
/** IAM's matching of an action pattern: `*` and `?` only. */
const matches = (pattern: string, action: string): boolean => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".")}$`, "iu").test(action);
const covered = (patterns: readonly string[], service: string, action: string): boolean => patterns.some((pattern) => matches(pattern, `${service}:${action}`));

describe("sizes", () => {
  it("keeps every managed policy and the boundary under IAM's limit", () => {
    for (const document of [policies.boundary, policies.access, policies.cleanup, ...policies.guards, ...policies.cleanupGuards]) {
      expect(policySize(document)).toBeLessThanOrEqual(IAM_MANAGED_POLICY_MAX_CHARS);
    }
  });
  it("keeps the number of managed policies on a role under IAM's default of 10 (the boundary is not counted)", () => {
    expect(1 + policies.guards.length).toBeLessThanOrEqual(10);
    expect(1 + policies.cleanupGuards.length).toBeLessThanOrEqual(10);
  });
  it("splits an over-long statement without losing an action (positive control: it does split)", () => {
    const actions = Array.from({ length: 400 }, (_, index) => `svc:Action${String(index).padStart(4, "0")}`);
    const chunks = chunkStatements([{ Sid: "Big", Effect: "Deny", Action: actions, Resource: "*" }], 2_000);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.flatMap((chunk) => chunk.Statement.flatMap((entry) => entry.Action ?? []))).toEqual(actions);
    for (const chunk of chunks) expect(policySize(chunk)).toBeLessThanOrEqual(2_000);
  });
});

describe("the boundary", () => {
  it("allows the default services and nothing else (no 'deny the expensive ones' list: owner decision 121)", () => {
    const allow = statement(policies.boundary, "AllowTestServices");
    expect(allow.Effect).toBe("Allow");
    for (const service of DEFAULT_TEST_ACCESS_SERVICES) expect(allow.Action).toContain(`${service}:*`);
    expect(allow.Action).not.toContain("sts:*");
    expect(allow.Action).toContain("sts:GetCallerIdentity");
    expect(JSON.stringify(allow)).not.toMatch(/sagemaker|redshift|emr/u);
    // every deny is about the run's tag, the Region, IAM or keys: none names a service as a cost measure
    const denied = allStatements([policies.boundary, ...policies.guards]).filter((entry) => entry.Effect === "Deny");
    expect(JSON.stringify(denied)).not.toMatch(/sagemaker|redshift|emr:|ec2:RunInstances|rds:Create/u);
  });

  it("refuses everything for a session with no run tag, and keeps to one Region", () => {
    expect(statement(policies.boundary, "DenyWithoutRunTag")).toMatchObject({ Effect: "Deny", NotAction: ["sts:GetCallerIdentity"], Condition: { Null: { "aws:PrincipalTag/rovara-run": "true" } } });
    const region = statement(policies.boundary, "DenyOtherRegions");
    expect(region.Condition).toEqual({ StringNotEquals: { "aws:RequestedRegion": "{{Region}}" } });
    expect(region.NotAction).toEqual(expect.arrayContaining(["iam:*"]));
  });

  it("refuses any request that sets, changes or removes the run tag with another value", () => {
    expect(statement(policies.boundary, "DenyRunTagChange")).toMatchObject({
      Effect: "Deny",
      Action: ["*"],
      Condition: { "ForAnyValue:StringEquals": { "aws:TagKeys": "rovara-run" }, StringNotEquals: { "aws:RequestTag/rovara-run": RUN_TAG_VARIABLE } },
    });
  });

  it("limits IAM to run-named roles with the boundary, and refuses long-lived keys and removing the boundary", () => {
    const names = statement(policies.boundary, "DenyIamOutsideRunNames");
    expect(names.NotResource).toEqual([
      `arn:{{Partition}}:iam::{{AccountId}}:instance-profile/${RUN_NAME_PATTERN}`,
      `arn:{{Partition}}:iam::{{AccountId}}:policy/${RUN_NAME_PATTERN}`,
      `arn:{{Partition}}:iam::{{AccountId}}:role/${RUN_NAME_PATTERN}`,
    ]);
    for (const action of ["CreateRole", "PassRole", "AttachRolePolicy", "PutRolePolicy", "UpdateAssumeRolePolicy", "DeleteRole", "TagRole"]) expect(covered(names.Action ?? [], "iam", action), action).toBe(true);
    for (const action of ["GetRole", "ListRoles", "GetPolicy"]) expect(covered(names.Action ?? [], "iam", action), action).toBe(false);
    expect(statement(policies.boundary, "DenyRoleWithoutBoundary")).toMatchObject({ Action: ["iam:CreateRole", "iam:PutRolePermissionsBoundary"], Condition: { StringNotEquals: { "iam:PermissionsBoundary": "{{BoundaryArn}}" } } });
    expect(statement(policies.boundary, "DenyBoundaryRemoval").Action).toContain("iam:DeleteRolePermissionsBoundary");
    expect(statement(policies.boundary, "DenyLongLivedKeys").Action).toEqual(expect.arrayContaining(["iam:CreateAccessKey", "iam:CreateUser", "iam:CreateLoginProfile"]));
  });

  it("has no IAM statements when IAM is not a service of the connection", () => {
    const withoutIam = buildTestAccessPolicies(["sqs"]);
    expect(withoutIam.boundary.Statement.map((entry) => entry.Sid)).toEqual(["AllowTestServices", "DenyWithoutRunTag", "DenyOtherRegions", "DenyRunTagChange"]);
  });
});

describe("the per-action guards agree with the scoping table", () => {
  const services = [...DEFAULT_TEST_ACCESS_SERVICES];
  const guards = allStatements(policies.guards);
  const patternsOf = (sid: string): string[] => guards.filter((entry) => entry.Sid.startsWith(sid)).flatMap((entry) => [...(entry.Action ?? [])]);

  it("denies a create without the run tag exactly for the create actions the table scopes by tag", () => {
    const patterns = patternsOf("DenyCreateWithoutRunTag");
    for (const service of services) {
      for (const action of scopedActionsOf(service)) {
        const expected = action.kind === "create" && action.guard === "tag";
        expect(covered(patterns, service, action.action), `${service}:${action.action}`).toBe(expected);
      }
    }
    for (const entry of guards.filter((candidate) => candidate.Sid.startsWith("DenyCreateWithoutRunTag"))) expect(entry.Condition).toEqual({ StringNotEquals: { "aws:RequestTag/rovara-run": RUN_TAG_VARIABLE } });
  });

  it("denies a change to a resource without the run's tag exactly for the write, delete and permission actions scoped by tag", () => {
    const patterns = patternsOf("DenyChangesToOtherResources");
    for (const service of services) {
      for (const action of scopedActionsOf(service)) {
        const expected = ["write", "delete", "permissions"].includes(action.kind) && action.guard === "tag";
        expect(covered(patterns, service, action.action), `${service}:${action.action}`).toBe(expected);
      }
    }
    for (const entry of guards.filter((candidate) => candidate.Sid.startsWith("DenyChangesToOtherResources"))) expect(entry.Condition).toEqual({ StringNotEquals: { "aws:ResourceTag/rovara-run": RUN_TAG_VARIABLE } });
  });

  it("keeps an action IAM cannot tag-scope out of the tag guards, so a run can still use its own resource (positive control: S3 objects)", () => {
    expect(covered(patternsOf("DenyChangesToOtherResources"), "s3", "PutObject")).toBe(false);
    expect(covered(patternsOf("DenyChangesOutsideRunNames"), "s3", "PutObject")).toBe(true);
    const named = guards.filter((entry) => entry.Sid.startsWith("DenyChangesOutsideRunNames"));
    expect(named.length).toBeGreaterThan(0);
    for (const entry of named) expect(entry.NotResource).toContain(`arn:{{Partition}}:s3:::${RUN_NAME_PATTERN}/*`);
  });

  it("does not confine an action by name where it already has the run tag, nor guard a signer-only action at all", () => {
    const named = patternsOf("DenyChangesOutsideRunNames");
    const tagged = [...patternsOf("DenyChangesToOtherResources"), ...patternsOf("DenyCreateWithoutRunTag")];
    for (const service of services.filter((candidate) => candidate !== "iam")) {
      for (const action of scopedActionsOf(service).filter((candidate) => candidate.guard === "signer")) {
        expect(covered(named, service, action.action) || covered(tagged, service, action.action), `${service}:${action.action}`).toBe(false);
      }
    }
  });

  it("refuses to tag another run's resources", () => {
    const tagging = guards.filter((entry) => entry.Sid.startsWith("DenyTaggingOtherRuns"));
    expect(tagging.length).toBeGreaterThan(0);
    expect(tagging[0]?.Condition).toEqual({ Null: { "aws:ResourceTag/rovara-run": "false" }, StringNotEquals: { "aws:ResourceTag/rovara-run": RUN_TAG_VARIABLE } });
    expect(covered(patternsOf("DenyTaggingOtherRuns"), "sqs", "TagQueue")).toBe(true);
  });

  it("gives the cleanup role reads and deletes only, and only the delete-side guards", () => {
    const allow = statement(policies.cleanup, "AllowReadAndDelete");
    expect(allow.Action).toEqual(expect.arrayContaining(["sqs:DeleteQueue", "sqs:Get*", "s3:DeleteBucket"]));
    expect(allow.Action).not.toContain("sqs:CreateQueue");
    expect(allow.Action).not.toContain("sqs:SendMessage");
    const namedLikeReads = allStatements(policies.cleanupGuards).filter((entry) => entry.Sid.startsWith("DenyChangesNamedLikeReads")).flatMap((entry) => [...(entry.Action ?? [])]);
    expect(covered(namedLikeReads, "states", "GetActivityTask")).toBe(true);
    for (const service of services) {
      for (const action of scopedActionsOf(service).filter((candidate) => candidate.kind !== "delete")) {
        const allowed = covered(allow.Action ?? [], service, action.action) && !covered(namedLikeReads, service, action.action);
        expect(allowed, `${service}:${action.action}`).toBe(false);
      }
    }
    const cleanupGuards = allStatements(policies.cleanupGuards);
    expect(cleanupGuards.some((entry) => entry.Sid.startsWith("DenyCreateWithoutRunTag"))).toBe(false);
    expect(cleanupGuards.some((entry) => entry.Sid.startsWith("DenyChangesToOtherResources"))).toBe(true);
  });
});

describe("compressActions", () => {
  it("replaces three or more actions of a safe verb with the verb and a star, when no other changing action starts with it", () => {
    expect(compressActions("x", ["DeleteA", "DeleteB", "DeleteC"], ["DeleteA", "DeleteB", "DeleteC", "PutD"])).toEqual(["x:Delete*"]);
  });
  it("keeps exact names when a changing action outside the set starts with the verb, or the verb is not a write verb, or there are fewer than three", () => {
    expect(compressActions("x", ["DeleteA", "DeleteB", "DeleteC"], ["DeleteA", "DeleteB", "DeleteC", "DeleteD"])).toEqual(["x:DeleteA", "x:DeleteB", "x:DeleteC"]);
    expect(compressActions("x", ["StartA", "StartB", "StartC"], ["StartA", "StartB", "StartC"])).toEqual(["x:StartA", "x:StartB", "x:StartC"]);
    expect(compressActions("x", ["DeleteA", "DeleteB"], ["DeleteA", "DeleteB"])).toEqual(["x:DeleteA", "x:DeleteB"]);
  });
});

describe("rendering", () => {
  it("writes a CloudFormation policy: a string with a token is an Fn::Sub, and IAM's own variables are escaped", () => {
    const rendered = JSON.stringify(cloudFormationPolicy(policies.boundary));
    expect(rendered).toContain('{"Fn::Sub":"${AWS::Region}"}');
    expect(rendered).toContain("${!aws:PrincipalTag/rovara-run}");
    expect(rendered).toContain("arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/rovara-test-boundary-${ExternalId}");
    expect(rendered).not.toMatch(/\{\{[A-Za-z]+\}\}/u);
    // a string with no token stays a string (so the template is readable)
    expect(JSON.stringify(cloudFormationPolicy(policies.access))).not.toContain("Fn::Sub");
  });

  it("writes a Terraform template: tokens become variables, IAM's variables are escaped with a second dollar", () => {
    const text = terraformPolicyTemplate(policies.boundary);
    expect(text).toContain('"${region}"');
    expect(text).toContain("$${aws:PrincipalTag/rovara-run}");
    expect(text).not.toMatch(/(?<!\$)\$\{aws:/u);
    expect(text).toContain("rovara-test-boundary-${external_id}");
    expect(text).not.toMatch(/\{\{[A-Za-z]+\}\}/u);
  });

  it("fills the tokens for the copy-paste text and keeps IAM's variables", () => {
    const text = JSON.stringify(renderPolicyTokens(policies.boundary, { Partition: "aws", Region: "us-west-2", AccountId: "123456789012", BoundaryArn: "arn:aws:iam::123456789012:policy/b" }));
    expect(text).toContain('"aws:RequestedRegion":"us-west-2"');
    expect(text).toContain("arn:aws:iam::123456789012:role/rv-${aws:PrincipalTag/rovara-run}-*");
    expect(text).not.toMatch(/\{\{/u);
  });
});

describe("the trust policy", () => {
  const trust = buildTrustPolicy({ principalArn: "arn:aws:iam::111111111111:role/rovara-broker", externalId: "rovara-org_aaaaaaaaaaaaaaaaaaaa-conn_bbbbbbbbbbbbbbbbbbbb" });
  it("trusts one named role, and only with the external id", () => {
    const assume = trust.Statement.find((entry) => entry.Action === "sts:AssumeRole");
    expect(assume).toMatchObject({ Principal: { AWS: "arn:aws:iam::111111111111:role/rovara-broker" }, Condition: { StringEquals: { "sts:ExternalId": "rovara-org_aaaaaaaaaaaaaaaaaaaa-conn_bbbbbbbbbbbbbbbbbbbb" } } });
    expect(JSON.stringify(trust)).not.toContain('"*"');
  });
  it("lets the session carry the run tag (8 characters) and no other tag", () => {
    const tag = trust.Statement.find((entry) => entry.Action === "sts:TagSession");
    expect(tag?.Condition).toEqual({ "ForAllValues:StringEquals": { "aws:TagKeys": ["rovara-run"] }, StringLike: { "aws:RequestTag/rovara-run": "????????" } });
  });
});
