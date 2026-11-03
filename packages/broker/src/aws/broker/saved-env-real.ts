// Saved project images (SV wiring): the registry's real bindings, built only while the install's `sv` switch is on. Nothing here makes a decision: the rules are in test-env/saved-env.ts and its siblings.
//   store            the DynamoDB adapter (test-env/saved-env-store.ts), with the audit ledger;
//   session / registry  STS and ECR through session credentials (saved-env-aws.ts), in the install's region, account and environment name, with the key the creation template encrypts with
//                    (AGENTX_NAMES `sk`, passed as the key's id): without any of them the registry is not installed (a log line names the missing one, never a value);
//   approved / proveHolds  the project's newest approved test environment (its digest is `testEnvDigest`) and the Prove report recorded for that digest;
//   defaultHeads     the head of each repository's default branch, through the code host the repository's RECORD names (as setup-pins.ts reads them), or undefined when any cannot be read;
//   currentKey       the environment key of the default branches AT the heads the registry read: worked out here from the code host's tree listing (blob ids of the key files, saved-env-key.ts), the approved
//                    environment (revision, detector globs, secret names) and the base image digest the install says (`savedEnvBaseImageDigest`). Anything missing gives undefined, and the registry then queues
//                    nothing (`no_key`): it fails closed;
//   keep / lightAfterIdleDays  the defaults (the company settings are not stored yet);
//   onQueued         starts the job the registry queued (saved-env-triggers.ts).
import { awsPartitionOf } from "../broker-environment.js";
import { readWorkerSettings } from "../worker-settings-read.js";
import { imageDigestOfReference, testEnvDigest, testEnvIsProved, type TestEnvironmentBody, workerProjectDefinition, SAVED_ENV_KEEP_DEFAULT, SAVED_ENV_LIGHT_AFTER_IDLE_DAYS_DEFAULT, type OrgId } from "@agentx/contracts";
import { readApprovedTestEnvironment, readTestEnvProveReport, type TestEnvDeps } from "../../org/test-environment.js";
import type { SavedEnvDeps } from "../../test-env/saved-env.js";
import { dynamoSavedEnvStore } from "../../test-env/saved-env-store.js";
import { savedEnvEnabled } from "../../test-env/saved-env-switch.js";
import { realSavedEnvAwsClients, savedEnvRegistryPort, savedEnvSessionPorts, type SavedEnvAwsClients } from "./saved-env-aws.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { requireLatestProject } from "./records.js";
import { hostOfRepository } from "./repository-hosts.js";
import { githubScope } from "./scope-helpers.js";
import { savedEnvOnQueued } from "./saved-env-triggers.js";
import { KeyListingCache, expectedEnvironmentKey, type KeyHost } from "../../test-env/saved-env-key.js";
import { GITHUB_HOST_KIND } from "../../plugins/code-host/github/index.js";
import type { SavedEnvBuildInputs } from "./saved-env-rebuild.js";

const ACCOUNT = /^[0-9]{12}$/u;
const KMS_KEY_ARN = /^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key\/(?:mrk-[0-9a-f]{32}|[0-9a-f-]{36})$/u;

/** The environment the registry's config is read from. Undefined (with the missing name logged) when the install cannot run it. */
export function savedEnvConfigOf(env: NodeJS.ProcessEnv): { env: string; scope: { partition: string; region: string; account: string }; kmsKeyArn: string } | undefined {
  const name = env["AGENTX_ENV"];
  const region = env["AWS_REGION"];
  const account = env["AGENTX_ACCOUNT_ID"];
  const kmsKeyArn = env["SAVED_ENV_KMS_KEY_ARN"];
  const missing = [["AGENTX_ENV", name !== undefined && name !== ""], ["AWS_REGION", region !== undefined && region !== ""], ["AGENTX_ACCOUNT_ID", account !== undefined && ACCOUNT.test(account)], ["SAVED_ENV_KMS_KEY_ARN", kmsKeyArn !== undefined && KMS_KEY_ARN.test(kmsKeyArn)]]
    .filter(([, present]) => present !== true).map(([variable]) => variable);
  if (missing.length > 0) {
    console.log(JSON.stringify({ component: "broker", event: "saved_env.not_installed", missing }));
    return undefined;
  }
  return { env: name!, scope: { partition: awsPartitionOf(region!), region: region!, account: account! }, kmsKeyArn: kmsKeyArn! };
}

