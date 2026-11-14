// S3-10 (DEFERRED S3-ENTRY-NEEDS item 2, S3-CLOUD-WIRING-INPUTS, 0519-INFRA-ENTRY-DEPS-NOT-WIRED): the production builder of `CloudCoreEntryInputs` (entry.ts), so a Lambda that has the combined
// switch on can build the Cloud root from the real Cloud pieces. Nothing here is a stand-in: every module dep is the install's own client or Cloud's own adapter, found where Cloud already builds it.
//
// Who builds what:
//   - the Lambda entry (aws/broker.ts, aws/dispatcher.ts) makes the AWS and GitHub clients (`CloudCoreHostResources`) and ONLY while the switch is on (`coreEngineWanted`): with it off nothing core
//     related is made, so a cold start is what it was;
//   - this file joins them with the broker's own dependencies (the State table, the developer API's people) into `CloudModuleDeps` and the rest of `CloudCoreEntryInputs`.
//
// What a host does not have is not faked. Each such dependency is left out, so the core refuses that feature in words (the registry names an empty point, or a service skips its job), and it is listed in
// `CORE_REFUSED_FOR_NOW` for the lane report and the switch-on readback.
import type { createDynamoStoreFromSettings } from "@rovara-code/aws-adapters/dynamodb";
import type { S3ObjectClient } from "@rovara-code/aws-adapters/s3";
import type { SecretsManagerClientLike } from "@rovara-code/aws-adapters/secrets-manager";
import type { createSqsQueueServiceFromSettings } from "@rovara-code/aws-adapters/sqs";
import { Ec2RuntimeBindingSchema, OrgIdSchema, agentXError, MachineError, projectRevisionKey, type JsonObject, type ModelPrice, type OrgId, type PriceTable } from "@rovara-code/contracts";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { CodeBuildGateway } from "../../codebuild.js";
import type { GitHubCodeHostProvider } from "../../plugins/code-host/github/index.js";
import type { GitHubActionsProvider } from "../../plugins/check-runner/github-actions/index.js";
import type { DeveloperRouteDependencies } from "../../aws/developer-routes/types.js";
import type { DeveloperRecord } from "../../developer/store.js";
import { signInStoreOf } from "../../aws/developer-routes/common.js";
import { orgStoreOf } from "../../aws/broker/dependency-wiring.js";
import { slackPersonLookups } from "../../aws/broker/decision-press.js";
import type { SessionWorkerMachinesDependencies, SessionWorkerPing } from "../../aws/worker-machines/session-worker-machines.js";
import { workspaceCompanyReader } from "../../aws/worker-machines/workspace-company.js";
import type { SessionManager } from "../../aws/sessions.js";
import { cloudApprovalIssuers, coreProofMarkerReader } from "../adapters/people/index.js";
import type { AppSyncEventsPublisherOptions } from "../../cloud-adapters/realtime-appsync/publisher.js";
import { coreEngineServes, readCoreEngineFlags } from "./flags.js";
import { cloudLevelSources } from "./money.js";
import { cloudDeciderRole } from "./decider-role.js";
import { CORE_DISPATCH_QUEUE, type CloudModuleDeps } from "./cloud-modules.js";
import type { CloudCoreEntryInputs } from "./entry.js";

/**
 * Whether this Lambda should build anything for the core: the combined switch is not off (`on`, `on:<ids>`, or `drain`, in which the core still serves its running tasks). Off (the default): the entry makes no
 * client and installs no input. Whether a NEW task starts on the core is the app's own rule (`anyCoreAreaOn`), which is false in `drain`.
 */
export function coreEngineWanted(env: NodeJS.ProcessEnv = process.env): boolean {
  return coreEngineServes(readCoreEngineFlags(env));
}

/**
 * What a core feature needs that no Cloud host has yet. Each is left out of the inputs (never faked): the core refuses it in words, or its job skips. Kept as data so the lane report, the switch-on readback and a
 * test agree. `host` names where it is missing: `broker`, `dispatcher` or both.
 */
