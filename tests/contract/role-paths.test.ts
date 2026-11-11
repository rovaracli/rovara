// Every IAM role of a named cloud environment lives under /agentx/<env>/ (the access stack's two roles are the
// intentional exception), and every ARN that names a fixed-name role carries that role's real path and name.
//
// Why it is more than a Path property: a role with a fixed RoleName is looked up by name before CloudFormation creates it
// (iam:GetRole), and IAM authorizes a lookup of a role that does not exist yet against the path-less ARN
// role/<name>, because the path of a missing role is unknown. The deploy role is scoped to role/agentx/<env>/*, so
// that first call is refused (staging, 2026-10-23: ConnectorSecretsRole, "iam:GetRole on resource: role
// agentx-staging-connector-secrets"), and so is the rollback's delete. So each fixed-name role needs its exact
// path-less ARN named, for the read and delete actions only, in the deploy role and in the boundary it carries.
import { Stack } from "aws-cdk-lib";
import { brokerRoleName, chainScheduleRoleName, connectorSecretsRoleName, modelAccessProbeRoleName, modelProxyTaskRoleName, savedEnvCreateRoleName, savedEnvRolePrefix, companyImageMirrorRoleName, savedEnvManageRoleName, savedEnvPullRoleName, savedEnvPushRoleName, teamRecordVectorsRoleName, testAccountSecretsRoleName } from "@agentx/contracts";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { defaultBoundaryStatements, fixedNameEnvironmentRoleNames, serviceRoleStatements, type PolicyScope, type PolicyStatementJson } from "../../infra/lib/access-policies.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Json = Record<string, unknown>;
type Resource = { Type: string; Properties: Json };
type Synthesized = { access: Record<string, Resource>; others: Array<{ stack: string; resources: Record<string, Resource> }> };

const ACCOUNT = "111122223333";
const ENVIRONMENTS = ["staging", "a1234567890123456789", "agentxlivetest123"];

const synthesized = new Map<string, Synthesized>();

function synthesize(env: string): Synthesized {
  // TR-SWITCH-B2: with the Team record on, so its vector data role (a fixed name the boundary and the deploy role must name) is among the roles checked.
  const app = buildAgentXApp({ agentxEnv: env, agentxCloud: "true", agentxTeamRecord: "enabled" });
  const result: Synthesized = { access: {}, others: [] };
  for (const stack of app.node.children.filter((child): child is Stack => Stack.isStack(child))) {
    const resources = Template.fromStack(stack).toJSON().Resources as Record<string, Resource>;
    if (stack.node.id === "AgentXAccess") result.access = resources;
    else result.others.push({ stack: stack.node.id, resources });
  }
  return result;
}

/** An ARN or any other string as text: pseudo parameters become sample values, anything else a character no ARN holds. */
function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  const node = value as { "Fn::Join"?: [string, unknown[]]; Ref?: string };
  if (node["Fn::Join"] !== undefined) return node["Fn::Join"][1].map(flatten).join(node["Fn::Join"][0]);
  if (node.Ref === "AWS::Partition") return "aws";
  if (node.Ref === "AWS::Region") return "us-west-2";
  if (node.Ref === "AWS::AccountId") return ACCOUNT;
  return "\u0000";
}

/** Every string in a template, with the Fn::Join chains flattened. */
function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (typeof value === "object" && value !== null) {
    const node = value as Json;
    if (node["Fn::Join"] !== undefined) into.push(flatten(node));
    for (const child of Object.values(node)) strings(child, into);
  }
  return into;
}

