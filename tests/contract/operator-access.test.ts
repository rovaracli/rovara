/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- reads untyped synthesised CloudFormation JSON */
// Enterprise foundations, N6: the standing Rovara operator role. These tests read what the synthesised role CAN and CANNOT do by evaluating its policy
// (explicit Deny, then Allow, then implicit deny) against concrete requests, so a deny that is present but ineffective is caught, not only a missing one.
import { existsSync, mkdirSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { OperatorAccess, parseOperatorAccessContext } from "../../infra/lib/operator-access.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { evaluate } from "../support/cfn-evaluate.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();
if (!existsSync("packages/web/dist/app/assets")) mkdirSync("packages/web/dist/app/assets", { recursive: true });

const PRINCIPAL = "arn:aws:iam::210987654321:role/rovara-operators";
const EXTERNAL_ID = "ext-id-held-by-the-customer-0001";
const ENT = { agentxEnv: "ent", rovaraEdition: "enterprise", rovaraEnterpriseEgressCidrs: "10.99.0.0/16", agentxAuditTsa: "off" } as const;
const APPROVERS = "arn:aws:iam::123456789012:role/security-approvers";
const ON = { ...ENT, rovaraOperatorAccess: "enabled", rovaraOperatorPrincipalArn: PRINCIPAL, rovaraOperatorExternalId: EXTERNAL_ID, rovaraBundleApproverArns: APPROVERS } as const;

function access(context: Record<string, unknown>): Template {
  const app = buildAgentXApp(context);
  const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.node.id === "AgentXAccess")!;
  return Template.fromStack(stack);
}
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const resources = (template: Template, type: string): Array<[string, Json]> => Object.entries(template.toJSON().Resources as Record<string, Json>).filter(([, r]) => r.Type === type);


const BUCKET = "customer-approved-bundles";
const FUNCTION_NAME = "agentx-ent-bundle-deployer";
const DEPLOYER_ARN = `arn:aws:lambda:us-east-1:123456789012:function:${FUNCTION_NAME}`;
const walkGetAtt = (template: Template) => {
  const resourcesJson = template.toJSON().Resources as Record<string, Json>;
  const arnOf = (id: string): string | undefined => {
    const type = resourcesJson[id]?.Type as string | undefined;
    if (type === "AWS::S3::Bucket") return `arn:aws:s3:::${BUCKET}`;
    if (type === "AWS::Lambda::Function") return DEPLOYER_ARN;
    if (type === "AWS::Logs::LogGroup") return `arn:aws:logs:us-east-1:123456789012:log-group:${resourcesJson[id]!.Properties.LogGroupName as string}`;
    return undefined;
  };
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== "object") return value;
    const entries = Object.entries(value as Json);
    if (entries.length === 1 && entries[0]![0] === "Fn::GetAtt") {
      const found = arnOf((entries[0]![1] as string[])[0]!);
      if (found !== undefined) return found;
    }
    return Object.fromEntries(entries.map(([k, v]) => [k, walk(v)]));
  };
  const entries = Object.entries(resourcesJson);
  const buckets = entries.filter(([, r]) => r.Type === "AWS::S3::Bucket").map(([id]) => [id, BUCKET] as const);
  const topics = entries.filter(([, r]) => r.Type === "AWS::SNS::Topic").map(([id]) => [id, "arn:aws:sns:us-east-1:123456789012:alerts"] as const);
  return { walk, parameters: Object.fromEntries([...buckets, ...topics]) };
};
/** A role's policy statements for a parameter value, intrinsics resolved. */
function resolve(template: Template, document: unknown, state: "enabled" | "suspended"): Json[] {
  const { walk, parameters } = walkGetAtt(template);
  const context = { parameters: { OperatorAccessState: state, ...parameters }, conditions: (template.toJSON()).Conditions as Record<string, unknown> };
  const policy = evaluate(walk(document), context) as { Statement: Array<Json | undefined> };
  return policy.Statement.filter((statement): statement is Json => statement !== undefined);
}
function statementsFor(template: Template, state: "enabled" | "suspended"): Json[] {
  const role = resources(template, "AWS::IAM::Role").find(([, r]) => r.Properties.RoleName === "agentx-ent-rovara-operator")![1];
  return resolve(template, role.Properties.Policies[0].PolicyDocument, state);
}
/** The deployer's role policy (an AWS::IAM::Policy attached to its role). */
function deployerStatements(template: Template): Json[] {
  const [roleId] = resources(template, "AWS::IAM::Role").find(([, r]) => r.Properties.RoleName === "agentx-ent-bundle-deployer")!;
  const policy = resources(template, "AWS::IAM::Policy").find(([, p]) => JSON.stringify(p.Properties.Roles).includes(roleId))![1];
  return resolve(template, policy.Properties.PolicyDocument, "enabled");
}
/** What a policy someone attaches later could add: everything. The explicit Denies must still hold. */
const withBroadAllow = (statements: Json[]): Json[] => [...statements, { Effect: "Allow", Action: "*", Resource: "*" }];

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
const STACK = (name: string) => `arn:aws:cloudformation:us-east-1:123456789012:stack/agentx-${name}/uuid`;
const PARTS = ["foundation", "identity", "runtime", "control-plane", "slack"];

