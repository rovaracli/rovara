// Setup and test health SH22 (design setup-test-health.md, sections 5.2 and 12): the broker mints the registry sessions of saved environment images.
//
// Four kinds, each an STS session on a fixed-name role with an inline session policy that names ONE repository (contracts `saved-env-image.ts`), so a wrong repository name built here still cannot reach
// another project's or another org's image:
//   - push: for the build after a passing Prove of an APPROVED environment, 60 minutes (a large seed takes most of that; the worker refuses a login with under a minute left);
//   - pull: for one prepare of one task of that project, 30 minutes (the caller also pins the digest in the prepare payload);
//   - manage: list, describe and delete the images of one repository (keep N, the age ceiling, project delete), 15 minutes, for the broker's own use;
//   - scan: start a basic scan and read its findings after a push, 15 minutes, for the broker's own use.
// SQUATTING: before a push or pull login is minted, the broker uses a manage session to describe the repository and checks it is the repository the creation template makes (KMS encryption with the install's
// key, IMMUTABLE tags, the exact repository policy). A repository someone in the account made first, with other settings, is refused as `unavailable`. A repository that does not exist yet is fine for a push
// (the first push creates it from the template) and is verified again by `verifyRepository` after the push, before the digest is recorded (SH24).
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
  SAVED_ENV_MANAGE_SESSION_SECONDS,
  SAVED_ENV_PULL_SESSION_SECONDS,
  SAVED_ENV_PUSH_SESSION_SECONDS,
  canonicalJson,
  environmentRolePath,
  SavedEnvRegistryAuthSchema,
  savedEnvManageRoleName,
  companyImageMirrorRoleName,
  companyImageMirrorSessionPolicy,
  isCompanyImageRepositoryName,
  savedEnvManageSessionPolicy,
  savedEnvPullRoleName,
  savedEnvPullSessionPolicy,
  savedEnvPushRoleName,
  savedEnvPushSessionPolicy,
  savedEnvRepositoryName,
  savedEnvRepositoryPolicy,
  savedEnvScanSessionPolicy,
  type SavedEnvAccountScope,
  type SavedEnvRegistryAuth,
  type SessionPolicyJson,
} from "@agentx/contracts";

export interface SessionCredentials { accessKeyId: string; secretAccessKey: string; sessionToken: string }

/** What the broker reads of a repository to check it is the one the creation template makes. */
export interface RepositoryDescription {
  encryptionType: string | undefined;
  /** The key ARN ECR reports for a KMS repository. */
  kmsKey: string | undefined;
  imageTagMutability: string | undefined;
  /** The repository policy document as ECR returns it (JSON text), or undefined when there is none. */
  policyText: string | undefined;
}

export interface SavedEnvSessionPorts {
  /** STS AssumeRole on `roleArn` with this inline policy and duration. Errors are mapped by the caller to `unavailable`. */
  assume(request: { roleArn: string; sessionName: string; policy: string; durationSeconds: number }): Promise<{ credentials: SessionCredentials; expiresAtMs: number }>;
  /** ECR GetAuthorizationToken made WITH the assumed session's credentials, so the token carries the session policy. Returns the `user:password` pair's password and the registry host. */
  authorizationToken(credentials: SessionCredentials): Promise<{ password: string; registry: string; expiresAtMs: number }>;
  /** The newest approved test environment of the project, or undefined. Bind to `readApprovedTestEnvironment` (the digest is `testEnvDigest(environment)`). */
  /** ECR DescribeRepositories + GetRepositoryPolicy for one repository, made with a manage session's credentials. "absent" when the repository does not exist. */
  inspectRepository(credentials: SessionCredentials, repository: string): Promise<RepositoryDescription | "absent">;
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
  /** The key the creation template encrypts with (the install's own key, or the customer's). A repository with another key is refused. */
  kmsKeyArn: string;
}

export type SessionRefusal = "disabled" | "not_approved" | "not_proved" | "bad_ids" | "unavailable";
export type ManageResult = { ok: true; credentials: SessionCredentials; expiresAtMs: number; repository: string } | { ok: false; reason: SessionRefusal };
export type MintResult = { ok: true; auth: SavedEnvRegistryAuth; expiresAtMs: number } | { ok: false; reason: SessionRefusal };

