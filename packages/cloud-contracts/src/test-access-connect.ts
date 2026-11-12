// How a customer connects an AWS account for tests (lane TA1, customer-test-account.md section 1; owner decisions 121, 122, 124): the names and shapes both ends of the connection share.
//
//   1. Rovara mints a connection id and a one-time token, and opens the CloudFormation quick-create link (`buildTestAccessLink`) for the customer's Region.
//   2. The template (environments/test-access/cloudformation/rovara-test-access.template.yaml) creates the test role and a custom resource whose ServiceToken is Rovara's SNS topic in that Region.
//   3. CloudFormation publishes the custom resource's request to the topic. Rovara's handler (lane TA2) reads it with `parseTestAccessCallback`, looks up the connection recorded for the request's StackId, consumes the one-use
//      token (one conditional write, which also records the StackId) only for a Create with no record, asks `planCallback` what to do, and answers CloudFormation's pre-signed S3 URL with `buildCloudFormationResponse` and
//      `sendCloudFormationResponse`: Create and Update with success, Delete always with success, so deleting the customer's stack never hangs on Rovara. A StackId is not a secret, so `planCallback` alone does not stop a forged Delete: the handler (broker test-access/callback.ts) acts on an Update or Delete only when the message carries the connect token the stack's Create spent (its hash is stored with the stack).
//
// Everything in a request is untrusted: the topic accepts publishes from any AWS account (the customer's account is not known when the topic is made), and the account and Region in the body are the publisher's word,
// so the one-use token is the only authentication. Therefore: the external id Rovara assumes the role with is made from the token's record (`connectionExternalId`), never read from the message; a reported connection stays
// unconfirmed until an admin has seen its account id, Region and role (`connectionConfirmation`) and said it is theirs; nothing assumes the role before. Browser-safe: no Node import.
import { z } from "zod";
import { OrgIdSchema } from "@rovara-code/contracts";

/** The template's version: it moves with every change to the template, the policies or the callback properties. The callback carries it, so Rovara knows what a connected account runs. */
export const TEST_ACCESS_TEMPLATE_VERSION = "1.0.0";
export const TEST_ACCESS_STACK_NAME = "Rovara-test-access";
/**
 * The custom resource's timeout, in seconds: a Rovara outage fails a stack create after this long (the customer starts again from Rovara) and holds a stack delete for this long (the customer then deletes it again, retaining the
 * RovaraCallback resource), not CloudFormation's hour. There is no code of Rovara's in the customer's account to answer in Rovara's place (owner's choice A), so this is the bound.
 */
export const TEST_ACCESS_CALLBACK_TIMEOUT_SECONDS = 120;
/** The connect token's life. */
export const TEST_ACCESS_TOKEN_TTL_SECONDS = 30 * 60;

/** A connection id: Rovara-made, lower-case letters and digits, so it can sit in an external id and an IAM policy name. */
export const TestAccessConnectionIdSchema = z.string().regex(/^conn_[0-9a-z]{20}$/u, "a connection id");
export type TestAccessConnectionId = z.infer<typeof TestAccessConnectionIdSchema>;

/** The external id of the role's trust policy: `rovara-<orgId>-<connectionId>`. A confused-deputy guard, not a secret. The account id is not in it: it is unknown when the link is made. */
export function connectionExternalId(orgId: string, connectionId: string): string {
  return `rovara-${OrgIdSchema.parse(orgId)}-${TestAccessConnectionIdSchema.parse(connectionId)}`;
}

/** The external id's parts, or undefined when it is not one `connectionExternalId` makes. */
export function parseConnectionExternalId(externalId: string): { readonly orgId: string; readonly connectionId: string } | undefined {
  const match = /^rovara-(org_[0-9a-z]{20})-(conn_[0-9a-z]{20})$/u.exec(externalId);
  return match === null ? undefined : { orgId: match[1] as string, connectionId: match[2] as string };
}

/** The names of the two roles the template creates, from the connection id (the template builds the same from the last part of the external id). Rovara finds the roles from the account id with them when no callback arrives. */
export function testAccessRoleName(connectionId: string): string {
  return `rovara-test-${TestAccessConnectionIdSchema.parse(connectionId)}`;
}
export function testAccessCleanupRoleName(connectionId: string): string {
  return `rovara-cleanup-${TestAccessConnectionIdSchema.parse(connectionId)}`;
}
/** A role's ARN in a commercial account. */
export function testAccessRoleArn(accountId: string, roleName: string): string {
  return `arn:aws:iam::${z.string().regex(/^\d{12}$/u).parse(accountId)}:role/${roleName}`;
}

