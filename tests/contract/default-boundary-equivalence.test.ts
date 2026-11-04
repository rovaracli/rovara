// 2026-11-03 (boundary tightened to make room, no new permission): the default boundary of v0.5.2, frozen as a fixture, and today's, must permit exactly the same (action, resource) pairs.
// The fixture (tests/fixtures/default-boundary-v0.5.2.json) is `defaultBoundaryStatements` as v0.5.2 built it, for two scopes. The check is a plain matcher, not IAM's simulator:
//  - statements with a Condition are compared as they are (they are untouched; the matcher cannot evaluate a condition);
//  - the others are evaluated for every action (all 190 IAM actions in tests/fixtures/iam-actions-2026-11-03.json, from AWS's service authorization reference, every action either boundary
//    names, and a few sample actions of other services) on every resource (each ARN either boundary names, with wildcards filled in, plus near misses): a matching Deny refuses, else a matching Allow permits.
// If a later change to the boundary is meant to differ, update the fixture's expectations in the same change and say why; this test exists so a size cut never widens (or narrows) it by accident.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultBoundaryStatements, type PolicyScope, type PolicyStatementJson } from "../../infra/lib/access-policies.js";

type Fixture = Record<string, { scope: Pick<PolicyScope, "env" | "partition" | "region" | "account" | "cloudFormationRoleName" | "rovaraOrganizationId">; statements: PolicyStatementJson[] }>;
const fixture = JSON.parse(readFileSync(new URL("../fixtures/default-boundary-v0.5.2.json", import.meta.url), "utf8")) as Fixture;
const iamActions = (JSON.parse(readFileSync(new URL("../fixtures/iam-actions-2026-11-03.json", import.meta.url), "utf8")) as { actions: string[] }).actions;

const list = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const regExp = (pattern: string, flags: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, flags);
const actionMatches = (pattern: string, action: string) => regExp(pattern, "i").test(action);
const resourceMatches = (pattern: string, resource: string) => regExp(pattern, "").test(resource);

function covers(statement: PolicyStatementJson, action: string, resource: string): boolean {
  if (!list(statement.Action).some((pattern) => actionMatches(pattern, action))) return false;
  if (statement.NotResource !== undefined) return !list(statement.NotResource).some((pattern) => resourceMatches(pattern, resource));
  return list(statement.Resource).some((pattern) => resourceMatches(pattern, resource));
}

/** Whether the unconditional statements permit the pair: no matching Deny, and a matching Allow. */
function permits(statements: readonly PolicyStatementJson[], action: string, resource: string): boolean {
  const plain = statements.filter((statement) => statement.Condition === undefined);
  if (plain.some((statement) => statement.Effect === "Deny" && covers(statement, action, resource))) return false;
  return plain.some((statement) => statement.Effect === "Allow" && covers(statement, action, resource));
}

const withoutSid = (statement: PolicyStatementJson) => JSON.stringify(Object.fromEntries(Object.entries(statement).filter(([key]) => key !== "Sid")));

const SAMPLE_ACTIONS = [
  "sts:GetCallerIdentity", "sts:AssumeRole", "sts:TagSession", "sts:AssumeRoleWithSAML", "sts:GetSessionToken", "servicequotas:GetServiceQuota", "servicequotas:ListServices",
  "bedrock:GetFoundationModelAvailability", "bedrock:InvokeModel", "organizations:CreateAccount", "account:CloseAccount", "s3:GetObject", "ses:SendEmail", "ses:GetAccount", "ses:GetEmailIdentity",
  "events:PutRule", "appsync:EventPublish", "appsync:GetApi", "cloudfront:CreateFunction", "cloudfront:UpdateDistribution", "kms:Decrypt", "ec2:RunInstances", "xray:PutTraceSegments", "*",
];

function resourcesOf(statements: readonly PolicyStatementJson[]): string[] {
  const arns = statements.flatMap((statement) => [...list(statement.Resource), ...list(statement.NotResource)]);
  const filled = arns.flatMap((arn) => (arn.includes("*") ? [arn.replace(/\*/g, "x"), arn.replace(/\*/g, "x/y"), arn.replace(/\*/g, "")] : [arn]));
  const variants = filled.flatMap((arn) => [arn, `${arn}-other`, `x${arn}`]);
  return [...new Set(["*", ...variants])];
}

