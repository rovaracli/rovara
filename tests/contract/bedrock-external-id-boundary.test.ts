// L4-HARD (a), owner 2026-11-18: ONE Bedrock external id scheme (the HMAC `rvb-` one) and a boundary ceiling that is exactly the broker's grant.
// Here: (1) the broker's own grant and the boundary's ceiling for it carry the same conditions (one source in cloud-boundary.ts), (2) a request simulation
// over both, from code, (3) the shipped customer role template names the same scheme, (4) the Code-side default boundary's `rovara-org_*` ceiling
// (access-policies.ts AssumeOrgRoles) is for the CloudWatch / test-account roles only and never covers the Bedrock broker, (5) the check can fail.
import { readFileSync } from "node:fs";
import type { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { defaultBoundaryStatements, brokerRoleName } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { BYO_CUSTOMER_EXTERNAL_ID_PATTERN, BYO_CUSTOMER_SESSION_NAME_PATTERN, byoCustomerAssumeConditions, cloudBoundaryStatements } from "../../infra/lib/cloud-boundary.js";
import { boundaryViolations, conditionWithin, globMatch, type CfnTemplate, type StackTemplate } from "../../infra/lib/cloud-boundary-check.js";
import { BEDROCK_BYO_CUSTOMER_ROLE_PREFIX, MODEL_GATEWAY_BEDROCK_BYO_CONTEXT_KEY, MODEL_GATEWAY_CONTEXT_KEY, MODEL_GATEWAY_PRODUCT_CONTEXT_KEY, bedrockBrokerRoleName } from "../../infra/lib/model-gateway.js";
import { BEDROCK_EXTERNAL_ID, bedrockExternalIdMessage } from "../../packages/model-gateway/src/bedrock-byo.js";

const ENV = "staging";
const ACCOUNT = "123456789012";
const scope = { env: ENV, partition: "aws", region: "us-west-2", account: ACCOUNT };
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, string | string[]>> };
type Resource = { Type: string; Properties: Record<string, unknown> };

const gateway = (): StackTemplate[] => {
  const app = buildAgentXApp({ [MODEL_GATEWAY_CONTEXT_KEY]: ENV, agentxRegion: scope.region, [MODEL_GATEWAY_PRODUCT_CONTEXT_KEY]: "on", [MODEL_GATEWAY_BEDROCK_BYO_CONTEXT_KEY]: "on" });
  return ["RovaraModelGatewayImages", "RovaraModelGateway"].map((id) => {
    const stack = app.node.findChild(id) as Stack;
    return { stackName: stack.stackName, template: Template.fromStack(stack).toJSON() as CfnTemplate };
  });
};
const stacks = gateway();
const gatewayTemplate = stacks[1]!.template;
const resources = gatewayTemplate.Resources as Record<string, Resource>;

const brokerRole = () => Object.entries(resources).find(([, r]) => r.Type === "AWS::IAM::Role" && r.Properties.RoleName === bedrockBrokerRoleName(ENV))!;
const grantStatement = (): Statement => ((brokerRole()[1].Properties.Policies as Array<{ PolicyDocument: { Statement: Statement[] } }>)[0]!.PolicyDocument.Statement[0]!);
const ceilingStatement = () => cloudBoundaryStatements(scope, "gateway").find((s) => s.Sid === "AssumeCustomerBedrockRoles")!;

/** The grant's condition with the template's account reference resolved. */
const grantCondition = () => JSON.parse(JSON.stringify(grantStatement().Condition).replace('{"Ref":"AWS::AccountId"}', JSON.stringify(ACCOUNT))) as Record<string, Record<string, string>>;

interface Request { role: string; externalId?: string; sessionName?: string; resourceAccount: string }
/** A minimal IAM evaluator for sts:AssumeRole: StringLike / StringNotEquals conditions only (anything else throws), implicit deny. */
function allows(statement: { Resource: unknown; Condition?: Record<string, Record<string, string | string[]>> }, request: Request): boolean {
  const resources = [statement.Resource].flat().map((r) => typeof r === "string" ? r : JSON.stringify(r));
  // The template's Join resource: arn:<partition>:iam::*:role/<prefix>*
  const patterns = resources.map((r) => r.startsWith("{") ? `arn:aws:iam::*:role/${BEDROCK_BYO_CUSTOMER_ROLE_PREFIX}*` : r);
  if (!patterns.some((p) => globMatch(p, request.role))) return false;
  const context: Record<string, string | undefined> = { "sts:ExternalId": request.externalId, "sts:RoleSessionName": request.sessionName, "aws:ResourceAccount": request.resourceAccount };
  for (const [operator, keys] of Object.entries(statement.Condition ?? {})) {
    for (const [key, wanted] of Object.entries(keys)) {
      const value = context[key];
      const list = [wanted].flat();
      if (operator === "StringLike") { if (value === undefined || !list.some((w) => globMatch(w, value))) return false; }
      else if (operator === "StringNotEquals") { if (value !== undefined && list.includes(value)) return false; }
      else throw new Error(`operator ${operator} is not modelled`);
    }
  }
  return true;
}

