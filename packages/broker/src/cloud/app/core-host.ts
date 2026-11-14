// S3-10: the Cloud root on a function that is NOT the broker: the dispatcher (the core's dispatch consumer, 0519-INFRA-CORE-DISPATCH-CONSUMER) and CoreTierChecks (the lighter flow's tier pass,
// S3-9-TIER-CHECKS-HOST-INPUTS). Both run the same root as the broker (`createCloudCoreEntry`), from the same production inputs (entry-inputs.ts), over the parts of the broker's dependencies a root reads.
//
// What such a function does NOT have, and is not given (each refuses in words, never faked):
//   - the developer API (no sign-in settings): nobody is decided for here. The people and approvers points refuse every call (`peopleHere: false`), and the task access rule is never asked (a dispatch and a
//     tier pass decide nothing for a person);
//   - the GitHub App on the dispatcher: a dispatch reads no repository (it signs a grant the broker exchanges), so its code host refuses every call (`refusingCodeHost`);
//   - the callback signing key on CoreTierChecks (its environment has none, by design): the root is given a random key of this container, so anything it could sign is refused by the broker (fail closed).
import { createHmac, randomBytes } from "node:crypto";
import { agentXError, type OrgId } from "@rovara-code/contracts";
import type { AwsBrokerDependencies } from "../../aws/broker/definitions.js";
import { RepositoryGrantService } from "../../repository-access.js";
import { GITHUB_CODE_HOST_CAPABILITIES, GITHUB_HOST_KIND, type GitHubCodeHostProvider } from "../../plugins/code-host/github/index.js";
import type { GitHubActionsProvider } from "../../plugins/check-runner/github-actions/index.js";
import { createCoreDispatchHost, type CoreDispatchHost } from "../../aws/worker-machines/core-dispatch-host.js";
import { workspaceCompanyReader } from "../../aws/worker-machines/workspace-company.js";
import { createCloudCoreEntry, type CloudCoreEntry } from "./entry.js";
import { cloudCoreEntryInputsFromHost, type CloudCoreHostResources } from "./entry-inputs.js";
import type { CoreJobHost } from "./jobs.js";

/** The repository grant key a callback signing key gives (the broker's `grantKeyOf`): a grant the dispatcher issues is one the broker's exchange verifies. */
export function repositoryGrantKeyOf(callbackKey: string): Buffer {
  return createHmac("sha256", callbackKey).update("agentx:repository-grants:v3").digest();
}

/** A worker's repository grant, issued here and exchanged only by the broker: this host never resolves a credential. */
export function issueOnlyRepositoryGrants(callbackKey: string): RepositoryGrantService {
  return new RepositoryGrantService(
    repositoryGrantKeyOf(callbackKey),
    async () => { throw agentXError("RUNTIME_UNAVAILABLE", "repository credentials are exchanged by the broker, not on this function"); },
    (hostKind) => (hostKind === GITHUB_HOST_KIND ? GITHUB_CODE_HOST_CAPABILITIES.credentialKinds : undefined),
  );
}

/** The words a function without the GitHub App says for any code host call. */
export const NO_CODE_HOST_HERE = "the code host is not reached from this function";

/** A code host (and GitHub Actions) provider that refuses every call in words: for a function that holds no GitHub App and reads no repository. */
export function refusingCodeHost(): GitHubCodeHostProvider & GitHubActionsProvider {
  return new Proxy({} as GitHubCodeHostProvider & GitHubActionsProvider, {
    get: (_target, key) => (key === "then" ? undefined : async () => { throw agentXError("RUNTIME_UNAVAILABLE", NO_CODE_HOST_HERE); }),
  });
}

/** What a non-broker root reads of the broker's dependencies. Everything else of `AwsBrokerDependencies` is absent on such a function, and no path of a dispatch or a tier pass reads it. */
export type CoreHostBrokerView = Pick<AwsBrokerDependencies, "documentClient" | "tableName" | "callbackSigningKey" | "repositoryGrants" | "cloud"> & Partial<Pick<AwsBrokerDependencies, "environmentName" | "modelAccess" | "agents">>;

export interface CoreHostEntryOptions {
  host: "dispatcher" | CoreJobHost;
  view: CoreHostBrokerView;
  resources: CloudCoreHostResources;
  installCompanyId: OrgId;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
}

/**
 * The Cloud root on a non-broker function. The broker's own fields it lacks are absent (the view is the whole of what is read: the slack and people paths that read more are never reached, since such a function
 * gets no Slack request, no start and no decision). `routes` is none: the people points refuse.
 */
export function createCoreHostEntry(options: CoreHostEntryOptions): CloudCoreEntry {
  const inputs = cloudCoreEntryInputsFromHost({
    documentClient: options.view.documentClient, tableName: options.view.tableName, routes: () => undefined, peopleHere: false, installCompanyId: options.installCompanyId, resources: options.resources,
    now: () => options.now().getTime(),
  });
  const entry = createCloudCoreEntry({
    env: options.env, broker: options.view as AwsBrokerDependencies, routes: () => undefined, inputs, installCompanyId: options.installCompanyId, now: options.now, log: options.log,
    host: options.host === "dispatcher" ? "broker" : options.host,
  });
  if (entry === undefined) throw new Error("the Cloud root could not be built on this function");
  return entry;
}

/** A random key of this container, for a root that signs nothing anyone accepts (CoreTierChecks has no callback signing key, by design). */
export function containerOnlyKey(): string {
  return randomBytes(32).toString("base64url");
}

export interface CoreDispatchWiring {
  /** The root on the dispatcher (`createCoreHostEntry({ host: "dispatcher" })`), built on the first core batch. */
  entry: () => Promise<CloudCoreEntry>;
  documentClient: AwsBrokerDependencies["documentClient"];
  tableName: string;
  installCompanyId: OrgId;
  /** The switch, read per batch. */
  enabled: () => boolean;
  /** SQS ChangeMessageVisibility on the CORE dispatch queue. */
  changeVisibility: (receiptHandle: string, seconds: number) => Promise<void>;
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * The dispatcher's host of the core's `runDispatchOnce` (lane A4's `createCoreDispatchHost`) over the production root: each company's records run with that company's flow dependencies (the root's runtime,
 * whose `machines` is the dispatcher's own EC2 adapter, which signs with the invoke key only this role may use), with the batch as the dispatch queue.
 */
export function createProductionCoreDispatchHost(wiring: CoreDispatchWiring): CoreDispatchHost {
  return createCoreDispatchHost({
    enabled: wiring.enabled,
    companyOfWorkspace: workspaceCompanyReader(wiring.documentClient, wiring.tableName, wiring.installCompanyId),
    depsFor: async (companyId, queues) => {
      const runtime = await (await wiring.entry()).app.runtimeFor(companyId);
      return { ...runtime.flow.deps, queues };
    },
    changeVisibility: wiring.changeVisibility,
    ...(wiring.log === undefined ? {} : { log: wiring.log }),
  });
}
