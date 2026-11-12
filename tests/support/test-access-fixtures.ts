// Shared builders for the customer test account connect lane (TA2) tests: a world with a clock, the in-memory store, a fake AWS port that records every call, and helpers that build the requests CloudFormation publishes.
// No real keys or tokens: tokens come from the lane's own minter, credentials are built from parts at runtime.
import { connectionExternalId, testAccessCleanupRoleName, testAccessRoleArn, testAccessRoleName } from "@agentx/cloud-contracts";
import type { TestEnvProdDeny } from "@rovara-code/contracts";
import { AssumeFailureError, type AccountCalls, type AssumeRoleRequest, type AssumedRole, type DeleteOutcome, type ServiceProbe, type TestAccessAws } from "../../packages/broker/src/test-access/aws-port.js";
import type { CallbackDeps } from "../../packages/broker/src/test-access/callback.js";
import type { ConnectCaller, ConnectDeps } from "../../packages/broker/src/test-access/connect.js";
import type { SnsEventRecord, SnsVerdict } from "../../packages/broker/src/test-access/sns-verify.js";
import { FakeTestAccessStore } from "./fake-test-access-store.js";

export const ORG = `org_${"a1b2c3d4e5".repeat(2)}`;
export const OTHER_ORG = `org_${"z9y8x7w6v5".repeat(2)}`;
export const ADMIN = "a".repeat(64);
export const OTHER_ADMIN = "b".repeat(64);
export const PROJECT = "orders";
export const REGION = "us-west-2";
export const ACCOUNT = "222233334444";
export const OTHER_ACCOUNT = "555566667777";
export const ROVARA_ACCOUNT = "999988887777";
export const NOW = Date.parse("2026-11-12T12:00:00.000Z");
export const TOPIC = `arn:aws:sns:${REGION}:${ROVARA_ACCOUNT}:agentx-test-access-callback`;
export const PRINCIPAL = `arn:aws:iam::${ROVARA_ACCOUNT}:role/agentx-broker`;
export const TEMPLATE_URL = "https://rovara-templates.s3.us-west-2.amazonaws.com/test-access/1.0.0/rovara-test-access.template.yaml";
export const RESPONSE_URL = `https://cloudformation-custom-resource-response-uswest2.s3-us-west-2.amazonaws.com/arn%3Aaws%3Acloudformation%3Aus-west-2%3A${ACCOUNT}%3Astack?X-Amz-Signature=0123`;
export const STACK_ID = `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/Rovara-test-access/11111111-2222-3333-4444-555555555555`;

export const caller = (over: Partial<ConnectCaller> = {}): ConnectCaller => ({ orgId: ORG, developerId: ADMIN, sessionId: "session-admin", ...over });

export const secretParts = (): { accessKeyId: string; secretAccessKey: string; sessionToken: string } => ({ accessKeyId: ["ASIA", "EXAMPLE"].join(""), secretAccessKey: ["s3cr3t", "example"].join("-"), sessionToken: ["token", "example"].join("-") });

export interface Fixture {
  clock: { ms: number };
  store: FakeTestAccessStore;
  assumeCalls: AssumeRoleRequest[];
  /** Per-call overrides for the fake AWS. */
  aws: { assume: (request: AssumeRoleRequest) => Promise<AssumedRole> | AssumedRole; calls: AccountCalls; sent: string[] };
  puts: Array<{ url: string; body: Record<string, unknown> }>;
  fetchStatus: { value: number };
  logs: Array<Record<string, unknown>>;
  enabled: { value: boolean };
  prodDeny: { value: TestEnvProdDeny | Error };
  canEdit: { value: boolean };
  admins: Set<string>;
  sessionAuthTime: { value: string | undefined };
  connectDeps: ConnectDeps;
  callbackDeps: CallbackDeps;
  verdict: { value: ((record: SnsEventRecord) => SnsVerdict) | undefined };
}

