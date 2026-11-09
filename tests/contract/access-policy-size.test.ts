// DEPLOY-POLICY-SIZE-CD: IAM caps the inline policies of a role at 10,240 characters in all and a managed policy at 6,144 (white space is not counted). The access stack with the custom domain ON
// (and the Team record on) was 10,431 for the deploy role, so a custom-domain switch-on would have failed the access deploy. This synthesizes the stack with both on, resolves every intrinsic the way CloudFormation
// does for the parameter values, and measures what IAM would measure.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { defaultBoundaryArn, serviceRoleStatements } from "../../infra/lib/access-policies.js";
import { evaluate, type CfnContext } from "../support/cfn-evaluate.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Condition?: string; Properties: Record<string, unknown> };
type Json = { Conditions: Record<string, unknown>; Resources: Record<string, Resource> };
const INLINE_ROLE_LIMIT = 10_240;
const MANAGED_POLICY_LIMIT = 6_144;
/** IAM does not count white space. */
const size = (document: unknown) => JSON.stringify(document).replace(/\s/gu, "").length;

function accessTemplate(env: string): Json {
  const app = buildAgentXApp({ agentxEnv: env, agentxCloud: true, agentxTeamRecord: "enabled" });
  const found = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === `agentx-${env}-access`);
  if (found === undefined) throw new Error("no access stack");
  return Template.fromStack(found).toJSON() as Json;
}

/** Every inline policy of every role, and every managed policy, as IAM receives them once the stack is deployed with these parameter values and no company boundary. */
function resolved(json: Json, env: string, parameters: { CustomDomainName: string; CustomDomainHostedZoneId: string }, companyBoundary = "") {
  const context: CfnContext = {
    parameters: { ...parameters, PermissionsBoundaryArn: companyBoundary, OperatorPrincipalArn: "", DefaultPermissionsBoundary: defaultBoundaryArn({ env, partition: "aws", account: "123456789012" }) },
    conditions: json.Conditions,
    pseudo: { "AWS::Region": "ap-southeast-2" },
  };
  const roles = Object.entries(json.Resources).filter(([, resource]) => resource.Type === "AWS::IAM::Role").map(([id, resource]) => ({
    id,
    policies: ((resource.Properties.Policies ?? []) as Array<{ PolicyName: string; PolicyDocument: unknown }>).map((policy) => ({ name: policy.PolicyName, document: evaluate(policy.PolicyDocument, context) })),
  }));
  const managed = Object.entries(json.Resources).filter(([, resource]) => resource.Type === "AWS::IAM::ManagedPolicy").map(([id, resource]) => ({ id, document: evaluate(resource.Properties.PolicyDocument, context) }));
  return { roles, managed };
}

const CASES = [
  { name: "a realistic name", env: "staging", parameters: { CustomDomainName: "staging.rovara.dev", CustomDomainHostedZoneId: "Z08286002FKUL2VBSO3MO" } },
  // The longest everything: a 20-character environment, a 64-character domain name (the parameter's maxLength), a 32-character hosted zone id (the pattern's most), the longest regular region name.
  { name: "the longest environment, domain name and zone id", env: "a".repeat(20), parameters: { CustomDomainName: `${"d".repeat(50)}.example.com`, CustomDomainHostedZoneId: `Z${"A".repeat(31)}` } },
];

describe("the access stack with the custom domain and the Team record on stays within IAM's policy size limits", () => {
  for (const { name, env, parameters } of CASES) {
    const json = accessTemplate(env);
    const { roles, managed } = resolved(json, env, parameters);

    it(`${name}: the deploy role's inline policies are under 10,240 characters in all (and each one is)`, () => {
      const deploy = roles.find((role) => role.id === "CloudFormationServiceRole")!;
      expect(deploy.policies.map((policy) => policy.name)).toContain("deploy");
      // The custom domain's grants are really in the document being measured.
      expect(JSON.stringify(deploy.policies)).toContain("acm:RequestCertificate");
      expect(JSON.stringify(deploy.policies)).toContain(parameters.CustomDomainHostedZoneId);
      expect(deploy.policies.reduce((total, policy) => total + size(policy.document), 0), "all inline policies of the deploy role").toBeLessThan(INLINE_ROLE_LIMIT);
    });

    it(`${name}: every role's inline policies (all of them, in all) are under 10,240 characters`, () => {
      expect(roles.length).toBeGreaterThanOrEqual(2);
      for (const role of roles) {
        for (const policy of role.policies) expect(size(policy.document), `${role.id} / ${policy.name}`).toBeLessThan(INLINE_ROLE_LIMIT);
        expect(role.policies.reduce((total, policy) => total + size(policy.document), 0), `${role.id}, in all`).toBeLessThan(INLINE_ROLE_LIMIT);
      }
    });

    it(`${name}: the default boundary is under 6,144 characters`, () => {
      const boundary = managed.find((policy) => policy.id === "DefaultPermissionsBoundary")!;
      expect(size(boundary.document)).toBeLessThan(MANAGED_POLICY_LIMIT);
    });
  }
});

describe("the trimming of the deploy policy changed no allowance", () => {
  const scope = { env: "staging", partition: "aws", region: "us-east-1", account: "123456789012", artifactBucketArn: "x", pullThroughPrefix: "x", cloudFormationRoleName: "x" };
  const statements = serviceRoleStatements({ ...scope, customDomain: { domainName: "staging.rovara.dev", hostedZoneId: "Z08286002FKUL2VBSO3MO" } });

  it("iam:PassRole is allowed on exactly the roles it was (the environment's roles and the saved-environment creation role), unconditionally, in IamRoles", () => {
    const passing = statements.filter((statement) => statement.Effect === "Allow" && statement.Action.includes("iam:PassRole"));
    expect(passing.map((statement) => statement.Sid)).toEqual(["IamRoles"]);
    const roles = passing[0]!;
    expect(roles.Condition).toBeUndefined();
    expect(roles.Resource).toEqual(["arn:aws:iam::123456789012:role/agentx/staging/*", "arn:aws:iam::123456789012:role/agentx-staging-img-create"]);
    // The same two resources the boundary Deny statements name: nothing was widened.
    expect(statements.find((statement) => statement.Sid === "IamKeepBoundary")!.Resource).toEqual(roles.Resource);
    expect(statements.some((statement) => statement.Sid === "PassRoles")).toBe(false);
  });
});

describe("with a company's own permissions boundary", () => {
  // The boundary's ARN appears twice in the deploy policy (IamRequireBoundary's condition and IamKeepBoundaryPolicy's resource), so a long one costs twice its length. The worst case above has 117 characters
  // to spare with the default boundary (DEFERRED-CHECKS, DEPLOY-POLICY-SIZE-CD): a company boundary ARN more than about 58 characters longer than the default, with the longest environment AND domain, would not fit.
  it("a realistic one (100 characters) fits with a realistic name, and with the longest environment, domain name and zone id", () => {
    const boundary = `arn:aws:iam::123456789012:policy/${"c".repeat(100 - "arn:aws:iam::123456789012:policy/".length)}`;
    expect(boundary).toHaveLength(100);
    for (const { env, parameters } of CASES) {
      const { roles } = resolved(accessTemplate(env), env, parameters, boundary);
      const deploy = roles.find((role) => role.id === "CloudFormationServiceRole")!;
      expect(JSON.stringify(deploy.policies)).toContain(boundary);
      expect(deploy.policies.reduce((total, policy) => total + size(policy.document), 0), env).toBeLessThan(INLINE_ROLE_LIMIT);
    }
  });
});