const roleResources = (resources: Record<string, Resource>) => Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::IAM::Role");
const glob = (pattern: string, text: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(text);
const asList = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/**
 * Whether the statements allow the action on the resource: some Allow matches and no unconditional Deny does. A Deny with a Condition
 * is skipped: the only ones are the boundary requirements, which a role created with the environment's boundary satisfies.
 */
function allowed(statements: PolicyStatementJson[], action: string, resource: string): boolean {
  const matches = (statement: PolicyStatementJson) =>
    statement.Action.some((pattern) => glob(pattern.toLowerCase(), action.toLowerCase()))
    && (statement.NotResource !== undefined
      ? !asList(statement.NotResource).some((pattern) => glob(pattern, resource))
      : asList(statement.Resource).some((pattern) => glob(pattern, resource)));
  return statements.some((s) => s.Effect === "Allow" && matches(s)) && !statements.some((s) => s.Effect === "Deny" && s.Condition === undefined && matches(s));
}

beforeAll(() => {
  for (const env of ENVIRONMENTS) synthesized.set(env, synthesize(env));
}, 600_000);

describe.each(ENVIRONMENTS)("the roles of the named cloud environment %s", (env) => {
  const path = `/agentx/${env}/`;
  const scope = (): PolicyScope => ({
    env, partition: "aws", region: "us-west-2", account: ACCOUNT,
    artifactBucketArn: `arn:aws:s3:::agentx-${env}-access-artifactbucket-abc`, pullThroughPrefix: `agentx-${env}`,
    cloudFormationRoleName: `agentx-${env}-cloudformation`,
  });
  const fixedNameRoles = (): Array<{ stack: string; id: string; name: string }> =>
    synthesized.get(env)!.others.flatMap(({ stack, resources }) => roleResources(resources)
      .filter(([, resource]) => resource.Properties.RoleName !== undefined)
      .map(([id, resource]) => ({ stack, id, name: flatten(resource.Properties.RoleName) })));

  it("sit under /agentx/<env>/, except the access stack's two, which stay at the root", () => {
    const { access, others } = synthesized.get(env)!;
    const wrong: string[] = [];
    let count = 0;
    for (const { stack, resources } of others) {
      for (const [id, resource] of roleResources(resources)) {
        count += 1;
        // The one exception among the environment's own roles: the saved environment images' creation role sits at the root, because ECR's CustomRoleArn pattern has no room for a path.
        const expected = resource.Properties.RoleName === savedEnvCreateRoleName(env) ? "/" : path;
        if (resource.Properties.Path !== expected) wrong.push(`${stack}/${id}: ${String(resource.Properties.Path)}`);
      }
    }
    expect(count).toBeGreaterThan(20);
    expect(wrong).toEqual([]);
    expect(roleResources(access).map(([id, resource]) => [id, resource.Properties.Path, resource.Properties.RoleName])).toEqual([
      ["CloudFormationServiceRole", undefined, `agentx-${env}-cloudformation`],
      ["OperatorRole", undefined, `agentx-${env}-operator`],
    ]);
  });

  it("have exactly the fixed names this test knows, so a new fixed-name role cannot slip past the deploy role", () => {
    // Plan 3 gave three roles fixed names (the broker's, the model proxy's task role and the model access probe's: the default boundary names them in AssumeOrgRoles) and Plan 4 the
    // scheduler's invoke role, which the broker passes to the scheduler by an ARN built from the environment; each needs the path-less grant of the lookup statement.
    expect(fixedNameRoles().map((role) => role.name).sort()).toEqual(
      [
        `agentx-${env}-connector-secrets`, testAccountSecretsRoleName(env), brokerRoleName(env), modelProxyTaskRoleName(env), modelAccessProbeRoleName(env), chainScheduleRoleName(env),
        // Setup and test health SH22: the roles the broker assumes for saved environment images.
        savedEnvPushRoleName(env), savedEnvPullRoleName(env), savedEnvManageRoleName(env), savedEnvCreateRoleName(env), companyImageMirrorRoleName(env),
        // TR-SWITCH-B2: the Team record's vector data role (only while the record is switched on, as here).
        teamRecordVectorsRoleName(env),
        ...(env === "agentxlivetest123" ? [`${env}-task-person-proof`] : []),
      ].sort(),
    );
    expect(fixedNameEnvironmentRoleNames(env).sort()).toEqual(fixedNameRoles().map((role) => role.name).sort());
  });

  it("are named in every ARN that points at a fixed-name role with that role's path and name", () => {
    const names = fixedNameRoles().map((role) => role.name);
    const found: string[] = [];
    for (const { resources } of synthesized.get(env)!.others) {
      for (const text of strings(resources)) {
        const at = text.indexOf(":role/");
        if (at < 0) continue;
        const rest = text.slice(at + ":role/".length);
        if (names.some((name) => rest.endsWith(name))) found.push(text);
      }
    }
    for (const text of found) expect(text).toMatch(new RegExp(`:iam::${ACCOUNT}:role(${path}|/)[^/]+$`));
    // The boundary names the connector secrets role, and the broker builds its ARN from the environment alone: all three agree.
    const arn = `arn:aws:iam::${ACCOUNT}:role${path}agentx-${env}-connector-secrets`;
    const boundaryStatement = defaultBoundaryStatements(scope()).find((statement) => statement.Sid === "ConnectorSecretsRole");
    // Test services TS26: the TestAccountSecretsRole's name starts with the connector role's, and one wildcard ARN names both.
    // TR-SWITCH-B2: and the Team record's vector data role, by its fixed name.
    expect(boundaryStatement?.Resource).toEqual([`${arn}*`, `arn:aws:iam::${ACCOUNT}:role${path}agentx-${env}-img-*`, `arn:aws:iam::${ACCOUNT}:role${path}${teamRecordVectorsRoleName(env)}`]);
    const built: MutableEnvironment = { AGENTX_ENV: env, AGENTX_NAMES: "{}", AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: ACCOUNT };
    hydrateBrokerEnvironment(built);
    expect(built.CONNECTOR_SECRETS_ROLE_ARN).toBe(arn);
  });

  it("give ECR's creation template a CustomRoleArn that matches ECR's pattern (no IAM path), and the deploy role and boundary may manage exactly that role at the root", () => {
    const { others } = synthesized.get(env)!;
    const all = others.flatMap(({ resources }) => Object.entries(resources));
    const template = all.find(([, resource]) => resource.Type === "AWS::ECR::RepositoryCreationTemplate");
    expect(template, "the control plane stack has the creation template").toBeDefined();
    const arn = template![1].Properties.CustomRoleArn as { "Fn::GetAtt": [string, string] };
    const role = all.find(([id]) => id === arn["Fn::GetAtt"][0])![1];
    expect(role.Properties.Path).toBe("/");
    const resolved = `arn:aws:iam::${ACCOUNT}:role${String(role.Properties.Path)}${flatten(role.Properties.RoleName)}`;
    expect(resolved).toMatch(/^arn:aws[-a-z0-9]*:iam::[0-9]{12}:role\/[A-Za-z0-9+=,\-.@_]*$/u);
    expect(resolved).toBe(`arn:aws:iam::${ACCOUNT}:role/${savedEnvCreateRoleName(env)}`);
    for (const [label, statements] of [["deploy role", serviceRoleStatements(scope())], ["boundary", defaultBoundaryStatements(scope())]] as const) {
      for (const action of ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:UpdateAssumeRolePolicy", "iam:PassRole", "iam:DeleteRole"]) {
        expect(allowed(statements, action, resolved), `${label} allows ${action} on ${resolved}`).toBe(true);
      }
      // Only that one role at the root.
      expect(allowed(statements, "iam:CreateRole", `${resolved}-other`), `${label} refuses a similar name`).toBe(false);
      expect(allowed(statements, "iam:CreateRole", `arn:aws:iam::${ACCOUNT}:role/${savedEnvPushRoleName(env)}`), `${label} refuses the push role at the root`).toBe(false);
    }
    // The deploy role still has to set the boundary on it.
    const requireBoundary = serviceRoleStatements(scope()).find((statement) => statement.Sid === "IamRequireBoundary")!;
    expect(asList(requireBoundary.Resource)).toContain(resolved);
  });

  it("can be looked up, and cleaned up on a rollback, by the deploy role and the boundary it carries, before they exist", () => {
    // What IAM authorizes for a role that does not exist yet: the path-less ARN. These calls are what failed on staging.
    for (const { name } of fixedNameRoles()) {
      const pathless = `arn:aws:iam::${ACCOUNT}:role/${name}`;
      for (const [label, statements] of [["deploy role", serviceRoleStatements(scope())], ["boundary", defaultBoundaryStatements(scope())]] as const) {
        for (const action of ["iam:GetRole", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:GetRolePolicy", "iam:DeleteRolePolicy", "iam:DetachRolePolicy", "iam:DeleteRole"]) {
          expect(allowed(statements, action, pathless), `${label} allows ${action} on ${pathless}`).toBe(true);
        }
        // Not create or change: a role at the root path would escape the path scoping and the boundary requirement. The one exception is ECR's creation role (see rootPathRoles), checked in the test above.
        if (name !== savedEnvCreateRoleName(env)) for (const action of ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:UpdateAssumeRolePolicy", "iam:PutRolePermissionsBoundary", "iam:PassRole"]) {
          expect(allowed(statements, action, pathless), `${label} refuses ${action} on ${pathless}`).toBe(false);
        }
        // Only that exact role, and the real path still works.
        // The boundary (a ceiling only, with no room for one ARN per role) names the connector and test account secrets roles with one `connector-secrets*` ARN, so it does not refuse a name that starts the same way;
        // the deploy role, which is what allows the lookups, still does.
        // The same for the saved environment image roles (`img-push|pull|manage|mirror|create`): the boundary names them with one `img-*` ARN.
        const sharedPrefix = label === "boundary" && (name.startsWith(connectorSecretsRoleName(env)) || name.startsWith(savedEnvRolePrefix(env)));
        expect(allowed(statements, "iam:GetRole", `arn:aws:iam::${ACCOUNT}:role/${name}-other`), `${label} refuses a similar name`).toBe(sharedPrefix);
        expect(allowed(statements, "iam:GetRole", `arn:aws:iam::${ACCOUNT}:role/agentx-${env}-operator`), `${label} refuses the access stack's roles`).toBe(false);
        expect(allowed(statements, "iam:CreateRole", `arn:aws:iam::${ACCOUNT}:role${path}${name}`), `${label} creates it under its path`).toBe(true);
      }
    }
  });
});