/** The template's parameter names. The quick-create link fills all of them (`param_<name>`). */
export const TEST_ACCESS_TEMPLATE_PARAMETERS = {
  externalId: "ExternalId",
  connectToken: "ConnectToken",
  rovaraPrincipal: "RovaraPrincipal",
  callbackTopicArn: "CallbackTopicArn",
} as const;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Rovara's per-Region topics
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** CloudFormation requires a custom resource's ServiceToken to be in the Region of the stack (AWS::CloudFormation::CustomResource, ServiceToken), so there is one topic per Region a customer can connect. */
export const TEST_ACCESS_DEFAULT_REGIONS: readonly string[] = [
  "ap-northeast-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ca-central-1",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
];

/** Regions that are off until an account enables them. SNS delivers across Regions to Lambda, but the receiving function's policy then names `sns.<topic-region>.amazonaws.com` instead of `sns.amazonaws.com`. */
export const SNS_OPT_IN_REGIONS: ReadonlySet<string> = new Set([
  "af-south-1",
  "ap-east-1",
  "ap-south-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "eu-central-2",
  "eu-south-1",
  "eu-south-2",
  "il-central-1",
  "me-central-1",
  "me-south-1",
]);

export const TestAccessRegionSchema = z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/u, "an AWS Region");

/** The service principal SNS publishes to a Lambda function with: `sns.amazonaws.com`, or `sns.<region>.amazonaws.com` for a topic in an opt-in Region. */
export function snsServicePrincipal(topicRegion: string): string {
  return SNS_OPT_IN_REGIONS.has(topicRegion) ? `sns.${topicRegion}.amazonaws.com` : "sns.amazonaws.com";
}

/** The topic's name: the same in every Region. */
export function testAccessTopicName(resourcePrefix: string): string {
  return `${resourcePrefix}-test-access-callback`;
}

export function testAccessTopicArn(input: { readonly region: string; readonly accountId: string; readonly topicName: string; readonly partition?: string }): string {
  return `arn:${input.partition ?? "aws"}:sns:${TestAccessRegionSchema.parse(input.region)}:${z.string().regex(/^\d{12}$/u).parse(input.accountId)}:${input.topicName}`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The quick-create link
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const STACK_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/u;
const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9]{0,254}$/u;
// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const TEMPLATE_HOST = /^(?:[a-z0-9][a-z0-9.-]{1,62}\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com|s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com)$/u;

export interface QuickCreateInput {
  /** The Region the stack is made in: the console opens there, and the topic must be in it. A commercial Region. */
  readonly region: string;
  /** The versioned template in S3 (https). */
  readonly templateUrl: string;
  readonly stackName: string;
  /** Parameter name to value; each becomes `param_<name>`. */
  readonly parameters: Readonly<Record<string, string>>;
}