const testEnvDepsOf = (dependencies: AwsBrokerDependencies): TestEnvDeps => ({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }) });

/** The head of each repository of the project's default branch, by repository name; undefined when the project has none or any head cannot be read. */
export async function savedEnvDefaultHeads(dependencies: AwsBrokerDependencies, orgId: OrgId, project: string): Promise<ReadonlyMap<string, string> | undefined> {
  try {
    const repositories = workerProjectDefinition((await requireLatestProject(dependencies, orgId, project)).definition).repositories;
    const heads = new Map<string, string>();
    for (const repository of repositories) {
      const host = hostOfRepository(dependencies, repository);
      const commit = await host.baseBranchHead({ url: repository.url }, repository.defaultBranch, githubScope(dependencies, orgId));
      if (!/^[a-f0-9]{40}$/u.test(commit)) return undefined;
      heads.set(repository.name, commit);
    }
    return heads;
  } catch {
    return undefined;
  }
}

/**
 * The digest of the image the project's commands run in, from the worker image setting: the sandbox image IS the worker image (boot-stage2.sh and boot-legacy.sh set AGENTX_SANDBOX_IMAGE to AGENTX_WORKER_IMAGE).
 * Only a reference pinned by digest (`...@sha256:<64 hex>`) has one: a tag, or anything else, gives none, and so no key (fail closed).
 * WORKER-WIDE BY DESIGN: it is the one image every worker of the environment runs, not a property of a project, so a rollout of a new worker image changes every project's key and every saved image is rebuilt once.
 */
export function baseImageDigestOfWorkerImage(image: string | undefined): string | undefined {
  return imageDigestOfReference(image);
}

/** How long a read of the worker image setting is reused: a check asks for it every time, and the setting changes at a release. */
export const SAVED_ENV_BASE_IMAGE_CACHE_MS = 60_000;

/**
 * `savedEnvBaseImageDigest`: reads the worker settings with the one reader the session steps launch workers with (`readWorkerSettings`), under the environment's settings prefix (the broker's read grant covers it), and
 * names the image's digest. A failed read, a missing setting or an image that is a tag is undefined. Only a good answer is kept (a minute).
 */
export function savedEnvBaseImageDigestReader(read: Parameters<typeof readWorkerSettings>[0], prefix: string, now: () => number = Date.now): () => Promise<string | undefined> {
  let kept: { digest: string; until: number } | undefined;
  return async () => {
    if (kept !== undefined && kept.until > now()) return kept.digest;
    try {
      const digest = baseImageDigestOfWorkerImage((await readWorkerSettings(read, { prefix, modelProxyRequired: false })).workerImage);
      if (digest !== undefined) kept = { digest, until: now() + SAVED_ENV_BASE_IMAGE_CACHE_MS };
      return digest;
    } catch {
      return undefined;
    }
  };
}

/**
 * The NAMES of the secrets an approved environment reads (never a value), in no particular order: the key holds them as a set. TODAY ONLY the `http_hook` accounts' `tokenSecretName` is one: no other field of the
 * environment names a secret, and the project's own secrets are not in the environment. A field added later that names a secret must be added here, or its change would not move the key.
 */
export function savedEnvSecretNames(environment: TestEnvironmentBody): string[] {
  return [...new Set(environment.accounts.flatMap((account) => (account.provisioner === "http_hook" ? [account.tokenSecretName] : [])))];
}

/** The code host's side of the key: GitHub's tree listing and file read, through the org's own installation. Another host kind gives no listing, and so no key. */
export function savedEnvKeyHost(dependencies: AwsBrokerDependencies, orgId: OrgId): KeyHost {
  const github = dependencies.githubPullRequests;
  return {
    async listTree(repository, commit) {
      const host = hostOfRepository(dependencies, repository as Parameters<typeof hostOfRepository>[1]);
      if (host.kind !== GITHUB_HOST_KIND || github.listTreeAtCommit === undefined) return undefined;
      return github.listTreeAtCommit(repository.url, commit, githubScope(dependencies, orgId));
    },
    async readText(repository, commit, path) {
      const host = hostOfRepository(dependencies, repository as Parameters<typeof hostOfRepository>[1]);
      return host.fileAtRevision({ url: repository.url }, path, commit, githubScope(dependencies, orgId), { maxBytes: 1_048_576 });
    },
  };
}

