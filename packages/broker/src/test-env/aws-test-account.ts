// Test services TS28 (design test-services.md 4.3 "AWS dev accounts" and 6; owner decisions Q3, Q6, Q7 and Q8 of 2026-11-02): a customer's AWS dev account as a test account, and which mode each pre-prod service ran in.
// This file GENERALISES preprod.ts (proof and test environment E9), whose session was SageMaker-only and built from one endpoint ARN. Replaces: `openPreprodSession` and its SageMaker-only policy; the session now comes
// from an approved `TestAccount` of kind `aws_role`, for any service on the data-plane allow-list (contracts `TEST_ACCOUNT_AWS_ACTIONS`). The probe and the mode functions below are unchanged.
//
// ACCESS. No long-lived key exists: the broker assumes the customer's own role (STS AssumeRole) with
//   - a SESSION POLICY built from exactly the account's approved actions and resource ARNs, one statement per service (an action never meets another service's resource), and nothing else. A session policy can only
//     narrow what the customer's role already allows, so the policy is the ceiling Rovara asks for, not a grant. It is checked against the 2,048 characters STS allows and REFUSED when it does not fit (never cut);
//   - the external id of the account's record (the customer's trust policy names it, a confused-deputy guard, not a secret), a session name and source identity from the round, and one hour at most.
// The credentials go to the caller to hand to the sealed sandbox's environment; they are never stored, logged, or put in evidence.
//
// WHERE THE SANDBOX MAY GO. The sealed check sandbox has no internet and no allow-list: its only way out is the test-account proxy (worker/src/test-account-proxy.ts), whose host list for this account is the REGIONAL
// ENDPOINT of exactly the services it approves (`dynamodb.<region>.amazonaws.com`, ...; `awsTestAccountHosts`), never `*.amazonaws.com`. That closes the wildcard the research warned about.
//
// WHAT IS REFUSED BEFORE ANY AWS CALL, each as a fixed word (`AWS_TEST_ACCOUNT_CODES`), none of which holds an ARN, an account id, a message from AWS or a credential:
//   - an account that is not an AWS role account, or is not usable now (not active, expired, approvals that no longer cover the record: `isTestAccountUsableAt`);
//   - a role in Rovara's own AWS account (the deployment's, or any id in `rovaraAccountIds`; when the deployment's own account is unknown every role is refused: fail closed);
//   - anything on the company's production deny list: the role, a resource, an account id, a host, or an empty list (an account reaches a real remote, so the list must exist first); a PRODUCTION-shaped host;
//   - a record whose AWS block does not pass the contract again (an action off the allow-list, a wildcard resource, a resource in another region or account), or whose hosts are not the regional endpoints of its services;
//   - an action with no resource of its service, and a policy that does not fit.
//
// Modes: `preprod` always uses the real service and the round FAILS when it cannot be reached; `mock` always uses the recorded fixtures; `auto` probes pre-prod once at the start of the round and uses the mock when the
// probe fails. The mode actually used is returned for every service, and goes into the evidence (the Environment line and the `mocked_service` not-tested items), so the PR never says "pre-prod" for a mocked call.
import type { AssumeRoleCommandInput } from "@aws-sdk/client-sts";
import {
  TestAccountAwsSchema,
  arnAccountId,
  isTestAccountUsableAt,
  testAccountAwsEndpointHosts,
  testAccountProdProblems,
  type EvidenceEnvironment,
  type ServiceMockFixtureSet,
  type TestAccount,
  type TestAccountAws,
  type TestEnvProdDeny,
  type TestEnvironmentBody,
} from "@agentx/contracts";

type Service = TestEnvironmentBody["services"][number];

export const AWS_TEST_ACCOUNT_SESSION_SECONDS = 3_600;
/** The most characters STS accepts in a session policy. */
export const SESSION_POLICY_MAX_CHARS = 2_048;

