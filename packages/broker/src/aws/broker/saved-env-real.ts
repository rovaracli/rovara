// Saved project images (SV wiring): the registry's real bindings, built only while the install's `sv` switch is on. Nothing here makes a decision: the rules are in test-env/saved-env.ts and its siblings.
//   store            the DynamoDB adapter (test-env/saved-env-store.ts), with the audit ledger;
//   session / registry  STS and ECR through session credentials (saved-env-aws.ts), in the install's region, account and environment name, with the key the creation template encrypts with
//                    (AGENTX_NAMES `sk`, passed as the key's id): without any of them the registry is not installed (a log line names the missing one, never a value);
//   approved / proveHolds  the project's newest approved test environment (its digest is `testEnvDigest`) and the Prove report recorded for that digest;
//   defaultHeads     the head of each repository's default branch, through the code host the repository's RECORD names (as setup-pins.ts reads them), or undefined when any cannot be read;
//   currentKey       the environment key of the default branches NOW. The key hashes key files that only a clone can read, so it comes from a reader the install gives (`savedEnvKey`); without one it is undefined,
//                    and the registry then queues nothing (`no_key`): it fails closed;
//   keep / lightAfterIdleDays  the defaults (the company settings are not stored yet);
//   onQueued         starts the job the registry queued (saved-env-triggers.ts).
import { awsPartitionOf } from "../broker-environment.js";
import { testEnvDigest, testEnvIsProved, workerProjectDefinition, SAVED_ENV_KEEP_DEFAULT, SAVED_ENV_LIGHT_AFTER_IDLE_DAYS_DEFAULT, type OrgId } from "@agentx/contracts";
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

const ACCOUNT = /^[0-9]{12}$/u;
const KMS_KEY_ARN = /^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key\/[0-9a-f-]{36}$/u;

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
 * The registry's dependencies, or undefined when the `sv` switch is off or the install cannot run it. `dependencies` is a getter: the registry is made while the broker's dependencies are being made.
 * `clients` is a test seam.
 */
export function realSavedEnvDeps(input: Pick<AwsBrokerDependencies, "documentClient" | "tableName" | "audit" | "savedEnvBuildInputs">, dependencies: () => AwsBrokerDependencies, env: NodeJS.ProcessEnv = process.env, clients?: SavedEnvAwsClients): SavedEnvDeps | undefined {
  if (!savedEnvEnabled(env)) return undefined;
  const config = savedEnvConfigOf(env);
  if (config === undefined) return undefined;
  const aws = clients ?? realSavedEnvAwsClients(config.scope.region);
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
    currentKey: async (orgId, project) => dependencies().savedEnvKey?.(orgId, project),
    defaultHeads: (orgId, project) => savedEnvDefaultHeads(dependencies(), orgId, project),
    keep: async () => SAVED_ENV_KEEP_DEFAULT,
    lightAfterIdleDays: async () => SAVED_ENV_LIGHT_AFTER_IDLE_DAYS_DEFAULT,
    now,
    onQueued: savedEnvOnQueued(dependencies, input.savedEnvBuildInputs === undefined ? undefined : async (orgId, project) => dependencies().savedEnvBuildInputs?.(orgId, project), env),
  };
}

