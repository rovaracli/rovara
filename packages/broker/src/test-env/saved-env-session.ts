// Setup and test health SH22 (design setup-test-health.md, sections 5.2 and 12): the broker mints the registry sessions of saved environment images.
//
// Three kinds, each an STS session on a fixed-name role with an inline session policy that names ONE repository (contracts `saved-env-image.ts`), so a wrong repository name built here still cannot reach
// another project's or another org's image:
//   - push: for the build after a passing Prove of an APPROVED environment, 15 minutes;
//   - pull: for one prepare of one task of that project, 15 minutes (the caller also pins the digest in the prepare payload);
//   - manage: list and delete the images of one repository (keep N, project delete), 15 minutes.
// A session is handed on as a REGISTRY LOGIN (`SavedEnvRegistryAuth`): the worker never sees AWS credentials, only a token that works for that one repository.
//
// What this refuses, each with its own fixed word and no value in it:
//   `disabled`      the install's `sv` setting is off (the caller passes it; with it off nothing here reaches AWS);
//   `not_approved`  the project has no approved test environment, or the one named is not the newest approved revision, or its digest is not the one named;
//   `not_proved`    (push) the Prove report recorded for the approved digest did not pass;
//   `bad_ids`       an org or project id that is not text.
// The org and the project come from the broker's own verified operation, never from the worker's request: the worker names neither (the caller derives the repository from the operation's project).
//
// The AWS calls are PORTS: `assume` (STS AssumeRole with the policy) and `authorizationToken` (ECR GetAuthorizationToken with the assumed session's credentials). Their adapters are wired with the routes (SH24/SH25).
import {
  SAVED_ENV_SESSION_SECONDS,
  environmentRolePath,
  SavedEnvRegistryAuthSchema,
  savedEnvManageRoleName,
  savedEnvManageSessionPolicy,
  savedEnvPullRoleName,
  savedEnvPullSessionPolicy,
  savedEnvPushRoleName,
  savedEnvPushSessionPolicy,
  savedEnvRepositoryName,
  type SavedEnvAccountScope,
  type SavedEnvRegistryAuth,
  type SessionPolicyJson,
} from "@agentx/contracts";

export interface SessionCredentials { accessKeyId: string; secretAccessKey: string; sessionToken: string }

export interface SavedEnvSessionPorts {
  /** STS AssumeRole on `roleArn` with this inline policy and duration. Errors are mapped by the caller to `unavailable`. */
  assume(request: { roleArn: string; sessionName: string; policy: string; durationSeconds: number }): Promise<{ credentials: SessionCredentials; expiresAtMs: number }>;
  /** ECR GetAuthorizationToken made WITH the assumed session's credentials, so the token carries the session policy. Returns the `user:password` pair's password and the registry host. */
  authorizationToken(credentials: SessionCredentials): Promise<{ password: string; registry: string; expiresAtMs: number }>;
  /** The newest approved test environment of the project, or undefined. Bind to `readApprovedTestEnvironment` (the digest is `testEnvDigest(environment)`). */
  readApproved(orgId: string, projectId: string): Promise<{ revision: number; digest: string } | undefined>;
  /** The Prove report recorded for that exact digest: whether it passed (`testEnvIsProved`). */
  proveHolds(orgId: string, projectId: string, digest: string): Promise<boolean>;
  now(): number;
}

export interface SavedEnvSessionConfig {
  /** The install's `sv` setting: on only when exactly "1" (contracts broker-names). */
  enabled: boolean;
  env: string;
  scope: SavedEnvAccountScope;
}

export type SessionRefusal = "disabled" | "not_approved" | "not_proved" | "bad_ids" | "unavailable";
export type MintResult = { ok: true; auth: SavedEnvRegistryAuth; expiresAtMs: number } | { ok: false; reason: SessionRefusal };

export interface ApprovedPin { revision: number; digest: string }

const roleArnOf = (config: SavedEnvSessionConfig, name: string): string => `arn:${config.scope.partition}:iam::${config.scope.account}:role${environmentRolePath(config.env)}${name}`;

/** The session name carries no org or project: a name shows in CloudTrail and in the role's session ARN. */
const sessionName = (kind: string, nowMs: number): string => `saved-env-${kind}-${String(Math.floor(nowMs / 1000))}`;

function repositoryOf(config: SavedEnvSessionConfig, orgId: string, projectId: string): string | undefined {
  try { return savedEnvRepositoryName({ env: config.env, orgId, projectId }); } catch { return undefined; }
}

