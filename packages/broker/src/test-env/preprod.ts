// Proof and test environment E9 (design proof-test-env, sections 4.6 and 6): access to a pre-prod service for one round, and which mode each service ran in.
//
// Access: STS AssumeRole into the customer's own role, with a SESSION POLICY that allows exactly `sagemaker:InvokeEndpoint` on that one endpoint, a session of at most one hour, a session name from the task, and an external id
// derived from the org (so a role made for one org never opens for another). The credentials are returned to the caller to hand to the sandbox's environment; they are never stored, logged or put in evidence.
// Refused before any AWS call: a role in Rovara's own account, anything on the company's production deny list, an endpoint ARN that is not the service's endpoint in its region, and any service kind this module has no
// narrow policy for (only SageMaker Runtime today; another kind is added with its own policy, never a wildcard).
//
// Modes: `preprod` always uses the real service and the round FAILS when it cannot be reached; `mock` always uses the recorded fixtures; `auto` probes pre-prod once at the start of the round and uses the mock when the
// probe fails. The mode actually used is returned for every service, and goes into the evidence (the Environment line and the `mocked_service` not-tested items), so the PR never says "pre-prod" for a mocked call.
import { createHash } from "node:crypto";
import type { AssumeRoleCommandInput } from "@aws-sdk/client-sts";
import {
  arnAccountId,
  prodDenyMatchesAccount,
  prodDenyMatchesArn,
  type EvidenceEnvironment,
  type OrgId,
  type ServiceMockFixtureSet,
  type TestEnvironmentBody,
} from "@agentx/contracts";

type Service = TestEnvironmentBody["services"][number];

export const PREPROD_SESSION_SECONDS = 3_600;
const SESSION_POLICY_MAX_CHARS = 2_048;

export interface AssumedCredentials { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date }
export interface PreprodAws {
  /** The AWS account the deployment runs in; a role in it is refused. Undefined where it is not known (then every role is refused: fail closed). */
  ownAccountId: string | undefined;
  assumeRole(input: AssumeRoleCommandInput): Promise<AssumedCredentials>;
}

/** Fixed reasons, safe to show. Never a role ARN, a message from AWS, or a credential. */
export const PREPROD_ACCESS_CODES = ["no_role", "own_account", "production", "arn_mismatch", "unsupported_kind", "refused", "unreachable", "bad_session"] as const;
export type PreprodAccessCode = (typeof PREPROD_ACCESS_CODES)[number];
const WORDS: Record<PreprodAccessCode, string> = {
  no_role: "this pre-prod service has no role to assume",
  own_account: "the pre-prod role must be in your own AWS account, not Rovara's",
  production: "this pre-prod service is on the production deny list",
  arn_mismatch: "the pre-prod endpoint does not match the service it is configured for",
  unsupported_kind: "Rovara can open pre-prod access only to SageMaker Runtime endpoints so far",
  refused: "AWS refused to let Rovara assume the pre-prod role; check its trust policy and external id",
  unreachable: "AWS could not be reached to assume the pre-prod role",
  bad_session: "AWS did not return a usable pre-prod session",
};

export class PreprodAccessError extends Error {
  constructor(readonly code: PreprodAccessCode, readonly retryable = code === "unreachable") {
    super(WORDS[code]);
    this.name = "PreprodAccessError";
  }
}

/** The external id the customer's role trusts: derived from the org, so it is not a secret to guess but a check that the request is for this org. */
export const preprodExternalId = (orgId: OrgId): string => `rovara-testenv-${createHash("sha256").update(`testenv|${orgId}`).digest("hex").slice(0, 32)}`;

/** The session policy: invoke this one endpoint and nothing else. */
export function preprodSessionPolicy(endpointArn: string): string {
  const policy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["sagemaker:InvokeEndpoint"], Resource: endpointArn }] });
  if (policy.length > SESSION_POLICY_MAX_CHARS) throw new PreprodAccessError("arn_mismatch");
  return policy;
}