/**
 * The key's inputs the install knows for a project: the approved environment's secret names and detector globs, and the base image digest the install says. Undefined when there is no approved environment or no base
 * image digest (then a job cannot be built for, and no key is worked out).
 */
export async function savedEnvBuildInputsOf(dependencies: AwsBrokerDependencies, orgId: OrgId, project: string): Promise<(SavedEnvBuildInputs & { revision: number }) | undefined> {
  const approved = await readApprovedTestEnvironment(testEnvDepsOf(dependencies), orgId, project);
  const baseImageDigest = await dependencies.savedEnvBaseImageDigest?.();
  if (approved === undefined || baseImageDigest === undefined || !/^sha256:[a-f0-9]{64}$/u.test(baseImageDigest)) return undefined;
  return { revision: approved.revision, baseImageDigest, secretNames: savedEnvSecretNames(approved.environment), detectorGlobs: [...approved.environment.selection.fullSuiteOn] };
}

/**
 * The registry's dependencies, or undefined when the `sv` switch is off or the install cannot run it. `dependencies` is a getter: the registry is made while the broker's dependencies are being made.
 * `clients` is a test seam.
 */
export function realSavedEnvDeps(input: Pick<AwsBrokerDependencies, "documentClient" | "tableName" | "audit">, dependencies: () => AwsBrokerDependencies, env: NodeJS.ProcessEnv = process.env, clients?: SavedEnvAwsClients): SavedEnvDeps | undefined {
  if (!savedEnvEnabled(env)) return undefined;
  const config = savedEnvConfigOf(env);
  if (config === undefined) return undefined;
  const aws = clients ?? realSavedEnvAwsClients(config.scope.region);
  const keyCache = new KeyListingCache();
  const now = Date.now;
  const approved = async (orgId: string, project: string) => {
    const found = await readApprovedTestEnvironment(testEnvDepsOf(dependencies()), orgId, project);
    return found === undefined ? undefined : { revision: found.revision, digest: testEnvDigest(found.environment) };
  };
  return {
    store: dynamoSavedEnvStore({ documentClient: input.documentClient, tableName: input.tableName, now, ...(input.audit === undefined ? {} : { audit: input.audit }) }),
    session: {
      config: { enabled: true, env: config.env, scope: config.scope, kmsKeyArn: config.kmsKeyArn },
      ports: savedEnvSessionPorts(aws, {
        readApproved: approved,
        proveHolds: async (orgId, project, digest) => testEnvIsProved(await readTestEnvProveReport(testEnvDepsOf(dependencies()), orgId, project, digest), digest),
        now,
      }),
    },
    registry: savedEnvRegistryPort(aws),
    approved,
    currentKey: async (orgId, project, heads) => {
      if (heads === undefined) return undefined;
      const current = dependencies();
      const inputs = await savedEnvBuildInputsOf(current, orgId, project);
      if (inputs === undefined) return undefined;
      const repositories = workerProjectDefinition((await requireLatestProject(current, orgId, project)).definition).repositories.map((repository) => ({ name: repository.name, url: repository.url }));
      return expectedEnvironmentKey(savedEnvKeyHost(current, orgId), { repositories, commits: heads, detectorGlobs: inputs.detectorGlobs, testEnvRevision: inputs.revision, secretNames: inputs.secretNames, baseImageDigest: inputs.baseImageDigest }, keyCache);
    },
    defaultHeads: (orgId, project) => savedEnvDefaultHeads(dependencies(), orgId, project),
    keep: async () => SAVED_ENV_KEEP_DEFAULT,
    lightAfterIdleDays: async () => SAVED_ENV_LIGHT_AFTER_IDLE_DAYS_DEFAULT,
    now,
    onQueued: savedEnvOnQueued(dependencies, async (orgId, project) => {
      const inputs = await savedEnvBuildInputsOf(dependencies(), orgId, project);
      return inputs === undefined ? undefined : { baseImageDigest: inputs.baseImageDigest, secretNames: inputs.secretNames, detectorGlobs: inputs.detectorGlobs };
    }, env),
  };
}