async function mint(
  config: SavedEnvSessionConfig, ports: SavedEnvSessionPorts, kind: "push" | "pull", roleName: string, policy: SessionPolicyJson, repository: string,
): Promise<MintResult> {
  const text = JSON.stringify(policy);
  // AWS packs a session policy to 2,048 characters; a longer one would be refused by STS, and a cut one would be wrong.
  if (text.length >= 2_048) return { ok: false, reason: "unavailable" };
  try {
    const assumed = await ports.assume({ roleArn: roleArnOf(config, roleName), sessionName: sessionName(kind, ports.now()), policy: text, durationSeconds: SAVED_ENV_SESSION_SECONDS });
    const token = await ports.authorizationToken(assumed.credentials);
    const expiresAtMs = Math.min(assumed.expiresAtMs, token.expiresAtMs);
    const parsed = SavedEnvRegistryAuthSchema.safeParse({ registry: token.registry, repository, username: "AWS", password: token.password, expiresAt: new Date(expiresAtMs).toISOString() });
    return parsed.success ? { ok: true, auth: parsed.data, expiresAtMs } : { ok: false, reason: "unavailable" };
  } catch {
    // Nothing from the error is kept: an AWS error can carry an ARN or a request id.
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * A push login for the project's repository. Only when the install's setting is on, the project has an approved test environment, the caller's `approved` pin IS that environment's newest revision and digest, and
 * the Prove report for that digest passed. The caller (the rebuild job) holds the pin from the job it queued; if the project's approved environment moved since, the push is refused and the job is requeued.
 */
export async function mintPushSession(config: SavedEnvSessionConfig, ports: SavedEnvSessionPorts, input: { orgId: string; projectId: string; approved: ApprovedPin }): Promise<MintResult> {
  if (!config.enabled) return { ok: false, reason: "disabled" };
  const repository = repositoryOf(config, input.orgId, input.projectId);
  if (repository === undefined) return { ok: false, reason: "bad_ids" };
  const current = await ports.readApproved(input.orgId, input.projectId);
  if (current === undefined || current.revision !== input.approved.revision || current.digest !== input.approved.digest) return { ok: false, reason: "not_approved" };
  if (!(await ports.proveHolds(input.orgId, input.projectId, current.digest))) return { ok: false, reason: "not_proved" };
  return mint(config, ports, "push", savedEnvPushRoleName(config.env), savedEnvPushSessionPolicy(config.scope, repository), repository);
}

/** A pull login for the project's repository, for a task pinned to `approved`. Refused when that is no longer the project's newest approved revision (the image of another revision is not used). */
export async function mintPullSession(config: SavedEnvSessionConfig, ports: SavedEnvSessionPorts, input: { orgId: string; projectId: string; approved: ApprovedPin }): Promise<MintResult> {
  if (!config.enabled) return { ok: false, reason: "disabled" };
  const repository = repositoryOf(config, input.orgId, input.projectId);
  if (repository === undefined) return { ok: false, reason: "bad_ids" };
  const current = await ports.readApproved(input.orgId, input.projectId);
  if (current === undefined || current.revision !== input.approved.revision || current.digest !== input.approved.digest) return { ok: false, reason: "not_approved" };
  return mint(config, ports, "pull", savedEnvPullRoleName(config.env), savedEnvPullSessionPolicy(config.scope, repository), repository);
}

/** Credentials to list and delete the images of ONE project's repository (keep N, project delete). Not tied to an approved revision: a deleted project has none. Not handed to a worker: the broker uses it itself. */
export async function mintManageSession(config: SavedEnvSessionConfig, ports: SavedEnvSessionPorts, input: { orgId: string; projectId: string }): Promise<{ ok: true; credentials: SessionCredentials; expiresAtMs: number; repository: string } | { ok: false; reason: SessionRefusal }> {
  if (!config.enabled) return { ok: false, reason: "disabled" };
  const repository = repositoryOf(config, input.orgId, input.projectId);
  if (repository === undefined) return { ok: false, reason: "bad_ids" };
  const policy = JSON.stringify(savedEnvManageSessionPolicy(config.scope, repository));
  if (policy.length >= 2_048) return { ok: false, reason: "unavailable" };
  try {
    const assumed = await ports.assume({ roleArn: roleArnOf(config, savedEnvManageRoleName(config.env)), sessionName: sessionName("manage", ports.now()), policy, durationSeconds: SAVED_ENV_SESSION_SECONDS });
    return { ok: true, credentials: assumed.credentials, expiresAtMs: assumed.expiresAtMs, repository };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
