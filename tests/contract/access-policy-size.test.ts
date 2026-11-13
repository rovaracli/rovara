// DEPLOY-POLICY-SIZE-CD: IAM caps the inline policies of a role at 10,240 characters in all and a managed policy at 6,144 (white space is not counted). The access stack with the custom domain ON
// (and the Team record on) was 10,431 for the deploy role, so a custom-domain switch-on would have failed the access deploy. This synthesizes the stack with both on, resolves every intrinsic the way CloudFormation
// does for the parameter values, and measures what IAM would measure.
// IAM-SIZE-HEADROOM (0.5.18): the hard limits only fail AT the cap, mid-release. Each policy also has a budget of 85% of its limit (8,704 for a role's inline policies, 5,222 for a managed policy), so a
// release that eats the headroom fails here first, and every run prints the measured sizes.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { defaultBoundaryArn, deployRoleBoundaryArn, serviceRoleStatements } from "../../infra/lib/access-policies.js";
import { MODEL_PROXY_TLS_CONTEXT_KEYS as T, MODEL_PROXY_TLS_PREVIOUS_CONTEXT_KEYS as P } from "../../infra/lib/model-proxy-tls.js";
import { evaluate, evaluateCondition, type CfnContext } from "../support/cfn-evaluate.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Condition?: string; Properties: Record<string, unknown> };
type Json = { Conditions: Record<string, unknown>; Resources: Record<string, Resource> };
const INLINE_ROLE_LIMIT = 10_240;
const MANAGED_POLICY_LIMIT = 6_144;
/** 85% of each limit: the early warning. */
const INLINE_ROLE_BUDGET = 8_704;
const MANAGED_POLICY_BUDGET = 5_222;
/**
 * The policies that cannot be brought under their budget in the worst case without allowing something new or dropping a statement (IAM-SIZE-HEADROOM, 0.5.18, DEFERRED-CHECKS IAM-SIZE-BOUNDARY-85): both
 * boundaries were 5,969 and 5,971 for a 20-character environment; compacting them without widening (exact action patterns, the two Denies on "*" merged) took them to the numbers below. A boundary cannot be split
 * (a role has one). Until that row is closed, each is held to its measured worst case instead of the budget, so it still cannot grow by a character unnoticed; the test below fails once one is back under
 * budget, so its entry is removed then.
 */
const OVER_BUDGET_CEILINGS: Record<string, number> = { DefaultPermissionsBoundary: 5_663, DeployRolePermissionsBoundary: 5_627 };
/** Rovara's own AWS Organization id at its longest (agentxRovaraOrgId): the default boundary's AssumeOrgRoles statement names it when set. */
const LONGEST_ORG_ID = `o-${"a".repeat(32)}`;
/** IAM does not count white space. */
const size = (document: unknown) => JSON.stringify(document).replace(/\s/gu, "").length;

function accessTemplate(env: string, context: Record<string, unknown> = {}): Json {
  const app = buildAgentXApp({ agentxEnv: env, agentxCloud: true, agentxTeamRecord: "enabled", ...context });
  const found = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === `agentx-${env}-access`);
  if (found === undefined) throw new Error("no access stack");
  return Template.fromStack(found).toJSON() as Json;
}

/** Every inline policy of every role, and every managed policy that exists for these values, as IAM receives them once the stack is deployed with these parameter values. */
function resolved(json: Json, env: string, parameters: { CustomDomainName: string; CustomDomainHostedZoneId: string }, companyBoundary = "") {
  const context: CfnContext = {
    parameters: { ...parameters, PermissionsBoundaryArn: companyBoundary, OperatorPrincipalArn: "", DefaultPermissionsBoundary: defaultBoundaryArn({ env, partition: "aws", account: "123456789012" }), DeployRolePermissionsBoundary: deployRoleBoundaryArn({ env, partition: "aws", account: "123456789012" }), CloudFormationServiceRole: "ref:CloudFormationServiceRole" },
    conditions: json.Conditions,
    pseudo: { "AWS::Region": "ap-southeast-2" },
  };
  const roles = Object.entries(json.Resources).filter(([, resource]) => resource.Type === "AWS::IAM::Role").map(([id, resource]) => ({
    id,
    policies: ((resource.Properties.Policies ?? []) as Array<{ PolicyName: string; PolicyDocument: unknown }>).map((policy) => ({ name: policy.PolicyName, document: evaluate(policy.PolicyDocument, context) })),
  }));
  const managed = Object.entries(json.Resources)
    .filter(([, resource]) => resource.Type === "AWS::IAM::ManagedPolicy" && (resource.Condition === undefined || evaluateCondition(resource.Condition, context)))
    .map(([id, resource]) => ({ id, document: evaluate(resource.Properties.PolicyDocument, context) }));
  return { roles, managed };
}

