// Plan 3 Task 12a: the ConnectorSecretsRole and the broker's permission to assume it. The exact policy is asserted:
// the role is the only workload principal that reads the org connector and hook secret paths, and it reads them only
// through a session tagged with the org whose secrets they are.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { defaultBoundaryStatements } from "../../packages/contracts/src/access-policies.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { boundaryWithSids } from "../support/deployed-boundary.js";
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

    // Final review M2: DeleteSecret is allowed (a removed connection's secret is scheduled for deletion), but never with
    // ForceDeleteWithoutRecovery: a broker bug could otherwise skip the 7-day recovery the CLI promises. A Deny, which wins over the Allow.
    const forced = statements.filter((statement) => statement.Effect === "Deny" && asList(statement.Action).includes("secretsmanager:DeleteSecret"));
    expect(forced).toHaveLength(1);
    expect(forced[0]).toMatchObject({ Sid: "NeverDeleteWithoutRecovery", Effect: "Deny", Action: "secretsmanager:DeleteSecret", Resource: "*" });
    expect(forced[0]!.Condition).toEqual({ Bool: { "secretsmanager:ForceDeleteWithoutRecovery": "true" } });

    // Nothing else: no other statement, no wildcard action, no other resource.
    expect(statements).toHaveLength(5);
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
    // Setup and test health SH22 adds the broker's assume of the saved environment image roles (its own statement, no session tags): this test is about the connector secrets role.
    const assume = statements.filter((statement) => asList(statement.Action).includes("sts:AssumeRole") && statement.Sid !== "AssumeSavedEnvImageRoles" && statement.Sid !== "AssumeTestAccountSecretsRole");
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

  it("does not tell the broker the role's ARN: the broker builds it, to the ARN the role has (the broker's variables are held to Lambda's 4 KB)", () => {
    const broker = Object.entries(resources).find(([id, resource]) => resource.Type === "AWS::Lambda::Function" && id.startsWith("Broker") && !id.startsWith("BrokerLogs"))!;
    const variables = (broker[1].Properties as { Environment: { Variables: Record<string, unknown> } }).Environment.Variables;
    expect(variables.CONNECTOR_SECRETS_ROLE_ARN).toBeUndefined();
    expect(variables.AGENTX_ENV).toBe("staging");
    expect(variables.AGENTX_ACCOUNT_ID).toEqual({ Ref: "AWS::AccountId" });
    // What it builds is `arn:<partition>:iam::<account>:role<path><name>` of this role: its fixed name, under its path.
    const built: MutableEnvironment = { AGENTX_ENV: "staging", AGENTX_NAMES: "{}", AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "111122223333" };
    hydrateBrokerEnvironment(built);
    expect(built.CONNECTOR_SECRETS_ROLE_ARN).toBe(`arn:aws:iam::111122223333:role${String(role.Properties.Path)}${String(role.Properties.RoleName)}`);
    expect(built.CONNECTOR_SECRETS_ROLE_ARN).toBe("arn:aws:iam::111122223333:role/agentx/staging/agentx-staging-connector-secrets");
  });

  it("sits at the environment role path, because the permissions boundary names the role by that path", () => {
    expect(role.Properties.Path).toBe("/agentx/staging/");
  });

  it("has a fixed name, which the default permissions boundary names as the one role a bounded role may assume", () => {
    expect(role.Properties.RoleName).toBe("agentx-staging-connector-secrets");
    const boundary = defaultBoundaryStatements({ env: "staging", partition: "aws", region: "us-west-2", account: "111122223333", cloudFormationRoleName: "x" });
    const sts = boundary.filter((statement) => [statement.Action].flat().some((action) => action.startsWith("sts:") && action !== "sts:GetCallerIdentity"));
    // Plan 4 Task 16 adds one more, for other accounts' roles only (a customer's CloudWatch role, a company's Bedrock role): it names this account in a NotEquals
    // condition, so the one role of this account a bounded role may assume is still this one.
    expect(sts.map((statement) => statement.Sid)).toEqual(["ConnectorSecretsRole", "AssumeOrgRoles"]);
    expect(sts[0]).toEqual({
      Sid: "ConnectorSecretsRole",
      Effect: "Allow",
      Action: ["sts:AssumeRole", "sts:TagSession"],
      // Setup and test health SH22: and one wildcard for the saved environment image roles (the broker's own policy names the three exactly).
      // Test services TS26: and the TestAccountSecretsRole, whose name starts the same way (one wildcard ARN; see test-account-secrets-infrastructure.test.ts).
      Resource: ["arn:aws:iam::111122223333:role/agentx/staging/agentx-staging-connector-secrets*", "arn:aws:iam::111122223333:role/agentx/staging/agentx-staging-img-*"],
    });
    // Owner decision A narrows it to the broker, the model proxy task role and the model access probe (ArnLike on the principal): see access-policies.test.ts for the exact JSON.
    expect(sts[1]!.Condition).toEqual({
      ArnLike: { "aws:PrincipalArn": [
        "arn:aws:iam::111122223333:role/agentx/staging/agentx-staging-broker-role",
        "arn:aws:iam::111122223333:role/agentx/staging/agentx-staging-model-proxy-task",
        "arn:aws:iam::111122223333:role/agentx/staging/agentx-staging-model-access-probe",
      ] },
      StringNotEquals: { "aws:ResourceAccount": "111122223333" },
      StringLike: { "sts:ExternalId": "rovara-org_*" },
    });
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

// Owner decision A: the permissions boundary's AssumeOrgRoles statement names the three roles that hold a cross-account grant, so each has a fixed name (CloudFormation's
// generated names are truncated and carry a hash, which no ArnLike can name exactly), and each sits on the environment's role path the boundary names them under.
describe("the three roles that may assume a customer's role (named environments)", () => {
  const rolesByPrefix = (resources: Resources, prefix: string) => Object.entries(resources).filter(([id, resource]) => resource.Type === "AWS::IAM::Role" && id.startsWith(prefix));
  const boundaryPrincipals = [
    "arn:aws:iam::111122223333:role/agentx/staging/agentx-staging-broker-role",
    "arn:aws:iam::111122223333:role/agentx/staging/agentx-staging-model-proxy-task",
    "arn:aws:iam::111122223333:role/agentx/staging/agentx-staging-model-access-probe",
  ];
  let resources: Resources;
  beforeAll(() => {
    resources = controlPlane({ agentxEnv: "staging", agentxCloud: true }).toJSON().Resources as Resources;
  }, 240_000);

  it("are named exactly as the boundary names them, on the environment's role path", () => {
    const named = [["BrokerServiceRole", "agentx-staging-broker-role"], ["ModelProxyTaskRole", "agentx-staging-model-proxy-task"], ["ModelAccessFunctionServiceRole", "agentx-staging-model-access-probe"]] as const;
    for (const [prefix, name] of named) {
      const found = rolesByPrefix(resources, prefix);
      expect(found.map(([id]) => id), prefix).toHaveLength(1);
      expect(found[0]![1].Properties.RoleName, prefix).toBe(name);
      expect(found[0]![1].Properties.Path, prefix).toBe("/agentx/staging/");
      expect(boundaryPrincipals).toContain(`arn:aws:iam::111122223333:role${found[0]![1].Properties.Path as string}${name}`);
    }
  });

  it("are the only roles in the control plane that hold an sts:AssumeRole grant into another account", () => {
    const grants = Object.values(resources).flatMap((resource) => {
      if (resource.Type !== "AWS::IAM::Policy" && resource.Type !== "AWS::IAM::ManagedPolicy") return [];
      const statements = resource.Properties.PolicyDocument!.Statement.filter((statement) => [statement.Action].flat().includes("sts:AssumeRole") && statement.Condition?.StringNotEquals !== undefined);
      return statements.length === 0 ? [] : (resource.Properties.Roles ?? []).map((entry) => entry.Ref ?? "?");
    });
    expect([...new Set(grants)].sort()).toEqual(
      ["BrokerServiceRole", "ModelAccessFunctionServiceRole", "ModelProxyTaskRole"].map((prefix) => rolesByPrefix(resources, prefix)[0]![0]).sort(),
    );
  });

  it("have no fixed name in the legacy deployment, which has no access stack and no boundary", () => {
    const legacy = controlPlane({}).toJSON().Resources as Resources;
    for (const prefix of ["BrokerServiceRole"]) for (const [, role] of rolesByPrefix(legacy, prefix)) expect(role.Properties.RoleName).toBeUndefined();
  });
});

describe("the access stack's boundary takes Rovara's AWS Organization id from context, never from the source", () => {
  const boundaryStatement = (context: Record<string, unknown>) => {
    const app = buildAgentXApp({ agentxEnv: "staging", ...context });
    const access = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXAccess")!;
    const policy = Object.values(Template.fromStack(access).toJSON().Resources as Resources).find((resource) => resource.Type === "AWS::IAM::ManagedPolicy" && resource.Properties.ManagedPolicyName === "agentx-staging-boundary")!;
    return boundaryWithSids(policy.Properties.PolicyDocument!.Statement).find((statement) => statement.Sid === "AssumeOrgRoles")!;
  };

  it("with no organization id configured, keeps the account-only exclusion", () => {
    expect(boundaryStatement({}).Condition!.StringNotEquals).toEqual({ "aws:ResourceAccount": { Ref: "AWS::AccountId" } });
  });

  it("with agentxRovaraOrgId, excludes the organization's accounts as well", () => {
    expect(boundaryStatement({ agentxRovaraOrgId: "o-abc123def4" }).Condition!.StringNotEquals).toEqual({ "aws:ResourceAccount": { Ref: "AWS::AccountId" }, "aws:ResourceOrgID": "o-abc123def4" });
  });

  it("names the three roles by ARN built from the partition and account of the deploy", () => {
    const principals = boundaryStatement({}).Condition!.ArnLike!["aws:PrincipalArn"] as unknown[];
    expect(principals.map(flatten)).toEqual([
      "arn:aws:iam::111122223333:role/agentx/staging/agentx-staging-broker-role",
      "arn:aws:iam::111122223333:role/agentx/staging/agentx-staging-model-proxy-task",
      "arn:aws:iam::111122223333:role/agentx/staging/agentx-staging-model-access-probe",
    ]);
  });

  it("refuses a malformed organization id at synth", () => {
    expect(() => boundaryStatement({ agentxRovaraOrgId: "not-an-org" })).toThrow(/organization id/i);
  });
});
