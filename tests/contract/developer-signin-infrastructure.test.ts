// tests/contract/developer-signin-infrastructure.test.ts
import { Stack, aws_iam as iam } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { brokerNamesIn, brokerSettingsIn } from "../support/broker-names-template.js";
import { evaluate } from "../support/cfn-evaluate.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string; UpdateReplacePolicy?: string };
type Statement = { Effect?: string; Sid?: string; Action: string | string[]; Resource?: unknown; Principal?: unknown; Condition?: Record<string, unknown> };
type TemplateJson = { Parameters: Record<string, Record<string, unknown>>; Resources: Record<string, Resource>; Outputs: Record<string, { Value: unknown }> };
type Ref = { Ref: string };

function leadingKeysOf(statement: Statement): string[] {
  const scopedKeys = statement.Condition?.["ForAllValues:StringLike"];
  if (typeof scopedKeys !== "object" || scopedKeys === null || !("dynamodb:LeadingKeys" in scopedKeys)) {
    throw new Error("expected a DynamoDB leading-keys condition");
  }
  const keys = scopedKeys["dynamodb:LeadingKeys"];
  if (!Array.isArray(keys) || !keys.every((key: unknown) => typeof key === "string")) {
    throw new Error("expected DynamoDB leading keys to be strings");
  }
  return keys.filter((key: unknown): key is string => typeof key === "string");
}

let named: TemplateJson;
let legacy: TemplateJson;

const controlPlane = (app: ReturnType<typeof buildAgentXApp>, name: string) =>
  Template.fromStack(app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === name)!).toJSON() as TemplateJson;
const ofType = (template: TemplateJson, type: string) => Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);
const actionsOf = (statement: Statement) => [statement.Action].flat();
const statementsIn = (document: unknown) => (document as { Statement: Statement[] }).Statement;
/** Logical IDs end in an eight-character hash; drop it to compare names. */
const withoutHash = (logicalId: string) => logicalId.replace(/[0-9A-F]{8}$/, "");
const functionId = (template: TemplateJson, prefix: string) => ofType(template, "AWS::Lambda::Function").map(([id]) => id).find((id) => withoutHash(id) === prefix)!;

/** Every identity-policy statement in the template, with the role (logical ID) it applies to:
 * AWS::IAM::Policy, AWS::IAM::ManagedPolicy (by its Roles or a role's ManagedPolicyArns) and a
 * role's inline Policies. */
function grants(template: TemplateJson): Array<{ role: string; statement: Statement }> {
  const found: Array<{ role: string; statement: Statement }> = [];
  const add = (roles: string[], document: unknown) => { for (const role of roles) for (const statement of statementsIn(document)) found.push({ role, statement }); };
  // A role from outside the stack (such as the EC2 worker role, named from an ARN parameter) keeps
  // a readable label, so its grants still count.
  const refs = (value: unknown) => ((value ?? []) as unknown[]).map((ref) => (typeof (ref as Ref).Ref === "string" ? (ref as Ref).Ref : `external:${JSON.stringify(ref)}`));
  for (const [, policy] of ofType(template, "AWS::IAM::Policy")) add(refs(policy.Properties.Roles), policy.Properties.PolicyDocument);
  for (const [id, policy] of ofType(template, "AWS::IAM::ManagedPolicy")) {
    const attachedBy = ofType(template, "AWS::IAM::Role").filter(([, role]) => refs(role.Properties.ManagedPolicyArns).includes(id)).map(([roleId]) => roleId);
    add([...new Set([...refs(policy.Properties.Roles), ...attachedBy])], policy.Properties.PolicyDocument);
  }
  for (const [roleId, role] of ofType(template, "AWS::IAM::Role")) {
    for (const inline of (role.Properties.Policies ?? []) as Array<{ PolicyDocument: unknown }>) add([roleId], inline.PolicyDocument);
  }
  return found;
}

