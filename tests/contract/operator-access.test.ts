/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- reads untyped synthesised CloudFormation JSON */
// Enterprise foundations, N6: the standing Rovara operator role. These tests read what the synthesised role CAN and CANNOT do by evaluating its policy
// (explicit Deny, then Allow, then implicit deny) against concrete requests, so a deny that is present but ineffective is caught, not only a missing one.
import { existsSync, mkdirSync } from "node:fs";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { parseOperatorAccessContext } from "../../infra/lib/operator-access.js";
import { evaluate } from "../support/cfn-evaluate.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();
if (!existsSync("packages/web/dist/app/assets")) mkdirSync("packages/web/dist/app/assets", { recursive: true });

const PRINCIPAL = "arn:aws:iam::210987654321:role/rovara-operators";
const EXTERNAL_ID = "ext-id-held-by-the-customer-0001";
const ENT = { agentxEnv: "ent", rovaraEdition: "enterprise", rovaraEnterpriseEgressCidrs: "10.99.0.0/16", agentxAuditTsa: "off" } as const;
const ON = { ...ENT, rovaraOperatorAccess: "enabled", rovaraOperatorPrincipalArn: PRINCIPAL, rovaraOperatorExternalId: EXTERNAL_ID } as const;

function access(context: Record<string, unknown>): Template {
  const app = buildAgentXApp(context);
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXAccess")!;
  return Template.fromStack(stack);
}
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const resources = (template: Template, type: string): Array<[string, Json]> => Object.entries(template.toJSON().Resources as Record<string, Json>).filter(([, r]) => r.Type === type);

const BUCKET = "customer-approved-bundles";
/** The operator role's policy statements for a parameter value, intrinsics resolved. */
function statementsFor(template: Template, state: "enabled" | "suspended"): Json[] {
  const json = template.toJSON();
  const [bucketId] = resources(template, "AWS::S3::Bucket").find(([id]) => id.includes("ApprovedBundles"))!;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== "object") return value;
    const entries = Object.entries(value as Json);
    if (entries.length === 1 && entries[0]![0] === "Fn::GetAtt" && (entries[0]![1] as string[])[0] === bucketId) return `arn:aws:s3:::${BUCKET}`;
    return Object.fromEntries(entries.map(([k, v]) => [k, walk(v)]));
  };
  const role = resources(template, "AWS::IAM::Role").find(([, r]) => r.Properties.RoleName === "agentx-ent-rovara-operator")![1];
  const context = { parameters: { OperatorAccessState: state, [bucketId]: BUCKET }, conditions: json.Conditions as Record<string, unknown> };
  const policy = evaluate(walk(role.Properties.Policies[0].PolicyDocument), context) as { Statement: Array<Json | undefined> };
  return policy.Statement.filter((statement): statement is Json => statement !== undefined);
}

// A small IAM evaluator: Action/NotAction/Resource/NotResource wildcards and the string condition operators the policy uses.
const wild = (pattern: string, value: string): boolean => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i").test(value);
const list = (value: unknown): string[] => (value === undefined ? [] : Array.isArray(value) ? (value as string[]) : [value as string]);
function conditionHolds(condition: Json | undefined, context: Record<string, string>): boolean {
  for (const [operator, keys] of Object.entries(condition ?? {})) {
    for (const [key, expected] of Object.entries(keys as Json)) {
      const actual = context[key];
      const values = list(expected);
      let ok: boolean;
      if (operator === "StringEquals") ok = actual !== undefined && values.includes(actual);
      else if (operator === "StringLike") ok = actual !== undefined && values.some((v) => wild(v, actual));
      else if (operator === "StringNotEquals") ok = actual === undefined || !values.includes(actual);
      else if (operator === "StringNotLike") ok = actual === undefined || !values.some((v) => wild(v, actual));
      else throw new Error(`test evaluator: operator ${operator}`);
      if (!ok) return false;
    }
  }
  return true;
}
function matches(statement: Json, action: string, resource: string, context: Record<string, string>): boolean {
  const actionOk = statement.Action !== undefined ? list(statement.Action).some((p) => wild(p, action)) : !list(statement.NotAction).some((p) => wild(p, action));
  const resourceOk = statement.Resource !== undefined ? list(statement.Resource).some((p) => wild(p, resource)) : !list(statement.NotResource).some((p) => wild(p, resource));
  return actionOk && resourceOk && conditionHolds(statement.Condition as Json | undefined, context);
}
function allowed(statements: Json[], action: string, resource: string, context: Record<string, string> = {}): boolean {
  const hits = statements.filter((statement) => matches(statement, action, resource, context));
  if (hits.some((statement) => statement.Effect === "Deny")) return false;
  return hits.some((statement) => statement.Effect === "Allow");
}