export const CORE_REFUSED_FOR_NOW: ReadonlyArray<{ feature: string; host: "broker" | "dispatcher" | "all"; why: string; refusal: string }> = [
  { feature: "live peek / live steer on a core task", host: "broker", why: "the broker is outside the workers' network and may not use the invoke signing key (only the dispatcher may)", refusal: "the worker machine's deliver is refused: 'the workspace's compute could not be reached; try again'" },
  { feature: "start a worker machine from the broker", host: "broker", why: "only the dispatcher starts the provisioner (its role and network); the core starts machines only while dispatching, on the dispatcher", refusal: "MachineError unavailable" },
  { feature: "stop a worker's instance at once on a core cancel", host: "broker", why: "the broker holds no ec2:TerminateInstances (least privilege)", refusal: "the session is claimed STOPPING and the idle reaper ends the instance on its next tick" },
  { feature: "the page notice's link, footer, address and urgency rules", host: "all", why: "Cloud's notifier words are not exposed as the core's notice rules yet (S3-CLOUD-WIRING-INPUTS notices)", refusal: "a notice has no link and the install's fixed footer" },
  { feature: "automation-stop job (143c)", host: "all", why: "Cloud's chain runner is not Code's ChainRunnerDeps; automations are hidden in Cloud (decision 45.10)", refusal: "the job answers service_not_wired" },
  { feature: "the agent runs host at a core task's end (release the slot, block keys, spent)", host: "all", why: "Cloud's agent run host is built inside the agent routes, per request", refusal: "the end is recorded and the end handlers told with no agent runs host" },
  { feature: "Slack on the core's channel point", host: "all", why: "slackSwitchReadiness facts (the CHANNEL_TENANTS backfill count, the bind writing tenants, the inbound sink) are not measured by the entry", refusal: "Slack keeps going through Cloud's own path; no `channel` adapter is registered" },
  { feature: "realtime page notices from the dispatcher", host: "dispatcher", why: "the dispatcher has no events API endpoint or grant (it publishes nothing today)", refusal: "no `realtime` adapter there; the broker's runtime publishes the core's page notices" },
  { feature: "the company's pinned recipe's step kinds", host: "all", why: "not readable in the sync settings mapping (S3-FINDINGS-ENTRY d)", refusal: "Cloud's journey install, which has none (Understand off)" },
  { feature: "the core's own model step choice (stepModels) and per-task model key minting at dispatch", host: "dispatcher", why: "the core's modelAccess and models are not wired in Cloud (cloudCoreRuntime `models` absent)", refusal: "a step runs on the worker's default model route" },
];

type DynamoDbSender = NonNullable<Parameters<typeof createDynamoStoreFromSettings>[1]>;
type SqsSender = NonNullable<Parameters<typeof createSqsQueueServiceFromSettings>[1]>;

/** The clients one Lambda has for the core. Made by the Lambda entry only while the switch is on. */
export interface CloudCoreHostResources {
  /** DynamoDB, as the core's document store speaks it (a `DynamoDBClient`). */
  dynamo: DynamoDbSender;
  /** S3 for the artifacts bucket (an `S3Client`), and the bucket. */
  s3: S3ObjectClient;
  artifactBucketName: string;
  /** The account that must own the bucket (the function's own); absent: not checked. */
  expectedBucketOwner?: string | undefined;
  /** Secrets Manager (a `SecretsManagerClient`): the install's provider keys and the company's connector secrets. */
  secretsManager: SecretsManagerClientLike;
  /** Every secret name the core may read starts with this (`agentx/<env>/`, or the install's connector prefix). */
  secretNamePrefix: string;
  /** The install's model provider key ARNs (`installModelKeyArns(process.env)`). */
  installModelKeys: Readonly<Record<string, string>>;
  /** SQS (an `SQSClient`) and the core dispatch queue's URLs (CORE_DISPATCH_QUEUE_URL / CORE_DISPATCH_DEAD_LETTER_URL). Absent URLs: the `queue` point stays empty. */
  sqs: SqsSender;
  region: string;
  coreDispatchQueue?: { url: string; deadLetterUrl: string } | undefined;
  /** The GitHub App credential provider (the code host and the GitHub Actions check runner) and its credential reference. */
  github: { provider: GitHubCodeHostProvider & GitHubActionsProvider; credentialRef: string; webhookSecret?: ((options?: { refresh?: boolean }) => Promise<string>) | undefined };
  /** CodeBuild (the second check runner); absent: GitHub Actions only. */
  codeBuild?: CodeBuildGateway | undefined;
  /** The EC2 session machines: what this host may do with a worker (see `brokerMachineOps` / the dispatcher's own). Absent: the `worker-machines` point stays empty. */
  machines?: CloudCoreMachineOps | undefined;
  /** The cloud events service; absent: no `realtime` adapter. */
  realtime?: AppSyncEventsPublisherOptions | undefined;
}