/** An IAM-style pattern ("*" any run of characters, "?" one character) as a whole-string RegExp. */
const globRegExp = (glob: string, flags = "") => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`, flags);
/** IAM action match (case-insensitive), honoring "*" and wildcards such as "kms:*" or "lambda:Invoke*". */
const allows = (statement: Statement, action: string) => actionsOf(statement).some((pattern) => globRegExp(pattern, "i").test(action));
/** Whether any of the statement's actions is in `service`, or a wildcard (such as "*") that covers it. */
const touches = (statement: Statement, service: string) =>
  actionsOf(statement).some((pattern) => pattern.toLowerCase().startsWith(`${service}:`) || globRegExp(pattern, "i").test(`${service}:AnyAction`));

/** A resource as a glob: pseudo parameters (AWS::Region and so on) become "*"; a stack parameter
 * is a specific value chosen at deploy time, so it stays an opaque token that matches nothing. */
function asGlob(value: unknown): string {
  if (typeof value === "string") return value;
  const node = value as { Ref?: string; "Fn::Join"?: [string, unknown[]] };
  if (typeof node.Ref === "string") return node.Ref.startsWith("AWS::") ? "*" : "\u0000";
  if (node["Fn::Join"] !== undefined) return node["Fn::Join"][1].map(asGlob).join(node["Fn::Join"][0]);
  // Any other intrinsic could produce anything: count it as a wildcard.
  return "*";
}

/** Whether a statement's resources can reach the resource `logicalId`, whose ARN looks like
 * `sampleArn`: by naming it, or by a pattern (including "*") that names no other logical ID and
 * matches the sample. */
function reaches(template: TemplateJson, statement: Statement, logicalId: string, sampleArn: string): boolean {
  const others = Object.keys(template.Resources).filter((id) => id !== logicalId);
  return [statement.Resource].flat().some((resource) => {
    const text = JSON.stringify(resource);
    if (text.includes(`"${logicalId}"`)) return true;
    if (others.some((id) => text.includes(`"${id}"`))) return false;
    return globRegExp(asGlob(resource)).test(sampleArn);
  });
}

/** The roles (hash dropped, sorted, distinct) with a grant of `action` that reaches `logicalId`. */
const rolesThatMay = (template: TemplateJson, action: string, logicalId: string, sampleArn: string) =>
  [...new Set(grants(template).filter(({ statement }) => statement.Effect !== "Deny" && allows(statement, action) && reaches(template, statement, logicalId, sampleArn)).map(({ role }) => withoutHash(role)))].sort();
const statementsOfRole = (template: TemplateJson, roleName: string) => grants(template).filter(({ role }) => withoutHash(role) === roleName).map(({ statement }) => statement);

const SAMPLE_KEY_ARN = "arn:aws:kms:us-east-1:111122223333:key/0b8a3c2e-1111-2222-3333-444455556666";
const SAMPLE_SLACK_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/staging/slack-AbCdEf";
const SAMPLE_FUNCTION_ARN = "arn:aws:lambda:us-east-1:111122223333:function:agentx-staging-control-p-DeveloperSignInFunction-AbCdEf";
const SAMPLE_TABLE_ARN = "arn:aws:dynamodb:us-east-1:111122223333:table/agentx-staging-control-plane-DeveloperSignInTable-AbCdEf";

beforeAll(() => {
  named = controlPlane(buildAgentXApp({ agentxEnv: "staging" }), "agentx-staging-control-plane");
  legacy = controlPlane(buildAgentXApp(), "AgentXControlPlane");
}, 300_000);

describe("developer sign-in infrastructure (named environments)", () => {
  it("declares the sign-in parameters, with sign-in off by default (R8)", () => {
    const p = named.Parameters;
    expect(p.SlackTeamId).toMatchObject({ Type: "String", Default: "", AllowedPattern: "^$|^[TE][A-Z0-9]{2,31}$" });
    expect(p.DeveloperSignInSlack).toMatchObject({ Type: "String", Default: "disabled", AllowedValues: ["enabled", "disabled"] });
    expect(p.DeveloperOidcIssuer).toMatchObject({ Type: "String", Default: "", AllowedPattern: "^$|^https://\\S+$" });
    expect(p.DeveloperOidcClientId).toMatchObject({ Type: "String", Default: "", MaxLength: 256 });
    expect(p.DeveloperOidcRequiredClaim).toMatchObject({ Type: "String", Default: "", MaxLength: 128 });
    expect(p.DeveloperOidcRequiredValues).toMatchObject({ Type: "String", Default: "[]", AllowedPattern: "^\\[.*\\]$" });
    expect(p.DeveloperOidcDisplayName).toMatchObject({ Type: "String", Default: "Company sign-in", MinLength: 1, MaxLength: 40 });
    // FR-045: when each method was last turned on, in epoch seconds; "0" is never.
    expect(p.DeveloperSignInSlackSince).toMatchObject({ Type: "String", Default: "0", AllowedPattern: "^[0-9]{1,12}$" });
    expect(p.DeveloperOidcSince).toMatchObject({ Type: "String", Default: "0", AllowedPattern: "^[0-9]{1,12}$" });
    expect(p.TaskPeopleChangesEnabled).toMatchObject({ Type: "String", Default: "false", AllowedValues: ["true", "false"] });
    expect(p.TaskPeoplePublicInvitationsEnabled).toMatchObject({ Type: "String", Default: "false", AllowedValues: ["true", "false"] });
    expect(p.TaskPeoplePrivateInvitationsEnabled).toMatchObject({ Type: "String", Default: "false", AllowedValues: ["true", "false"] });
    expect(p.WorkflowDependenciesEnabled).toMatchObject({ Type: "String", Default: "false", AllowedValues: ["true", "false"] });
    for (const parameter of Object.values(p)) expect(JSON.stringify(parameter)).not.toContain("—");
  });

  it("has no JWT authorizer whose issuer is this API, which API Gateway cannot create before the API serves discovery (D17)", () => {
    // The live check on 2026-09-27: creating an authorizer whose issuer is <api>/v1/auth failed with
    // "Issuer must have a valid discovery endpoint", because the API did not exist yet.
    const authorizers = ofType(named, "AWS::ApiGatewayV2::Authorizer").map(([, resource]) => resource.Properties);
    const apiIds = ofType(named, "AWS::ApiGatewayV2::Api").map(([id]) => id);
    for (const properties of authorizers.filter((p) => p.AuthorizerType === "JWT")) {
      const issuer = JSON.stringify((properties.JwtConfiguration as { Issuer: unknown }).Issuer);
      for (const apiId of apiIds) expect(issuer).not.toContain(apiId);
      expect(issuer).not.toContain("/v1/auth");
    }
    expect(authorizers.map((properties) => properties.Name)).toEqual(["agentx-jwt"]);
  });

  it("routes /v1/dev/* and /review/* and /s/* to the broker without JWT, keeps /v1/auth/* on DeveloperIdentity, and leaves ANY /{proxy+} protected", () => {
    const routes = Object.fromEntries(ofType(named, "AWS::ApiGatewayV2::Route").map(([, resource]) => [resource.Properties.RouteKey as string, resource.Properties]));
    const authorizerId = (name: string) => ({ Ref: ofType(named, "AWS::ApiGatewayV2::Authorizer").find(([, r]) => r.Properties.Name === name)![0] });
    expect(routes["ANY /v1/dev/{proxy+}"]).toMatchObject({ AuthorizationType: "NONE", Target: routes["ANY /{proxy+}"]!.Target });
    expect(routes["ANY /v1/dev/{proxy+}"]!.AuthorizerId).toBeUndefined();
    expect(routes["ANY /review/{proxy+}"]).toMatchObject({ AuthorizationType: "NONE", Target: routes["ANY /{proxy+}"]!.Target });
    expect(routes["ANY /review/{proxy+}"]!.AuthorizerId).toBeUndefined();
    // Plan 5: a session's link, `/s/<sessionId>`, is a browser page like the review pages: the broker's integration, no JWT.
    expect(routes["ANY /s/{proxy+}"]).toMatchObject({ AuthorizationType: "NONE", Target: routes["ANY /{proxy+}"]!.Target });
    expect(routes["ANY /s/{proxy+}"]!.AuthorizerId).toBeUndefined();
    expect(routes["ANY /{proxy+}"]).toMatchObject({ AuthorizationType: "JWT", AuthorizerId: authorizerId("agentx-jwt") });
    const auth = routes["ANY /v1/auth/{proxy+}"]!;
    expect(auth.AuthorizationType).toBe("NONE");
    expect(auth.AuthorizerId).toBeUndefined();
    const [integrationId] = ofType(named, "AWS::ApiGatewayV2::Integration").find(([, r]) => JSON.stringify(r.Properties.IntegrationUri).includes(functionId(named, "DeveloperSignInFunction")))!;
    expect(auth.Target).toEqual({ "Fn::Join": ["", ["integrations/", { Ref: integrationId }]] });
  });

  it("signs with an RSA_2048 KMS key only the DeveloperIdentity role may use (R1)", () => {
    const keys = ofType(named, "AWS::KMS::Key").filter(([, resource]) => resource.Properties.KeySpec === "RSA_2048");
    expect(keys).toHaveLength(1);
    const [keyId, key] = keys[0]!;
    expect(key.Properties.KeyUsage).toBe("SIGN_VERIFY");
    const denies = (key.Properties.KeyPolicy as { Statement: Statement[] }).Statement.filter((statement) => statement.Effect === "Deny");
    // Signing is the sign-in function's alone. Reading the public half is its and one more role's (Plan 5 Task 8: the realtime authorizer, which verifies tokens with it).
    expect(denies).toHaveLength(2);
    const sign = denies.find((statement) => statement.Sid === "SignOnlyAsDeveloperIdentity")!;
    expect(sign).toMatchObject({ Principal: { AWS: "*" }, Resource: "*" });
    expect(actionsOf(sign)).toEqual(["kms:Sign"]);
    const exempt = (sign.Condition as { ArnNotEquals: Record<string, unknown> }).ArnNotEquals["aws:PrincipalArn"] as { "Fn::GetAtt": [string, string] };
    expect(withoutHash(exempt["Fn::GetAtt"][0])).toBe("DeveloperSignInFunctionServiceRole");
    expect(exempt["Fn::GetAtt"][1]).toBe("Arn");
    const read = denies.find((statement) => statement.Sid === "GetPublicKeyOnlyAsDeveloperIdentityAndTokenVerifiers")!;
    expect(read).toMatchObject({ Principal: { AWS: "*" }, Resource: "*" });
    expect(actionsOf(read)).toEqual(["kms:GetPublicKey"]);
    const readers = (read.Condition as { ArnNotEquals: Record<string, unknown> }).ArnNotEquals["aws:PrincipalArn"] as Array<{ "Fn::GetAtt": [string, string] }>;
    expect(readers.map((reader) => withoutHash(reader["Fn::GetAtt"][0]))).toEqual(["DeveloperSignInFunctionServiceRole", "RealtimeAuthorizerServiceRole"]);
    // The only identity policies that grant kms:Sign on this key (by name or pattern) are DeveloperIdentity's; kms:GetPublicKey, also the authorizer's.
    expect(rolesThatMay(named, "kms:Sign", keyId, SAMPLE_KEY_ARN)).toEqual(["DeveloperSignInFunctionServiceRole"]);
    expect(rolesThatMay(named, "kms:GetPublicKey", keyId, SAMPLE_KEY_ARN)).toEqual(["DeveloperSignInFunctionServiceRole", "RealtimeAuthorizerServiceRole"]);
    const aliases = ofType(named, "AWS::KMS::Alias").map(([, resource]) => resource.Properties);
    expect(aliases.find((alias) => alias.AliasName === "alias/agentx/staging/developer-tokens")).toMatchObject({ TargetKeyId: { "Fn::GetAtt": [keyId, "Arn"] } });
  });

  // Issue 173: the reconciler reads it too, for the unwaited task note's bot token (named environments only).
  it("lets only the ingress, the orchestrator task role, DeveloperIdentity, the task notifier and the reconciler read the Slack secret (R2, FR-034, #173)", () => {
    const [secretId] = ofType(named, "AWS::SecretsManager::Secret").find(([, resource]) => resource.Properties.Name === "agentx/staging/slack")!;
    const readers = rolesThatMay(named, "secretsmanager:GetSecretValue", secretId, SAMPLE_SLACK_SECRET_ARN);
    expect(readers).toEqual(["DeveloperSignInFunctionServiceRole", "DeveloperTaskNotifierFunctionServiceRole", "SessionsReconcilerServiceRole", "SlackIngressServiceRole", "SlackOrchestratorTaskRole"]);
  });

  it("lets DeveloperIdentity read only its own company sign-in secret besides the Slack secret", () => {
    const reads = statementsOfRole(named, "DeveloperSignInFunctionServiceRole").filter((s) => allows(s, "secretsmanager:GetSecretValue"));
    expect(reads).toHaveLength(2);
    expect(JSON.stringify(reads.map((s) => s.Resource))).toContain(":secret:agentx/staging/developer-oidc-??????");
  });

  it("lets only the broker invoke DeveloperIdentity directly, and API Gateway only on /v1/auth/*", () => {
    const fnId = functionId(named, "DeveloperSignInFunction");
    for (const action of ["lambda:InvokeFunction", "lambda:InvokeFunctionUrl"]) {
      expect(rolesThatMay(named, action, fnId, SAMPLE_FUNCTION_ARN), action).toEqual(action === "lambda:InvokeFunction" ? ["BrokerServiceRole"] : []);
    }
    const permissions = ofType(named, "AWS::Lambda::Permission").map(([, r]) => r.Properties).filter((properties) => JSON.stringify(properties.FunctionName).includes(fnId));
    expect(permissions).toHaveLength(1);
    expect(permissions[0]).toMatchObject({ Action: "lambda:InvokeFunction", Principal: "apigateway.amazonaws.com" });
    expect(JSON.stringify(permissions[0]!.SourceArn)).toContain("/*/*/v1/auth/*");
  });

  it("gives the broker only session, developer and email-index reads, and a developer-partition Query, on the sign-in table", () => {
    const [tableId] = ofType(named, "AWS::DynamoDB::Table").find(([logicalId]) => logicalId.startsWith("DeveloperSignInTable"))!;
    const tableStatements = statementsOfRole(named, "BrokerServiceRole").filter((statement) => touches(statement, "dynamodb") && reaches(named, statement, tableId, SAMPLE_TABLE_ARN));
    expect(tableStatements).toHaveLength(3);
    const reads = tableStatements.filter((statement) => actionsOf(statement).includes("dynamodb:GetItem"));
    // GET /v1/app/me lists a developer's linked identities: a Query, and only inside the developer's own partition.
    const queries = tableStatements.filter((statement) => actionsOf(statement).includes("dynamodb:Query"));
    expect(queries).toHaveLength(1);
    expect(actionsOf(queries[0]!)).toEqual(["dynamodb:Query"]);
    expect(queries[0]!.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVELOPER#*"] } });
    const creatorChecks = tableStatements.filter((statement) => actionsOf(statement).includes("dynamodb:ConditionCheckItem"));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.Action).toBe("dynamodb:GetItem");
    // Plan 2, Task 13: SIGNIN_IDENTITY# (the forward link of a sign-in identity) joined the read, for the GitHub connect callback. Read only.
    expect(reads[0]!.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SESSION#*", "DEVELOPER#*", "EMAIL#*", "SIGNIN_IDENTITY#*"] } });
    expect(creatorChecks).toHaveLength(1);
    expect(actionsOf(creatorChecks[0]!)).toEqual(["dynamodb:ConditionCheckItem"]);
    expect(creatorChecks[0]!.Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVELOPER#*"] },
      Null: { "dynamodb:LeadingKeys": "false" },
    });
  });

  it("gives DeveloperIdentity exactly the item operations its store uses on the sign-in table", () => {
    const [tableId] = ofType(named, "AWS::DynamoDB::Table").find(([logicalId]) => logicalId.startsWith("DeveloperSignInTable"))!;
    const tableStatements = statementsOfRole(named, "DeveloperSignInFunctionServiceRole").filter((statement) => touches(statement, "dynamodb") && reaches(named, statement, tableId, SAMPLE_TABLE_ARN));
    // Four statements, each naming only the table: what every sign-in uses, (Plan 2, Task 8) the two an unlink adds, and (SLACK-LINK-1) the developer-record condition check.
    expect(tableStatements).toHaveLength(4);
    for (const statement of tableStatements) {
      expect(statement.Effect).toBe("Allow");
      expect(statement.Resource).toEqual({ "Fn::GetAtt": [tableId, "Arn"] });
    }
    // TransactWriteItems is authorized per item as PutItem and UpdateItem; no condition-check, no scan, no batch.
    const everySignIn = tableStatements.filter((statement) => actionsOf(statement).includes("dynamodb:GetItem"));
    expect(everySignIn).toHaveLength(1);
    expect(actionsOf(everySignIn[0]!).sort()).toEqual(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]);
    expect(everySignIn[0]!.Condition).toBeUndefined();
    // Unlinking a sign-in method (unlinkIdentity): the transaction's Delete of the developer's IDENTITY# item is authorized as DeleteItem, and the
    // developer's own identities are listed with a Query. Both only in the developer partitions, DEVELOPER#<id>; never SESSION#, SIGNIN_IDENTITY# or EMAIL#.
    const deletes = tableStatements.filter((statement) => actionsOf(statement).includes("dynamodb:DeleteItem"));
    expect(deletes).toHaveLength(1);
    expect(actionsOf(deletes[0]!)).toEqual(["dynamodb:DeleteItem"]);
    expect(leadingKeysOf(deletes[0]!)).toEqual(["DEVELOPER#*"]);
    // SLACK-LINK-1: the one ConditionCheckItem on this table (a company join checks the developer's record was not merged away) is on the developer records only.
    const checks = tableStatements.filter((statement) => actionsOf(statement).includes("dynamodb:ConditionCheckItem"));
    expect(checks).toHaveLength(1);
    expect(actionsOf(checks[0]!)).toEqual(["dynamodb:ConditionCheckItem"]);
    expect(leadingKeysOf(checks[0]!)).toEqual(["DEVELOPER#*"]);
    const queries = tableStatements.filter((statement) => actionsOf(statement).includes("dynamodb:Query"));
    expect(queries).toHaveLength(1);
    expect(actionsOf(queries[0]!)).toEqual(["dynamodb:Query"]);
    expect(leadingKeysOf(queries[0]!)).toEqual(["DEVELOPER#*"]);
    // No other action reaches the table (a wildcard would show up here).
    expect(tableStatements.flatMap(actionsOf).sort()).toEqual(["dynamodb:ConditionCheckItem", "dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"]);
  });

  it("gives DeveloperIdentity the audit outbox and nothing else of the ledger: the intake queue's URL, SendMessage on that queue, and PutItem and DeleteItem on the State table under AUDIT_PENDING# only (Audit Ledger, Task 18)", () => {
    const [queueId] = ofType(named, "AWS::SQS::Queue").find(([id]) => withoutHash(id) === "AuditLedgerAuditIntakeQueue")!;
    const [stateId] = ofType(named, "AWS::DynamoDB::Table").find(([id]) => withoutHash(id) === "State")!;
    const variables = (named.Resources[functionId(named, "DeveloperSignInFunction")]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(variables.AUDIT_INTAKE_QUEUE_URL).toEqual({ Ref: queueId });
    const statements = statementsOfRole(named, "DeveloperSignInFunctionServiceRole");
    // One statement sends to the queue, and it sends and does nothing else (no receive, no delete, no purge).
    const sends = statements.filter((statement) => touches(statement, "sqs"));
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ Effect: "Allow", Action: "sqs:SendMessage", Resource: { "Fn::GetAtt": [queueId, "Arn"] } });
    // One statement writes pending items, inside the audit partitions' key prefix and nowhere else in the State table.
    const pending = statements.filter((statement) => JSON.stringify(statement.Condition ?? {}).includes("AUDIT_PENDING#"));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ Effect: "Allow", Action: ["dynamodb:PutItem", "dynamodb:DeleteItem"], Resource: { "Fn::GetAtt": [stateId, "Arn"] } });
    expect(leadingKeysOf(pending[0]!)).toEqual(["AUDIT_PENDING#*"]);
    // Nothing else of the ledger: its tables, buckets and key are named by no statement of this role.
    for (const name of ["AuditLedgerAuditLedgerTable", "AuditLedgerAuditSealsTable", "AuditLedgerAuditKeysTable", "AuditLedgerAuditLedgerBucket", "AuditLedgerAuditExportsBucket", "AuditLedgerAuditIntakeDeadLetterQueue", "AuditLedgerAuditVaultKey"]) {
      expect(JSON.stringify(statements.map((statement) => statement.Resource))).not.toContain(name);
    }
    // The legacy deployment has no sign-in function and no ledger.
    expect(JSON.stringify(legacy)).not.toContain("AUDIT_INTAKE_QUEUE_URL");
  });

  it("needs no new permission for the fresh sign-in check and for adding a removed method back (Plan 2, Task 8b)", () => {
    const [tableId] = ofType(named, "AWS::DynamoDB::Table").find(([logicalId]) => logicalId.startsWith("DeveloperSignInTable"))!;
    const tableStatements = statementsOfRole(named, "DeveloperSignInFunctionServiceRole").filter((statement) => touches(statement, "dynamodb") && reaches(named, statement, tableId, SAMPLE_TABLE_ARN));
    // What the two flows do in DeveloperIdentity, item by item (the fresh-signin test records the commands and pins that nothing else is used):
    //   GetItem    SESSION#<id> (is the session fresh, and not the method being removed), DEVELOPER#<id> (revoked, ended, marks), SIGNIN_IDENTITY#<key>
    //   PutItem    AUTHREQ#<id> (the link request), and in the re-add's transaction SIGNIN_IDENTITY#<key> and DEVELOPER#<id> / IDENTITY#<key>
    //   UpdateItem AUTHREQ#<id> (method chosen, request used), and in the re-add's transaction DEVELOPER#<id> (the cutoff mark)
    // They are all covered by the one statement every sign-in already has: Get, Put and Update on the table, with no key condition.
    const everySignIn = tableStatements.filter((statement) => actionsOf(statement).includes("dynamodb:GetItem"));
    expect(everySignIn).toHaveLength(1);
    expect(actionsOf(everySignIn[0]!).sort()).toEqual(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]);
    expect(everySignIn[0]!.Condition).toBeUndefined();
    // Nothing was added for them: Delete and Query stay inside the developer partitions (the unlink's), and no other action exists.
    expect(tableStatements).toHaveLength(4);
    expect(tableStatements.flatMap(actionsOf).sort()).toEqual(["dynamodb:ConditionCheckItem", "dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"]);
    for (const narrow of tableStatements.filter((statement) => !actionsOf(statement).includes("dynamodb:GetItem"))) expect(leadingKeysOf(narrow)).toEqual(["DEVELOPER#*"]);
    // The broker starts the flow by naming the token's session in an invoke; it still only reads SESSION# and DEVELOPER# and has no write.
    const broker = statementsOfRole(named, "BrokerServiceRole").filter((statement) => touches(statement, "dynamodb") && reaches(named, statement, tableId, SAMPLE_TABLE_ARN));
    expect(broker.flatMap(actionsOf).sort()).toEqual(["dynamodb:ConditionCheckItem", "dynamodb:GetItem", "dynamodb:Query"]);
    for (const write of ["dynamodb:PutItem", "dynamodb:UpdateItem"]) expect(rolesThatMay(named, write, tableId, SAMPLE_TABLE_ARN)).toEqual(["DeveloperSignInFunctionServiceRole"]);
  });

  it("needs no new permission for the display name (release 0.4.18): no PutItem or UpdateItem on the sign-in table, the creator's ConditionCheckItem for the check, and the State table for the name item", () => {
    const [tableId] = ofType(named, "AWS::DynamoDB::Table").find(([logicalId]) => logicalId.startsWith("DeveloperSignInTable"))!;
    const [stateId] = ofType(named, "AWS::DynamoDB::Table").find(([logicalId]) => withoutHash(logicalId) === "State")!;
    const brokerOnSignIn = statementsOfRole(named, "BrokerServiceRole").filter((statement) => touches(statement, "dynamodb") && reaches(named, statement, tableId, SAMPLE_TABLE_ARN));
    // The rename is a transaction whose Update-free check reads the sign-in record: ConditionCheckItem, on DEVELOPER# items only, and the broker has nothing that writes there.
    expect(brokerOnSignIn.flatMap(actionsOf).sort()).toEqual(["dynamodb:ConditionCheckItem", "dynamodb:GetItem", "dynamodb:Query"]);
    for (const write of ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"]) {
      expect(rolesThatMay(named, write, tableId, SAMPLE_TABLE_ARN)).not.toContain("BrokerServiceRole");
    }
    const check = brokerOnSignIn.filter((statement) => actionsOf(statement).includes("dynamodb:ConditionCheckItem"));
    expect(check).toHaveLength(1);
    expect(leadingKeysOf(check[0]!)).toEqual(["DEVELOPER#*"]);
    // The name item (DEVELOPER_NAME#<id>) and the audit's pending item are in the State table, where the broker reads, writes and batch-reads without a key limit.
    const SAMPLE_STATE_ARN = "arn:aws:dynamodb:us-east-1:111122223333:table/agentx-staging-control-plane-State-AbCdEf";
    for (const action of ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:BatchGetItem"]) {
      const granting = grants(named).filter(({ role, statement }) => withoutHash(role) === "BrokerServiceRole" && statement.Effect !== "Deny" && allows(statement, action) && reaches(named, statement, stateId, SAMPLE_STATE_ARN));
      expect(granting.some(({ statement }) => statement.Condition === undefined), action).toBe(true);
    }
  });

  it("gives the broker no write on the sign-in table: unlinking runs in DeveloperIdentity", () => {
    const [tableId] = ofType(named, "AWS::DynamoDB::Table").find(([logicalId]) => logicalId.startsWith("DeveloperSignInTable"))!;
    const actions = statementsOfRole(named, "BrokerServiceRole")
      .filter((statement) => touches(statement, "dynamodb") && reaches(named, statement, tableId, SAMPLE_TABLE_ARN))
      .flatMap(actionsOf).sort();
    expect(actions).toEqual(["dynamodb:ConditionCheckItem", "dynamodb:GetItem", "dynamodb:Query"]);
    for (const write of ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"]) {
      expect(rolesThatMay(named, write, tableId, SAMPLE_TABLE_ARN)).not.toContain("BrokerServiceRole");
    }
    expect(rolesThatMay(named, "dynamodb:DeleteItem", tableId, SAMPLE_TABLE_ARN)).toEqual(["DeveloperSignInFunctionServiceRole"]);
  });

  it("throttles the public /v1/auth/*, /v1/dev/*, /v1/app/*, /review/* and GitHub install routes on the default stage (burst 50, 20 requests a second)", () => {
    const stages = ofType(named, "AWS::ApiGatewayV2::Stage");
    expect(stages).toHaveLength(1);
    const [, stage] = stages[0]!;
    expect(stage.Properties.RouteSettings).toEqual({
      "ANY /v1/auth/{proxy+}": { ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 },
      "ANY /v1/dev/{proxy+}": { ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 },
      "ANY /v1/app/{proxy+}": { ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 },
      "ANY /review/{proxy+}": { ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 },
      "ANY /s/{proxy+}": { ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 },
      "ANY /v1/web/{proxy+}": { ThrottlingBurstLimit: 400, ThrottlingRateLimit: 200 },
      "GET /app": { ThrottlingBurstLimit: 200, ThrottlingRateLimit: 100 },
      "GET /app/{proxy+}": { ThrottlingBurstLimit: 200, ThrottlingRateLimit: 100 },
      "GET /s/{sessionId}": { ThrottlingBurstLimit: 200, ThrottlingRateLimit: 100 },
      // UX1: the invite link's page on the app's own origin.
      "GET /join": { ThrottlingBurstLimit: 200, ThrottlingRateLimit: 100 },
      // Plan 2, Task 13: GitHub's install redirect and the confirm page's form post.
      "GET /v1/github/install/callback": { ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 },
      "POST /v1/github/install/confirm": { ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 },
      // Plan 4 Task 19: the public event-hook route has a bucket of its own.
      "POST /v1/hooks/{source}/{hookId}": { ThrottlingBurstLimit: 100, ThrottlingRateLimit: 50 },
    });
    // A stage's route settings name routes that must already exist.
    const routeId = (key: string) => ofType(named, "AWS::ApiGatewayV2::Route").find(([, r]) => r.Properties.RouteKey === key)![0];
    const dependsOn = [(stage as Resource & { DependsOn?: string | string[] }).DependsOn].flat();
    expect(dependsOn).toContain(routeId("ANY /v1/auth/{proxy+}"));
    expect(dependsOn).toContain(routeId("ANY /v1/dev/{proxy+}"));
    expect(dependsOn).toContain(routeId("ANY /v1/app/{proxy+}"));
    expect(dependsOn).toContain(routeId("ANY /review/{proxy+}"));
    expect(dependsOn).toContain(routeId("ANY /s/{proxy+}"));
    for (const key of ["ANY /v1/web/{proxy+}", "GET /app", "GET /app/{proxy+}", "GET /s/{sessionId}"]) expect(dependsOn).toContain(routeId(key));
    expect(dependsOn).toContain(routeId("GET /v1/github/install/callback"));
    expect(dependsOn).toContain(routeId("POST /v1/github/install/confirm"));
    expect(dependsOn).toContain(routeId("POST /v1/hooks/{source}/{hookId}"));
    // The app route is served by the broker, which verifies the developer token itself: no API Gateway authorizer.
    const appRoute = ofType(named, "AWS::ApiGatewayV2::Route").find(([, r]) => r.Properties.RouteKey === "ANY /v1/app/{proxy+}")![1];
    expect(appRoute.Properties.AuthorizationType).toBe("NONE");
    expect(appRoute.Properties.Target).toEqual(ofType(named, "AWS::ApiGatewayV2::Route").find(([, r]) => r.Properties.RouteKey === "ANY /v1/dev/{proxy+}")![1].Properties.Target);
  });

  it("keeps sign-in records in a retained, point-in-time recoverable table with a TTL", () => {
    const [, table] = ofType(named, "AWS::DynamoDB::Table").find(([logicalId]) => logicalId.startsWith("DeveloperSignInTable"))!;
    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: "expiresAt", Enabled: true });
    expect(table.Properties.KeySchema).toEqual([{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }]);
    expect(table.Properties.BillingMode).toBe("PAY_PER_REQUEST");
    expect(table.Properties.PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
    expect(table.DeletionPolicy).toBe("RetainExceptOnCreate");
    expect(table.UpdateReplacePolicy).toBe("Retain");
  });

  it("passes the developer configuration to the broker and DeveloperIdentity", () => {
    const functions = Object.fromEntries(ofType(named, "AWS::Lambda::Function").map(([id, resource]) => [
      withoutHash(id), Object.keys((resource.Properties.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables ?? {}),
    ]));
    // The table, the sign-in function and the API are in the broker's one variable of names (its variables are held to Lambda's 4 KB), and the
    // broker puts them back as DEVELOPER_SIGNIN_TABLE_NAME, DEVELOPER_IDENTITY_FUNCTION_NAME and DEVELOPER_TOKEN_ISSUER.
    expect(functions.Broker).toEqual(expect.arrayContaining(["AGENTX_NAMES", "AGENTX_SETTINGS", "AGENTX_ENV", "DEVELOPER_OIDC_ISSUER"]));
    // The Slack team and the Slack switch are in the broker's settings (ENV-ROOM), not variables of their own.
    expect(functions.Broker).not.toEqual(expect.arrayContaining(["SLACK_TEAM_ID"]));
    expect(functions.Broker).not.toEqual(expect.arrayContaining(["DEVELOPER_SIGNIN_SLACK"]));
    expect(functions.Broker).not.toEqual(expect.arrayContaining(["DEVELOPER_TOKEN_ISSUER"]));
    expect(functions.Broker).not.toEqual(expect.arrayContaining(["DEVELOPER_SIGNIN_TABLE_NAME"]));
    expect(functions.Broker).not.toEqual(expect.arrayContaining(["DEVELOPER_IDENTITY_FUNCTION_NAME"]));
    const brokerVariables = (ofType(named, "AWS::Lambda::Function").find(([id]) => withoutHash(id) === "Broker")![1].Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    const brokerNames = brokerNamesIn(brokerVariables);
    expect(brokerNames.signInTable).toEqual({ Ref: ofType(named, "AWS::DynamoDB::Table").find(([id]) => id.startsWith("DeveloperSignInTable"))![0] });
    expect(brokerNames.identityFunction).toEqual({ Ref: ofType(named, "AWS::Lambda::Function").find(([id]) => withoutHash(id) === "DeveloperSignInFunction")![0] });
    expect(brokerNames.signInApi).toEqual({ Ref: ofType(named, "AWS::ApiGatewayV2::Api")[0]![0] });
    expect(functions.Broker).not.toContain("SLACK_SECRET_ARN");
    expect(functions.DeveloperSignInFunction).toEqual(expect.arrayContaining([
      "AGENTX_ENV", "DEVELOPER_TOKEN_ISSUER", "DEVELOPER_SIGNIN_TABLE_NAME", "DEVELOPER_TOKEN_KEY_ARN", "SLACK_SECRET_ARN", "SLACK_TEAM_ID",
      "DEVELOPER_SIGNIN_SLACK", "DEVELOPER_OIDC_ISSUER", "DEVELOPER_OIDC_CLIENT_ID", "DEVELOPER_OIDC_REQUIRED_CLAIM", "DEVELOPER_OIDC_REQUIRED_VALUES",
      "DEVELOPER_OIDC_DISPLAY_NAME", "DEVELOPER_OIDC_SECRET_ID", "STATE_TABLE_NAME",
    ]));
    // A sign-in puts the developer in an org, which lives in the State table. DeveloperIdentity gets the statement every sign-in needs, plus
    // one statement per action for each further key that healing a duplicate member (Plan 2, Task 3) uses: exactly those keys, no more.
    const stateGrants = ofType(named, "AWS::IAM::Policy").flatMap(([, policy]) => (policy.Properties.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement)
      .filter((statement) => /ORG#org_|DEVELOPER_ORG#/.test(JSON.stringify(statement.Condition ?? {})));
    const keysOf = (statement: Record<string, unknown>) => (statement.Condition as Record<string, Record<string, unknown>>)["ForAllValues:StringLike"]!["dynamodb:LeadingKeys"];
    const grantsOf = stateGrants.map((statement) => [[statement.Action].flat().join(","), keysOf(statement)] as const).sort((a, b) => a[0].localeCompare(b[0]));
    const ORG = "ORG#org_????????????????????";
    expect(grantsOf).toEqual([
      // Deleting: the duplicate's member row (bare partition; IAM cannot tell it from the org record) and grants, and its org pointer.
      // Plan 2, Task 4: accepting an invite checks the org is open (ConditionCheckItem on the org record, nothing wider).
      // SLACK-LINK-1: linking a Slack or GitHub account checks the account's own developer has no company pointer, in the link's transaction.
      ["dynamodb:ConditionCheckItem", [ORG, "DEVELOPER_ORG#*"]],
      // Plan 5, Task 20 (the notifier's, not DeveloperIdentity's): recording a task's thread checks the session's own record.
      ["dynamodb:ConditionCheckItem", [`${ORG}#AGENT_SESSION#*`]],
      // Plan 2, Task 4: it also names the ban key, which accepting an invite deletes.
      ["dynamodb:DeleteItem", [`${ORG}#MEMBER#*`, ORG, `${ORG}#BAN`, "DEVELOPER_ORG#*"]],
      // Plan 2, Task 4: a sign-in reads the ban (a removed member of a single-org install is refused); nothing else, and never a write.
      ["dynamodb:GetItem", [`${ORG}#BAN`]],
      // 0.5.11 (the notifier's, not DeveloperIdentity's): a coding plan with no stored estimate has its run limit worked out as the decision does, which reads the org's spend policy by key.
      ["dynamodb:GetItem", [`${ORG}#SETTINGS`]],
      // The org's budget settings, read and written back.
      ["dynamodb:GetItem,dynamodb:PutItem", [`${ORG}#SETTINGS`]],
      // What every sign-in uses: the bare org partition (20 characters, an org ID's), the developer's org pointer, and the email and invite rows.
      ["dynamodb:GetItem,dynamodb:PutItem,dynamodb:UpdateItem", [ORG, "DEVELOPER_ORG#*", "ORG_EMAIL#*", "ORG_INVITE#*"]],
      // Listing: a member's grants, a race org's whole partition, and its project catalog.
      ["dynamodb:Query", [`${ORG}#MEMBER#*`, ORG, `${ORG}#PROJECT_CATALOG`]],
      // 0.5.11 (the notifier's): the same run-limit read of the newest costs of this project's runs, in one RUN_COST partition.
      ["dynamodb:Query", [`${ORG}#RUN_COST#*`]],
      // A member's grants copied to the survivor.
      ["dynamodb:PutItem", [`${ORG}#MEMBER#*`]],
      // Plan 5, Task 20 (the notifier's): the session's binding to the thread (in its own partition, never the session's) and the thread's reverse item, put with the thread's record.
      ["dynamodb:PutItem", [`${ORG}#SESSION_BINDING#*`, `${ORG}#SESSION_SURFACE`]],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    for (const statement of stateGrants) {
      expect(statement.Effect).toBe("Allow");
      expect(JSON.stringify(keysOf(statement))).not.toMatch(/"ORG#\*"|SLACK_TEAM|PROJECT#/);
    }
    // Nothing is queried under the developer pointers.
    expect(grantsOf.filter(([action, keys]) => action === "dynamodb:Query" && JSON.stringify(keys).includes("DEVELOPER_ORG#"))).toEqual([]);
    // Plan 3, Task 11: the sign-in function writes one merge marker per merge and nothing else. The grants above are unchanged
    // (the list is compared whole); this is the one statement added. PutItem only: it never reads, lists, updates or deletes a marker.
    const markerStatements = statementsOfRole(named, "DeveloperSignInFunctionServiceRole").filter((statement) => JSON.stringify(statement.Condition ?? {}).includes("MEMBER_MERGE_QUEUE"));
    expect(markerStatements).toHaveLength(1);
    expect(markerStatements[0]).toMatchObject({ Effect: "Allow", Action: "dynamodb:PutItem", Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["MEMBER_MERGE_QUEUE"] } } });
    for (const action of ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:DeleteItem", "dynamodb:UpdateItem", "dynamodb:BatchWriteItem"]) {
      expect(allows(markerStatements[0]!, action), action).toBe(false);
    }
    // The removal queue is the broker\'s alone (its table grant): no statement of any role names it, so the sign-in function cannot write a removal.
    expect(grants(named).filter(({ statement }) => JSON.stringify(statement.Condition ?? {}).includes("MEMBER_REMOVAL_QUEUE"))).toEqual([]);
    // No other role is granted the marker partition by name: the broker reads and deletes markers through its own table grant.
    expect(grants(named).filter(({ role, statement }) => withoutHash(role) !== "DeveloperSignInFunctionServiceRole" && JSON.stringify(statement.Condition ?? {}).includes("MEMBER_MERGE_QUEUE"))).toEqual([]);
    // FR-045: both functions get each method's enabled-since cutoff straight from its parameter.
    const variables = (prefix: string) => (named.Resources[functionId(named, prefix)]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(brokerSettingsIn(variables("Broker"))).toMatchObject({
      taskPeopleChanges: { Ref: "TaskPeopleChangesEnabled" },
      taskPeoplePublicInvitations: { Ref: "TaskPeoplePublicInvitationsEnabled" },
      taskPeoplePrivateInvitations: { Ref: "TaskPeoplePrivateInvitationsEnabled" },
      workflowDependencies: { Ref: "WorkflowDependenciesEnabled" },
      signInSlackSince: { Ref: "DeveloperSignInSlackSince" },
      oidcSince: { Ref: "DeveloperOidcSince" },
    });
    expect(variables("DeveloperSignInFunction").DEVELOPER_SIGNIN_SLACK_SINCE).toEqual({ Ref: "DeveloperSignInSlackSince" });
    expect(variables("DeveloperSignInFunction").DEVELOPER_OIDC_SINCE).toEqual({ Ref: "DeveloperOidcSince" });
    const [separator, [endpoint, suffix]] = (named.Outputs.DeveloperSignInIssuer!.Value as { "Fn::Join": [string, [{ "Fn::GetAtt": [string, string] }, string]] })["Fn::Join"];
    expect(separator).toBe("");
    expect(endpoint["Fn::GetAtt"][0]).toMatch(/^HttpApi/);
    expect(endpoint["Fn::GetAtt"][1]).toBe("ApiEndpoint");
    expect(suffix).toBe("/v1/auth");
  });
});