export interface ApprovedPin { revision: number; digest: string }

const roleArnOf = (config: SavedEnvSessionConfig, name: string): string => `arn:${config.scope.partition}:iam::${config.scope.account}:role${environmentRolePath(config.env)}${name}`;

/** The session name carries no org or project: a name shows in CloudTrail and in the role's session ARN. */
const sessionName = (kind: string, nowMs: number): string => `saved-env-${kind}-${String(Math.floor(nowMs / 1000))}`;

function repositoryOf(config: SavedEnvSessionConfig, orgId: string, projectId: string): string | undefined {
  try { return savedEnvRepositoryName({ env: config.env, orgId, projectId }); } catch { return undefined; }
}

async function mintRaw(
  config: SavedEnvSessionConfig, ports: SavedEnvSessionPorts, kind: "push" | "pull", roleName: string, policy: SessionPolicyJson, repository: string, durationSeconds: number,
): Promise<MintResult> {
  const text = JSON.stringify(policy);
  // AWS packs a session policy to 2,048 characters; a longer one would be refused by STS, and a cut one would be wrong.
  if (text.length >= 2_048) return { ok: false, reason: "unavailable" };
  try {
    const assumed = await ports.assume({ roleArn: roleArnOf(config, roleName), sessionName: sessionName(kind, ports.now()), policy: text, durationSeconds });
    const token = await ports.authorizationToken(assumed.credentials);
    const expiresAtMs = Math.min(assumed.expiresAtMs, token.expiresAtMs);
    const parsed = SavedEnvRegistryAuthSchema.safeParse({ registry: token.registry, repository, username: "AWS", password: token.password, expiresAt: new Date(expiresAtMs).toISOString() });
    return parsed.success ? { ok: true, auth: parsed.data, expiresAtMs } : { ok: false, reason: "unavailable" };
  } catch {
    // Nothing from the error is kept: an AWS error can carry an ARN or a request id.
    return { ok: false, reason: "unavailable" };
  }
}

/** Whether `text` is JSON that is exactly `expected` (compared as canonical JSON, so key order and spacing do not matter). */
function samePolicy(text: string | undefined, expected: unknown): boolean {
  if (text === undefined) return false;
  try { return canonicalJson(JSON.parse(text)) === canonicalJson(JSON.parse(JSON.stringify(expected))); } catch { return false; }
}

/** The repository policy the creation template gives every repository of this environment: built from the three fixed-name roles' ARNs, the same function the template uses. */
export function expectedRepositoryPolicy(config: SavedEnvSessionConfig): ReturnType<typeof savedEnvRepositoryPolicy> {
  return savedEnvRepositoryPolicy({
    pushRoleArn: roleArnOf(config, savedEnvPushRoleName(config.env)),
    pullRoleArn: roleArnOf(config, savedEnvPullRoleName(config.env)),
    manageRoleArn: roleArnOf(config, savedEnvManageRoleName(config.env)),
    mirrorRoleArn: roleArnOf(config, companyImageMirrorRoleName(config.env)),
  });
}

/**
 * Credentials to list, describe and delete the images of ONE project's repository (keep N, the age ceiling, project delete). Not tied to an approved revision: a deleted project has none. Not handed to a
 * worker: the broker uses it itself.
 */
export async function mintManageSession(config: SavedEnvSessionConfig, ports: SavedEnvSessionPorts, input: { orgId: string; projectId: string }): Promise<ManageResult> {
  if (!config.enabled) return { ok: false, reason: "disabled" };
  const repository = repositoryOf(config, input.orgId, input.projectId);
  if (repository === undefined) return { ok: false, reason: "bad_ids" };
  return mintManageSessionFor(config, ports, repository);
}