const EXT = `rvb-${"a1".repeat(20)}`;
const roleIn = (account: string, name = `RovaraBedrockInvoke-org_aaaaaaaaaaaaaaaaaaaa`) => `arn:aws:iam::${account}:role/${name}`;
const REQUESTS: Array<[string, Request, boolean]> = [
  ["a customer's role, the rvb- id, the org_ session", { role: roleIn("222222222222"), externalId: EXT, sessionName: "org_aaaaaaaaaaaaaaaaaaaa", resourceAccount: "222222222222" }, true],
  ["another customer, same shape", { role: roleIn("333333333333", "RovaraBedrockInvoke-org_bbbbbbbbbbbbbbbbbbbb"), externalId: `rvb-${"b2".repeat(20)}`, sessionName: "org_bbbbbbbbbbbbbbbbbbbb", resourceAccount: "333333333333" }, true],
  ["the OLD guessable id (rovara-<org>)", { role: roleIn("222222222222"), externalId: "rovara-org_aaaaaaaaaaaaaaaaaaaa", sessionName: "org_aaaaaaaaaaaaaaaaaaaa", resourceAccount: "222222222222" }, false],
  ["the CloudWatch / test-account form (rovara-org_...-<account>)", { role: roleIn("222222222222"), externalId: "rovara-org_aaaaaaaaaaaaaaaaaaaa-orders", sessionName: "org_aaaaaaaaaaaaaaaaaaaa", resourceAccount: "222222222222" }, false],
  ["no external id at all", { role: roleIn("222222222222"), sessionName: "org_aaaaaaaaaaaaaaaaaaaa", resourceAccount: "222222222222" }, false],
  ["an empty-ish id (rvb without the hash)", { role: roleIn("222222222222"), externalId: "rvb", sessionName: "org_aaaaaaaaaaaaaaaaaaaa", resourceAccount: "222222222222" }, false],
  ["the rvb- id with no session name", { role: roleIn("222222222222"), externalId: EXT, resourceAccount: "222222222222" }, false],
  ["the rvb- id with a session name that is not a company", { role: roleIn("222222222222"), externalId: EXT, sessionName: "attacker", resourceAccount: "222222222222" }, false],
  ["a customer role name in ROVARA'S OWN account", { role: roleIn(ACCOUNT), externalId: EXT, sessionName: "org_aaaaaaaaaaaaaaaaaaaa", resourceAccount: ACCOUNT }, false],
  ["a role of another name in a customer account", { role: roleIn("222222222222", "Admin"), externalId: EXT, sessionName: "org_aaaaaaaaaaaaaaaaaaaa", resourceAccount: "222222222222" }, false],
];