describe("the legacy deployment (R3)", () => {
  it("has none of it", () => {
    const text = JSON.stringify(legacy);
    for (const absent of ["SlackTeamId", "DeveloperSignIn", "DeveloperOidc", "TaskPeopleChangesEnabled", "TaskPeoplePublicInvitationsEnabled", "TaskPeoplePrivateInvitationsEnabled", "WorkflowDependenciesEnabled", "AGENTX_WORKFLOW_DEPENDENCIES_ENABLED", "agentx-developer-jwt", "/v1/dev/", "/v1/auth", "DEVELOPER_TOKEN_ISSUER", "developer-tokens"]) {
      expect(text).not.toContain(absent);
    }
    expect(ofType(legacy, "AWS::ApiGatewayV2::Authorizer")).toHaveLength(1);
    expect(ofType(legacy, "AWS::KMS::Key").map(([, r]) => r.Properties.KeySpec)).toEqual(["ECC_NIST_P256"]);
    expect(ofType(legacy, "AWS::ApiGatewayV2::Stage").map(([, r]) => r.Properties.RouteSettings)).toEqual([undefined]);
  });
});

describe("AI-tool turn records (spec 025 FR-037, R27)", () => {
  const brokerRole = (template: TemplateJson) => {
    const brokerFunction = template.Resources[functionId(template, "Broker")]!;
    return ((brokerFunction.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];
  };
  const turnTable = (template: TemplateJson) => ofType(template, "AWS::DynamoDB::Table").map(([id]) => id).find((id) => withoutHash(id) === "TurnRecords")!;

  it("lets the broker put items in TurnRecords only under TASK#, and (spec 025 25e) admin change audit records under CHANGE#", () => {
    const puts = grants(named).filter(({ role, statement }) => role === brokerRole(named) && allows(statement, "dynamodb:PutItem") && JSON.stringify(statement.Resource).includes(turnTable(named)));
    expect(puts).toHaveLength(2);
    // Each statement is chosen by its leading keys, so the order CDK emits them in does not matter.
    const putUnder = (key: string) => puts.filter(({ statement }) => JSON.stringify((statement.Condition as Record<string, Record<string, unknown>> | undefined)?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"]) === JSON.stringify([key]));
    const tasks = putUnder("TASK#*");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.statement.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TASK#*"] } });
    expect(actionsOf(tasks[0]!.statement)).toEqual(["dynamodb:PutItem"]);
    // Spec 025 E3, FR-051: an admin change's audit record is written once, then stepped forward.
    const changes = putUnder("CHANGE#*");
    expect(changes).toHaveLength(1);
    expect(changes[0]!.statement.Condition).toEqual({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CHANGE#*"] } });
    expect(actionsOf(changes[0]!.statement)).toEqual(["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"]);
  });

  it("gives the broker no other write on TurnRecords: no delete or batch write, and an update only on CHANGE# audit records", () => {
    for (const action of ["dynamodb:DeleteItem", "dynamodb:BatchWriteItem"]) {
      expect(grants(named).some(({ role, statement }) => role === brokerRole(named) && allows(statement, action) && JSON.stringify(statement.Resource ?? "").includes(turnTable(named)))).toBe(false);
    }
    // Spec 025 25e changes this deliberately: an admin change audit record is stepped forward (E3).
    // The old assertion (no UpdateItem at all) now holds for every TurnRecords item outside CHANGE#.
    const updates = grants(named).filter(({ role, statement }) => role === brokerRole(named) && allows(statement, "dynamodb:UpdateItem") && JSON.stringify(statement.Resource ?? "").includes(turnTable(named)));
    expect(updates.map(({ statement }) => statement.Condition)).toEqual([{ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CHANGE#*"] } }]);
  });

  it("adds nothing to the legacy templates", () => {
    expect(grants(legacy).some(({ statement }) => (statement.Condition as Record<string, Record<string, unknown>> | undefined)?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"] !== undefined
      && JSON.stringify(statement.Condition).includes("TASK#"))).toBe(false);
  });
});

describe("the developer task notifier (spec 025 phase 25c, named environments)", () => {
  const stateId = () => ofType(named, "AWS::DynamoDB::Table").find(([id]) => withoutHash(id) === "State")![0];
  const streamMappings = (template: TemplateJson) => ofType(template, "AWS::Lambda::EventSourceMapping")
    .filter(([, mapping]) => JSON.stringify(mapping.Properties.EventSourceArn).includes("StreamArn"));

  it("runs the notifier with its table, queue, Slack secret and metrics namespace", () => {
    const [, notifier] = ofType(named, "AWS::Lambda::Function").find(([id]) => withoutHash(id) === "DeveloperTaskNotifierFunction")!;
    const variables = (notifier.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    const idOf = (type: string, prefix: string) => ofType(named, type).find(([id]) => withoutHash(id) === prefix)![0];
    const [secretId] = ofType(named, "AWS::SecretsManager::Secret").find(([, resource]) => resource.Properties.Name === "agentx/staging/slack")!;
    expect(variables).toMatchObject({
      STATE_TABLE_NAME: { Ref: stateId() },
      NOTICE_QUEUE_URL: { Ref: idOf("AWS::SQS::Queue", "DeveloperTaskNotifierNoticeQueue") },
      SLACK_SECRET_ARN: { Ref: secretId },
      AGENTX_METRICS_NAMESPACE: "AgentX/staging",
      AGENTX_TASK_PEOPLE_CHANGES_ENABLED: { Ref: "TaskPeopleChangesEnabled" },
      DECISION_CARDS_ENABLED: { Ref: "DecisionCardsEnabled" },
    });
  });

  it("reads the state table's stream as its second and last reader, filtered to task, pointer and ended-operation changes (C7)", () => {
    const mappings = streamMappings(named);
    expect(mappings).toHaveLength(2);
    const notifierMapping = mappings.find(([, mapping]) => JSON.stringify(mapping.Properties.FunctionName).includes("DeveloperTaskNotifierFunction"))![1];
    const patterns = (notifierMapping.Properties.FilterCriteria as { Filters: Array<{ Pattern: string }> }).Filters.map((filter) => JSON.parse(filter.Pattern) as unknown);
    expect(patterns).toEqual([
      { dynamodb: { NewImage: { entityType: { S: ["DEVELOPER_TASK"] } } } },
      { dynamodb: { NewImage: { entityType: { S: ["DEVELOPER_TASK_POINTER"] } } } },
      // #342: every ended operation, so one that left its owner's ChatGPT plan says so; the code keeps a developer's
      // own for their notices and drops the rest.
      { dynamodb: { NewImage: { entityType: { S: ["OPERATION"] }, status: { S: ["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"] } } } },
      // Spec 025 E13: a fourth filter on this same mapping, never a third reader.
      { dynamodb: { NewImage: { entityType: { S: ["ADMIN_CHANGE"] } } } },
      // Task 19: a fifth, for refused Slack presses, on this same mapping. Spec 061: comment nudges share it, since a
      // mapping takes five filters by default.
      // Plan 3, Task 22: the same filter also takes an agent-step run's final report.
      { dynamodb: { NewImage: { entityType: { S: ["WORKFLOW_ACTION_REFUSAL", "TASK_COMMENT_NUDGE", "TASK_PEOPLE_NOTIFICATION", "AGENT_REPORT_POST", "SPEC_STATE", "PROJECT_SETTINGS_PROOF", "DESIGN_WAIT_NOTIFY", "TASK_ATTENTION_DM"] } } } },
    ]);
    expect(JSON.stringify(patterns.at(-1))).toContain("TASK_PEOPLE_NOTIFICATION");
    expect(notifierMapping.Properties).toMatchObject({ StartingPosition: "LATEST", MaximumRecordAgeInSeconds: 3600, MaximumRetryAttempts: 10, BisectBatchOnFunctionError: true });
    // A batch that still fails (the notice queue refusing sends, say) leaves a record of its shard and
    // sequence numbers, never its item images, and the operator is told.
    const [streamFailuresId] = ofType(named, "AWS::SQS::Queue").find(([id]) => withoutHash(id) === "DeveloperTaskNotifierStreamFailureQueue")!;
    expect(notifierMapping.Properties).toMatchObject({ DestinationConfig: { OnFailure: { Destination: { "Fn::GetAtt": [streamFailuresId, "Arn"] } } } });
  });

  it("consumes its own queue with per-message failures and a dead-letter queue", () => {
    const queueMappings = ofType(named, "AWS::Lambda::EventSourceMapping").filter(([, mapping]) => JSON.stringify(mapping.Properties.FunctionName).includes("DeveloperTaskNotifierFunction") && !JSON.stringify(mapping.Properties.EventSourceArn).includes("StreamArn"));
    expect(queueMappings).toHaveLength(1);
    // Ruling F15: one notice per invocation, so 10 s Slack calls never pass the 30 s timeout between a post and its marker.
    expect(queueMappings[0]![1].Properties).toMatchObject({ FunctionResponseTypes: ["ReportBatchItemFailures"], BatchSize: 1 });
    const [, notifier] = ofType(named, "AWS::Lambda::Function").find(([id]) => withoutHash(id) === "DeveloperTaskNotifierFunction")!;
    expect(notifier.Properties).toMatchObject({ Timeout: 30 });
    const [, queue] = ofType(named, "AWS::SQS::Queue").find(([id]) => withoutHash(id) === "DeveloperTaskNotifierNoticeQueue")!;
    expect(queue.Properties).toMatchObject({ MessageRetentionPeriod: 86_400, VisibilityTimeout: 180, SqsManagedSseEnabled: true });
    expect(queue.Properties.RedrivePolicy).toMatchObject({ maxReceiveCount: 100 });
  });

  it("limits closeout manifest access to the dedicated private task-closeout prefix", () => {
    const statements = statementsOfRole(named, "DeveloperTaskNotifierFunctionServiceRole");
    const closeout = statements.filter((statement) => JSON.stringify(statement.Resource).includes("private/task-closeouts"));
    expect(closeout).toHaveLength(1);
    expect(actionsOf(closeout[0]!).sort()).toEqual(["s3:GetObject", "s3:PutObject"]);
    expect(JSON.stringify(closeout[0]!.Resource)).toContain("private/task-closeouts/*/*");
    // The existing notice DLQ alarm is the exhausted closeout-work alarm; no new queue/service is introduced.
    expect(ofType(named, "AWS::CloudWatch::Alarm").some(([, alarm]) => alarm.Properties.AlarmName === "agentx-staging-DeveloperNoticeDeadLetters")).toBe(true);
  });

  it("gives the notifier only key-limited item access on the state table: no scan, no delete", () => {
    const statements = statementsOfRole(named, "DeveloperTaskNotifierFunctionServiceRole").filter((statement) => reaches(named, statement, stateId(), "arn:aws:dynamodb:us-east-1:111122223333:table/state"));
    const dynamo = statements.filter((statement) => touches(statement, "dynamodb") && !actionsOf(statement).some((action) => action.startsWith("dynamodb:DescribeStream") || action.startsWith("dynamodb:GetRecords") || action.startsWith("dynamodb:GetShardIterator") || action.startsWith("dynamodb:ListStreams")));
    for (const statement of dynamo) {
      expect(statement.Condition).toMatchObject({ "ForAllValues:StringLike": { "dynamodb:LeadingKeys": expect.any(Array) as unknown } });
      for (const forbidden of ["dynamodb:Scan", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"]) expect(allows(statement, forbidden)).toBe(false);
    }
    // The task read is chosen by its leading keys, not by position among the GetItem statements.
    const reads = dynamo.filter((statement) => allows(statement, "dynamodb:GetItem") && leadingKeysOf(statement).includes("DEVTASK#*"));
    expect(reads).toHaveLength(1);
    expect([...leadingKeysOf(reads[0]!)].sort()).toEqual(["CHATGPT_NOTICE#*", "DEVTASK#*", "OPERATION#*", "WORKSPACE#*"]);
    expect(actionsOf(reads[0]!).sort()).toEqual(["dynamodb:GetItem", "dynamodb:Query"]);
    const keysOf = (statement: Statement) => leadingKeysOf(statement);
    const writes = dynamo.filter((statement) => allows(statement, "dynamodb:PutItem") || allows(statement, "dynamodb:UpdateItem"));
    expect(writes).toHaveLength(5);
    // The task and its notice markers are put and updated; a shared thread record is only put;
    // an admin change (spec 025 E13) is only read and updated, never put; a ChatGPT fallback's notice
    // marker (#342) is only put; a session's binding to the thread (Plan 5 Task 20) is only put, in an org's own keys.
    expect(writes.map((statement) => ({ actions: actionsOf(statement).sort(), keys: keysOf(statement) }))).toEqual(expect.arrayContaining([
      { actions: ["dynamodb:PutItem", "dynamodb:UpdateItem"], keys: ["DEVTASK#*"] },
      { actions: ["dynamodb:PutItem"], keys: ["SHARED_TASK#*"] },
      { actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"], keys: ["ADMIN_CHANGE#*"] },
      { actions: ["dynamodb:PutItem"], keys: ["CHATGPT_NOTICE#*"] },
      { actions: ["dynamodb:PutItem"], keys: ["ORG#org_????????????????????#SESSION_BINDING#*", "ORG#org_????????????????????#SESSION_SURFACE"] },
    ]));
  });

  it("lets the ingress read shared thread records, and the broker read Slack thread counters, by key", () => {
    const [, ingress] = ofType(named, "AWS::Lambda::Function").find(([id]) => withoutHash(id) === "SlackIngress")!;
    expect((ingress.Properties.Environment as { Variables: Record<string, unknown> }).Variables).toMatchObject({ SHARED_TASKS: "enabled" });
    expect(statementsOfRole(named, "SlackIngressServiceRole")).toContainEqual(expect.objectContaining({
      Action: "dynamodb:GetItem", Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["SHARED_TASK#*"] } },
    }));
    expect(statementsOfRole(named, "BrokerServiceRole")).toContainEqual(expect.objectContaining({
      Action: "dynamodb:GetItem", Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["THREAD#*"] } },
    }));
  });

  it("tells the operator when a notice or a stream batch is dead-lettered", () => {
    for (const [queue, name] of [["DeveloperTaskNotifierNoticeDeadLetterQueue", "agentx-staging-DeveloperNoticeDeadLetters"], ["DeveloperTaskNotifierStreamFailureQueue", "agentx-staging-DeveloperNoticeStreamFailures"]] as const) {
      const [queueId] = ofType(named, "AWS::SQS::Queue").find(([id]) => withoutHash(id) === queue)!;
      const [, alarm] = ofType(named, "AWS::CloudWatch::Alarm").find(([, resource]) => resource.Properties.AlarmName === name)!;
      expect(alarm.Properties).toMatchObject({
        MetricName: "ApproximateNumberOfMessagesVisible", Namespace: "AWS/SQS", Dimensions: [{ Name: "QueueName", Value: { "Fn::GetAtt": [queueId, "QueueName"] } }],
        Threshold: 1, ComparisonOperator: "GreaterThanOrEqualToThreshold", TreatMissingData: "notBreaching",
      });
      expect(JSON.stringify(alarm.Properties.AlarmActions)).toContain("OperatorAlerts");
    }
  });

  it("adds none of it to the legacy template", () => {
    expect(ofType(legacy, "AWS::Lambda::Function").map(([id]) => withoutHash(id))).not.toContain("DeveloperTaskNotifierFunction");
    expect(ofType(legacy, "AWS::CloudWatch::Alarm").map(([, resource]) => JSON.stringify(resource.Properties.AlarmName))).not.toContainEqual(expect.stringContaining("DeveloperNotice"));
    expect(streamMappings(legacy)).toHaveLength(1);
    const [, ingress] = ofType(legacy, "AWS::Lambda::Function").find(([id]) => withoutHash(id) === "SlackIngress")!;
    expect((ingress.Properties.Environment as { Variables: Record<string, unknown> }).Variables).not.toHaveProperty("SHARED_TASKS");
  });
});

describe("the notice of a newly linked sign-in method (Plan 2, Task 8, cloud installs)", () => {
  let cloud: TemplateJson;
  const FROM = "Rovara <signin@rovara.dev>";
  const SOURCE_ARN = "arn:aws:ses:us-west-2:123456789012:identity/rovara.dev";
  beforeAll(() => { cloud = controlPlane(buildAgentXApp({ agentxEnv: "staging", agentxCloud: true }), "agentx-staging-control-plane"); }, 300_000);
  const sesGrants = (template: TemplateJson) => grants(template).filter(({ statement }) => touches(statement, "ses"));
  const identityVariables = (template: TemplateJson) => (template.Resources[functionId(template, "DeveloperSignInFunction")]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  const conditionsOf = (template: TemplateJson) => (template as unknown as { Conditions: Record<string, unknown> }).Conditions;

  it("gives DeveloperIdentity and, for the GitHub request notice (Plan 2, Task 14), the broker ses:SendEmail on the sender's identity ARN parameter only, each in a policy that exists only under CloudSignInEmailFromSes", () => {
    const found = sesGrants(cloud);
    expect(found.map(({ role }) => withoutHash(role)).sort()).toEqual(["BrokerServiceRole", "DeveloperSignInFunctionServiceRole"]);
    for (const grant of found) {
      expect(grant.statement.Effect).toBe("Allow");
      expect(actionsOf(grant.statement)).toEqual(["ses:SendEmail"]);
      expect(grant.statement.Resource).toEqual({ Ref: "CloudSignInEmailSourceArn" });
      expect(grant.statement.Condition).toBeUndefined();
    }
    // Each grant is its own policy, switched by the condition: with no sender the resource would be an empty ARN.
    const policies = ofType(cloud, "AWS::IAM::Policy").filter(([, policy]) => JSON.stringify(policy.Properties.PolicyDocument).includes("ses:SendEmail"));
    expect(policies.map(([id]) => withoutHash(id)).sort()).toEqual(["DeveloperSignInBrokerGithubConnectedNoticeSend", "DeveloperSignInIdentityNoticeSend"]);
    for (const [, policy] of policies) expect((policy as unknown as { Condition?: string }).Condition).toBe("CloudSignInEmailFromSes");
    expect(conditionsOf(cloud).CloudSignInEmailFromSes).toEqual({
      "Fn::And": [
        { "Fn::Not": [{ "Fn::Equals": [{ Ref: "CloudSignInEmailFrom" }, ""] }] },
        { "Fn::Not": [{ "Fn::Equals": [{ Ref: "CloudSignInEmailSourceArn" }, ""] }] },
      ],
    });
  });

  it("grants no ses:SendRawEmail, no wildcard, and nothing to any other role", () => {
    for (const { statement } of sesGrants(cloud)) {
      expect(allows(statement, "ses:SendRawEmail")).toBe(false);
      expect(allows(statement, "ses:GetAccount")).toBe(false);
      expect(JSON.stringify(statement.Resource)).not.toContain("*");
    }
    expect(sesGrants(cloud).map(({ role }) => withoutHash(role)).sort()).toEqual(["BrokerServiceRole", "DeveloperSignInFunctionServiceRole"]);
  });

  it("hands DeveloperIdentity and the broker the sender and its region, empty unless both sender parameters are set, and DeveloperIdentity the web origin", () => {
    const variables = identityVariables(cloud);
    const broker = (cloud.Resources[functionId(cloud, "Broker")]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    for (const set of [variables, broker]) {
      const evaluated = (parameters: Record<string, string>) => ({
        from: evaluate(set.DEVELOPER_NOTICE_EMAIL_FROM, { parameters, conditions: conditionsOf(cloud) }),
        region: evaluate(set.DEVELOPER_NOTICE_EMAIL_REGION, { parameters, conditions: conditionsOf(cloud) }),
      });
      expect(evaluated({ CloudSignInEmailFrom: FROM, CloudSignInEmailSourceArn: SOURCE_ARN })).toEqual({ from: FROM, region: "us-west-2" });
      for (const parameters of [{ CloudSignInEmailFrom: "", CloudSignInEmailSourceArn: "" }, { CloudSignInEmailFrom: FROM, CloudSignInEmailSourceArn: "" }, { CloudSignInEmailFrom: "", CloudSignInEmailSourceArn: SOURCE_ARN }]) {
        expect(evaluated(parameters)).toEqual({ from: "", region: "" });
      }
    }
    expect(variables.ROVARA_WEB_ORIGIN).toEqual({ Ref: "RovaraWebOrigin" });
    expect(Object.keys(broker).filter((name) => name.startsWith("DEVELOPER_NOTICE_")).sort()).toEqual(["DEVELOPER_NOTICE_EMAIL_FROM", "DEVELOPER_NOTICE_EMAIL_REGION"]);
  });

  it("keeps the cloud template's sign-in table statements the same as a named environment's, and the broker's unchanged", () => {
    const [tableId] = ofType(cloud, "AWS::DynamoDB::Table").find(([logicalId]) => logicalId.startsWith("DeveloperSignInTable"))!;
    const functionActions = statementsOfRole(cloud, "DeveloperSignInFunctionServiceRole").filter((statement) => touches(statement, "dynamodb") && reaches(cloud, statement, tableId, SAMPLE_TABLE_ARN)).flatMap(actionsOf).sort();
    // The named environment's five actions, plus the decide statements (state: Put, Get, Delete; session: Put, Delete; tickets and rates: Get, Put, Update).
    expect(functionActions).toEqual([
      "dynamodb:ConditionCheckItem", "dynamodb:DeleteItem", "dynamodb:DeleteItem", "dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:GetItem", "dynamodb:GetItem",
      "dynamodb:PutItem", "dynamodb:PutItem", "dynamodb:PutItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:UpdateItem",
    ]);
    // Plan 3, Task 21a-presence (PF9): one exact list for the broker on a cloud install: the creator check, the reads, the developer-partition
    // Query, and the decide statements (sessions: Get, Update, Delete; tickets and rates: Put, Update). The statements are pinned one by one below.
    const brokerActions = statementsOfRole(cloud, "BrokerServiceRole").filter((statement) => touches(statement, "dynamodb") && reaches(cloud, statement, tableId, SAMPLE_TABLE_ARN)).flatMap(actionsOf).sort();
    expect(brokerActions).toEqual([
      "dynamodb:ConditionCheckItem", "dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:UpdateItem",
    ]);
  });

  it("adds none of it to a named environment without the cloud, or to the legacy deployment", () => {
    expect(sesGrants(named)).toEqual([]);
    expect(sesGrants(legacy)).toEqual([]);
    expect(Object.keys(identityVariables(named)).filter((name) => name.startsWith("DEVELOPER_NOTICE_"))).toEqual([]);
    expect(JSON.stringify(legacy)).not.toContain("DEVELOPER_NOTICE_EMAIL");
  });

  it("puts no em dash in any name or description", () => {
    expect(JSON.stringify(cloud)).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("the decide flow's grants and pool (Plan 3, Task 21a-presence, cloud installs)", () => {
  let cloud: TemplateJson;
  beforeAll(() => { cloud = controlPlane(buildAgentXApp({ agentxEnv: "staging", agentxCloud: true }), "agentx-staging-control-plane"); }, 300_000);
  const tableId = () => ofType(cloud, "AWS::DynamoDB::Table").find(([logicalId]) => logicalId.startsWith("DeveloperSignInTable"))![0];
  const onTable = (role: string) => statementsOfRole(cloud, role).filter((statement) => touches(statement, "dynamodb") && reaches(cloud, statement, tableId(), SAMPLE_TABLE_ARN));
  const decideStatements = (role: string) => onTable(role).filter((statement) => JSON.stringify(statement.Condition ?? {}).includes("DECIDE_"));
  const shape = (statement: Statement) => ({ actions: [...actionsOf(statement)].sort(), keys: leadingKeysOf(statement) });

  it("gives DeveloperIdentity exactly the state, session, ticket and rate grants, each narrowed by leading keys", () => {
    expect(decideStatements("DeveloperSignInFunctionServiceRole").map(shape)).toEqual(expect.arrayContaining([
      { actions: ["dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem"], keys: ["DECIDE_STATE#*"] },
      // Put to write the session, Delete to end the one a newer sign-in replaces (fix round 1).
      { actions: ["dynamodb:DeleteItem", "dynamodb:PutItem"], keys: ["DECIDE_SESSION#*"] },
      { actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], keys: ["DECIDE_TICKET#*", "DECIDE_RATE#*"] },
    ]));
    expect(decideStatements("DeveloperSignInFunctionServiceRole")).toHaveLength(3);
  });

  it("gives the broker exactly the session grant and the ticket and rate grant, and nothing wider", () => {
    expect(decideStatements("BrokerServiceRole").map(shape)).toEqual(expect.arrayContaining([
      { actions: ["dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:UpdateItem"], keys: ["DECIDE_SESSION#*"] },
      { actions: ["dynamodb:PutItem", "dynamodb:UpdateItem"], keys: ["DECIDE_TICKET#*", "DECIDE_RATE#*"] },
    ]));
    expect(decideStatements("BrokerServiceRole")).toHaveLength(2);
    // The broker's other sign-in table statements are unchanged: reads, the developer-partition Query and the creator check.
    const others = onTable("BrokerServiceRole").filter((statement) => !decideStatements("BrokerServiceRole").includes(statement));
    expect(others.flatMap(actionsOf).sort()).toEqual(["dynamodb:ConditionCheckItem", "dynamodb:GetItem", "dynamodb:Query"]);
  });

  it("lets no other statement or role mention the decide prefixes on the sign-in table", () => {
    const mentioning = grants(cloud).filter(({ statement }) => JSON.stringify(statement.Condition ?? {}).includes("DECIDE_") && reaches(cloud, statement, tableId(), SAMPLE_TABLE_ARN));
    expect(mentioning.map(({ role }) => withoutHash(role)).sort()).toEqual([
      "BrokerServiceRole", "BrokerServiceRole", "DeveloperSignInFunctionServiceRole", "DeveloperSignInFunctionServiceRole", "DeveloperSignInFunctionServiceRole",
    ]);
    for (const { statement } of mentioning) {
      expect(statement.Effect).toBe("Allow");
      expect(actionsOf(statement).every((action) => /^dynamodb:(GetItem|PutItem|UpdateItem|DeleteItem)$/.test(action))).toBe(true);
    }
  });

  it("gives DeveloperIdentity AdminCreateUser and AdminGetUser on the cloud pool's ARN only, and nothing Cognito to the broker", () => {
    const [poolId] = ofType(cloud, "AWS::Cognito::UserPool")[0]!;
    const cognito = grants(cloud).filter(({ statement }) => touches(statement, "cognito-idp"));
    const sameStatement = cognito.filter(({ role }) => withoutHash(role) === "DeveloperSignInFunctionServiceRole");
    expect(sameStatement).toHaveLength(1);
    expect(sameStatement[0]!.statement.Effect).toBe("Allow");
    expect([...actionsOf(sameStatement[0]!.statement)].sort()).toEqual(["cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser"]);
    expect(sameStatement[0]!.statement.Resource).toEqual({ "Fn::GetAtt": [poolId, "Arn"] });
    expect(sameStatement[0]!.statement.Condition).toBeUndefined();
    expect(cognito.filter(({ role }) => withoutHash(role) === "BrokerServiceRole")).toEqual([]);
    const variables = (cloud.Resources[functionId(cloud, "DeveloperSignInFunction")]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(variables.DEVELOPER_CLOUD_USER_POOL_ID).toEqual({ Ref: poolId });
  });

  it("keeps the pool on managed login v2 with a branding for the app client, the email code as a first factor, and the one existing callback URL", () => {
    const [domainId, domain] = ofType(cloud, "AWS::Cognito::UserPoolDomain")[0]!;
    expect(domain.Properties.ManagedLoginVersion).toBe(2);
    const [, client] = ofType(cloud, "AWS::Cognito::UserPoolClient")[0]!;
    const clientId = ofType(cloud, "AWS::Cognito::UserPoolClient")[0]![0];
    const brandings = ofType(cloud, "AWS::Cognito::ManagedLoginBranding");
    expect(brandings).toHaveLength(1);
    expect(brandings[0]![1].Properties.ClientId).toEqual({ Ref: clientId });
    expect(JSON.stringify((brandings[0]![1] as unknown as { DependsOn?: unknown }).DependsOn ?? brandings[0]![1])).toContain(domainId);
    const [, pool] = ofType(cloud, "AWS::Cognito::UserPool")[0]!;
    expect(pool.Properties.Policies).toMatchObject({ SignInPolicy: { AllowedFirstAuthFactors: ["PASSWORD", "EMAIL_OTP"] } });
    // The callback is the sign-in server's existing `${issuer}/callback/cloud`; the decide flow adds none.
    const callbacks = JSON.stringify(client.Properties.CallbackURLs);
    // 0.5.7: one URL without the custom domain, that one and the domain's with it (tests/contract/custom-domain-infrastructure.test.ts).
    const branches = (client.Properties.CallbackURLs as { "Fn::If": [string, unknown[], unknown[]] })["Fn::If"];
    expect(branches[0]).toBe("CustomDomainEnabled");
    expect(branches[2]).toHaveLength(1);
    expect(branches[1]).toHaveLength(2);
    expect(callbacks).toContain("/v1/auth/callback/cloud");
    expect(client.Properties.SupportedIdentityProviders).toBeDefined();
  });

  it("adds none of it to a named environment without the cloud, or to the legacy deployment", () => {
    for (const template of [named, legacy]) {
      expect(JSON.stringify(template)).not.toContain("DECIDE_");
      expect(grants(template).filter(({ statement }) => touches(statement, "cognito-idp") && withoutHash(grants(template).find((g) => g.statement === statement)!.role) === "DeveloperSignInFunctionServiceRole")).toEqual([]);
    }
  });

  it("keeps each broker managed-policy group under 5,500 characters on a cloud install (the guard under IAM's 6,144)", () => {
    const app = buildAgentXApp({ agentxEnv: "staging", agentxCloud: true });
    const stack = app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === "agentx-staging-control-plane")!;
    Template.fromStack(stack); // synthesizes, so the merge-and-move aspect has run
    const policies = stack.node.findAll().filter((node): node is iam.ManagedPolicy => node instanceof iam.ManagedPolicy && /^agentx-.+-broker-/.test(String((node.node.defaultChild as iam.CfnManagedPolicy).managedPolicyName)));
    expect(policies.map((policy) => String((policy.node.defaultChild as iam.CfnManagedPolicy).managedPolicyName)).sort()).toEqual(["agentx-staging-broker-integrations", "agentx-staging-broker-orchestration", "agentx-staging-broker-state"]);
    for (const policy of policies) {
      // PolicyStatement._estimateSize is an internal API (pinned with aws-cdk-lib): 20 characters per action and 150 per unresolved token.
      const estimate = (policy.document as unknown as { statements: Array<{ _estimateSize(options: { actionEstimate: number; arnEstimate: number }): number }> }).statements
        .reduce((total, statement) => total + statement._estimateSize({ actionEstimate: 20, arnEstimate: 150 }), 0);
      expect(estimate, `${String((policy.node.defaultChild as iam.CfnManagedPolicy).managedPolicyName)} is estimated at ${estimate}`).toBeLessThanOrEqual(5500);
    }
  });

  it("has no API Gateway access log on the stage, so the ticket in a confirmation URL's query string is not recorded by it", () => {
    // HTTP API access logs exist only as a stage's AccessLogSettings. If one is ever added, the ticket must move out of the query string first.
    for (const [, stage] of ofType(cloud, "AWS::ApiGatewayV2::Stage")) expect(stage.Properties).not.toHaveProperty("AccessLogSettings");
    expect(JSON.stringify(cloud)).not.toContain("AccessLogSettings");
  });
});

describe("the sign-in function asks the broker whether a member may decide (Plan 3, Task 21a-wiring, hand-off 1, cloud installs)", () => {
  let cloud: TemplateJson;
  beforeAll(() => { cloud = controlPlane(buildAgentXApp({ agentxEnv: "staging", agentxCloud: true }), "agentx-staging-control-plane"); }, 300_000);
  const BROKER_NAME = "agentx-staging-broker";
  const variablesOf = (template: TemplateJson, prefix: string) => (template.Resources[functionId(template, prefix)]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
  const invokeGrants = (template: TemplateJson, role: string) => statementsOfRole(template, role).filter((statement) => allows(statement, "lambda:InvokeFunction"));

  /** The logical IDs a value points at: Ref, Fn::GetAtt and the ${Name} parts of Fn::Sub. */
  function pointsAt(value: unknown, known: Set<string>, found = new Set<string>()): Set<string> {
    if (Array.isArray(value)) { for (const item of value) pointsAt(item, known, found); return found; }
    if (typeof value !== "object" || value === null) return found;
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === "Ref" && typeof inner === "string" && known.has(inner)) found.add(inner);
      else if (key === "Fn::GetAtt") { const target: unknown = Array.isArray(inner) ? (inner as unknown[])[0] : String(inner).split(".")[0]; if (typeof target === "string" && known.has(target)) found.add(target); }
      else if (key === "Fn::Sub") {
        const text: unknown = Array.isArray(inner) ? (inner as unknown[])[0] : inner;
        if (typeof text === "string") for (const match of text.matchAll(/\$\{([A-Za-z0-9]+)(?:\.[A-Za-z0-9]+)?\}/g)) if (known.has(match[1]!)) found.add(match[1]!);
        if (Array.isArray(inner)) pointsAt((inner as unknown[])[1], known, found);
      } else pointsAt(inner, known, found);
    }
    return found;
  }
  /** A resource cycle CloudFormation would refuse at deploy ("Circular dependency between resources"), as the path of logical IDs; undefined when there is none. */
  function cycleIn(template: TemplateJson): string[] | undefined {
    const known = new Set(Object.keys(template.Resources));
    const edges = new Map<string, string[]>();
    for (const [id, resource] of Object.entries(template.Resources)) {
      const dependsOn = [(resource as unknown as { DependsOn?: string | string[] }).DependsOn ?? []].flat();
      edges.set(id, [...new Set([...pointsAt(resource.Properties, known), ...dependsOn.filter((name) => known.has(name))])].filter((name) => name !== id));
    }
    const state = new Map<string, "open" | "done">();
    const walk = (id: string, path: string[]): string[] | undefined => {
      if (state.get(id) === "done") return undefined;
      if (state.get(id) === "open") return [...path.slice(path.indexOf(id)), id];
      state.set(id, "open");
      for (const next of edges.get(id) ?? []) { const found = walk(next, [...path, id]); if (found !== undefined) return found; }
      state.set(id, "done");
      return undefined;
    };
    for (const id of known) { const found = walk(id, []); if (found !== undefined) return found; }
    return undefined;
  }

  it("names the broker function (agentx-<env>-broker) on a cloud install, so neither function refers to the other's generated name", () => {
    const broker = cloud.Resources[functionId(cloud, "Broker")]!;
    expect(broker.Properties.FunctionName).toBe(BROKER_NAME);
    expect(variablesOf(cloud, "DeveloperSignInFunction").DECIDE_INSPECT_FUNCTION_NAME).toBe(BROKER_NAME);
    // The broker reaches the sign-in function by its generated name (Lambda's Invoke takes a name), not its ARN: the variable is held to Lambda's 4 KB.
    expect(brokerNamesIn(variablesOf(cloud, "Broker")).identityFunction).toBeDefined();
    expect(variablesOf(cloud, "Broker").DEVELOPER_IDENTITY_FUNCTION_ARN).toBeUndefined();
  });

  it("has no circular dependency between the two functions, their roles and their policies", () => {
    expect(cycleIn(cloud)).toBeUndefined();
    // The check itself finds a cycle: a function whose environment names the other, which already names it.
    const broken = structuredClone(cloud);
    const brokerId = functionId(broken, "Broker");
    const identityId = functionId(broken, "DeveloperSignInFunction");
    (broken.Resources[identityId]!.Properties.Environment as { Variables: Record<string, unknown> }).Variables.BROKER_ARN = { "Fn::GetAtt": [brokerId, "Arn"] };
    expect(cycleIn(broken)).toBeDefined();
  });

  it("gives DeveloperIdentity exactly one invoke grant: lambda:InvokeFunction on the broker's ARN, unqualified, and nothing else of Lambda for it", () => {
    const grantsOf = invokeGrants(cloud, "DeveloperSignInFunctionServiceRole");
    // The model-access function it already invokes (budgets sync) is a different, existing statement.
    const toBroker = grantsOf.filter((statement) => globRegExp(asGlob(statement.Resource)).test(`arn:aws:lambda:us-east-1:111122223333:function:${BROKER_NAME}`));
    expect(toBroker).toHaveLength(1);
    expect(toBroker[0]!.Effect).toBe("Allow");
    expect(actionsOf(toBroker[0]!)).toEqual(["lambda:InvokeFunction"]);
    expect(asGlob(toBroker[0]!.Resource)).toBe(`arn:*:lambda:*:*:function:${BROKER_NAME}`);
    expect(toBroker[0]!.Condition).toBeUndefined();
    // Not the broker's version or alias, and no wildcard that reaches another function.
    expect(asGlob(toBroker[0]!.Resource)).not.toContain("*:" + BROKER_NAME + "*");
    for (const statement of grantsOf) expect(globRegExp(asGlob(statement.Resource)).test("arn:aws:lambda:us-east-1:111122223333:function:some-other-function")).toBe(false);
  });

  it("gives the broker no new grant for it, and keeps each of its managed-policy groups as small as before", () => {
    // The sign-in function's request is answered by the broker's existing role: no statement of the broker mentions the sign-in function's invoke.
    const brokerLambda = statementsOfRole(cloud, "BrokerServiceRole").filter((statement) => allows(statement, "lambda:InvokeFunction"));
    for (const statement of brokerLambda) expect(JSON.stringify(statement.Resource)).not.toContain(BROKER_NAME);
  });

  it("keeps the sign-in function's role policies under IAM's 10,240-character inline limit", () => {
    const statements = statementsOfRole(cloud, "DeveloperSignInFunctionServiceRole");
    const size = JSON.stringify({ Version: "2012-10-17", Statement: statements }).length;
    expect(size).toBeLessThan(10_240);
  });

  it("adds none of it to a named environment without the cloud, or to the legacy deployment", () => {
    for (const template of [named, legacy]) {
      expect(JSON.stringify(template)).not.toContain("DECIDE_INSPECT_FUNCTION_NAME");
      expect(JSON.stringify(template)).not.toContain(`:function:${BROKER_NAME}`);
      const broker = template.Resources[functionId(template, "Broker")]!;
      expect(broker.Properties).not.toHaveProperty("FunctionName");
    }
  });
});

it("browser sign-out adds no broker write on ordinary sign-in sessions", () => {
 const table = ofType(named, "AWS::DynamoDB::Table").find(([id]) => id.startsWith("DeveloperSignInTable"))![0];
 expect(grants(named).some(({ role, statement }) => role.startsWith("BrokerServiceRole") && reaches(named, statement, table, SAMPLE_TABLE_ARN) && allows(statement, "dynamodb:GetItem"))).toBe(true);
 const brokerWrites = grants(named).filter(({ role, statement }) => role.startsWith("BrokerServiceRole") && reaches(named, statement, table, SAMPLE_TABLE_ARN) && ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"].some(action => allows(statement, action)));
 for (const { statement } of brokerWrites) expect(leadingKeysOf(statement).every(key => key.startsWith("DECIDE_"))).toBe(true);
});