const NO_DOMAIN = { CustomDomainName: "", CustomDomainHostedZoneId: "" };
const CASES = [
  { name: "a realistic name", env: "staging", parameters: { CustomDomainName: "staging.rovara.dev", CustomDomainHostedZoneId: "Z08286002FKUL2VBSO3MO" } },
  // The longest everything: a 20-character environment, a 64-character domain name (the parameter's maxLength), a 32-character hosted zone id (the pattern's most), the longest regular region name.
  { name: "the longest environment, domain name and zone id", env: "a".repeat(20), parameters: { CustomDomainName: `${"d".repeat(50)}.example.com`, CustomDomainHostedZoneId: `Z${"A".repeat(31)}` } },
];

describe("the access stack with the custom domain and the Team record on stays within IAM's policy size limits", () => {
  for (const { name, env, parameters } of CASES) {
    const json = accessTemplate(env);
    const { roles, managed } = resolved(json, env, parameters);

    it(`${name}: the deploy role's inline policies are under 10,240 characters in all (and each one is); the custom domain's grants are in their own managed policy, under 6,144`, () => {
      const deploy = roles.find((role) => role.id === "CloudFormationServiceRole")!;
      expect(deploy.policies.map((policy) => policy.name)).toContain("deploy");
      expect(deploy.policies.reduce((total, policy) => total + size(policy.document), 0), "all inline policies of the deploy role").toBeLessThan(INLINE_ROLE_LIMIT);
      // IAM-SIZE-HEADROOM: the custom domain's grants left the inline policy for CustomDomainDeployPolicy, and they really are in the document measured there.
      expect(JSON.stringify(deploy.policies)).not.toContain("acm:");
      const domain = managed.find((policy) => policy.id === "CustomDomainDeployPolicy")!;
      expect(JSON.stringify(domain.document)).toContain("acm:RequestCertificate");
      expect(JSON.stringify(domain.document)).toContain(parameters.CustomDomainHostedZoneId);
      expect(size(domain.document), "CustomDomainDeployPolicy").toBeLessThan(MANAGED_POLICY_LIMIT);
    });

    it(`${name}: every role's inline policies (all of them, in all) are under 10,240 characters`, () => {
      expect(roles.length).toBeGreaterThanOrEqual(2);
      for (const role of roles) {
        for (const policy of role.policies) expect(size(policy.document), `${role.id} / ${policy.name}`).toBeLessThan(INLINE_ROLE_LIMIT);
        expect(role.policies.reduce((total, policy) => total + size(policy.document), 0), `${role.id}, in all`).toBeLessThan(INLINE_ROLE_LIMIT);
      }
    });

    it(`${name}: the default boundary and the deploy role's own boundary (0.5.17) are each under 6,144 characters`, () => {
      for (const id of ["DefaultPermissionsBoundary", "DeployRolePermissionsBoundary"]) {
        const boundary = managed.find((policy) => policy.id === id)!;
        expect(size(boundary.document), id).toBeLessThan(MANAGED_POLICY_LIMIT);
      }
    });
  }
});

/** Prints the sizes and checks each against its 85% budget, naming the policy and what to do about it. */
function checkBudgets(label: string, measured: ReturnType<typeof resolved>) {
  const lines: string[] = [];
  const over: string[] = [];
  for (const role of measured.roles) {
    const total = role.policies.reduce((sum, policy) => sum + size(policy.document), 0);
    for (const policy of role.policies) {
      lines.push(`  ${role.id} inline ${policy.name}: ${size(policy.document)} / ${INLINE_ROLE_LIMIT}`);
      if (size(policy.document) >= INLINE_ROLE_BUDGET) over.push(`${role.id} inline policy ${policy.name} is ${size(policy.document)} characters, over the ${INLINE_ROLE_BUDGET} budget (85% of ${INLINE_ROLE_LIMIT}): compact it, or move a group of its statements into a managed policy attached to ${role.id} (as CustomDomainDeployPolicy)`);
    }
    lines.push(`  ${role.id} inline total: ${total} / ${INLINE_ROLE_LIMIT} (${Math.round((total / INLINE_ROLE_LIMIT) * 100)}%)`);
    if (total >= INLINE_ROLE_BUDGET) over.push(`${role.id}'s inline policies are ${total} characters in all, over the ${INLINE_ROLE_BUDGET} budget (85% of ${INLINE_ROLE_LIMIT}): move a group of statements into a managed policy attached to ${role.id} (as CustomDomainDeployPolicy), or compact them`);
  }
  for (const policy of measured.managed) {
    const measuredSize = size(policy.document);
    lines.push(`  managed ${policy.id}: ${measuredSize} / ${MANAGED_POLICY_LIMIT} (${Math.round((measuredSize / MANAGED_POLICY_LIMIT) * 100)}%)`);
    const ceiling = OVER_BUDGET_CEILINGS[policy.id];
    if (ceiling !== undefined) {
      lines.push(`    (held to its recorded worst case ${ceiling}, over the ${MANAGED_POLICY_BUDGET} budget: DEFERRED-CHECKS IAM-SIZE-BOUNDARY-85)`);
      if (measuredSize > ceiling) over.push(`managed policy ${policy.id} is ${measuredSize} characters, over its recorded worst case ${ceiling} (it is already over the ${MANAGED_POLICY_BUDGET} budget, 85% of ${MANAGED_POLICY_LIMIT}): compact it without widening before adding to it`);
    } else if (measuredSize >= MANAGED_POLICY_BUDGET) {
      const fix = policy.id.endsWith("PermissionsBoundary")
        ? "a boundary cannot be split (a role has one): compact it without widening (merge statements of the same Effect, Resource and Condition, or patterns pinned against AWS's action list)"
        : "split its statements into a second managed policy attached to the same role, or compact them";
      over.push(`managed policy ${policy.id} is ${measuredSize} characters, over the ${MANAGED_POLICY_BUDGET} budget (85% of ${MANAGED_POLICY_LIMIT}): ${fix}`);
    }
  }
  console.log(`IAM policy sizes, ${label}:\n${lines.join("\n")}`);
  return over;
}