/** The CloudFormation console link that opens "Create stack" with the template and every parameter filled in. Pure; throws on an input the console would refuse or that could carry something else into the link. */
export function buildQuickCreateLink(input: QuickCreateInput): string {
  const region = TestAccessRegionSchema.parse(input.region);
  if (region.startsWith("cn-") || region.startsWith("us-gov-") || region.startsWith("us-iso")) throw new Error("only commercial AWS Regions are supported");
  const template = new URL(input.templateUrl);
  if (template.protocol !== "https:" || !TEMPLATE_HOST.test(template.hostname) || template.username !== "" || template.password !== "" || template.search !== "" || template.hash !== "") {
    throw new Error("the template URL must be a plain https S3 URL");
  }
  if (!STACK_NAME.test(input.stackName)) throw new Error("a stack name starts with a letter and holds letters, digits and hyphens");
  const parts = [`templateURL=${encodeURIComponent(template.href)}`, `stackName=${encodeURIComponent(input.stackName)}`];
  for (const [name, value] of Object.entries(input.parameters)) {
    if (!PARAMETER_NAME.test(name)) throw new Error("a parameter name holds letters and digits");
    if (value.length > 4096 || CONTROL_CHARACTERS.test(value)) throw new Error(`parameter ${name} has a value the link cannot carry`);
    parts.push(`param_${name}=${encodeURIComponent(value)}`);
  }
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/quickcreate?${parts.join("&")}`;
}

export interface TestAccessLinkInput {
  readonly region: string;
  readonly templateUrl: string;
  readonly orgId: string;
  readonly connectionId: string;
  /** The one-time token (30 minutes). It is in the link, so it is for one use only. */
  readonly connectToken: string;
  /** The role of the broker that assumes the customer's role. */
  readonly rovaraPrincipalArn: string;
  /** Rovara's topic in `region`. */
  readonly callbackTopicArn: string;
  readonly stackName?: string;
}

/** The link of "Connect in AWS": every template parameter filled, so the admin ticks the IAM acknowledgement and presses Create stack. */
export function buildTestAccessLink(input: TestAccessLinkInput): string {
  const topic = /^arn:aws:sns:([a-z0-9-]+):\d{12}:[A-Za-z0-9_-]{1,256}$/u.exec(input.callbackTopicArn);
  if (topic === null || topic[1] !== input.region) throw new Error("the callback topic must be an SNS topic in the stack's Region");
  if (!/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/u.test(input.rovaraPrincipalArn)) throw new Error("the principal must be an IAM role ARN");
  if (!/^[A-Za-z0-9_-]{16,256}$/u.test(input.connectToken)) throw new Error("the connect token has a shape the template refuses");
  return buildQuickCreateLink({
    region: input.region,
    templateUrl: input.templateUrl,
    stackName: input.stackName ?? TEST_ACCESS_STACK_NAME,
    parameters: {
      [TEST_ACCESS_TEMPLATE_PARAMETERS.externalId]: connectionExternalId(input.orgId, input.connectionId),
      [TEST_ACCESS_TEMPLATE_PARAMETERS.connectToken]: input.connectToken,
      [TEST_ACCESS_TEMPLATE_PARAMETERS.rovaraPrincipal]: input.rovaraPrincipalArn,
      [TEST_ACCESS_TEMPLATE_PARAMETERS.callbackTopicArn]: input.callbackTopicArn,
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The callback: what CloudFormation publishes, and how Rovara answers
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const RoleArnSchema = z.string().regex(/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/u);
const StackIdSchema = z.string().regex(/^arn:aws:cloudformation:[a-z0-9-]+:\d{12}:stack\/[A-Za-z][A-Za-z0-9-]{0,127}\/[0-9a-f-]{36}$/u);

/** The custom resource's properties (the template's `RovaraCallback`). CloudFormation sends every value as a string; it adds ServiceToken and ServiceTimeout. */
export const TestAccessCallbackPropertiesSchema = z.looseObject({
  RoleArn: RoleArnSchema,
  CleanupRoleArn: RoleArnSchema,
  AccountId: z.string().regex(/^\d{12}$/u),
  Region: TestAccessRegionSchema,
  ExternalId: z.string().regex(/^rovara-org_[0-9a-z]{20}-conn_[0-9a-z]{20}$/u),
  ConnectToken: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/u),
  TemplateVersion: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/u),
});
export type TestAccessCallbackProperties = z.infer<typeof TestAccessCallbackPropertiesSchema>;

const RequestBase = {
  RequestId: z.string().min(1).max(256),
  StackId: StackIdSchema,
  ResponseURL: z.string().min(1).max(4096),
  ResourceType: z.string().max(60),
  LogicalResourceId: z.string().min(1).max(255),
};

export const TestAccessCallbackRequestSchema = z.discriminatedUnion("RequestType", [
  z.looseObject({ RequestType: z.literal("Create"), ...RequestBase, ResourceProperties: TestAccessCallbackPropertiesSchema }),
  z.looseObject({ RequestType: z.literal("Update"), ...RequestBase, PhysicalResourceId: z.string().min(1).max(1024), ResourceProperties: TestAccessCallbackPropertiesSchema, OldResourceProperties: z.looseObject({}) }),
  // A Delete carries the properties the template holds now; they can be anything the customer changed, so they are not required to parse.
  z.looseObject({ RequestType: z.literal("Delete"), ...RequestBase, PhysicalResourceId: z.string().min(1).max(1024), ResourceProperties: z.looseObject({}).optional() }),
]);
export type TestAccessCallbackRequest = z.infer<typeof TestAccessCallbackRequestSchema>;

/** The fixed reasons a callback is refused. A reason goes back to CloudFormation and into the customer's stack events, so it is a fixed sentence, never text from the request. */
export const CALLBACK_FAILURE_REASONS = {
  malformed: "Rovara could not read this request. Delete the stack and start again from Rovara.",
  region_mismatch: "This stack's Region does not match Rovara's topic. Start again from Rovara.",
  account_mismatch: "The role does not belong to the account that made this stack. Start again from Rovara.",
  external_id_mismatch: "The external id does not match this connection. Start again from Rovara.",
  role_mismatch: "The roles are not the ones this connection's template makes. Start again from Rovara.",
  token_refused: "The connect link has expired or was already used. Start again from Rovara.",
  account_refused: "Rovara cannot use this account for tests. Start again from Rovara with a test account of your own.",
  not_ready: "Rovara could not record the connection. Try again in a few minutes.",
} as const;
export type CallbackFailureCode = keyof typeof CALLBACK_FAILURE_REASONS;

export type ParsedCallback =
  | { readonly ok: true; readonly request: TestAccessCallbackRequest }
  | { readonly ok: false; readonly code: "malformed" | "region_mismatch" | "account_mismatch" | "external_id_mismatch"; readonly request?: TestAccessCallbackRequest };

const accountOf = (arn: string): string | undefined => arn.split(":")[4];
const regionOf = (arn: string): string | undefined => arn.split(":")[3];

/**
 * The request in an SNS message body, bound to where it came from. `topicRegion` is the Region of the topic that received it. A Create or Update must name the same account in the stack's id, the role ARNs and AccountId,
 * and the same Region in the stack's id, the properties and the topic: a stack in another account cannot report another account's role. A Delete is only parsed: it must always be answered.
 * The token is not checked here; the caller checks it (one use, 30 minutes) against its own records.
 */
export function parseTestAccessCallback(body: string, topicRegion: string): ParsedCallback {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, code: "malformed" };
  }
  const parsed = TestAccessCallbackRequestSchema.safeParse(json);
  if (!parsed.success) return { ok: false, code: "malformed" };
  const request = parsed.data;
  if (request.RequestType === "Delete") return { ok: true, request };
  const properties = request.ResourceProperties;
  if (regionOf(request.StackId) !== topicRegion || properties.Region !== topicRegion) return { ok: false, code: "region_mismatch", request };
  const stackAccount = accountOf(request.StackId);
  if (stackAccount !== properties.AccountId || accountOf(properties.RoleArn) !== stackAccount || accountOf(properties.CleanupRoleArn) !== stackAccount) return { ok: false, code: "account_mismatch", request };
  if (parseConnectionExternalId(properties.ExternalId) === undefined) return { ok: false, code: "external_id_mismatch", request };
  return { ok: true, request };
}

/** The physical id of the connection's custom resource: the same in every response for it, so CloudFormation sees an Update, never a replacement. */
export function callbackPhysicalId(externalId: string): string {
  return `rovara-connection-${externalId}`;
}

export interface CloudFormationResponse {
  readonly Status: "SUCCESS" | "FAILED";
  readonly Reason?: string;
  readonly PhysicalResourceId: string;
  readonly StackId: string;
  readonly RequestId: string;
  readonly LogicalResourceId: string;
  readonly NoEcho?: boolean;
  readonly Data?: Readonly<Record<string, string>>;
}

/** The most bytes CloudFormation accepts in a response body. */
export const CLOUDFORMATION_RESPONSE_MAX_BYTES = 4096;

export type CallbackOutcome = { readonly status: "SUCCESS" } | { readonly status: "FAILED"; readonly code: CallbackFailureCode };

/**
 * The answer to a request: StackId, RequestId and LogicalResourceId copied from it, and the physical id the same in every answer for the resource (a Create's is made from the external id; an Update's and a Delete's
 * is the one CloudFormation sent). A Delete is always answered SUCCESS, whatever the outcome says, so deleting the customer's stack never fails on Rovara. Create and Update return nothing in Data: the stack's outputs
 * are what the customer sees, and the token and the role are not echoed.
 */
export function buildCloudFormationResponse(request: Pick<TestAccessCallbackRequest, "RequestType" | "StackId" | "RequestId" | "LogicalResourceId"> & { readonly PhysicalResourceId?: string; readonly ResourceProperties?: unknown }, outcome: CallbackOutcome): CloudFormationResponse {
  const externalId = (request.ResourceProperties as { ExternalId?: unknown } | undefined)?.ExternalId;
  const created = typeof externalId === "string" && parseConnectionExternalId(externalId) !== undefined ? callbackPhysicalId(externalId) : undefined;
  const physicalId = request.RequestType === "Create" ? (created ?? `rovara-connection-${request.RequestId.replace(/[^A-Za-z0-9-]/gu, "").slice(0, 64) || "unknown"}`) : (request.PhysicalResourceId ?? created ?? "rovara-connection-unknown");
  const base = { PhysicalResourceId: physicalId, StackId: request.StackId, RequestId: request.RequestId, LogicalResourceId: request.LogicalResourceId };
  if (request.RequestType === "Delete" || outcome.status === "SUCCESS") return { Status: "SUCCESS", ...base };
  return { Status: "FAILED", Reason: CALLBACK_FAILURE_REASONS[outcome.code], ...base };
}

/**
 * The hosts CloudFormation's response bucket has in a Region: `cloudformation-custom-resource-response-<region without hyphens>` on S3's host for the Region, in the old (`s3-<region>`) and the current (`s3.<region>`) form, and
 * on the global host in us-east-1. Exactly these; a host that merely looks like one is refused. (Taken from the forms in AWS's documentation; TA11 checks a real URL.)
 */
export function cloudFormationResponseHosts(region: string): readonly string[] {
  const bucket = `cloudformation-custom-resource-response-${region.replaceAll("-", "")}`;
  return [`${bucket}.s3-${region}.amazonaws.com`, `${bucket}.s3.${region}.amazonaws.com`, ...(region === "us-east-1" ? [`${bucket}.s3.amazonaws.com`] : [])];
}

/** CloudFormation's response URLs are pre-signed S3 URLs on its own bucket for the stack's Region. Anything else in a request is an attempt to make Rovara call somewhere it should not. */
export function isCloudFormationResponseUrl(value: string, region: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    TestAccessRegionSchema.safeParse(region).success &&
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    cloudFormationResponseHosts(region).includes(url.hostname) &&
    url.pathname.length > 1
  );
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

export interface SendResponseOptions {
  /** The stack's Region: the response URL must be on CloudFormation's bucket for it. */
  readonly region: string;
  /** The caller's `fetch`; a test passes a stub. */
  readonly fetch: (url: string, init: { method: "PUT"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ readonly ok: boolean; readonly status: number }>;
  readonly timeoutMs?: number;
  readonly attempts?: number;
}

/**
 * Sends the response to CloudFormation's URL. Bounded (a few attempts, each with a timeout) and never throws: it returns whether CloudFormation took it. A response over 4,096 bytes is cut down to a bare one
 * (no Reason) before it is sent, because an oversized body is refused and leaves the stack waiting.
 */
export async function sendCloudFormationResponse(url: string, response: CloudFormationResponse, options: SendResponseOptions): Promise<boolean> {
  if (!isCloudFormationResponseUrl(url, options.region)) return false;
  let body = JSON.stringify(response);
  if (byteLength(body) > CLOUDFORMATION_RESPONSE_MAX_BYTES) {
    body = JSON.stringify({ Status: response.Status, PhysicalResourceId: response.PhysicalResourceId, StackId: response.StackId, RequestId: response.RequestId, LogicalResourceId: response.LogicalResourceId });
  }
  const attempts = Math.min(Math.max(options.attempts ?? 3, 1), 5);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    try {
      // The pre-signed URL signs the host only; an empty content type is what CloudFormation's own helper sends.
      const result = await options.fetch(url, { method: "PUT", headers: { "content-type": "", "content-length": String(byteLength(body)) }, body, signal: controller.signal });
      if (result.ok) return true;
      if (result.status >= 400 && result.status < 500 && result.status !== 429) return false;
    } catch {
      // A failed attempt is retried; the loop is the bound.
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// What to do with a callback
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** What consuming a connect token returned: the connection it was made for. The token is one-use: the caller consumes it with one conditional write, which also stores the connection's StackId, and only then plans a Create. */
export interface ConnectTokenRecord {
  readonly orgId: string;
  readonly connectionId: string;
}

/** What Rovara stored when the Create was accepted, found by the request's StackId. */
export interface RecordedConnection extends ConnectTokenRecord {
  readonly stackId: string;
  readonly accountId: string;
}

/**
 * A connection as reported. `externalId` is made from the token's record (`connectionExternalId`), never read from the message: Rovara assumes the role with this value, so a publisher cannot choose it. Account and Region
 * come from the publisher's body (bound to the stack's own id, but not otherwise proved), and the token is the only authentication, so a connection stays unconfirmed until an admin has seen the account id, role and
 * Region (`connectionConfirmation`) and said it is theirs: nothing assumes the role before that.
 */
export interface ReportedConnection extends ConnectTokenRecord {
  readonly externalId: string;
  readonly stackId: string;
  readonly accountId: string;
  readonly region: string;
  readonly roleArn: string;
  readonly cleanupRoleArn: string;
  readonly templateVersion: string;
  readonly confirmedByAdmin: false;
}

export type CallbackPlan =
  | { readonly kind: "connect" | "update"; readonly connection: ReportedConnection; readonly answer: { readonly status: "SUCCESS" } }
  | { readonly kind: "disconnect"; readonly recorded: RecordedConnection; readonly answer: { readonly status: "SUCCESS" } }
  | { readonly kind: "ignore"; readonly answer: CallbackOutcome };

/**
 * What to do with a parsed callback, and what to answer. `recorded` is the connection stored for the request's StackId (look it up first); `consumedToken` is the result of consuming the connect token, passed for a Create only,
 * and only when no connection is recorded for the stack.
 *   Create:  a stack already recorded is a repeated delivery: nothing changes and it is answered SUCCESS. Otherwise the token must have been consumed, and the message's external id must be the one made from it.
 *   Update:  acts only on the recorded stack, with the recorded external id and account; anything else changes nothing and is answered SUCCESS (an update must not fail a customer's stack because of a stranger's message).
 *   Delete:  disconnects only when the StackId is exactly the one recorded at Create; any other Delete changes nothing and is answered SUCCESS. Someone who holds an external id cannot disconnect another's account. (The StackId is not a secret either: the handler also requires the stack's own connect token for an Update or a Delete.)
 */
export function planCallback(request: TestAccessCallbackRequest, state: { readonly recorded?: RecordedConnection | undefined; readonly consumedToken?: ConnectTokenRecord | undefined }): CallbackPlan {
  const { recorded, consumedToken } = state;
  if (request.RequestType === "Delete") return recorded !== undefined && recorded.stackId === request.StackId ? { kind: "disconnect", recorded, answer: { status: "SUCCESS" } } : { kind: "ignore", answer: { status: "SUCCESS" } };
  const properties = request.ResourceProperties;
  const report = (identity: ConnectTokenRecord): ReportedConnection => ({
    orgId: identity.orgId,
    connectionId: identity.connectionId,
    externalId: connectionExternalId(identity.orgId, identity.connectionId),
    stackId: request.StackId,
    accountId: properties.AccountId,
    region: properties.Region,
    roleArn: properties.RoleArn,
    cleanupRoleArn: properties.CleanupRoleArn,
    templateVersion: properties.TemplateVersion,
    confirmedByAdmin: false,
  });
  if (request.RequestType === "Update") {
    if (recorded === undefined || recorded.stackId !== request.StackId || recorded.accountId !== properties.AccountId || properties.ExternalId !== connectionExternalId(recorded.orgId, recorded.connectionId)) return { kind: "ignore", answer: { status: "SUCCESS" } };
    return { kind: "update", connection: report(recorded), answer: { status: "SUCCESS" } };
  }
  if (recorded !== undefined && recorded.stackId === request.StackId) return { kind: "ignore", answer: { status: "SUCCESS" } };
  if (consumedToken === undefined) return { kind: "ignore", answer: { status: "FAILED", code: "token_refused" } };
  if (properties.ExternalId !== connectionExternalId(consumedToken.orgId, consumedToken.connectionId)) return { kind: "ignore", answer: { status: "FAILED", code: "external_id_mismatch" } };
  return { kind: "connect", connection: report(consumedToken), answer: { status: "SUCCESS" } };
}

/** What the admin is shown to confirm a reported connection is theirs, before anything assumes the role. */
export function connectionConfirmation(connection: ReportedConnection): { readonly accountId: string; readonly region: string; readonly roleArn: string } {
  return { accountId: connection.accountId, region: connection.region, roleArn: connection.roleArn };
}