function checkService(service: Service, prodDeny: TestEnvironmentBody["prodDeny"], ownAccountId: string | undefined): { roleArn: string; endpointArn: string } {
  const preprod = service.preprod;
  if (preprod?.roleArn === undefined) throw new PreprodAccessError("no_role");
  if (service.kind !== "sagemaker_runtime" || preprod.endpointArn === undefined) throw new PreprodAccessError("unsupported_kind");
  const roleAccount = arnAccountId(preprod.roleArn);
  if (ownAccountId === undefined || roleAccount === ownAccountId) throw new PreprodAccessError("own_account");
  for (const arn of [preprod.roleArn, preprod.endpointArn]) {
    if (prodDenyMatchesArn(prodDeny, arn) !== undefined || (arnAccountId(arn) !== undefined && prodDenyMatchesAccount(prodDeny, arnAccountId(arn) as string))) throw new PreprodAccessError("production");
  }
  // arn:aws:sagemaker:<region>:<account>:endpoint/<name>
  const parts = preprod.endpointArn.split(":");
  const name = parts[5]?.replace(/^endpoint\//u, "");
  if (parts[3] !== preprod.region || name !== service.match.endpointName) throw new PreprodAccessError("arn_mismatch");
  return { roleArn: preprod.roleArn, endpointArn: preprod.endpointArn };
}

/** Opens a session for one service for one round. */
export async function openPreprodSession(
  aws: PreprodAws,
  input: { orgId: OrgId; taskId: string; service: Service; prodDeny: TestEnvironmentBody["prodDeny"]; now(): number },
): Promise<{ credentials: AssumedCredentials; expiresAtMs: number }> {
  const { roleArn, endpointArn } = checkService(input.service, input.prodDeny, aws.ownAccountId);
  let credentials: AssumedCredentials;
  try {
    credentials = await aws.assumeRole({
      RoleArn: roleArn,
      RoleSessionName: `rovara-${input.taskId.replace(/[^A-Za-z0-9]/gu, "").slice(0, 8) || "task"}`,
      ExternalId: preprodExternalId(input.orgId),
      DurationSeconds: PREPROD_SESSION_SECONDS,
      Policy: preprodSessionPolicy(endpointArn),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new PreprodAccessError(name === "AccessDenied" || name === "AccessDeniedException" || name === "MalformedPolicyDocument" ? "refused" : "unreachable");
  }
  const expiresAtMs = credentials?.expiration instanceof Date ? credentials.expiration.getTime() : Number.NaN;
  // A session longer than the hour asked for, one that has already ended, or one with missing parts is not used.
  if (typeof credentials?.accessKeyId !== "string" || credentials.accessKeyId === "" || typeof credentials.secretAccessKey !== "string" || credentials.secretAccessKey === "" || typeof credentials.sessionToken !== "string" || credentials.sessionToken === ""
    || !Number.isFinite(expiresAtMs) || expiresAtMs <= input.now() || expiresAtMs > input.now() + PREPROD_SESSION_SECONDS * 1_000 + 60_000) throw new PreprodAccessError("bad_session", false);
  return { credentials, expiresAtMs };
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
): EvidenceEnvironment["services"] {
  return decisions.map((decision) => {
    const set = decision.mode === "mocked" ? fixtureSets.get(decision.name) : undefined;
    const synthesized = unrecordedAnswered.get(decision.name) ?? 0;
    return {
      name: decision.name, mode: decision.mode,
      ...(set === undefined ? {} : { fixtureRevision: set.revision, recordedAt: set.recordedAt }),
      ...(decision.mode === "mocked" && synthesized > 0 ? { unrecordedAnswered: synthesized } : {}),
    };
  });
}

export const preprodAccessMessage = (error: unknown): string => (error instanceof PreprodAccessError ? error.message : WORDS.unreachable);