describe("every access-stack policy stays under 85% of IAM's limit (the early warning), worst cases included", () => {
  const budgetCases = [
    CASES[0]!,
    // The longest cases also carry the longest organization id.
    { ...CASES[1]!, name: `${CASES[1]!.name}, and the longest organization id` },
    { name: "no custom domain (a realistic name)", env: "staging", parameters: NO_DOMAIN },
    { name: "no custom domain (the longest environment and organization id)", env: "a".repeat(20), parameters: NO_DOMAIN },
  ];
  for (const { name, env, parameters } of budgetCases) {
    it(`${name}: every role's inline policies, each and in all, under ${INLINE_ROLE_BUDGET}; every managed policy, both boundaries included, under ${MANAGED_POLICY_BUDGET}`, () => {
      const measured = resolved(accessTemplate(env, env === "staging" ? {} : { agentxRovaraOrgId: LONGEST_ORG_ID }), env, parameters);
      const over = checkBudgets(name, measured);
      // Positive control: the policies the budget is about were measured.
      expect(measured.managed.map((policy) => policy.id)).toEqual(expect.arrayContaining(["DefaultPermissionsBoundary", "DeployRolePermissionsBoundary", ...(parameters.CustomDomainName === "" ? [] : ["CustomDomainDeployPolicy"])]));
      if (parameters.CustomDomainName === "") expect(measured.managed.map((policy) => policy.id)).not.toContain("CustomDomainDeployPolicy");
      expect(over).toEqual([]);
    }, 120_000);
  }

  it("the model proxy's TLS grants (ModelProxyTlsDeployPolicy) at their longest: a requested certificate for a 64-character name, and the clean-up grants for a previous one", () => {
    const env = "a".repeat(20);
    const longName = (first: string) => `${first.repeat(52)}.example.com`;
    const json = accessTemplate(env, {
      agentxRegion: "us-west-2", agentxRovaraOrgId: LONGEST_ORG_ID,
      [T.name]: longName("m"), [T.zoneId]: `Z${"B".repeat(31)}`, [T.legacyHttp]: "keep",
      [P.name]: longName("o"), [P.zoneId]: `Z${"C".repeat(31)}`, [P.certificate]: "requested",
    });
    const measured = resolved(json, env, NO_DOMAIN);
    expect(measured.managed.map((policy) => policy.id)).toContain("ModelProxyTlsDeployPolicy");
    expect(checkBudgets("model proxy TLS at its longest", measured)).toEqual([]);
  }, 120_000);
});

describe("the recorded over-budget ceilings are still needed (IAM-SIZE-BOUNDARY-85)", () => {
  it("each policy held to a recorded worst case is still over the 85% budget in that worst case, at exactly that number", () => {
    const env = "a".repeat(20);
    const { managed } = resolved(accessTemplate(env, { agentxRovaraOrgId: LONGEST_ORG_ID }), env, CASES[1]!.parameters);
    for (const [id, ceiling] of Object.entries(OVER_BUDGET_CEILINGS)) {
      const measured = size(managed.find((policy) => policy.id === id)!.document);
      expect(measured, `${id} is back under the budget: remove it from OVER_BUDGET_CEILINGS and close IAM-SIZE-BOUNDARY-85`).toBeGreaterThanOrEqual(MANAGED_POLICY_BUDGET);
      expect(measured, `${id}: lower its recorded ceiling to what it measures now`).toBe(ceiling);
    }
  }, 120_000);
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
  // The boundary's ARN appears twice in the deploy policy (IamRequireBoundary's condition and IamKeepBoundaryPolicy's resource), so a long one costs twice its length.
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