const ARN = (service: string, rest: string, region = "us-east-1") => `arn:aws:${service}:${service === "s3" ? "" : region}:${service === "s3" ? "" : "123456789012"}:${rest}`;
const DEPLOY_ROLE = "arn:aws:iam::123456789012:role/agentx-ent-cloudformation";
const STACK = (name: string) => `arn:aws:cloudformation:us-east-1:123456789012:stack/agentx-ent-${name}/uuid`;
const APPROVED_URL = `https://${BUCKET}.s3.us-east-1.amazonaws.com/approved/${"a".repeat(64)}/templates/control-plane.template.json`;

describe("the Rovara operator role", () => {
  const template = access(ON);
  const enabled = statementsFor(template, "enabled");

  describe("existence", () => {
    it("is absent unless the install asks for it: Public and Enterprise without the setting create nothing of it", () => {
      for (const context of [ENT, { agentxEnv: "pub", agentxCloud: true, rovaraEdition: "public" }, { agentxEnv: "legacyish" }]) {
        const t = access(context);
        expect(resources(t, "AWS::IAM::Role").some(([, r]) => String(r.Properties.RoleName).includes("rovara-operator")), JSON.stringify(context)).toBe(false);
        expect(JSON.stringify(t.toJSON())).not.toMatch(/rovara-operator|ApprovedBundles|OperatorAccessState/);
      }
    });

    it("refuses to be asked for outside Enterprise, or with settings that do not name one role and one external id", () => {
      expect(() => access({ agentxEnv: "pub", agentxCloud: true, rovaraEdition: "public", rovaraOperatorAccess: "enabled", rovaraOperatorPrincipalArn: PRINCIPAL, rovaraOperatorExternalId: EXTERNAL_ID })).toThrow(/Enterprise setting/);
      expect(() => access({ agentxEnv: "legacyish", rovaraOperatorAccess: "enabled", rovaraOperatorPrincipalArn: PRINCIPAL, rovaraOperatorExternalId: EXTERNAL_ID })).toThrow(/Enterprise setting/);
      for (const principal of [undefined, "arn:aws:iam::210987654321:root", "arn:aws:iam::210987654321:user/someone", "*", "arn:aws:iam::210987654321:role/*", "210987654321"]) {
        expect(() => access({ ...ON, rovaraOperatorPrincipalArn: principal }), String(principal)).toThrow(/rovaraOperatorPrincipalArn/);
      }
      for (const externalId of [undefined, "short", "x".repeat(2000), "has space in it 123456"]) expect(() => access({ ...ON, rovaraOperatorExternalId: externalId }), String(externalId)).toThrow(/rovaraOperatorExternalId/);
      expect(() => access({ ...ON, rovaraOperatorAccess: "on" })).toThrow(/disabled, enabled or suspended/);
      expect(() => access({ ...ENT, rovaraOperatorPrincipalArn: PRINCIPAL })).toThrow(/is not enabled/);
    });

    it("lets only log groups that hold no content be named", () => {
      const parse = (groups: string) => parseOperatorAccessContext({ edition: "enterprise", env: "ent", workerLogGroup: "/agentx/ent/worker", get: (key) => ({ rovaraOperatorAccess: "enabled", rovaraOperatorPrincipalArn: PRINCIPAL, rovaraOperatorExternalId: EXTERNAL_ID, rovaraOperatorLogGroups: groups })[key] });
      expect(parse("/aws/lambda/agentx-ent-doctor").logGroups).toEqual(["/aws/lambda/agentx-ent-doctor"]);
      expect(() => parse("/agentx/ent/worker")).toThrow(/holds task content/);
      expect(() => parse("/agentx/ent/worker/i-123")).toThrow(/holds task content/);
      expect(() => parse("/aws/lambda/*")).toThrow(/exact log groups/);
    });
  });

  describe("who may assume it", () => {
    const [, role] = resources(template, "AWS::IAM::Role").find(([, r]) => r.Properties.RoleName === "agentx-ent-rovara-operator")!;
    const trust = role.Properties.AssumeRolePolicyDocument.Statement;

    it("is one named role, with the customer's external id, MFA, a source identity on every session, and sessions of at most an hour", () => {
      expect(trust).toHaveLength(1);
      expect(trust[0].Principal).toEqual({ AWS: PRINCIPAL });
      expect(trust[0].Action).toEqual(["sts:AssumeRole", "sts:SetSourceIdentity"]);
      expect(trust[0].Condition).toEqual({
        StringEquals: { "sts:ExternalId": EXTERNAL_ID },
        Bool: { "aws:MultiFactorAuthPresent": "true" },
        Null: { "sts:SourceIdentity": "false" },
        StringLike: { "sts:SourceIdentity": "?*" },
      });
      expect(role.Properties.MaxSessionDuration).toBe(3600);
    });

    it("never trusts an account root or a wildcard, and its name and description carry no em dash", () => {
      expect(JSON.stringify(trust)).not.toMatch(/:root|"\*"/);
      expect(JSON.stringify(template.toJSON())).not.toContain("—");
    });
  });

  describe("what it can deploy", () => {
    const create = (url: string, role = DEPLOY_ROLE, stack = STACK("control-plane")) => allowed(enabled, "cloudformation:CreateChangeSet", stack, { "cloudformation:TemplateUrl": url, "cloudformation:RoleArn": role });

    it("can start a deployment from a template under approved/ in the customer's bucket, through the customer's deploy role", () => {
      expect(create(APPROVED_URL)).toBe(true);
      expect(create(`https://s3.us-east-1.amazonaws.com/${BUCKET}/approved/${"a".repeat(64)}/x.json`)).toBe(true);
      expect(allowed(enabled, "cloudformation:ExecuteChangeSet", STACK("control-plane"))).toBe(true);
    });

    it("cannot start a deployment of any other template: another bucket, another prefix, a pasted body, or none", () => {
      expect(create(`https://${BUCKET}.s3.us-east-1.amazonaws.com/unapproved/x.json`)).toBe(false);
      expect(create(`https://${BUCKET}.s3.us-east-1.amazonaws.com/${"approved/"}`.replace("approved/", "approvedx/x.json"))).toBe(false);
      expect(create(`https://attacker-bucket.s3.us-east-1.amazonaws.com/approved/x.json`)).toBe(false);
      expect(create(`https://${BUCKET}.s3.us-east-1.amazonaws.com.evil.example/approved/x.json`)).toBe(false);
      // A template body has no TemplateUrl at all.
      expect(allowed(enabled, "cloudformation:CreateChangeSet", STACK("control-plane"), { "cloudformation:RoleArn": DEPLOY_ROLE })).toBe(false);
    });

    it("cannot deploy through any role but the customer's deploy role", () => {
      expect(create(APPROVED_URL, "arn:aws:iam::123456789012:role/some-admin-role")).toBe(false);
      expect(allowed(enabled, "cloudformation:CreateChangeSet", STACK("control-plane"), { "cloudformation:TemplateUrl": APPROVED_URL })).toBe(false);
      expect(allowed(enabled, "iam:PassRole", DEPLOY_ROLE, { "iam:PassedToService": "cloudformation.amazonaws.com" })).toBe(true);
      expect(allowed(enabled, "iam:PassRole", "arn:aws:iam::123456789012:role/some-admin-role", { "iam:PassedToService": "cloudformation.amazonaws.com" })).toBe(false);
      expect(allowed(enabled, "iam:PassRole", DEPLOY_ROLE, { "iam:PassedToService": "lambda.amazonaws.com" })).toBe(false);
    });

    it("cannot touch the access stack (which holds this role), another account's or environment's stacks, or call the stack APIs directly", () => {
      expect(create(APPROVED_URL, DEPLOY_ROLE, STACK("access"))).toBe(false);
      expect(allowed(enabled, "cloudformation:ExecuteChangeSet", STACK("access"))).toBe(false);
      expect(allowed(enabled, "cloudformation:ExecuteChangeSet", "arn:aws:cloudformation:us-east-1:123456789012:stack/other-team-stack/uuid")).toBe(false);
      for (const action of ["UpdateStack", "CreateStack", "DeleteStack", "SetStackPolicy", "UpdateTerminationProtection", "CreateStackSet"]) expect(allowed(enabled, `cloudformation:${action}`, STACK("control-plane")), action).toBe(false);
    });

    it("reads templates only under approved/, and cannot write to any bucket", () => {
      expect(allowed(enabled, "s3:GetObject", `arn:aws:s3:::${BUCKET}/approved/${"a".repeat(64)}/templates/x.json`)).toBe(true);
      expect(allowed(enabled, "s3:GetObject", `arn:aws:s3:::${BUCKET}/other/x`)).toBe(false);
      expect(allowed(enabled, "s3:GetObject", "arn:aws:s3:::agentx-ent-artifacts/screenshots/task.png")).toBe(false);
      expect(allowed(enabled, "s3:PutObject", `arn:aws:s3:::${BUCKET}/approved/${"b".repeat(64)}/templates/x.json`)).toBe(false);
      expect(allowed(enabled, "s3:DeleteObject", `arn:aws:s3:::${BUCKET}/approved/x`)).toBe(false);
      expect(allowed(enabled, "s3:PutBucketPolicy", `arn:aws:s3:::${BUCKET}`)).toBe(false);
      // Listing is allowed for the approval bucket under approved/ only.
      expect(allowed(enabled, "s3:ListBucket", `arn:aws:s3:::${BUCKET}`, { "s3:prefix": "approved/" })).toBe(true);
      expect(allowed(enabled, "s3:ListBucket", `arn:aws:s3:::${BUCKET}`, { "s3:prefix": "secrets/" })).toBe(false);
      expect(allowed(enabled, "s3:ListBucket", "arn:aws:s3:::agentx-ent-artifacts", { "s3:prefix": "approved/" })).toBe(false);
    });
  });

  describe("what it can never do", () => {
    const denied = (action: string, resource = "*", context: Record<string, string> = {}) => expect(allowed(enabled, action, resource, context), action).toBe(false);

    it("makes no IAM change, assumes no other role, and cannot widen itself", () => {
      for (const action of ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:UpdateAssumeRolePolicy", "iam:DeleteRolePermissionsBoundary", "iam:CreateAccessKey", "iam:TagRole", "iam:CreatePolicyVersion"]) denied(action, "arn:aws:iam::123456789012:role/agentx-ent-rovara-operator");
      for (const action of ["sts:AssumeRole", "sts:GetFederationToken", "sts:TagSession"]) denied(action, "arn:aws:iam::123456789012:role/agentx-ent-operator");
    });

    it("has no shell on, or copy of, a worker", () => {
      for (const action of ["ssm:StartSession", "ssm:SendCommand", "ssm:ResumeSession", "ec2:GetConsoleOutput", "ec2:CreateSnapshot", "ec2:CreateImage", "ec2-instance-connect:SendSSHPublicKey", "ebs:GetSnapshotBlock"]) denied(action);
    });

    it("cannot read or replace function code, read secret values, or use a key", () => {
      for (const action of ["lambda:GetFunction", "lambda:GetFunctionConfiguration", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration", "lambda:InvokeFunction"]) denied(action);
      for (const action of ["secretsmanager:GetSecretValue", "secretsmanager:BatchGetSecretValue", "secretsmanager:PutSecretValue"]) denied(action);
      for (const action of ["kms:Decrypt", "kms:GenerateDataKey", "kms:CreateGrant", "kms:PutKeyPolicy"]) denied(action);
    });

    it("has no data-plane read of the stores that hold code, tasks, plans, conversations and the Team record", () => {
      for (const action of ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:BatchGetItem", "dynamodb:ExecuteStatement", "dynamodb:PartiQLSelect", "dynamodb:ExportTableToPointInTime", "dynamodb:PutItem"]) denied(action, "arn:aws:dynamodb:us-east-1:123456789012:table/agentx-ent-tasks");
      for (const action of ["sqs:ReceiveMessage", "states:GetExecutionHistory", "bedrock:InvokeModel", "s3vectors:QueryVectors", "athena:GetQueryResults"]) denied(action);
    });

    it("cannot read log lines, because they can carry task text (no group is named by default)", () => {
      for (const action of ["logs:GetLogEvents", "logs:FilterLogEvents", "logs:StartQuery", "logs:StartLiveTail"]) denied(action, ARN("logs", "log-group:/agentx/ent/worker:*"));
      denied("logs:FilterLogEvents", ARN("logs", "log-group:/aws/lambda/agentx-ent-doctor:*"));
    });

    it("can read the named content-free log groups and no others, when the install names some", () => {
      const named = statementsFor(access({ ...ON, rovaraOperatorLogGroups: "/aws/lambda/agentx-ent-doctor" }), "enabled");
      expect(allowed(named, "logs:FilterLogEvents", ARN("logs", "log-group:/aws/lambda/agentx-ent-doctor:*"))).toBe(true);
      expect(allowed(named, "logs:FilterLogEvents", ARN("logs", "log-group:/agentx/ent/worker:*"))).toBe(false);
      expect(allowed(named, "logs:FilterLogEvents", ARN("logs", "log-group:/aws/lambda/agentx-ent-broker:*"))).toBe(false);
    });

    it("can read the install's records and health, and load images into its own bundle repositories only", () => {
      expect(allowed(enabled, "ssm:GetParameter", ARN("ssm", "parameter/agentx/ent/settings"))).toBe(true);
      expect(allowed(enabled, "ssm:PutParameter", ARN("ssm", "parameter/agentx/ent/restore-points/20261031T101500000Z"))).toBe(true);
      expect(allowed(enabled, "ssm:PutParameter", ARN("ssm", "parameter/agentx/ent/signin"))).toBe(false);
      expect(allowed(enabled, "ssm:GetParameter", ARN("ssm", "parameter/agentx/other/settings"))).toBe(false);
      expect(allowed(enabled, "ecr:PutImage", ARN("ecr", "repository/rovara-bundle/ent/litellm"))).toBe(true);
      expect(allowed(enabled, "ecr:PutImage", ARN("ecr", "repository/agentx-worker-production"))).toBe(false);
      expect(allowed(enabled, "cloudwatch:GetMetricData", "*")).toBe(true);
      expect(allowed(enabled, "cloudformation:DescribeStackEvents", STACK("control-plane"))).toBe(true);
    });

    it("has no allow statement with a wildcard action, and no allow of any IAM action but passing the deploy role", () => {
      for (const statement of enabled.filter((s) => s.Effect === "Allow")) {
        for (const action of list(statement.Action)) {
          expect(action, statement.Sid).not.toMatch(/^\*$|:\*$/);
          if (action.startsWith("iam:")) expect(action).toBe("iam:PassRole");
        }
      }
    });
  });

  describe("the customer's switches", () => {
    it("suspended: every request is denied, including the ones enabled allows, in sessions already open", () => {
      const suspended = statementsFor(template, "suspended");
      expect(suspended.find((statement) => statement.Sid === "SuspendedByCustomer")).toMatchObject({ Effect: "Deny", Action: "*", Resource: "*" });
      expect(allowed(enabled, "cloudformation:DescribeStacks", STACK("control-plane"))).toBe(true);
      expect(allowed(suspended, "cloudformation:DescribeStacks", STACK("control-plane"))).toBe(false);
      expect(allowed(suspended, "cloudformation:CreateChangeSet", STACK("control-plane"), { "cloudformation:TemplateUrl": APPROVED_URL, "cloudformation:RoleArn": DEPLOY_ROLE })).toBe(false);
      expect(allowed(suspended, "sts:GetCallerIdentity", "*")).toBe(false);
      expect(enabled.find((statement) => statement.Sid === "SuspendedByCustomer")).toBeUndefined();
    });

    it("is a parameter the customer sets with its own admin credentials; it starts as the install says, and only two values are accepted", () => {
      const parameter = template.toJSON().Parameters.OperatorAccessState;
      expect(parameter).toMatchObject({ Type: "String", Default: "enabled", AllowedValues: ["enabled", "suspended"] });
      const born = access({ ...ON, rovaraOperatorAccess: "suspended" });
      expect(born.toJSON().Parameters.OperatorAccessState.Default).toBe("suspended");
      expect(statementsFor(born, "suspended").some((statement) => statement.Sid === "SuspendedByCustomer")).toBe(true);
    });

    it("keeps the approval bucket customer-owned: private, versioned, TLS only, kept on delete, and written by neither the operator nor the deploy role", () => {
      const [, bucket] = resources(template, "AWS::S3::Bucket").find(([id]) => id.includes("ApprovedBundles"))!;
      expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
      expect(bucket.Properties.VersioningConfiguration).toEqual({ Status: "Enabled" });
      expect(bucket.DeletionPolicy).toMatch(/Retain/);
      const policy = resources(template, "AWS::S3::BucketPolicy").find(([, p]) => JSON.stringify(p.Properties.PolicyDocument).includes("OnlyTheCustomerWritesApprovals"))![1].Properties.PolicyDocument.Statement as Json[];
      const deny = policy.find((statement) => statement.Sid === "OnlyTheCustomerWritesApprovals")!;
      expect(deny.Effect).toBe("Deny");
      expect(JSON.stringify(deny.Condition)).toContain("agentx-ent-rovara-operator");
      expect(JSON.stringify(deny.Condition)).toContain("agentx-ent-cloudformation");
      expect(list(deny.Action)).toEqual(expect.arrayContaining(["s3:PutObject*", "s3:DeleteObject*", "s3:PutBucketPolicy".replace("PutBucketPolicy", "PutBucket*")]));
      expect(JSON.stringify(policy)).toContain("aws:SecureTransport");
    });

    it("gives the deploy role read access to the approved templates, and nothing else is added to it", () => {
      const deployRole = resources(template, "AWS::IAM::Role").find(([, r]) => r.Properties.RoleName === "agentx-ent-cloudformation")![1];
      const names = (deployRole.Properties.Policies as Json[]).map((policy) => policy.PolicyName);
      expect(names).toEqual(["deploy", "read-approved-bundles"]);
      const extra = (deployRole.Properties.Policies as Json[])[1]!.PolicyDocument.Statement as Json[];
      for (const statement of extra) expect(list(statement.Action).every((action) => action === "s3:GetObject" || action === "s3:GetObjectVersion" || action === "s3:ListBucket")).toBe(true);
    });

    it("reports every assumption to the customer's alert topic", () => {
      const [, rule] = resources(template, "AWS::Events::Rule").find(([, r]) => r.Properties.Name === "agentx-ent-rovara-operator-assumed")!;
      expect(rule.Properties.EventPattern.detail.eventName).toEqual(["AssumeRole"]);
      expect(JSON.stringify(rule.Properties.EventPattern.detail.requestParameters.roleArn)).toContain("role/agentx-ent-rovara-operator");
      const [topicId] = resources(template, "AWS::SNS::Topic").find(([, topic]) => topic.Properties.TopicName === "agentx-ent-rovara-operator-use")!;
      expect(rule.Properties.Targets).toEqual([{ Arn: { Ref: topicId }, Id: "Target0" }]);
      const topicPolicy = resources(template, "AWS::SNS::TopicPolicy").find(([, p]) => JSON.stringify(p.Properties.Topics).includes(topicId))![1];
      expect(JSON.stringify(topicPolicy.Properties.PolicyDocument)).toContain("events.amazonaws.com");
    });

    it("keeps the role's policy within IAM's 10,240-character limit for inline role policies", () => {
      const [, role] = resources(template, "AWS::IAM::Role").find(([, r]) => r.Properties.RoleName === "agentx-ent-rovara-operator")!;
      expect(JSON.stringify(role.Properties.Policies).replace(/\s/g, "").length).toBeLessThan(10_240);
    });
  });
});