export interface AssumedCredentials { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date }
export interface AwsTestAccountPort {
  /** The AWS account the deployment runs in; a role in it is refused. Undefined where it is not known (then every role is refused: fail closed). */
  ownAccountId: string | undefined;
  /** Every AWS account id that is Rovara's own (the deployment's and the others the company of Rovara runs): a role in one is refused. */
  rovaraAccountIds: readonly string[];
  assumeRole(input: AssumeRoleCommandInput): Promise<AssumedCredentials>;
}

/** Fixed reasons, safe to show. Never a role ARN, an account id, a message from AWS, or a credential. */
export const AWS_TEST_ACCOUNT_CODES = ["not_aws_account", "not_usable", "own_account", "production", "bad_role", "arn_mismatch", "too_large", "refused", "unreachable", "bad_session"] as const;
export type AwsTestAccountCode = (typeof AWS_TEST_ACCOUNT_CODES)[number];
const WORDS: Record<AwsTestAccountCode, string> = {
  not_aws_account: "this test account is not an AWS role account",
  not_usable: "this test account is not usable now",
  own_account: "the test account's role must be in your own AWS account, not Rovara's",
  production: "this test account names production",
  bad_role: "this test account's role, actions or resources are not valid",
  arn_mismatch: "an approved action has no resource of its service",
  too_large: "the test account's actions and resources do not fit in one AWS session policy",
  refused: "AWS refused to let Rovara assume the test account's role; check its trust policy and external id",
  unreachable: "AWS could not be reached to assume the test account's role",
  bad_session: "AWS did not return a usable test account session",
};

export class AwsTestAccountError extends Error {
  constructor(readonly code: AwsTestAccountCode, readonly retryable = code === "unreachable") {
    super(WORDS[code]);
    this.name = "AwsTestAccountError";
  }
}

// ---- the session policy

const serviceOfAction = (action: string): string => action.slice(0, action.indexOf(":"));
const serviceOfArn = (arn: string): string => arn.split(":")[2] ?? "";

/**
 * The session policy: for each service the account approves, one Allow with exactly the approved actions of that service on exactly the approved resources of that service. No action or resource appears that the
 * record does not hold. Actions and resources are sorted, so the same record always gives the same text. Throws `bad_role` for an AWS block the contract refuses, `arn_mismatch` for a service with actions and no
 * resource, and `too_large` when the text is longer than STS allows.
 */
export function awsTestAccountSessionPolicy(aws: TestAccountAws): string {
  if (!TestAccountAwsSchema.safeParse(aws).success) throw new AwsTestAccountError("bad_role");
  const services = [...new Set(aws.actions.map(serviceOfAction))].sort();
  const statements = services.map((service) => {
    const actions = aws.actions.filter((action) => serviceOfAction(action) === service).sort();
    const resources = aws.resources.filter((resource) => serviceOfArn(resource) === service).sort();
    if (resources.length === 0) throw new AwsTestAccountError("arn_mismatch");
    return { Effect: "Allow", Action: actions, Resource: resources.length === 1 ? resources[0] : resources };
  });
  const policy = JSON.stringify({ Version: "2012-10-17", Statement: statements });
  if (policy.length > SESSION_POLICY_MAX_CHARS) throw new AwsTestAccountError("too_large");
  return policy;
}

/**
 * The proxy's host list for the account: the regional endpoint of each service it approves, in the account's region, and no other name. The record's own hosts must be among them (a record with any other
 * host does not pass the contract; this repeats the check for a record that did not come through it). Throws `bad_role`.
 */
export function awsTestAccountHosts(account: Pick<TestAccount, "hosts" | "aws">): string[] {
  if (account.aws === undefined) throw new AwsTestAccountError("not_aws_account");
  const endpoints = testAccountAwsEndpointHosts(account.aws);
  if (account.hosts.length === 0 || account.hosts.some((host) => !endpoints.includes(host))) throw new AwsTestAccountError("bad_role");
  return [...account.hosts];
}

