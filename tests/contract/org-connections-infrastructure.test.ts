// Plan 3 Task 12a: the ConnectorSecretsRole and the broker's permission to assume it. The exact policy is asserted:
// the role is the only workload principal that reads the org connector and hook secret paths, and it reads them only
// through a session tagged with the org whose secrets they are.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { defaultBoundaryStatements } from "../../packages/contracts/src/access-policies.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Json = Record<string, unknown>;
type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource?: unknown; Principal?: unknown; Condition?: Record<string, Record<string, unknown>> };
type Resource = { Type: string; Properties: Json & { Roles?: Array<{ Ref?: string }>; Policies?: Array<{ PolicyDocument: { Statement: Statement[] } }>; AssumeRolePolicyDocument?: { Statement: Statement[] }; ManagedPolicyArns?: unknown[]; PolicyDocument?: { Statement: Statement[] } } };
type Resources = Record<string, Resource>;

function controlPlane(context: Record<string, unknown>): Template {
  const app = buildAgentXApp(context);
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXControlPlane");
  return Template.fromStack(stack!);
}

const PRINCIPAL_TAG = "${aws:PrincipalTag/rovara:org}";
const asList = (value: string | string[]): string[] => (Array.isArray(value) ? value : [value]);

/** A resource ARN as text: pseudo parameters become their sample values, anything else a character no ARN holds. */
function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  const node = value as { "Fn::Join"?: [string, unknown[]]; Ref?: string };
  if (node["Fn::Join"] !== undefined) return node["Fn::Join"][1].map(flatten).join(node["Fn::Join"][0]);
  if (node.Ref === "AWS::Partition") return "aws";
  if (node.Ref === "AWS::Region") return "us-west-2";
  if (node.Ref === "AWS::AccountId") return "111122223333";
  return "\u0000";
}