/** The manage session for a repository NAMED by the caller (a company image's mirror, `companyImageRepositoryName`); the name must be a saved-environment-shaped one (the session policy builder refuses any other). */
export async function mintManageSessionFor(config: SavedEnvSessionConfig, ports: SavedEnvSessionPorts, repository: string): Promise<ManageResult> {
  if (!config.enabled) return { ok: false, reason: "disabled" };
  const policy = JSON.stringify(savedEnvManageSessionPolicy(config.scope, repository));
  if (policy.length >= 2_048) return { ok: false, reason: "unavailable" };
  try {
    const assumed = await ports.assume({ roleArn: roleArnOf(config, savedEnvManageRoleName(config.env)), sessionName: sessionName("manage", ports.now()), policy, durationSeconds: SAVED_ENV_MANAGE_SESSION_SECONDS });
    return { ok: true, credentials: assumed.credentials, expiresAtMs: assumed.expiresAtMs, repository };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Credentials for the push role limited to starting a basic scan on ONE repository and reading its findings (SH24 starts a scan after each push). For the broker's own use; the worker never gets them.
 */
export async function mintScanSession(config: SavedEnvSessionConfig, ports: SavedEnvSessionPorts, input: { orgId: string; projectId: string }): Promise<ManageResult> {
  if (!config.enabled) return { ok: false, reason: "disabled" };
  const repository = repositoryOf(config, input.orgId, input.projectId);
  if (repository === undefined) return { ok: false, reason: "bad_ids" };
  try {
    const assumed = await ports.assume({ roleArn: roleArnOf(config, savedEnvPushRoleName(config.env)), sessionName: sessionName("scan", ports.now()), policy: JSON.stringify(savedEnvScanSessionPolicy(config.scope, repository)), durationSeconds: SAVED_ENV_MANAGE_SESSION_SECONDS });
    return { ok: true, credentials: assumed.credentials, expiresAtMs: assumed.expiresAtMs, repository };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Whether the project's repository is the one the creation template makes: KMS encryption with the install's key, IMMUTABLE tags, the exact repository policy. Run with a manage session of the broker's own.
 * `absent` is `"absent"` (a push may go ahead: the first push creates it from the template; verify again after the push). Any other difference, or any error, is `unavailable`.
 */
export async function verifyRepository(config: SavedEnvSessionConfig, ports: SavedEnvSessionPorts, input: { orgId: string; projectId: string }): Promise<{ ok: true; state: "matches" | "absent" } | { ok: false; reason: SessionRefusal }> {
  const manage = await mintManageSession(config, ports, input);
  if (!manage.ok) return manage;
  return verifyManaged(config, ports, manage);
}

/** `verifyRepository` for a repository named by the caller. */
export async function verifyRepositoryNamed(config: SavedEnvSessionConfig, ports: SavedEnvSessionPorts, repository: string): Promise<{ ok: true; state: "matches" | "absent" } | { ok: false; reason: SessionRefusal }> {
  const manage = await mintManageSessionFor(config, ports, repository);
  if (!manage.ok) return manage;
  return verifyManaged(config, ports, manage);
}

export async function verifyManaged(config: SavedEnvSessionConfig, ports: SavedEnvSessionPorts, manage: { credentials: SessionCredentials; repository: string }): Promise<{ ok: true; state: "matches" | "absent" } | { ok: false; reason: SessionRefusal }> {
  let found: RepositoryDescription | "absent";
  try { found = await ports.inspectRepository(manage.credentials, manage.repository); } catch { return { ok: false, reason: "unavailable" }; }
  if (found === "absent") return { ok: true, state: "absent" };
  const same = found.encryptionType === "KMS" && found.kmsKey === config.kmsKeyArn && found.imageTagMutability === "IMMUTABLE" && samePolicy(found.policyText, expectedRepositoryPolicy(config));
  return same ? { ok: true, state: "matches" } : { ok: false, reason: "unavailable" };
}

/**
 * A push login for the project's repository. Only when the install's setting is on, the project has an approved test environment, the caller's `approved` pin IS that environment's newest revision and digest,
 * the Prove report for that digest passed, and the repository (if it exists) is the one the template made. The caller (the rebuild job) holds the pin from the job it queued; if the project's approved
 * environment moved since, the push is refused and the job is requeued.
 */
export async function mintPushSession(config: SavedEnvSessionConfig, ports: SavedEnvSessionPorts, input: { orgId: string; projectId: string; approved: ApprovedPin }): Promise<MintResult> {
  if (!config.enabled) return { ok: false, reason: "disabled" };
  const repository = repositoryOf(config, input.orgId, input.projectId);
  if (repository === undefined) return { ok: false, reason: "bad_ids" };
  const current = await ports.readApproved(input.orgId, input.projectId);
  if (current === undefined || current.revision !== input.approved.revision || current.digest !== input.approved.digest) return { ok: false, reason: "not_approved" };
  if (!(await ports.proveHolds(input.orgId, input.projectId, current.digest))) return { ok: false, reason: "not_proved" };
  const verified = await verifyRepository(config, ports, input);
  if (!verified.ok) return verified;
  return mintRaw(config, ports, "push", savedEnvPushRoleName(config.env), savedEnvPushSessionPolicy(config.scope, repository), repository, SAVED_ENV_PUSH_SESSION_SECONDS);
}

/** A pull login for the project's repository, for a task pinned to `approved`. Refused when that is no longer the project's newest approved revision (the image of another revision is not used), and when the repository is missing or is not the one the template made. */
export async function mintPullSession(config: SavedEnvSessionConfig, ports: SavedEnvSessionPorts, input: { orgId: string; projectId: string; approved: ApprovedPin }): Promise<MintResult> {
  if (!config.enabled) return { ok: false, reason: "disabled" };
  const repository = repositoryOf(config, input.orgId, input.projectId);
  if (repository === undefined) return { ok: false, reason: "bad_ids" };
  const current = await ports.readApproved(input.orgId, input.projectId);
  if (current === undefined || current.revision !== input.approved.revision || current.digest !== input.approved.digest) return { ok: false, reason: "not_approved" };
  const verified = await verifyRepository(config, ports, input);
  if (!verified.ok || verified.state !== "matches") return { ok: false, reason: "unavailable" };
  return mintRaw(config, ports, "pull", savedEnvPullRoleName(config.env), savedEnvPullSessionPolicy(config.scope, repository), repository, SAVED_ENV_PULL_SESSION_SECONDS);
}

/** A pull login for a repository named by the caller (a company image's mirror), for the seconds the worker's pull may take. The repository must be there and be the one the template made. */
export async function mintPullSessionFor(config: SavedEnvSessionConfig, ports: SavedEnvSessionPorts, repository: string): Promise<MintResult> {
  if (!config.enabled) return { ok: false, reason: "disabled" };
  const verified = await verifyRepositoryNamed(config, ports, repository);
  if (!verified.ok || verified.state !== "matches") return { ok: false, reason: "unavailable" };
  return mintRaw(config, ports, "pull", savedEnvPullRoleName(config.env), savedEnvPullSessionPolicy(config.scope, repository), repository, SAVED_ENV_PULL_SESSION_SECONDS);
}

/**
 * Credentials for the company image mirror's OWN role (`companyImageMirrorRoleName`), with a session policy that names ONE mirror repository. Not the push or manage role: those reach every saved environment's
 * repositories, and the mirror function, which parses untrusted bytes from the internet, must not. The role's own IAM policy reaches `o?/c?` mirror repositories only. Used for the template check, the copy and the revoke's delete.
 */
export async function mintMirrorCredentials(config: SavedEnvSessionConfig, ports: SavedEnvSessionPorts, repository: string): Promise<{ ok: true; credentials: SessionCredentials } | { ok: false; reason: SessionRefusal }> {
  if (!config.enabled) return { ok: false, reason: "disabled" };
  try {
    if (!isCompanyImageRepositoryName(repository)) return { ok: false, reason: "bad_ids" };
    const policy = JSON.stringify(companyImageMirrorSessionPolicy(config.scope, repository));
    if (policy.length >= 2_048) return { ok: false, reason: "unavailable" };
    const assumed = await ports.assume({ roleArn: roleArnOf(config, companyImageMirrorRoleName(config.env)), sessionName: sessionName("mirror", ports.now()), policy, durationSeconds: SAVED_ENV_PUSH_SESSION_SECONDS });
    return { ok: true, credentials: assumed.credentials };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