/** Everything that is refused before AWS is called. */
function check(account: TestAccount, deny: TestEnvProdDeny, port: AwsTestAccountPort, now: number, maxExpiryDays: number | undefined): TestAccountAws {
  const aws = account.aws;
  if (account.kind !== "aws_role" || aws === undefined) throw new AwsTestAccountError("not_aws_account");
  if (!isTestAccountUsableAt(account, now, maxExpiryDays === undefined ? {} : { maxExpiryDays })) throw new AwsTestAccountError("not_usable");
  const roleAccount = arnAccountId(aws.roleArn);
  if (roleAccount === undefined) throw new AwsTestAccountError("bad_role");
  if (port.ownAccountId === undefined || roleAccount === port.ownAccountId || port.rovaraAccountIds.includes(roleAccount)) throw new AwsTestAccountError("own_account");
  if (testAccountProdProblems(account, deny, { rovaraAccountIds: [...port.rovaraAccountIds, port.ownAccountId] }).length > 0) throw new AwsTestAccountError("production");
  awsTestAccountHosts(account);
  return aws;
}

const idPart = (text: string, max: number, fallback: string): string => text.replace(/[^A-Za-z0-9]/gu, "").slice(0, max) || fallback;

export interface AwsTestAccountSession {
  credentials: AssumedCredentials;
  expiresAtMs: number;
  /** The proxy's host list for this account: the regional endpoints of exactly the services it approves. */
  hosts: string[];
  region: string;
}