describe("the Rovara operator role", () => {
  const template = access(ON);
  const enabled = statementsFor(template, "enabled");

  describe("existence", () => {
    it("is absent unless the install asks for it: Public and Enterprise without the setting create nothing of it", () => {
      for (const context of [ENT, { agentxEnv: "pub", agentxCloud: true, rovaraEdition: "public" }, { agentxEnv: "legacyish" }]) {
        const t = access(context);
        expect(resources(t, "AWS::IAM::Role").some(([, r]) => /rovara-operator|bundle-deployer/.test(String(r.Properties.RoleName))), JSON.stringify(context)).toBe(false);
        expect(JSON.stringify(t.toJSON())).not.toMatch(/rovara-operator|ApprovedBundles|OperatorAccessState|bundle-deployer|bundle-trust/);
        expect(resources(t, "AWS::Lambda::Function")).toEqual([]);
      }
    });

    it("refuses to be asked for outside Enterprise, or with settings that do not name one role and one external id", () => {
      expect(() => access({ agentxEnv: "pub", agentxCloud: true, rovaraEdition: "public", rovaraOperatorAccess: "enabled", rovaraOperatorPrincipalArn: PRINCIPAL, rovaraOperatorExternalId: EXTERNAL_ID, rovaraBundleApproverArns: APPROVERS })).toThrow(/Enterprise setting/);
      expect(() => access({ agentxEnv: "legacyish", rovaraOperatorAccess: "enabled", rovaraOperatorPrincipalArn: PRINCIPAL, rovaraOperatorExternalId: EXTERNAL_ID, rovaraBundleApproverArns: APPROVERS })).toThrow(/Enterprise setting/);
      for (const principal of [undefined, "arn:aws:iam::210987654321:root", "arn:aws:iam::210987654321:user/someone", "*", "arn:aws:iam::210987654321:role/*", "210987654321"]) {
        expect(() => access({ ...ON, rovaraOperatorPrincipalArn: principal }), String(principal)).toThrow(/rovaraOperatorPrincipalArn/);
      }
      for (const externalId of [undefined, "short", "x".repeat(2000), "has space in it 123456"]) expect(() => access({ ...ON, rovaraOperatorExternalId: externalId }), String(externalId)).toThrow(/rovaraOperatorExternalId/);
      expect(() => access({ ...ON, rovaraOperatorAccess: "on" })).toThrow(/disabled, enabled or suspended/);
      expect(() => access({ ...ENT, rovaraOperatorPrincipalArn: PRINCIPAL })).toThrow(/is not enabled/);
      expect(() => access({ ...ENT, rovaraBundleSigningKeys: "[]" })).toThrow(/is not enabled/);
    });

    it("lets only log groups that hold no content be named", () => {
      const parse = (groups: string) => parseOperatorAccessContext({ edition: "enterprise", env: "ent", workerLogGroup: "/agentx/ent/worker", get: (key) => ({ rovaraOperatorAccess: "enabled", rovaraOperatorPrincipalArn: PRINCIPAL, rovaraOperatorExternalId: EXTERNAL_ID, rovaraBundleApproverArns: APPROVERS, rovaraOperatorLogGroups: groups })[key] });
      expect(parse("/aws/lambda/agentx-ent-doctor").logGroups).toEqual(["/aws/lambda/agentx-ent-doctor"]);
      expect(() => parse("/agentx/ent/worker")).toThrow(/holds task content/);
      expect(() => parse("/agentx/ent/worker/i-123")).toThrow(/holds task content/);
      expect(() => parse("/aws/lambda/*")).toThrow(/exact log groups/);
    });
  });

  describe("who may assume it", () => {
    const [, role] = resources(template, "AWS::IAM::Role").find(([, r]) => r.Properties.RoleName === "agentx-ent-rovara-operator")!;
    const trust = role.Properties.AssumeRolePolicyDocument.Statement;

    it("is one named role, with the customer's external id, MFA, a source identity on every session, only through the install's region, and sessions of at most an hour", () => {
      expect(trust).toHaveLength(1);
      expect(trust[0].Principal).toEqual({ AWS: PRINCIPAL });
      expect(trust[0].Action).toEqual(["sts:AssumeRole", "sts:SetSourceIdentity"]);
      expect(trust[0].Condition).toEqual({
        StringEquals: { "sts:ExternalId": EXTERNAL_ID, "aws:RequestedRegion": { Ref: "AWS::Region" } },
        Bool: { "aws:MultiFactorAuthPresent": "true" },
        Null: { "sts:SourceIdentity": "false" },
        StringLike: { "sts:SourceIdentity": "?*" },
      });
      expect(role.Properties.MaxSessionDuration).toBe(3600);
    });

    it("never trusts an account root or a wildcard, and no name or description carries an em dash", () => {
      expect(JSON.stringify(trust)).not.toMatch(/:root|"\*"/);
      expect(JSON.stringify(template.toJSON())).not.toContain("—");
    });
  });

  describe("what it can start (review C1: it no longer chooses a template, a stack or a parameter)", () => {
    it("can invoke the customer-owned deployer, and nothing else it could invoke", () => {
      expect(allowed(enabled, "lambda:InvokeFunction", DEPLOYER_ARN)).toBe(true);
      expect(allowed(enabled, "lambda:InvokeFunction", `${DEPLOYER_ARN}:1`)).toBe(false); // a qualified ARN is not the deployer's
      expect(allowed(enabled, "lambda:InvokeFunction", ARN("lambda", "function:agentx-ent-broker"))).toBe(false);
      expect(allowed(enabled, "lambda:InvokeFunction", ARN("lambda", "function:agentx-ent-bundle-deployer-copy"))).toBe(false);
    });

    it("makes no CloudFormation change itself, whatever template, role or stack it names: it holds no create, execute, update or delete", () => {
      const context = { "cloudformation:TemplateUrl": `https://${BUCKET}.s3.us-east-1.amazonaws.com/approved/${"a".repeat(64)}/x.json`, "cloudformation:RoleArn": DEPLOY_ROLE };
      for (const action of ["CreateChangeSet", "ExecuteChangeSet", "DeleteChangeSet", "UpdateStack", "CreateStack", "DeleteStack", "SetStackPolicy", "UpdateTerminationProtection", "CreateStackSet"]) {
        for (const stack of ["control-plane", "slack", "access"]) expect(allowed(withBroadAllow(enabled), `cloudformation:${action}`, STACK(`ent-${stack}`), context), `${action} ${stack}`).toBe(false);
      }
    });

    it("reads status of this environment's stacks by exact name: an environment whose name starts with this one's (ent-x) is not reachable", () => {
      for (const part of [...PARTS, "access"]) expect(allowed(enabled, "cloudformation:DescribeStacks", STACK(`ent-${part}`)), part).toBe(true);
      for (const part of [...PARTS, "access"]) expect(allowed(enabled, "cloudformation:DescribeStacks", STACK(`ent-x-${part}`)), `ent-x ${part}`).toBe(false);
      expect(allowed(enabled, "cloudformation:DescribeStacks", STACK("ent-anything"))).toBe(false);
      expect(JSON.stringify(enabled.filter((statement) => statement.Effect === "Allow" && JSON.stringify(statement.Action).includes("cloudformation")).map((s) => s.Resource))).not.toMatch(/agentx-ent-\*|stack\/\*/);
    });

    it("has no S3 access at all (the deployer reads the approvals), and cannot write any record: settings, the installed-bundle record, restore points", () => {
      for (const action of ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket", "s3:PutObject", "s3:DeleteObject", "s3:PutBucketPolicy"]) {
        expect(allowed(enabled, action, `arn:aws:s3:::${BUCKET}/approved/x`, { "s3:prefix": "approved/" }), action).toBe(false);
        expect(allowed(withBroadAllow(enabled), action, `arn:aws:s3:::${BUCKET}/approved/x`), `${action} (with a broad allow)`).toBe(false);
      }
      for (const name of ["settings", "bundle", "lock", "restore-points/20261031T101500000Z", "bundle-trust/public-keys", "signin"]) {
        for (const action of ["ssm:PutParameter", "ssm:DeleteParameter"]) {
          expect(allowed(enabled, action, ARN("ssm", `parameter/agentx/ent/${name}`)), `${action} ${name}`).toBe(false);
          expect(allowed(withBroadAllow(enabled), action, ARN("ssm", `parameter/agentx/ent/${name}`)), `${action} ${name} (with a broad allow)`).toBe(false);
        }
        expect(allowed(enabled, "ssm:GetParameter", ARN("ssm", `parameter/agentx/ent/${name}`)), `get ${name}`).toBe(false);
      }
    });

    it("cannot push to any registry repository, nor pass any role", () => {
      for (const resource of [ARN("ecr", "repository/rovara-bundle/ent/litellm"), ARN("ecr", "repository/agentx-worker-production")]) {
        expect(allowed(enabled, "ecr:PutImage", resource)).toBe(false);
        expect(allowed(withBroadAllow(enabled), "ecr:PutImage", resource)).toBe(false);
        expect(allowed(withBroadAllow(enabled), "ecr:UploadLayerPart", resource)).toBe(false);
      }
      for (const role of [DEPLOY_ROLE, "arn:aws:iam::123456789012:role/some-admin-role"]) {
        expect(allowed(enabled, "iam:PassRole", role, { "iam:PassedToService": "cloudformation.amazonaws.com" })).toBe(false);
        expect(allowed(withBroadAllow(enabled), "iam:PassRole", role, { "iam:PassedToService": "cloudformation.amazonaws.com" })).toBe(false);
      }
    });
  });

  describe("what it can never do, even if someone later attaches a policy that allows everything", () => {
    const denied = (action: string, resource = "*", context: Record<string, string> = {}) => {
      expect(allowed(enabled, action, resource, context), action).toBe(false);
      expect(allowed(withBroadAllow(enabled), action, resource, context), `${action} (with a broad allow)`).toBe(false);
    };

    it("makes no IAM change, assumes no other role, and cannot widen itself", () => {
      for (const action of ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:UpdateAssumeRolePolicy", "iam:DeleteRolePermissionsBoundary", "iam:CreateAccessKey", "iam:TagRole", "iam:CreatePolicyVersion", "iam:PassRole"]) denied(action, "arn:aws:iam::123456789012:role/agentx-ent-rovara-operator");
      for (const action of ["sts:AssumeRole", "sts:GetFederationToken", "sts:TagSession"]) denied(action, "arn:aws:iam::123456789012:role/agentx-ent-operator");
    });

    it("has no shell on, or copy of, a worker", () => {
      for (const action of ["ssm:StartSession", "ssm:SendCommand", "ssm:ResumeSession", "ec2:GetConsoleOutput", "ec2:CreateSnapshot", "ec2:CreateImage", "ec2-instance-connect:SendSSHPublicKey", "ebs:GetSnapshotBlock"]) denied(action);
    });

    it("cannot read or replace any function's code, read secret values, or use a key", () => {
      for (const action of ["lambda:GetFunction", "lambda:GetFunctionConfiguration", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration"]) {
        denied(action, ARN("lambda", "function:agentx-ent-broker"));
        denied(action, DEPLOYER_ARN);
      }
      denied("lambda:InvokeFunction", ARN("lambda", "function:agentx-ent-broker"));
      for (const action of ["secretsmanager:GetSecretValue", "secretsmanager:BatchGetSecretValue", "secretsmanager:PutSecretValue"]) denied(action);
      for (const action of ["kms:Decrypt", "kms:GenerateDataKey", "kms:CreateGrant", "kms:PutKeyPolicy", "kms:DeriveSharedSecret"]) denied(action);
    });

    it("has no data-plane read of the stores that hold code, tasks, plans, conversations and the Team record", () => {
      for (const action of ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:BatchGetItem", "dynamodb:ExecuteStatement", "dynamodb:BatchExecuteStatement", "dynamodb:ExecuteTransaction", "dynamodb:TransactGetItems", "dynamodb:TransactWriteItems", "dynamodb:PartiQLSelect", "dynamodb:ExportTableToPointInTime", "dynamodb:PutItem"]) denied(action, "arn:aws:dynamodb:us-east-1:123456789012:table/agentx-ent-tasks");
      for (const action of ["sqs:ReceiveMessage", "states:GetExecutionHistory", "bedrock:InvokeModel", "s3vectors:QueryVectors", "athena:GetQueryResults"]) denied(action);
    });

    it("cannot read log lines of anything but the deployer's own group (it names bundle ids and fixed words) and the groups the customer named", () => {
      for (const action of ["logs:GetLogEvents", "logs:FilterLogEvents", "logs:StartQuery", "logs:StartLiveTail"]) denied(action, ARN("logs", "log-group:/agentx/ent/worker:*"));
      denied("logs:FilterLogEvents", ARN("logs", "log-group:/aws/lambda/agentx-ent-doctor:*"));
      expect(allowed(enabled, "logs:FilterLogEvents", ARN("logs", `log-group:/aws/lambda/${FUNCTION_NAME}:*`))).toBe(true);
    });

    it("can read the named content-free log groups and no others, when the install names some", () => {
      const named = statementsFor(access({ ...ON, rovaraOperatorLogGroups: "/aws/lambda/agentx-ent-doctor" }), "enabled");
      expect(allowed(named, "logs:FilterLogEvents", ARN("logs", "log-group:/aws/lambda/agentx-ent-doctor:*"))).toBe(true);
      expect(allowed(named, "logs:FilterLogEvents", ARN("logs", "log-group:/agentx/ent/worker:*"))).toBe(false);
      expect(allowed(withBroadAllow(named), "logs:FilterLogEvents", ARN("logs", "log-group:/aws/lambda/agentx-ent-broker:*"))).toBe(false);
    });

    it("can read health, and has no allow statement with a wildcard action or any IAM action", () => {
      expect(allowed(enabled, "cloudwatch:GetMetricData", "*")).toBe(true);
      expect(allowed(enabled, "cloudformation:DescribeStackEvents", STACK("ent-control-plane"))).toBe(true);
      for (const statement of enabled.filter((s) => s.Effect === "Allow")) {
        for (const action of list(statement.Action)) {
          expect(action, statement.Sid).not.toMatch(/^\*$|:\*$/);
          expect(action.startsWith("iam:"), statement.Sid).toBe(false);
        }
      }
    });
  });

  describe("the customer-owned deployer (review C1, C2, I1, I2)", () => {
    const deployer = deployerStatements(template);
    const deployable = ["foundation", "identity", "runtime", "control-plane", "slack"].map((part) => STACK(`ent-${part}`));
    const url = `https://${BUCKET}.s3.us-east-1.amazonaws.com/deploying/${"a".repeat(64)}/foundation.template.json`;
    const ctx = { "cloudformation:RoleArn": DEPLOY_ROLE, "cloudformation:TemplateUrl": url };

    it("creates change sets only on the five fixed stacks, only through the customer's deploy role, only from its own verified copies", () => {
      for (const stack of deployable) expect(allowed(deployer, "cloudformation:CreateChangeSet", stack, ctx), stack).toBe(true);
      expect(allowed(deployer, "cloudformation:CreateChangeSet", STACK("ent-access"), ctx)).toBe(false);
      expect(allowed(deployer, "cloudformation:CreateChangeSet", STACK("ent-x-control-plane"), ctx)).toBe(false);
      expect(allowed(deployer, "cloudformation:CreateChangeSet", STACK("ent-control-plane"), { ...ctx, "cloudformation:RoleArn": "arn:aws:iam::123456789012:role/other" })).toBe(false);
      expect(allowed(deployer, "cloudformation:CreateChangeSet", STACK("ent-control-plane"), { ...ctx, "cloudformation:TemplateUrl": `https://${BUCKET}.s3.us-east-1.amazonaws.com/approved/x.json` })).toBe(false);
      expect(allowed(deployer, "cloudformation:CreateChangeSet", STACK("ent-control-plane"), { "cloudformation:RoleArn": DEPLOY_ROLE })).toBe(false);
      for (const action of ["CreateStack", "UpdateStack", "DeleteStack", "SetStackPolicy"]) expect(allowed(deployer, `cloudformation:${action}`, STACK("ent-control-plane")), action).toBe(false);
      expect(allowed(deployer, "cloudformation:ExecuteChangeSet", STACK("ent-access"))).toBe(false);
    });

    it("passes the deploy role and no other, and has no other IAM or wildcard action", () => {
      expect(allowed(deployer, "iam:PassRole", DEPLOY_ROLE, { "iam:PassedToService": "cloudformation.amazonaws.com" })).toBe(true);
      expect(allowed(deployer, "iam:PassRole", "arn:aws:iam::123456789012:role/other", { "iam:PassedToService": "cloudformation.amazonaws.com" })).toBe(false);
      for (const statement of deployer.filter((s) => s.Effect === "Allow")) for (const action of list(statement.Action)) {
        expect(action, statement.Sid).not.toMatch(/^\*$|:\*$/);
        if (action.startsWith("iam:")) expect(action).toBe("iam:PassRole");
      }
    });

    it("can read back the exact version of a copy it wrote (the template URL carries ?versionId=), and nothing outside deploying/ beyond the approvals", () => {
      const copy = `arn:aws:s3:::${BUCKET}/deploying/${"a".repeat(64)}/control-plane.template.json`;
      expect(allowed(deployer, "s3:GetObjectVersion", copy)).toBe(true);
      expect(allowed(deployer, "s3:GetObject", copy)).toBe(true);
      expect(allowed(deployer, "s3:GetObjectVersion", `arn:aws:s3:::${BUCKET}/other/x`)).toBe(false);
      expect(allowed(deployer, "s3:DeleteObjectVersion", copy)).toBe(false);
    });

    it("reads the approvals and writes only its own verified copies: it cannot place, change or withdraw an approval", () => {
      expect(allowed(deployer, "s3:GetObjectVersion", `arn:aws:s3:::${BUCKET}/approved/${"a".repeat(64)}/bundle.json`)).toBe(true);
      expect(allowed(deployer, "s3:GetObject", `arn:aws:s3:::${BUCKET}/approvals/${"a".repeat(64)}.json`)).toBe(true);
      expect(allowed(deployer, "s3:PutObject", `arn:aws:s3:::${BUCKET}/deploying/${"a".repeat(64)}/control-plane.template.json`)).toBe(true);
      for (const key of ["approvals/x.json", "approved/x/bundle.json", "other/x"]) expect(allowed(deployer, "s3:PutObject", `arn:aws:s3:::${BUCKET}/${key}`), key).toBe(false);
      expect(allowed(deployer, "s3:DeleteObject", `arn:aws:s3:::${BUCKET}/approvals/x.json`)).toBe(false);
    });

    it("writes only the records an upgrade owns, and reads the trusted keys it cannot write", () => {
      for (const name of ["settings", "bundle", "restore-points/20261031T101500000Z", "deploy/progress"]) expect(allowed(deployer, "ssm:PutParameter", ARN("ssm", `parameter/agentx/ent/${name}`)), name).toBe(true);
      for (const name of ["bundle-trust/public-keys", "signin", "lock", "install/answers"]) expect(allowed(deployer, "ssm:PutParameter", ARN("ssm", `parameter/agentx/ent/${name}`)), name).toBe(false);
      expect(allowed(deployer, "ssm:GetParameter", ARN("ssm", "parameter/agentx/ent/bundle-trust/public-keys"))).toBe(true);
      expect(allowed(deployer, "ssm:DeleteParameter", ARN("ssm", "parameter/agentx/ent/deploy/progress"))).toBe(true);
      expect(allowed(deployer, "ssm:DeleteParameter", ARN("ssm", "parameter/agentx/ent/settings"))).toBe(false);
    });

    it("is one function with a fixed name, a 15 minute limit and only the install's five settings (environment, bucket, deploy role, alert topic, S3 suffix); no caller input reaches its environment", () => {
      const [, fn] = resources(template, "AWS::Lambda::Function").find(([, f]) => f.Properties.FunctionName === FUNCTION_NAME)!;
      expect(fn.Properties.Timeout).toBe(900);
      expect(fn.Properties.Runtime).toBe("nodejs22.x");
      expect(Object.keys(fn.Properties.Environment.Variables as object).filter((name) => !["ROVARA_EDITION", "AWS_NODEJS_CONNECTION_REUSE_ENABLED"].includes(name)).sort()).toEqual(["ALERT_TOPIC_ARN", "APPROVAL_BUCKET", "DEPLOY_ROLE_ARN", "ROVARA_ENV", "URL_SUFFIX"]);
      expect(resources(template, "AWS::Lambda::Permission")).toEqual([]);
      expect(resources(template, "AWS::Lambda::Url")).toEqual([]);
    });
  });

  describe("trust anchor and approvals (review I1, I5, M4)", () => {
    it("keeps the trusted signing keys in the install's own parameter, empty by default so every bundle is refused, set only from the install's settings", () => {
      const parameter = (t: Template) => resources(t, "AWS::SSM::Parameter").find(([, p]) => p.Properties.Name === "/agentx/ent/bundle-trust/public-keys")![1].Properties.Value;
      expect(parameter(template)).toBe("[]");
      const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "pem" }).toString();
      expect(JSON.parse(parameter(access({ ...ON, rovaraBundleSigningKeys: JSON.stringify([key]) })) as string)).toEqual([key]);
      for (const bad of ["not json", JSON.stringify(["junk"]), JSON.stringify([generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey.export({ type: "spki", format: "pem" }).toString()]), JSON.stringify([generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()])]) {
        expect(() => access({ ...ON, rovaraBundleSigningKeys: bad }), bad.slice(0, 20)).toThrow(/rovaraBundleSigningKeys/);
      }
    });

    it("keeps the approval bucket customer-owned: private, versioned, TLS only, kept on delete, never written by the operator, the deploy role or (outside its copies) the deployer", () => {
      const [, bucket] = resources(template, "AWS::S3::Bucket").find(([id]) => id.includes("ApprovedBundles"))!;
      expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
      expect(bucket.Properties.VersioningConfiguration).toEqual({ Status: "Enabled" });
      expect(bucket.DeletionPolicy).toMatch(/Retain/);
      const statements = resources(template, "AWS::S3::BucketPolicy").find(([, p]) => JSON.stringify(p.Properties.PolicyDocument).includes("OperatorAndDeployRoleNeverWrite"))![1].Properties.PolicyDocument.Statement as Json[];
      const never = statements.find((statement) => statement.Sid === "OperatorAndDeployRoleNeverWrite")!;
      expect(never.Effect).toBe("Deny");
      expect(JSON.stringify(never.Condition)).toContain("agentx-ent-rovara-operator");
      expect(JSON.stringify(never.Condition)).toContain("agentx-ent-cloudformation");
      expect(list(never.Action)).toEqual(expect.arrayContaining(["s3:PutObject*", "s3:DeleteObject*", "s3:PutBucket*"]));
      const copies = statements.find((statement) => statement.Sid === "DeployerWritesOnlyItsCopies")!;
      expect(copies.Effect).toBe("Deny");
      expect(JSON.stringify(copies.Condition)).toContain("agentx-ent-bundle-deployer");
      expect(JSON.stringify(copies.NotResource)).toContain("deploying/");
      expect(JSON.stringify(statements)).toContain("aws:SecureTransport");
      expect(statements.find((statement) => statement.Sid === "OnlyNamedApproversApprove")!.Condition).toEqual({ ArnNotLike: { "aws:PrincipalArn": [APPROVERS] } });
    });

    it("requires the approvers to be named: with none, the build stops (the default is that nobody can approve), and the barred roles cannot be named", () => {
      const { rovaraBundleApproverArns: _approvers, ...withoutApprovers } = ON;
      void _approvers;
      expect(() => access(withoutApprovers)).toThrow(/must name the roles or users that may approve/);
      expect(() => access({ ...ON, rovaraBundleApproverArns: "" })).toThrow(/must name the roles or users that may approve/);
      for (const name of ["agentx-ent-rovara-operator", "agentx-ent-cloudformation", "agentx-ent-bundle-deployer", "agentx-ent-*", "agentx-ent-bundle-*"]) {
        expect(() => access({ ...ON, rovaraBundleApproverArns: `arn:aws:iam::123456789012:role/${name}` }), name).toThrow(/cannot approve its own deployments/);
      }
    });

    it("refuses approvers that are Rovara's: the Rovara principal itself (also by wildcard), anything in its account, and mixed or foreign accounts", () => {
      const approve = (arn: string) => access({ ...ON, rovaraBundleApproverArns: arn });
      expect(() => approve("arn:aws:iam::210987654321:role/rovara-operators"), "the principal").toThrow(/Rovara's account/);
      expect(() => approve("arn:aws:iam::210987654321:role/someone-else"), "same account as the principal").toThrow(/Rovara's account/);
      expect(() => approve("arn:aws:iam::123456789012:role/security-approvers,arn:aws:iam::111111111111:role/other"), "two accounts").toThrow(/one account/);
      expect(() => access({ ...ON, rovaraOperatorPrincipalArn: "arn:aws:iam::123456789012:role/rovara-operators", rovaraBundleApproverArns: "arn:aws:iam::123456789012:role/rovara-*" }), "wildcard over the principal").toThrow(/Rovara's account/);
    });

    it("refuses, when the stack's account is known, an approver of another account", () => {
      const app = new App();
      const stack = new Stack(app, "Known", { env: { account: "123456789012", region: "us-east-1" } });
      const settings = { state: "enabled" as const, principalArn: PRINCIPAL, externalId: EXTERNAL_ID, logGroups: [], signingKeys: [], approverArns: ["arn:aws:iam::999999999999:role/approvers"] };
      expect(() => new OperatorAccess(stack, "OA", { naming: environmentNaming("ent"), settings })).toThrow(/not in this install's account 123456789012/);
      const ok = new Stack(app, "Ok", { env: { account: "123456789012", region: "us-east-1" } });
      expect(() => new OperatorAccess(ok, "OA", { naming: environmentNaming("ent"), settings: { ...settings, approverArns: ["arn:aws:iam::123456789012:role/approvers"] } })).not.toThrow();
    });

    it("keeps the deployer's copies (a rollback may need them): only superseded versions expire, never the current object", () => {
      const [, bucket] = resources(template, "AWS::S3::Bucket").find(([id]) => id.includes("ApprovedBundles"))!;
      const rule = (bucket.Properties.LifecycleConfiguration.Rules as Json[]).find((entry) => entry.Prefix === "deploying/")!;
      expect(rule.Status).toBe("Enabled");
      expect(rule.NoncurrentVersionExpiration).toEqual({ NoncurrentDays: 7 });
      expect(rule.ExpirationInDays).toBeUndefined();
      expect(rule.ExpirationDate).toBeUndefined();
      expect((bucket.Properties.LifecycleConfiguration.Rules as Json[]).filter((entry) => entry.ExpirationInDays !== undefined)).toEqual([]);
    });

    it("lets only the deployer write its verified copies (templates and packages): everyone else is denied on deploying/", () => {
      const statements = resources(template, "AWS::S3::BucketPolicy").find(([, p]) => JSON.stringify(p.Properties.PolicyDocument).includes("OnlyTheDeployerWritesCopies"))![1].Properties.PolicyDocument.Statement as Json[];
      const only = statements.find((statement) => statement.Sid === "OnlyTheDeployerWritesCopies")!;
      expect(only.Effect).toBe("Deny");
      // The exemption is exactly one principal, the deployer's role: a single string (not a list), nothing alongside it.
      expect(Object.keys(only.Condition)).toEqual(["ArnNotEquals"]);
      expect(Object.keys(only.Condition.ArnNotEquals)).toEqual(["aws:PrincipalArn"]);
      const exempt = only.Condition.ArnNotEquals["aws:PrincipalArn"];
      expect(Array.isArray(exempt)).toBe(false);
      expect(JSON.stringify(exempt).match(/role\/[A-Za-z0-9-]+/g)).toEqual(["role/agentx-ent-bundle-deployer"]);
      expect(JSON.stringify(exempt)).not.toContain("*");
      expect(list(only.Action)).toEqual(expect.arrayContaining(["s3:PutObject*", "s3:DeleteObject*"]));
      expect(JSON.stringify(only.Resource)).toMatch(/\/deploying\/\*"/);
      expect(JSON.stringify(only.Resource)).not.toMatch(/approv/);
    });

    it("limits the deployer's own bucket statement to deploying/ exactly: it cannot place or change an approval", () => {
      const statements = resources(template, "AWS::S3::BucketPolicy").find(([, p]) => JSON.stringify(p.Properties.PolicyDocument).includes("DeployerWritesOnlyItsCopies"))![1].Properties.PolicyDocument.Statement as Json[];
      const copies = statements.find((statement) => statement.Sid === "DeployerWritesOnlyItsCopies")!;
      expect(copies.Action).toEqual(expect.arrayContaining(["s3:PutObject*", "s3:DeleteObject*"]));
      const notResource = JSON.stringify(copies.NotResource);
      expect(notResource).toMatch(/\/deploying\/\*"\]\}\]\}$|\/deploying\/\*"\]\}$|deploying\/\*/);
      expect(notResource).not.toMatch(/approv|\/\*"\]\}\]\}$/);
      expect(JSON.stringify(copies.Condition)).toContain("role/agentx-ent-bundle-deployer");
    });

    it("bars every principal but the customer's named approvers from approvals, when the install names them", () => {
      const approvers = "arn:aws:iam::123456789012:role/security-approvers,arn:aws:iam::123456789012:user/alice";
      const t = access({ ...ON, rovaraBundleApproverArns: approvers });
      const statements = resources(t, "AWS::S3::BucketPolicy").find(([, p]) => JSON.stringify(p.Properties.PolicyDocument).includes("OnlyNamedApproversApprove"))![1].Properties.PolicyDocument.Statement as Json[];
      const only = statements.find((statement) => statement.Sid === "OnlyNamedApproversApprove")!;
      expect(only.Effect).toBe("Deny");
      expect(only.Condition).toEqual({ ArnNotLike: { "aws:PrincipalArn": approvers.split(",") } });
      expect(JSON.stringify(only.Resource)).toMatch(/approved\/\*/);
      expect(JSON.stringify(only.Resource)).toMatch(/approvals\/\*/);
      for (const bad of ["arn:aws:iam::123456789012:role/*", "*", "arn:aws:s3:::x"]) expect(() => access({ ...ON, rovaraBundleApproverArns: bad }), bad).toThrow(/not specific enough|ARN/);
    });

    it("gives the deploy role read access to the deployer's verified copies (Lambda code) and nothing else", () => {
      const deployRole = resources(template, "AWS::IAM::Role").find(([, r]) => r.Properties.RoleName === "agentx-ent-cloudformation")![1];
      expect((deployRole.Properties.Policies as Json[]).map((policy) => policy.PolicyName)).toEqual(["deploy", "read-approved-bundles"]);
      const extra = (deployRole.Properties.Policies as Json[])[1]!.PolicyDocument.Statement as Json[];
      expect(extra).toHaveLength(1);
      expect(extra[0]!.Action).toEqual(["s3:GetObject"]);
      expect(JSON.stringify(extra[0]!.Resource)).toMatch(/\/deploying\/\*/);
      expect(JSON.stringify(extra[0]!.Resource)).not.toMatch(/approv/);
    });
  });

  describe("the customer's switches", () => {
    it("suspended: every request is denied, including the ones enabled allows, in sessions already open", () => {
      const suspended = statementsFor(template, "suspended");
      expect(suspended.find((statement) => statement.Sid === "SuspendedByCustomer")).toMatchObject({ Effect: "Deny", Action: "*", Resource: "*" });
      expect(allowed(enabled, "cloudformation:DescribeStacks", STACK("ent-control-plane"))).toBe(true);
      expect(allowed(suspended, "cloudformation:DescribeStacks", STACK("ent-control-plane"))).toBe(false);
      expect(allowed(suspended, "lambda:InvokeFunction", DEPLOYER_ARN)).toBe(false);
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

    it("reports every assumption of the role to the customer's alert topic, and the deployer itself publishes at every start and end (not CloudTrail data events)", () => {
      const [, rule] = resources(template, "AWS::Events::Rule").find(([, r]) => r.Properties.Name === "agentx-ent-rovara-operator-assumed")!;
      expect(rule.Properties.EventPattern.detail.eventName).toEqual(["AssumeRole"]);
      expect(JSON.stringify(rule.Properties.EventPattern.detail.requestParameters.roleArn)).toContain("role/agentx-ent-rovara-operator");
      const [topicId] = resources(template, "AWS::SNS::Topic").find(([, topic]) => topic.Properties.TopicName === "agentx-ent-rovara-operator-use")!;
      expect(rule.Properties.Targets).toEqual([{ Arn: { Ref: topicId }, Id: "Target0" }]);
      const topicPolicy = resources(template, "AWS::SNS::TopicPolicy").find(([, p]) => JSON.stringify(p.Properties.Topics).includes(topicId))![1];
      expect(JSON.stringify(topicPolicy.Properties.PolicyDocument)).toContain("events.amazonaws.com");
      // No rule leans on Lambda data events.
      expect(resources(template, "AWS::Events::Rule").every(([, r]) => !JSON.stringify(r.Properties.EventPattern).includes("lambda.amazonaws.com"))).toBe(true);
      const [, fn] = resources(template, "AWS::Lambda::Function").find(([, f]) => f.Properties.FunctionName === FUNCTION_NAME)!;
      expect(fn.Properties.Environment.Variables.ALERT_TOPIC_ARN).toEqual({ Ref: topicId });
      const publish = deployerStatements(template).find((statement) => statement.Sid === "TellTheCustomer")!;
      expect(publish).toMatchObject({ Effect: "Allow" });
      expect(list(publish.Action)).toEqual(["sns:Publish"]);
      expect(publish.Resource).toBe("arn:aws:sns:us-east-1:123456789012:alerts"); // the topic, resolved
    });

    it("mirrors the switch where a deployer run already going can read it, and drops queued calls instead of retrying them", () => {
      const record = resources(template, "AWS::SSM::Parameter").find(([, p]) => p.Properties.Name === "/agentx/ent/operator-access/state")![1];
      expect(record.Properties.Value).toEqual({ Ref: "OperatorAccessState" });
      expect(allowed(deployerStatements(template), "ssm:GetParameter", ARN("ssm", "parameter/agentx/ent/operator-access/state"))).toBe(true);
      expect(allowed(deployerStatements(template), "ssm:PutParameter", ARN("ssm", "parameter/agentx/ent/operator-access/state"))).toBe(false);
      const [, config] = resources(template, "AWS::Lambda::EventInvokeConfig")[0]!;
      expect(config.Properties).toMatchObject({ MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 });
    });

    it("lets the deployer take and release only its one-run lock, and gives it the partition's S3 suffix", () => {
      const deployer = deployerStatements(template);
      expect(allowed(deployer, "ssm:PutParameter", ARN("ssm", "parameter/agentx/ent/deploy/lock"))).toBe(true);
      expect(allowed(deployer, "ssm:DeleteParameter", ARN("ssm", "parameter/agentx/ent/deploy/lock"))).toBe(true);
      const [, fn] = resources(template, "AWS::Lambda::Function").find(([, f]) => f.Properties.FunctionName === FUNCTION_NAME)!;
      expect(fn.Properties.Environment.Variables.URL_SUFFIX).toEqual({ Ref: "AWS::URLSuffix" });
    });

    it("keeps the role's policy within IAM's 10,240-character limit for inline role policies", () => {
      const [, role] = resources(template, "AWS::IAM::Role").find(([, r]) => r.Properties.RoleName === "agentx-ent-rovara-operator")!;
      expect(JSON.stringify(role.Properties.Policies).replace(/\s/g, "").length).toBeLessThan(10_240);
    });
  });
});