const glob = (pattern: string, text: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(text);

describe("ConnectorSecretsRole (named environments)", () => {
  let resources: Resources;
  let roleId: string;
  let role: Resource;
  let brokerRoleId: string;
  const statementsOfRole = (id: string): Statement[] => [
    ...(resources[id]!.Properties.Policies ?? []).flatMap((policy) => policy.PolicyDocument.Statement),
    ...Object.values(resources).filter((resource) => (resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy") && (resource.Properties.Roles ?? []).some((entry) => entry.Ref === id))
      .flatMap((resource) => resource.Properties.PolicyDocument!.Statement),
  ];

  beforeAll(() => {
    resources = controlPlane({ agentxEnv: "staging" }).toJSON().Resources as Resources;
    const roles = Object.entries(resources).filter(([id, resource]) => resource.Type === "AWS::IAM::Role" && id.startsWith("ConnectorSecretsRole"));
    expect(roles.map(([id]) => id)).toHaveLength(1);
    [roleId, role] = roles[0]!;
    brokerRoleId = Object.entries(resources).find(([id, resource]) => resource.Type === "AWS::IAM::Role" && id.startsWith("BrokerServiceRole"))![0];
  }, 240_000);

  it("trusts the broker function role only, with the three conditions that pin the org tag", () => {
    const trust = role.Properties.AssumeRolePolicyDocument!.Statement;
    expect(trust).toEqual([{
      Effect: "Allow",
      Principal: { AWS: { "Fn::GetAtt": [brokerRoleId, "Arn"] } },
      Action: ["sts:AssumeRole", "sts:TagSession"],
      Condition: {
        StringLike: { "aws:RequestTag/rovara:org": "org_????????????????????" },
        Null: { "aws:RequestTag/rovara:org": "false" },
        "ForAllValues:StringEquals": { "aws:TagKeys": ["rovara:org"] },
      },
    }]);
    expect("org_????????????????????").toHaveLength(24);
  });

  it("grants the exact permissions: resource-tag reads and writes, tagged create with its TagResource, and an unconditional UntagResource deny", () => {
    const statements = statementsOfRole(roleId);
    const resourcesOf = (statement: Statement) => asList(statement.Resource as string | string[]).map(flatten);
    const paths = (resource: string) => resource.replace(/^arn:aws:secretsmanager:us-west-2:111122223333:secret:/, "");
    const own = [`agentx/staging/org-connectors/${PRINCIPAL_TAG}/*`, `agentx/staging/org-hooks/${PRINCIPAL_TAG}/*`];

    const byAction = (action: string) => statements.filter((statement) => asList(statement.Action).includes(action));
    const [readWrite] = byAction("secretsmanager:GetSecretValue");
    expect(byAction("secretsmanager:GetSecretValue")).toHaveLength(1);
    expect(asList(readWrite!.Action).sort()).toEqual(["secretsmanager:DeleteSecret", "secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]);
    expect(readWrite!.Effect).toBe("Allow");
    expect(resourcesOf(readWrite!).map(paths)).toEqual(own);
    expect(readWrite!.Condition).toEqual({ StringEquals: { "aws:ResourceTag/rovara:org": PRINCIPAL_TAG } });

    const [create] = byAction("secretsmanager:CreateSecret");
    expect(byAction("secretsmanager:CreateSecret")).toHaveLength(1);
    expect(create).toMatchObject({ Effect: "Allow", Action: "secretsmanager:CreateSecret" });
    expect(resourcesOf(create!).map(paths)).toEqual(own);
    const tagConditions = {
      StringEquals: { "aws:RequestTag/rovara:org": PRINCIPAL_TAG },
      "ForAllValues:StringEquals": { "aws:TagKeys": ["rovara:org"] },
    };
    expect(create!.Condition).toEqual(tagConditions);

    // TagResource is allowed only here, under the same two conditions, and never denied.
    const tagging = byAction("secretsmanager:TagResource");
    expect(tagging).toHaveLength(1);
    expect(tagging[0]).toMatchObject({ Effect: "Allow", Action: "secretsmanager:TagResource" });
    expect(resourcesOf(tagging[0]!).map(paths)).toEqual(own);
    expect(tagging[0]!.Condition).toEqual(tagConditions);
    expect(statements.filter((statement) => statement.Effect === "Deny" && asList(statement.Action).some((action) => action === "secretsmanager:TagResource" || action === "secretsmanager:*" || action === "*"))).toEqual([]);

    const untag = statements.filter((statement) => asList(statement.Action).includes("secretsmanager:UntagResource"));
    expect(untag).toHaveLength(1);
    expect(untag[0]).toMatchObject({ Effect: "Deny", Action: "secretsmanager:UntagResource", Resource: "*" });
    expect(untag[0]!.Condition).toBeUndefined();

    // Nothing else: no other statement, no wildcard action, no other resource.
    expect(statements).toHaveLength(4);
    expect(statements.flatMap((statement) => asList(statement.Action))).not.toContain("secretsmanager:*");
  });

  it("is the only workload role that can read, write, create, tag or delete the org connector and hook secret paths", () => {
    const connectorSecret = "arn:aws:secretsmanager:us-west-2:111122223333:secret:agentx/staging/org-connectors/org_aaaaaaaaaaaaaaaaaaaa/con_aaaaaaaaaaaaaaaaaaaa-AbCdEf";
    const hookSecret = "arn:aws:secretsmanager:us-west-2:111122223333:secret:agentx/staging/org-hooks/org_aaaaaaaaaaaaaaaaaaaa/hok_aaaaaaaaaaaaaaaaaaaa-AbCdEf";
    // Every Secrets Manager action that reads or changes a secret, so no other role can write or delete org secrets either.
    const actionsToCheck = ["GetSecretValue", "BatchGetSecretValue", "DescribeSecret", "PutSecretValue", "CreateSecret", "UpdateSecret", "DeleteSecret", "RestoreSecret", "RotateSecret", "TagResource", "UntagResource", "PutResourcePolicy", "ReplicateSecretToRegions"];
    const reaching: Record<string, string[]> = Object.fromEntries(actionsToCheck.map((action) => [action, []]));
    for (const [id, resource] of Object.entries(resources)) {
      if (resource.Type !== "AWS::IAM::Role") continue;
      const statements = statementsOfRole(id).filter((statement) => statement.Effect === "Allow");
      for (const statement of statements) {
        const actions = asList(statement.Action);
        // The policy variable is the session's org: here the org of the sample secrets.
        const targets = statement.Resource === undefined ? [] : asList(statement.Resource as string | string[]).map(flatten).map((target) => target.replace(PRINCIPAL_TAG, "org_aaaaaaaaaaaaaaaaaaaa"));
        if (!targets.some((target) => glob(target, connectorSecret) || glob(target, hookSecret))) continue;
        for (const name of actionsToCheck) {
          if (actions.some((action) => glob(action.toLowerCase(), `secretsmanager:${name.toLowerCase()}`))) reaching[name]!.push(id);
        }
      }
      expect(JSON.stringify(resource.Properties.ManagedPolicyArns ?? []), id).not.toMatch(/SecretsManager|AdministratorAccess|PowerUser/);
    }
    const base = (id: string) => id.replace(/[0-9A-F]{8}$/, "");
    for (const name of actionsToCheck) {
      // The role itself holds Allow for these four tagged-path actions and UntagResource is a Deny, so it is not reached.
      const expected = ["GetSecretValue", "DescribeSecret", "PutSecretValue", "DeleteSecret", "CreateSecret", "TagResource"].includes(name) ? [base(roleId)] : [];
      expect([...new Set(reaching[name])].map(base), name).toEqual(expected);
    }
  });

  it("lets the broker assume the role with session tags and gives it no Secrets Manager permission on the org paths", () => {
    const statements = statementsOfRole(brokerRoleId);
    const assume = statements.filter((statement) => asList(statement.Action).includes("sts:AssumeRole"));
    expect(assume).toHaveLength(1);
    expect(asList(assume[0]!.Action).sort()).toEqual(["sts:AssumeRole", "sts:TagSession"]);
    expect(assume[0]).toMatchObject({ Effect: "Allow", Resource: { "Fn::GetAtt": [roleId, "Arn"] } });
    expect(assume[0]!.Condition).toBeUndefined();
    const text = JSON.stringify(statements.filter((statement) => asList(statement.Action).some((action) => action.startsWith("secretsmanager:") || action === "*")));
    expect(text).not.toContain("org-connectors");
    expect(text).not.toContain("org-hooks");
    // No broad secretsmanager grant either.
    for (const statement of statements.filter((entry) => entry.Effect === "Allow" && asList(entry.Action).some((action) => action.startsWith("secretsmanager:") || action === "*"))) {
      expect(JSON.stringify(statement.Resource), JSON.stringify(statement)).not.toBe('"*"');
    }
  });

  it("tells the broker the role's ARN", () => {
    const broker = Object.entries(resources).find(([id, resource]) => resource.Type === "AWS::Lambda::Function" && id.startsWith("Broker") && !id.startsWith("BrokerLogs"))!;
    const variables = (broker[1].Properties as { Environment: { Variables: Record<string, unknown> } }).Environment.Variables;
    expect(variables.CONNECTOR_SECRETS_ROLE_ARN).toEqual({ "Fn::GetAtt": [roleId, "Arn"] });
    expect(variables.AGENTX_ENV).toBe("staging");
  });

  it("sits at the environment role path, because the permissions boundary names the role by that path", () => {
    expect(role.Properties.Path).toBe("/agentx/staging/");
  });

  it("has a fixed name, which the default permissions boundary names as the one role a bounded role may assume", () => {
    expect(role.Properties.RoleName).toBe("agentx-staging-connector-secrets");
    const boundary = defaultBoundaryStatements({ env: "staging", partition: "aws", region: "us-west-2", account: "111122223333", cloudFormationRoleName: "x" });
    const sts = boundary.filter((statement) => [statement.Action].flat().some((action) => action.startsWith("sts:") && action !== "sts:GetCallerIdentity"));
    expect(sts).toEqual([{
      Sid: "ConnectorSecretsRole",
      Effect: "Allow",
      Action: ["sts:AssumeRole", "sts:TagSession"],
      Resource: "arn:aws:iam::111122223333:role/agentx/staging/agentx-staging-connector-secrets",
    }]);
  });

  it("uses no em dash in a name or description", () => {
    const text = JSON.stringify(role.Properties);
    expect(text).not.toContain("—");
    expect(text).not.toContain("–");
  });

  it("does not exist in the legacy deployment", () => {
    const legacy = controlPlane({}).toJSON().Resources as Resources;
    expect(Object.keys(legacy).filter((id) => id.startsWith("ConnectorSecretsRole"))).toEqual([]);
    expect(JSON.stringify(legacy)).not.toContain("org-connectors");
    expect(JSON.stringify(legacy)).not.toContain("CONNECTOR_SECRETS_ROLE_ARN");
  });
});