/** Opens a session for one AWS test account for one round. */
export async function openAwsTestAccountSession(
  port: AwsTestAccountPort,
  input: { account: TestAccount; taskId: string; prodDeny: TestEnvProdDeny; maxExpiryDays?: number; now(): number },
): Promise<AwsTestAccountSession> {
  const aws = check(input.account, input.prodDeny, port, input.now(), input.maxExpiryDays);
  const policy = awsTestAccountSessionPolicy(aws);
  const hosts = awsTestAccountHosts(input.account);
  let credentials: AssumedCredentials;
  try {
    credentials = await port.assumeRole({
      RoleArn: aws.roleArn,
      RoleSessionName: `rovara-${idPart(input.taskId, 8, "task")}`,
      ExternalId: aws.externalId,
      // Shows in CloudTrail on every call the session makes: which task it was for.
      SourceIdentity: `rovara-${idPart(input.taskId, 16, "task")}`,
      DurationSeconds: AWS_TEST_ACCOUNT_SESSION_SECONDS,
      Policy: policy,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new AwsTestAccountError(name === "AccessDenied" || name === "AccessDeniedException" || name === "MalformedPolicyDocument" ? "refused" : "unreachable");
  }
  const expiresAtMs = credentials?.expiration instanceof Date ? credentials.expiration.getTime() : Number.NaN;
  // A session longer than the hour asked for, one that has already ended, or one with missing parts is not used.
  if (typeof credentials?.accessKeyId !== "string" || credentials.accessKeyId === "" || typeof credentials.secretAccessKey !== "string" || credentials.secretAccessKey === "" || typeof credentials.sessionToken !== "string" || credentials.sessionToken === ""
    || !Number.isFinite(expiresAtMs) || expiresAtMs <= input.now() || expiresAtMs > input.now() + AWS_TEST_ACCOUNT_SESSION_SECONDS * 1_000 + 60_000) throw new AwsTestAccountError("bad_session", false);
  return { credentials, expiresAtMs, hosts, region: aws.region };
}

// ---- the probe

export type ProbeResult = { ok: true } | { ok: false; reason: "error_status" | "unreachable" | "timeout" };

/** One bounded call with a canned synthetic payload. Never throws; the reason is a fixed word. */
export async function probePreprod(send: (signal: AbortSignal) => Promise<{ status: number }>, timeoutMs = 10_000): Promise<ProbeResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await send(controller.signal);
    return response.status >= 200 && response.status < 300 ? { ok: true } : { ok: false, reason: "error_status" };
  } catch {
    return { ok: false, reason: timedOut ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/** The canned probe request: the first recorded request of the service's fixture set (synthetic by construction). Undefined when the set has none, and then `auto` cannot probe and uses the mock. */
export function probeRequestOf(set: Pick<ServiceMockFixtureSet, "entries">): { contentType: string; body: string } | undefined {
  const first = set.entries[0];
  return first === undefined ? undefined : { contentType: first.request.contentType, body: first.request.body };
}

// ---- modes

export type ModeUsed = "preprod" | "mocked";
export interface ModeDecision { name: string; mode: ModeUsed; reason: "configured_mock" | "configured_preprod" | "probe_ok" | "probe_failed_fell_back" }
export type ModeOutcome = { ok: true; modes: ModeDecision[] } | { ok: false; code: "preprod_unreachable"; service: string };

/**
 * Decides the mode of every service for a round, from the probes. `preprod` with a failed probe fails the round (`preprod_unreachable`); `auto` with a failed probe, or with no probe at all, falls back to the mock and
 * says so; `mock` never looks at pre-prod. A service missing from `probes` counts as not reachable.
 */
export function resolveRoundModes(services: readonly Service[], probes: ReadonlyMap<string, ProbeResult>): ModeOutcome {
  const modes: ModeDecision[] = [];
  for (const service of services) {
    if (service.mode === "mock") { modes.push({ name: service.name, mode: "mocked", reason: "configured_mock" }); continue; }
    const probe = probes.get(service.name);
    if (service.mode === "preprod") {
      if (probe?.ok !== true) return { ok: false, code: "preprod_unreachable", service: service.name };
      modes.push({ name: service.name, mode: "preprod", reason: "configured_preprod" });
      continue;
    }
    modes.push(probe?.ok === true ? { name: service.name, mode: "preprod", reason: "probe_ok" } : { name: service.name, mode: "mocked", reason: "probe_failed_fell_back" });
  }
  return { ok: true, modes };
}

/** What a failed `preprod` round does: one retry (a blip), then the task asks a person with the card. */
export function preprodUnreachableNextStep(attempt: number): "retry" | "ask_card" {
  return attempt < 1 ? "retry" : "ask_card";
}

/**
 * The environment's services as the evidence shows them: the mode USED this round (never the configured one), the fixture set's revision and recording date for a mocked service, and how many unrecorded requests a
 * mock answered (counted, never hidden).
 */
export function evidenceServices(
  decisions: readonly ModeDecision[],
  fixtureSets: ReadonlyMap<string, Pick<ServiceMockFixtureSet, "revision" | "recordedAt">>,
  unrecordedAnswered: ReadonlyMap<string, number>,
  /** The task's new mock answers per service (count and the digest the broker pinned them by), listed so no task feeds itself answers silently. */
  newAnswers: ReadonlyMap<string, { count: number; digest: string }> = new Map(),
): EvidenceEnvironment["services"] {
  return decisions.map((decision) => {
    const set = decision.mode === "mocked" ? fixtureSets.get(decision.name) : undefined;
    const synthesized = unrecordedAnswered.get(decision.name) ?? 0;
    return {
      name: decision.name, mode: decision.mode,
      ...(set === undefined ? {} : { fixtureRevision: set.revision, recordedAt: set.recordedAt }),
      ...(decision.mode === "mocked" && synthesized > 0 ? { unrecordedAnswered: synthesized } : {}),
      ...(decision.mode === "mocked" && (newAnswers.get(decision.name)?.count ?? 0) > 0 ? { newAnswers: newAnswers.get(decision.name)!.count, newAnswersDigest: newAnswers.get(decision.name)!.digest } : {}),
    };
  });
}

export const awsTestAccountMessage = (error: unknown): string => (error instanceof AwsTestAccountError ? error.message : WORDS.unreachable);