describe("the default boundary after the 2026-11-03 tightening", () => {
  for (const [name, { scope, statements: before }] of Object.entries(fixture)) {
    const after = defaultBoundaryStatements(scope);

    it(`${name}: keeps every statement with a condition exactly as it was`, () => {
      const conditional = (statements: readonly PolicyStatementJson[]) => statements.filter((statement) => statement.Condition !== undefined).map(withoutSid).sort();
      expect(conditional(after)).toEqual(conditional(before));
    });

    it(`${name}: permits and refuses the same (action, resource) pairs as v0.5.2`, () => {
      const actions = [...new Set([...iamActions, ...SAMPLE_ACTIONS, ...[...before, ...after].flatMap((statement) => list(statement.Action)).filter((action) => !action.includes("*"))])];
      const resources = [...new Set([...resourcesOf(before), ...resourcesOf(after)])];
      const differences: string[] = [];
      let permitted = 0;
      for (const action of actions) {
        // The universe holds real action names only (a wildcard in a statement is not an action; the IAM list expands the patterns).
        for (const resource of resources) {
          const was = permits(before, action, resource);
          const is = permits(after, action, resource);
          if (was) permitted += 1;
          if (was !== is) differences.push(`${action} on ${resource}: was ${was}, is ${is}`);
        }
      }
      expect(differences.slice(0, 20)).toEqual([]);
      // A positive control: the grid reaches plenty of permitted pairs, so "no difference" is not "nothing permitted".
      expect(permitted).toBeGreaterThan(500);
    });

    it(`${name}: still permits what the roles' own policies need, by name`, () => {
      const { account, env, cloudFormationRoleName } = scope;
      const path = `arn:aws:iam::${account}:role/agentx/${env}/`;
      const cases: Array<[string, string]> = [
        ["iam:CreateRole", `${path}agentx-${env}-broker-role`],
        ["iam:PassRole", `${path}agentx-${env}-broker-role`],
        ["iam:PassRole", `arn:aws:iam::${account}:role/${cloudFormationRoleName}`],
        ["iam:PassRole", `arn:aws:iam::${account}:role/agentx-${env}-img-create`],
        ["iam:AttachRolePolicy", `arn:aws:iam::${account}:role/agentx-${env}-img-create`],
        ["iam:GetRole", `arn:aws:iam::${account}:role/agentx-${env}-broker-role`],
        ["iam:DeleteRole", `arn:aws:iam::${account}:role/agentx-${env}-img-push`],
        ["iam:CreateInstanceProfile", `arn:aws:iam::${account}:instance-profile/agentx/${env}/agentx-${env}-workers`],
        ["iam:AddRoleToInstanceProfile", `arn:aws:iam::${account}:instance-profile/agentx/${env}/agentx-${env}-workers`],
        ["iam:RemoveRoleFromInstanceProfile", `arn:aws:iam::${account}:instance-profile/agentx/${env}/agentx-${env}-workers`],
        ["iam:CreatePolicyVersion", `arn:aws:iam::${account}:policy/agentx/${env}/agentx-${env}-broker-state`],
        ["sts:GetCallerIdentity", "*"],
        ["servicequotas:GetServiceQuota", "*"],
        ["bedrock:GetFoundationModelAvailability", "*"],
        ["bedrock:InvokeModel", `arn:aws:bedrock:*::foundation-model/anthropic.claude`],
      ];
      for (const [action, resource] of cases) expect(permits(after, action, resource), `${action} on ${resource}`).toBe(true);
      // And still refuses what it did: other environments' roles, the access stack's roles at the root, the boundary itself, users and groups, organizations, an instance profile outside the path.
      const refused: Array<[string, string]> = [
        ["iam:CreateRole", `arn:aws:iam::${account}:role/agentx/other/agentx-other-broker-role`],
        ["iam:PassRole", `arn:aws:iam::${account}:role/agentx-${env}-operator`],
        ["iam:CreatePolicyVersion", `arn:aws:iam::${account}:policy/agentx/${env}/agentx-${env}-boundary`],
        ["iam:SetDefaultPolicyVersion", `arn:aws:iam::${account}:policy/agentx/${env}/agentx-${env}-broker-state`],
        ["iam:CreateUser", `arn:aws:iam::${account}:user/x`],
        ["organizations:CreateAccount", "*"],
        ["iam:CreateInstanceProfile", `arn:aws:iam::${account}:instance-profile/other`],
        ["iam:UpdateAccountPasswordPolicy", "*"],
        ["sts:AssumeRoleWithSAML", "*"],
      ];
      for (const [action, resource] of refused) expect(permits(after, action, resource), `${action} on ${resource}`).toBe(false);
    });
  }
});
