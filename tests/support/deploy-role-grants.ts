// IAM-SIZE-HEADROOM (0.5.18): the deploy role's effective grant set, as IAM receives it once the access stack is deployed with given parameter values: every statement of every inline
// policy the role carries plus every managed policy attached to it (AWS::IAM::ManagedPolicy with the role in Roles), whose resource condition holds. Each statement is split into
// (Effect, action, resource, condition) entries, so a statement that moves between policies, or is split or merged with one of the same Effect, Resource and Condition, gives the same set.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { defaultBoundaryArn, deployRoleBoundaryArn } from "../../infra/lib/access-policies.js";
import { evaluate, evaluateCondition, type CfnContext } from "./cfn-evaluate.js";

type Resource = { Type: string; Condition?: string; Properties: Record<string, unknown> };
export type AccessJson = { Conditions?: Record<string, unknown>; Resources: Record<string, Resource> };
type Statement = { Effect: string; Action?: string | string[]; Resource?: unknown; NotResource?: unknown; Condition?: unknown };

export const GRANT_ACCOUNT = "123456789012";
export const GRANT_REGION = "ap-southeast-2";

/** The hosted cloud's access stack with the Team record on, for this environment name. */
export function hostedAccessTemplate(env: string): AccessJson {
  const app = buildAgentXApp({ agentxEnv: env, agentxCloud: true, agentxTeamRecord: "enabled" });
  const found = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === `agentx-${env}-access`);
  if (found === undefined) throw new Error("no access stack");
  return Template.fromStack(found).toJSON() as AccessJson;
}

export function grantContext(json: AccessJson, env: string, parameters: { CustomDomainName: string; CustomDomainHostedZoneId: string }): CfnContext {
  const scope = { env, partition: "aws", account: GRANT_ACCOUNT };
  return {
    parameters: { ...parameters, PermissionsBoundaryArn: "", OperatorPrincipalArn: "", DefaultPermissionsBoundary: defaultBoundaryArn(scope), DeployRolePermissionsBoundary: deployRoleBoundaryArn(scope), CloudFormationServiceRole: "ref:CloudFormationServiceRole" },
    conditions: json.Conditions ?? {},
    pseudo: { "AWS::Region": GRANT_REGION, "AWS::AccountId": GRANT_ACCOUNT },
  };
}

/** A value with its object keys sorted and its arrays sorted, so two equal conditions print the same. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical).map((entry) => JSON.stringify(entry)).sort().map((entry) => JSON.parse(entry) as unknown);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
}

const list = (value: unknown): unknown[] => (value === undefined ? [] : [value].flat());
const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(canonical(value)));

/** The policies the deploy role holds for these parameters: its inline ones by name, and each attached managed policy (present under its condition) by logical id. */
export function deployRolePolicies(json: AccessJson, context: CfnContext): Array<{ name: string; statements: Statement[] }> {
  const role = json.Resources.CloudFormationServiceRole;
  if (role === undefined) throw new Error("no CloudFormationServiceRole");
  const statementsOf = (document: unknown) => list((evaluate(document, context) as { Statement?: unknown }).Statement).filter((entry) => entry !== undefined) as Statement[];
  const inline = ((role.Properties.Policies ?? []) as Array<{ PolicyName: string; PolicyDocument: unknown }>).map((policy) => ({ name: `inline ${policy.PolicyName}`, statements: statementsOf(policy.PolicyDocument) }));
  const managed = Object.entries(json.Resources)
    .filter(([, resource]) => resource.Type === "AWS::IAM::ManagedPolicy" && list(resource.Properties.Roles).some((entry) => (entry as { Ref?: string }).Ref === "CloudFormationServiceRole"))
    .filter(([, resource]) => resource.Condition === undefined || evaluateCondition(resource.Condition, context))
    .map(([id, resource]) => ({ name: id, statements: statementsOf(resource.Properties.PolicyDocument) }));
  return [...inline, ...managed];
}

/** The deploy role's grants as sorted "Effect action Resource|NotResource condition" lines. */
export function deployRoleGrants(json: AccessJson, env: string, parameters: { CustomDomainName: string; CustomDomainHostedZoneId: string }): string[] {
  const out = new Set<string>();
  for (const { statements } of deployRolePolicies(json, grantContext(json, env, parameters))) {
    for (const statement of statements) {
      const condition = statement.Condition === undefined ? "-" : text(statement.Condition);
      const targets = statement.NotResource !== undefined ? list(statement.NotResource).map((entry) => `NotResource=${text(entry)}`) : list(statement.Resource).map((entry) => text(entry));
      for (const action of list(statement.Action)) for (const target of targets) out.add(`${statement.Effect} ${String(action)} ${target} ${condition}`);
    }
  }
  return [...out].sort();
}

/** The cases the equivalence fixture was recorded for: the size test's two custom-domain cases, and no custom domain. */
export const GRANT_CASES = [
  { name: "a realistic name", env: "staging", parameters: { CustomDomainName: "staging.rovara.dev", CustomDomainHostedZoneId: "Z08286002FKUL2VBSO3MO" } },
  { name: "the longest environment, domain name and zone id", env: "a".repeat(20), parameters: { CustomDomainName: `${"d".repeat(50)}.example.com`, CustomDomainHostedZoneId: `Z${"A".repeat(31)}` } },
  { name: "no custom domain", env: "staging", parameters: { CustomDomainName: "", CustomDomainHostedZoneId: "" } },
] as const;