export function makeCalls(over: Partial<AccountCalls> = {}, log: string[] = []): AccountCalls {
  return {
    listAccountAliases: () => { log.push("aliases"); return Promise.resolve(["beta-shared"]); },
    roleBoundary: (name) => { log.push(`boundary:${name}`); return Promise.resolve(`arn:aws:iam::${ACCOUNT}:policy/rovara-test-boundary-${connectionExternalIdOfLast.value}`); },
    probeService: (service): Promise<ServiceProbe> => { log.push(`probe:${service}`); return Promise.resolve("ok"); },
    listNames: () => Promise.resolve([]),
    createQueue: (name) => { log.push(`create:${name}`); return Promise.resolve({ ok: true as const, queueUrl: `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/${name}` }); },
    deleteQueueByName: (name): Promise<DeleteOutcome> => { log.push(`delete-name:${name}`); return Promise.resolve("denied"); },
    deleteQueueByUrl: (url): Promise<DeleteOutcome> => { log.push(`delete-url:${url}`); return Promise.resolve("deleted"); },
    ...over,
  };
}
/** The external id of the connection a test just started, so the fake boundary reports the right policy. */
export const connectionExternalIdOfLast = { value: "" };

export function world(): Fixture {
  const clock = { ms: NOW };
  const store = new FakeTestAccessStore();
  const assumeCalls: AssumeRoleRequest[] = [];
  const sent: string[] = [];
  const calls = makeCalls({}, sent);
  const assumed = (request: AssumeRoleRequest): AssumedRole => ({ credentials: { ...secretParts(), expiration: new Date(clock.ms + 3_600_000) }, assumedRoleArn: `arn:aws:sts::${request.RoleArn.split(":")[4]}:assumed-role/${request.RoleArn.split("/").pop()}/${request.RoleSessionName}` });
  const aws: Fixture["aws"] = {
    assume: (request) => {
      // A real role answers only with the external id it was made for.
      if (request.ExternalId === undefined || request.ExternalId !== connectionExternalIdOfLast.value) throw new AssumeFailureError("refused");
      return assumed(request);
    },
    calls,
    sent,
  };
  const awsPort: TestAccessAws = {
    assumeRole: async (request) => { assumeCalls.push({ ...request }); return aws.assume(request); },
    calls: () => aws.calls,
  };
  const puts: Fixture["puts"] = [];
  const fetchStatus = { value: 200 };
  const logs: Array<Record<string, unknown>> = [];
  const enabled = { value: true };
  const prodDeny: Fixture["prodDeny"] = { value: { accountIds: ["111122223333"], hosts: [], arnPrefixes: [] } };
  const canEdit = { value: true };
  const admins = new Set<string>([ADMIN]);
  const sessionAuthTime: Fixture["sessionAuthTime"] = { value: new Date(clock.ms - 60_000).toISOString() };
  const verdict: Fixture["verdict"] = { value: undefined };
  const denyOf = (): Promise<TestEnvProdDeny> => (prodDeny.value instanceof Error ? Promise.reject(prodDeny.value) : Promise.resolve(prodDeny.value));
  const connectDeps: ConnectDeps = {
    enabled: () => enabled.value,
    store,
    now: () => new Date(clock.ms),
    config: { templateUrl: TEMPLATE_URL, rovaraPrincipalArn: PRINCIPAL, topicArn: (region) => (region === REGION || region === "us-east-1" ? `arn:aws:sns:${region}:${ROVARA_ACCOUNT}:agentx-test-access-callback` : undefined), rovaraAccountIds: [ROVARA_ACCOUNT] },
    aws: awsPort,
    requireAdmin: (who) => (admins.has(who.developerId) ? Promise.resolve() : Promise.reject(Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" }))),
    readSession: (sessionId) => Promise.resolve(sessionId.startsWith("session-") ? { developerId: sessionId === "session-admin" ? ADMIN : OTHER_ADMIN, ...(sessionAuthTime.value === undefined ? {} : { authTime: sessionAuthTime.value }) } : undefined),
    canEditProject: () => Promise.resolve(canEdit.value),
    prodDeny: denyOf,
  };
  const callbackDeps: CallbackDeps = {
    store,
    now: () => clock.ms,
    enabled: () => enabled.value,
    verify: (record) => Promise.resolve(verdict.value !== undefined ? verdict.value(record) : { ok: true, message: String((record.Sns as { Message: unknown }).Message), topicArn: TOPIC, topicRegion: REGION }),
    rovaraAccountIds: [ROVARA_ACCOUNT],
    prodDeny: denyOf,
    fetch: (url, init) => {
      puts.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return Promise.resolve({ ok: fetchStatus.value >= 200 && fetchStatus.value < 300, status: fetchStatus.value });
    },
    log: (entry) => { logs.push(entry); },
  };
  return { clock, store, assumeCalls, aws, puts, fetchStatus, logs, enabled, prodDeny, canEdit, admins, sessionAuthTime, connectDeps, callbackDeps, verdict };
}

/** The token in a connect link (`param_ConnectToken`). */
export function tokenOfLink(link: string): string {
  const fragment = link.slice(link.indexOf("?", link.indexOf("#")) + 1);
  return decodeURIComponent(new URLSearchParams(fragment).get("param_ConnectToken") ?? "");
}

export interface RequestOver {
  RequestType?: "Create" | "Update" | "Delete";
  StackId?: string;
  ResponseURL?: string;
  properties?: Record<string, unknown>;
  accountId?: string;
  connectionId: string;
  token?: string;
  region?: string;
  extra?: Record<string, unknown>;
}

/** The custom resource request CloudFormation publishes, for a connection (roles named as the template names them). */
export function callbackRequest(over: RequestOver): Record<string, unknown> {
  const accountId = over.accountId ?? ACCOUNT;
  const region = over.region ?? REGION;
  const type = over.RequestType ?? "Create";
  const properties = {
    ServiceToken: TOPIC,
    ServiceTimeout: "120",
    RoleArn: testAccessRoleArn(accountId, testAccessRoleName(over.connectionId)),
    CleanupRoleArn: testAccessRoleArn(accountId, testAccessCleanupRoleName(over.connectionId)),
    AccountId: accountId,
    Region: region,
    ExternalId: connectionExternalId(ORG, over.connectionId),
    ConnectToken: over.token ?? "t".repeat(43),
    TemplateVersion: "1.0.0",
    ...over.properties,
  };
  return {
    RequestType: type,
    RequestId: "req-0001",
    ResponseURL: over.ResponseURL ?? RESPONSE_URL,
    ResourceType: "Custom::RovaraTestAccess",
    LogicalResourceId: "RovaraCallback",
    StackId: over.StackId ?? `arn:aws:cloudformation:${region}:${accountId}:stack/Rovara-test-access/11111111-2222-3333-4444-555555555555`,
    ResourceProperties: properties,
    ...(type === "Create" ? {} : { PhysicalResourceId: `rovara-connection-${connectionExternalId(ORG, over.connectionId)}` }),
    ...(type === "Update" ? { OldResourceProperties: {} } : {}),
    ...over.extra,
  };
}

/** A Lambda SNS event around a message (the verifier is stubbed in the handler tests; the real one has its own test). */
export const snsEvent = (request: Record<string, unknown> | string): { Records: SnsEventRecord[] } => ({
  Records: [{ EventSubscriptionArn: `${TOPIC}:sub`, Sns: { Type: "Notification", TopicArn: TOPIC, Message: typeof request === "string" ? request : JSON.stringify(request), MessageId: "m-1", Timestamp: new Date(NOW).toISOString(), SignatureVersion: "1", Signature: "AA==", SigningCertUrl: "x" } }],
});