/** What a host may do with a workspace's EC2 session machine. The broker and the dispatcher differ: only the dispatcher signs, posts to a worker and starts the provisioner. */
export interface CloudCoreMachineOps {
  sessions: Pick<SessionManager, "get" | "ensureSession" | "deleteSession" | "claimStop" | "markStopped">;
  stopInstance: SessionWorkerMachinesDependencies["stopInstance"];
  sign: SessionWorkerMachinesDependencies["sign"];
  post: SessionWorkerMachinesDependencies["post"];
  ping: (url: string) => Promise<SessionWorkerPing | undefined>;
}

/**
 * The ec2-ebs runtime binding of a CORE workspace: its project revision's `runtimeBinding`, as Cloud registers it. Cloud's own reader (`workspaceBinding`) takes only a workspace Cloud made (it requires the record's
 * `deploymentMode: "ec2-ebs"`, which the core never writes), so it would refuse every core workspace. The company is the record's own (`companyId`, the core's), never a fallback: a record without one has no binding.
 */
export function coreWorkspaceBinding(documentClient: DeveloperRouteDependencies["documentClient"], tableName: string): SessionWorkerMachinesDependencies["binding"] {
  return async (workspaceId) => {
    const read = async (key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> => ((await documentClient.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
    const workspace = await read({ pk: `WORKSPACE#${workspaceId}`, sk: "META" });
    const company = workspace?.["companyId"];
    if (typeof company !== "string" || typeof workspace?.["projectName"] !== "string" || typeof workspace["projectRevision"] !== "number") return undefined;
    const parsedCompany = OrgIdSchema.safeParse(company);
    if (!parsedCompany.success) return undefined;
    const project = await read(projectRevisionKey(parsedCompany.data, workspace["projectName"], workspace["projectRevision"]));
    const parsed = Ec2RuntimeBindingSchema.safeParse(project?.["runtimeBinding"]);
    return parsed.success ? parsed.data : undefined;
  };
}

/** The broker's word for a worker it cannot reach (it is outside the workers' network) or sign for (the key is the dispatcher's alone). */
export const BROKER_CANNOT_DELIVER = "the workspace's compute could not be reached from here; try again";

/**
 * The broker's machine operations: it ends a session (the deleter, which it already starts for Cloud's own closes) and claims a stop, but it never starts a machine, never ends an instance itself, never signs and
 * never posts to a worker. Each refusal is a `MachineError` the core already handles (a retry, or a stop the reaper finishes).
 */
export function brokerMachineOps(sessionsOf: () => Pick<SessionManager, "get" | "deleteSession" | "claimStop" | "markStopped">): CloudCoreMachineOps {
  return {
    sessions: {
      get: (workspaceId) => sessionsOf().get(workspaceId),
      ensureSession: async () => { throw new MachineError("unavailable", "worker machines are started by the dispatcher"); },
      deleteSession: (workspaceId) => sessionsOf().deleteSession(workspaceId),
      claimStop: (session) => sessionsOf().claimStop(session),
      markStopped: (workspaceId, generation) => sessionsOf().markStopped(workspaceId, generation),
    },
    // No ec2:TerminateInstances on the broker: the claimed STOPPING session is ended by the idle reaper's next tick (session-worker-machines.ts `stop`).
    stopInstance: async () => ({ gone: false }),
    sign: async () => { throw new MachineError("unavailable", BROKER_CANNOT_DELIVER); },
    post: async () => { throw new MachineError("unavailable", BROKER_CANNOT_DELIVER); },
    ping: async () => undefined,
  };
}

/**
 * The core's prices from Cloud's own model catalog (`listPricesPerMillion`, the prices every Cloud bill uses), in the port's micro-dollar form, read per model as Metering asks (`provider/modelId`). A model the
 * catalog does not price, or prices at zero for input or output while not free, has no price: its call is unpriced, never $0 (decision 79; the rule of `cloudCatalogPrices`).
 */
export function cloudCatalogPriceTable(): PriceTable {
  const micros = (dollars: number): number => Math.round(dollars * 1_000_000);
  const priceOf = (key: string): ModelPrice | undefined => {
    const slash = key.indexOf("/");
    if (slash <= 0 || slash === key.length - 1) return undefined;
    const listed = listPricesPerMillion({ provider: key.slice(0, slash), modelId: key.slice(slash + 1) });
    if (listed === undefined) return undefined;
    const row = { inputMicrosPerMillionTokens: micros(listed.input), outputMicrosPerMillionTokens: micros(listed.output), cacheReadMicrosPerMillionTokens: micros(listed.cacheRead), cacheWriteMicrosPerMillionTokens: micros(listed.cacheWrite) };
    const free = Object.values(row).every((value) => value === 0);
    return free || (row.inputMicrosPerMillionTokens > 0 && row.outputMicrosPerMillionTokens > 0) ? row : undefined;
  };
  // Metering reads one key at a time (`prices.models[\`${provider}/${modelId}\`]`); the catalog cannot be listed, so the table answers each key from it.
  const models = new Proxy({}, {
    get: (_target, key) => (typeof key === "string" ? priceOf(key) : undefined),
    has: (_target, key) => typeof key === "string" && priceOf(key) !== undefined,
  });
  return { currency: "USD", models };
}

export interface CloudCoreInputsSources {
  /** The State table and its document client (the broker's own). */
  documentClient: DeveloperRouteDependencies["documentClient"];
  tableName: string;
  /** The developer API's dependencies (the people). Undefined: no developer sign-in, and the core has no people: the registry cannot be built and every start stays on Cloud's path. */
  routes: () => DeveloperRouteDependencies | undefined;
  /**
   * Whether people are decided on this function (default true: the broker). False on a function with no developer API (the dispatcher, CoreTierChecks): the people and approvers points refuse every call
   * in words (`NO_PEOPLE_HERE`), and no approval method is offered, so nothing is ever approved there.
   */
  peopleHere?: boolean | undefined;
  /** The company of this install (ruling R3): the worker machines adapter serves it alone. */
  installCompanyId: OrgId;
  resources: CloudCoreHostResources;
  /** The origin session links are made from (the sign-in issuer's). */
  origin?: string | undefined;
  now: () => number;
}

const requireRoutes = (routes: () => DeveloperRouteDependencies | undefined): DeveloperRouteDependencies => {
  const found = routes();
  if (found === undefined) throw new Error("the developer API is not configured: the core has no people to decide with");
  return found;
};

/** The core's dispatch queue settings for Code's SQS adapter (`{ region, queues: { "task-dispatch": { url, deadLetterUrl } } }`), from the derived URLs. */
export function coreQueueSettings(region: string, queue: { url: string; deadLetterUrl: string }): JsonObject {
  return { region, queues: { [CORE_DISPATCH_QUEUE]: { url: queue.url, deadLetterUrl: queue.deadLetterUrl } } };
}

/**
 * `CloudModuleDeps` from the real Cloud pieces. Called on the first core request of a container (lazily, by the registry), never at cold start. Throws when the developer API is not configured: the entry logs
 * `core_entry.not_configured` and the start stays on Cloud's path.
 */
export function cloudModuleDepsFromHost(sources: CloudCoreInputsSources): CloudModuleDeps {
  const { resources } = sources;
  const table = { documentClient: sources.documentClient, tableName: sources.tableName };
  const machines = resources.machines;
  const peopleDeps = sources.peopleHere === false ? noPeopleHere(table, sources.now) : brokerPeople(sources, table);
  return {
    tableName: sources.tableName,
    dynamo: resources.dynamo,
    objects: { client: resources.s3, bucket: resources.artifactBucketName, ...(resources.expectedBucketOwner === undefined ? {} : { expectedBucketOwner: resources.expectedBucketOwner }) },
    secrets: { namePrefix: resources.secretNamePrefix, clientFor: () => resources.secretsManager, companyPaths: ["org-connectors"] },
    modelKeys: { secrets: resources.secretsManager, installKeys: resources.installModelKeys },
    prices: cloudCatalogPriceTable(),
    // A5: Cloud's own payer rules and limits (money.ts), over the State table.
    levels: cloudLevelSources({ ...table, now: sources.now } as Parameters<typeof cloudLevelSources>[0]),
    ...peopleDeps,
    codeHost: { provider: resources.github.provider, options: { credentialRef: resources.github.credentialRef, now: sources.now, ...(resources.github.webhookSecret === undefined ? {} : { webhookSecret: resources.github.webhookSecret }) } },
    ...(resources.coreDispatchQueue === undefined ? {} : { queue: { settings: coreQueueSettings(resources.region, resources.coreDispatchQueue), client: resources.sqs } }),
    ...(machines === undefined ? {} : {
      workerMachines: {
        companyId: sources.installCompanyId,
        sessions: machines.sessions,
        // The workspace's own record says whose it is (A4's rule: read on every call, never cached).
        companyOfWorkspace: workspaceCompanyReader(sources.documentClient as never, sources.tableName, sources.installCompanyId),
        binding: coreWorkspaceBinding(sources.documentClient, sources.tableName),
        stopInstance: machines.stopInstance, sign: machines.sign, post: machines.post, ping: machines.ping, now: sources.now,
      },
    }),
    checkRunners: { githubActions: resources.github.provider, ...(resources.codeBuild === undefined ? {} : { codeBuild: resources.codeBuild }) },
    ...(resources.realtime === undefined ? {} : { realtime: resources.realtime }),
  };
}

/** The words a function without the developer API says for any people call. */
export const NO_PEOPLE_HERE = "people are decided by the broker, not on this function";

/**
 * A6 on the broker (DEC 211: Cloud's existing people and approvers adapters, no new identity mechanism): the developer API's own people, the approval issuers over the same routes with the Slack person lookups the
 * decision press uses, the decider's LIVE standing (`cloudDeciderRole`), the place rule over the sign-in table, and the proof marker the core's gate writes.
 */
function brokerPeople(sources: CloudCoreInputsSources, table: { documentClient: DeveloperRouteDependencies["documentClient"]; tableName: string }): Pick<CloudModuleDeps, "people" | "approvers"> {
  const routes = requireRoutes(sources.routes);
  return {
    people: routes,
    approvers: {
      issuers: cloudApprovalIssuers({
        routes,
        slackLookups: (signedIn: Map<string, DeveloperRecord>) => slackPersonLookups({
          signIn: signInStoreOf(routes), orgs: orgStoreOf({ documentClient: routes.documentClient as never, tableName: sources.tableName, developer: { signInTableName: routes.developer.signInTableName } }),
          policy: { editionPolicy: routes.editionPolicy, slackOn: routes.developer.methods.slack === true, slackSince: routes.developer.since?.slack },
        }, signedIn),
      }),
      deciderRole: cloudDeciderRole(() => requireRoutes(sources.routes)),
      place: { ...table, signInTableName: routes.developer.signInTableName, now: sources.now },
      proofUsed: coreProofMarkerReader(table),
    },
  };
}

/**
 * The people points on a function with no developer API: every read of a person refuses in words, no approval method is offered (so `verify` refuses every proof) and nobody stands anywhere. Nothing here can
 * identify or approve anyone.
 */
function noPeopleHere(table: { documentClient: DeveloperRouteDependencies["documentClient"]; tableName: string }, now: () => number): Pick<CloudModuleDeps, "people" | "approvers"> {
  const people = new Proxy({} as DeveloperRouteDependencies, {
    get: (_target, key) => { if (key === "then") return undefined; throw agentXError("RUNTIME_UNAVAILABLE", NO_PEOPLE_HERE); },
  });
  return {
    people,
    approvers: { issuers: {}, deciderRole: async () => "none", place: { ...table, now }, proofUsed: coreProofMarkerReader(table) },
  };
}

/** The whole `CloudCoreEntryInputs` for a Lambda that has the switch on. What Cloud has no host for yet is left out (see `CORE_REFUSED_FOR_NOW`). */
export function cloudCoreEntryInputsFromHost(sources: CloudCoreInputsSources): CloudCoreEntryInputs {
  return {
    moduleDeps: () => cloudModuleDepsFromHost(sources),
    ...(sources.origin === undefined ? {} : { origin: sources.origin }),
  };
}