describe("Bedrock external ids: one scheme, and the boundary ceiling is exactly the broker's grant", () => {
  it("the broker's grant carries the shared conditions, and the boundary's ceiling carries the same ones", () => {
    expect(grantCondition()).toEqual(byoCustomerAssumeConditions(ACCOUNT));
    expect(ceilingStatement().Condition).toEqual(byoCustomerAssumeConditions(ACCOUNT));
    expect(ceilingStatement().Condition).toEqual(grantCondition());
    expect(ceilingStatement().Action).toEqual(["sts:AssumeRole"]);
    expect(ceilingStatement().Resource).toEqual([`arn:aws:iam::*:role/${BEDROCK_BYO_CUSTOMER_ROLE_PREFIX}*`]);
    // The one scheme is rvb-: the pattern is the prefix of the gateway's id form, and nothing of the old form is in either.
    expect(BYO_CUSTOMER_EXTERNAL_ID_PATTERN).toBe("rvb-*");
    expect(BYO_CUSTOMER_SESSION_NAME_PATTERN).toBe("org_*");
    expect(BEDROCK_EXTERNAL_ID.test(EXT)).toBe(true);
    expect(globMatch(BYO_CUSTOMER_EXTERNAL_ID_PATTERN, EXT)).toBe(true);
    expect(JSON.stringify([grantStatement(), ceilingStatement()])).not.toMatch(/rovara-org_/u);
    expect(bedrockExternalIdMessage("iss", "org_aaaaaaaaaaaaaaaaaaaa").length).toBeGreaterThan(0);
  });

  it.each(REQUESTS)("simulation: %s", (_name, request, expected) => {
    const grant = allows({ Resource: grantStatement().Resource, Condition: grantCondition() }, request);
    const ceiling = allows(ceilingStatement(), request);
    // Effective permission under a boundary is grant AND ceiling: both agree on every request, so the ceiling neither blocks nor adds anything.
    expect({ grant, ceiling, effective: grant && ceiling }).toEqual({ grant: expected, ceiling: expected, effective: expected });
  });

  it("every other statement the gateway boundary has for sts:AssumeRole cannot reach a customer role (the conditioned one is the only way)", () => {
    const assumes = cloudBoundaryStatements(scope, "gateway").filter((s) => s.Effect === "Allow" && s.Action.includes("sts:AssumeRole"));
    expect(assumes.map((s) => s.Sid)).toEqual(["AssumeGatewayRoles", "AssumeCustomerBedrockRoles"]);
    const reachable = assumes.filter((s) => allows(s, { role: roleIn("222222222222"), externalId: "rovara-org_x", sessionName: "attacker", resourceAccount: "222222222222" }));
    expect(reachable).toEqual([]);
  });

  it("nothing the gateway's roles grant themselves leaves the boundary (conditions included)", () => {
    expect(boundaryViolations(stacks, scope)).toEqual([]);
  });

  it("the check can fail: a grant on the old id form, with no external id, or with any session name is outside the boundary", () => {
    const widen = (condition: Record<string, Record<string, string | { Ref: string }>>): StackTemplate[] => {
      const t = structuredClone(gatewayTemplate) as CfnTemplate & { Resources: Record<string, Resource> };
      const role = Object.values(t.Resources).find((r) => r.Type === "AWS::IAM::Role" && r.Properties.RoleName === bedrockBrokerRoleName(ENV))!;
      ((role.Properties.Policies as Array<{ PolicyDocument: { Statement: Statement[] } }>)[0]!.PolicyDocument.Statement[0]! as { Condition: unknown }).Condition = condition;
      return [stacks[0]!, { stackName: stacks[1]!.stackName, template: t }];
    };
    const own = { StringNotEquals: { "aws:ResourceAccount": { Ref: "AWS::AccountId" } } };
    const base = { "sts:ExternalId": "rvb-*", "sts:RoleSessionName": "org_*" };
    expect(boundaryViolations(widen({ StringLike: base, ...own }), scope)).toEqual([]);
    for (const bad of [
      { ...base, "sts:ExternalId": "rovara-org_*" }, { ...base, "sts:ExternalId": "*" }, { ...base, "sts:ExternalId": "rvb*" },
      { "sts:RoleSessionName": "org_*" }, { "sts:ExternalId": "rvb-*" }, { ...base, "sts:RoleSessionName": "*" },
    ]) expect(boundaryViolations(widen({ StringLike: bad, ...own }), scope), JSON.stringify(bad)).toMatchObject([{ action: "sts:AssumeRole", reason: "not allowed by the boundary" }]);
    // The account exclusion is part of the ceiling too: a grant without it (a role of this account could be named) is outside.
    expect(boundaryViolations(widen({ StringLike: base }), scope)).toMatchObject([{ reason: "not allowed by the boundary" }]);
    expect(boundaryViolations(widen({ StringLike: base, StringNotEquals: { "aws:ResourceAccount": "999999999999" } }), scope)).toMatchObject([{ reason: "not allowed by the boundary" }]);
  });

  it("conditionWithin: a boundary condition needs the grant to be as narrow; an operator it does not know is an error, never a guess", () => {
    const need = { StringLike: { k: ["a-*"] } };
    expect(conditionWithin({ StringLike: { k: ["a-*"] } }, need)).toBe(true);
    expect(conditionWithin({ StringLike: { k: ["a-b*"] } }, need)).toBe(true);
    expect(conditionWithin({ StringLike: { k: ["*"] } }, need)).toBe(false);
    expect(conditionWithin({ StringLike: { k: ["a-*", "b"] } }, need)).toBe(false);
    expect(conditionWithin(undefined, need)).toBe(false);
    expect(conditionWithin({ StringLike: { other: ["a-*"] } }, need)).toBe(false);
    expect(conditionWithin({ StringEquals: { k: ["a-*"] } }, need)).toBe(false);
    expect(conditionWithin(undefined, undefined)).toBe(true);
    expect(conditionWithin({ StringNotEquals: { k: ["x", "y"] } }, { StringNotEquals: { k: ["x"] } })).toBe(true);
    expect(conditionWithin({ StringNotEquals: { k: ["y"] } }, { StringNotEquals: { k: ["x"] } })).toBe(false);
    // An operator the check does not understand still refuses. ArnLike / ArnEquals are understood since PH-S3 (ARN-typed keys such as ecs:cluster) and read like StringLike / StringEquals.
    expect(() => conditionWithin({}, { NumericLessThan: { k: ["1"] } })).toThrow(/not supported/);
    expect(conditionWithin({ ArnLike: { k: ["arn:aws:ecs:*:*:cluster/a-*"] } }, { ArnLike: { k: ["arn:aws:ecs:*:*:cluster/a-*"] } })).toBe(true);
    expect(conditionWithin({ ArnLike: { k: ["arn:aws:ecs:*:*:cluster/*"] } }, { ArnLike: { k: ["arn:aws:ecs:*:*:cluster/a-*"] } })).toBe(false);
    expect(() => conditionWithin({ ArnLike: { k: ["a-b"] } }, { ArnLike: { k: ["a?b"] } })).toThrow(/uses \? in a ArnLike value/);
    expect(() => conditionWithin({ StringLike: { k: ["a-b"] } }, { StringLike: { k: ["a?b"] } })).toThrow(/uses \? in a StringLike value/);
  });

  it("the shipped customer role template names the same scheme: rvb- external id parameter, the broker role pattern, session name = company id", () => {
    const template = JSON.parse(readFileSync(new URL("../../docs/bedrock/rovara-bedrock-role.json", import.meta.url), "utf8")) as {
      Parameters: Record<string, { AllowedPattern?: string }>; Resources: { RovaraBedrockInvokeRole: { Properties: { AssumeRolePolicyDocument: { Statement: Array<Record<string, unknown>> } } } };
    };
    expect(new RegExp(template.Parameters.ExternalId!.AllowedPattern!, "u").source).toBe(BEDROCK_EXTERNAL_ID.source);
    expect(new RegExp(template.Parameters.BrokerRoleArn!.AllowedPattern!, "u").test(`arn:aws:iam::${ACCOUNT}:role/${bedrockBrokerRoleName(ENV)}`)).toBe(true);
    const [trust] = template.Resources.RovaraBedrockInvokeRole.Properties.AssumeRolePolicyDocument.Statement;
    expect(trust).toMatchObject({ Effect: "Allow", Action: "sts:AssumeRole", Principal: { AWS: { Ref: "BrokerRoleArn" } }, Condition: { StringEquals: { "sts:ExternalId": { Ref: "ExternalId" }, "sts:RoleSessionName": { Ref: "CompanyId" } } } });
    expect(JSON.stringify(template)).not.toMatch(/rovara-org_|rovara-\$\{/u);
    // A role built from the template with the broker's own grant: the roles Rovara assumes are named RovaraBedrockInvoke-<company>.
    expect(BEDROCK_BYO_CUSTOMER_ROLE_PREFIX).toBe("RovaraBedrockInvoke-");
  });

  it("the Code-side default boundary's AssumeOrgRoles ceiling (`rovara-org_*`) names the CloudWatch / test-account / probe roles only: never the Bedrock broker, and an rvb- id does not pass it", () => {
    const boundary = defaultBoundaryStatements({ env: ENV, partition: "aws", region: scope.region, account: ACCOUNT, cloudFormationRoleName: "agentx-staging-cloudformation" });
    const ceiling = boundary.find((s) => s.Sid === "AssumeOrgRoles")! as unknown as { Condition: { ArnLike: { "aws:PrincipalArn": string[] }; StringLike: Record<string, string> } };
    expect(ceiling.Condition.StringLike).toEqual({ "sts:ExternalId": "rovara-org_*" });
    const principals = ceiling.Condition.ArnLike["aws:PrincipalArn"];
    expect(principals).toHaveLength(3);
    expect(principals.some((p) => p.endsWith(`/${brokerRoleName(ENV)}`))).toBe(true);
    // The Bedrock broker is not a principal of this ceiling (it carries Cloud's boundary instead, above), so this pattern can never be asked of it.
    expect(principals.some((p) => p.includes("RovaraBedrockBroker"))).toBe(false);
    expect(globMatch(ceiling.Condition.StringLike["sts:ExternalId"]!, EXT)).toBe(false);
  });
});
