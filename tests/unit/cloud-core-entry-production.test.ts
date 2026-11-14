// S3-10 (DEFERRED S3-ENTRY-NEEDS 2, S3-CLOUD-WIRING-INPUTS, 0519-INFRA-CORE-DISPATCH-CONSUMER): the production builder of the core's inputs, end to end, with fake AWS clients only.
//
// One State table (Cloud's FakeDynamoDb, which the core's DynamoDB adapter reaches through the wire protocol), Code's SQS adapter over a fake SQS holding the core dispatch queue, Code's S3 adapter over a
// fake S3, the GitHub code host adapter over a recorded GitHub provider, and the people of a real Cloud company (the developer API's own records). Two roots, as two Lambdas: the broker's (start, jobs,
// callbacks, decisions) and the dispatcher's (the core dispatch queue's consumer, which signs and posts the job to the worker). A core task starts, its steps are dispatched through the core queue, a
// fake worker runs them, the owner approves the plan with a browser session, and the task reaches a pull request.
import { randomBytes, randomUUID } from "node:crypto";
import { ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";
import { WORKER_INVOCATION_FEATURES, createCandidateManifest, orgProjectCatalogKey, projectRevisionKey, type WorkflowSnapshot } from "@rovara-code/contracts";
import { FakeSqs } from "../../vendor/rovara-code/tests/support/ports/sqs-fake.js";
import { FakeS3, FakeSecretsManager } from "../../vendor/rovara-code/tests/support/ports/aws-fakes.js";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import { BROWSER_SESSION_METHOD } from "../../packages/broker/src/cloud/adapters/people/index.js";
import { coreDispatchLoaderFor, createDispatcherHandler } from "../../packages/broker/src/aws/dispatcher.js";
import { DISPATCHER_CORE_NOT_CONFIGURED, createDispatcherCoreDispatch } from "../../packages/broker/src/aws/core-dispatch-entry.js";
import { coreTierChecksView } from "../../packages/broker/src/aws/core-tier-checks-production.js";
import { CORE_REFUSED_FOR_NOW, brokerMachineOps, cloudCatalogPriceTable, cloudCoreEntryInputsFromHost, cloudModuleDepsFromHost, coreEngineWanted, coreWorkspaceBinding, type CloudCoreHostResources } from "../../packages/broker/src/cloud/app/entry-inputs.js";
import { NO_CODE_HOST_HERE, createCoreHostEntry, createProductionCoreDispatchHost, issueOnlyRepositoryGrants, refusingCodeHost, repositoryGrantKeyOf } from "../../packages/broker/src/cloud/app/core-host.js";
import { createCloudCoreEntry, type CloudCoreEntry } from "../../packages/broker/src/cloud/app/entry.js";
import { owedPoints } from "../../packages/broker/src/cloud/app/cloud-modules.js";
import { PEOPLE_ORG, createPeopleWorld } from "../support/cloud-people-world.js";
import { TEST_ENV } from "../support/orgs.js";
import { wireOver } from "../support/dynamo-wire-over-document-fake.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const QUEUE_URL = "https://sqs.us-west-2.amazonaws.com/111122223333/agentx-staging-core-dispatch";
const DEAD_URL = "https://sqs.us-west-2.amazonaws.com/111122223333/agentx-staging-core-dispatch-dead";
const QUEUE_ARN = "arn:aws:sqs:us-west-2:111122223333:agentx-staging-core-dispatch";
const REPO = "https://github.com/example/demo";
const BINDING = { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }], volumeSizeGiB: 20, volumeType: "gp3" };
/** Every feature a worker of this image lists. */
const FEATURES = [...WORKER_INVOCATION_FEATURES];
const ON = { CLOUD_CORE_ENGINE: "on" };

/** A small GitHub: branches, commits (tree, parents) and pull requests, as the GitHub App provider answers them. A call it does not model is recorded and refused. */
function fakeGitHub() {
  const branches = new Map<string, string>([["main", "c0".padEnd(40, "0")]]);
  const commits = new Map<string, { tree: string; parents: string[] }>([["c0".padEnd(40, "0"), { tree: "t0".padEnd(40, "0"), parents: [] }]]);
  const pulls: Array<{ number: number; headBranch: string; baseBranch: string; title: string; draft: boolean }> = [];
  const unmodelled: string[] = [];
  const modelled: Record<string, (...args: never[]) => unknown> = {
    getPullRequest: async (_url: string, number: number) => {
      const pull = pulls.find((each) => each.number === number)!;
      return { number, url: `${REPO}/pull/${number}`, state: "open", headBranch: pull.headBranch, baseBranch: pull.baseBranch, headCommit: branches.get(pull.headBranch)!, title: pull.title, body: "", authoredByApp: true };
    },
    getBranchHead: async (_url: string, branch: string) => branches.get(branch) ?? (() => { throw Object.assign(new Error("no branch"), { code: "NOT_FOUND" }); })(),
    getDefaultBranchHead: async (_url: string, branch: string) => branches.get(branch)!,
    getCommitTree: async (_url: string, commit: string) => commits.get(commit)!.tree,
    getCommitParents: async (_url: string, commit: string) => commits.get(commit)!.parents,
    reconcilePullRequest: async (input: { headBranch: string; baseBranch: string; title: string; draft?: boolean }) => {
      const found = pulls.find((pull) => pull.headBranch === input.headBranch);
      if (found !== undefined) return { number: found.number, url: `${REPO}/pull/${found.number}`, reconciled: true };
      const pull = { number: pulls.length + 1, headBranch: input.headBranch, baseBranch: input.baseBranch, title: input.title, draft: input.draft === true };
      pulls.push(pull);
      return { number: pull.number, url: `${REPO}/pull/${pull.number}`, reconciled: false };
    },
  };
  const calls: string[] = [];
  const provider = new Proxy({}, { get: (_target, key) => (typeof key !== "string" || key === "then" ? undefined : (modelled[key] === undefined ? undefined : async (...args: never[]) => { const out = await modelled[key]!(...args); calls.push(`${key}(${JSON.stringify(args.slice(0, 2))})=${JSON.stringify(out)}`); return out; }) ?? (async () => { unmodelled.push(key); throw new Error(`the fake GitHub does not model ${key}`); })) });
  const commit = (parent: string): string => {
    const sha = randomBytes(20).toString("hex");
    commits.set(sha, { tree: randomBytes(20).toString("hex"), parents: [parent] });
    return sha;
  };
  return { calls, provider: provider as CloudCoreHostResources["github"]["provider"], branches, commits, pulls, unmodelled, commit };
}

/** The EC2 session machines, as the provisioner leaves them: a session READY at its first start; the worker answers its /ping and takes every job posted to it. */
function fakeMachines() {
  const sessions = new Map<string, Record<string, unknown>>();
  const jobs: Array<Record<string, unknown>> = [];
  const signed: number[] = [];
  const store = {
    get: async (workspaceId: string) => sessions.get(workspaceId) as never,
    ensureSession: async ({ workspaceId }: { workspaceId: string }) => {
      sessions.set(workspaceId, { workspaceId, state: "READY", generation: 1, privateIp: "10.42.0.7", instanceId: "i-0123456789abcdef0", workerFeatures: FEATURES });
      return { ready: true, generation: 1, privateIp: "10.42.0.7" } as never;
    },
    deleteSession: async (workspaceId: string) => { sessions.delete(workspaceId); },
    claimStop: async () => true,
    markStopped: async () => undefined as never,
  };
  return {
    sessions, jobs, signed, store,
    dispatcher: {
      sessions: store,
      stopInstance: async () => ({ gone: true }),
      sign: async (message: Uint8Array) => { signed.push(message.byteLength); return new Uint8Array([48, 6, 2, 1, 1, 2, 1, 1]); },
      post: async (_url: string, init: { authorization: string; body: string }) => { jobs.push(JSON.parse(init.body) as Record<string, unknown>); return { status: 202, body: "{}" }; },
      ping: async () => ({ status: "Healthy", activeOperations: 0, features: FEATURES }),
    },
  };
}

function world(options: { env?: Record<string, string> } = {}) {
  const env = options.env ?? ON;
  const people = createPeopleWorld();
  const db = people.db;
  const sqs = new FakeSqs({ order: "oldest-first" });
  sqs.createQueue(DEAD_URL);
  sqs.createQueue(QUEUE_URL, { maxReceiveCount: 25, deadLetterUrl: DEAD_URL, visibilityTimeout: 120 });
  const s3 = new FakeS3({ bucket: "artifacts" });
  const github = fakeGitHub();
  const machines = fakeMachines();
  const callbackKey = randomBytes(32).toString("base64url");
  const base = { dynamo: wireOver(db) as never, s3: s3 as never, artifactBucketName: "artifacts", secretsManager: new FakeSecretsManager() as never, secretNamePrefix: `agentx/${TEST_ENV}/`, installModelKeys: {}, sqs: sqs as never, region: "us-west-2", coreDispatchQueue: { url: QUEUE_URL, deadLetterUrl: DEAD_URL } };
  const brokerResources: CloudCoreHostResources = { ...base, github: { provider: github.provider, credentialRef: "host-app" }, machines: brokerMachineOps(() => machines.store as never) };
  const dispatcherResources: CloudCoreHostResources = { ...base, github: { provider: refusingCodeHost(), credentialRef: "" }, machines: machines.dispatcher as never };
  const logs: Array<Record<string, unknown>> = [];
  const log = (entry: Record<string, unknown>) => { logs.push(entry); };
  const now = () => new Date(people.routes.now());
  const broker = {
    documentClient: db, tableName: "state", callbackSigningKey: callbackKey, cloud: true, environmentName: TEST_ENV, developer: people.routes.developer,
    repositoryGrants: new RepositoryGrantService(repositoryGrantKeyOf(callbackKey), async () => ({ token: "repository-token-for-tests" })),
  };
  const inputs = cloudCoreEntryInputsFromHost({ documentClient: db, tableName: "state", routes: () => people.routes, installCompanyId: PEOPLE_ORG, resources: brokerResources, now: () => people.routes.now() });
  /** The broker's and the dispatcher's roots for one value of the switch: new Lambda containers over the same table, queues and machines. */
  const roots = (rootEnv: Record<string, string>) => {
    const brokerEntry = createCloudCoreEntry({ env: rootEnv, broker: broker as never, routes: () => people.routes, inputs, installCompanyId: PEOPLE_ORG, now, log })!;
    const dispatcherEntry = createCoreHostEntry({
      host: "dispatcher", env: rootEnv, installCompanyId: PEOPLE_ORG, resources: dispatcherResources, now, log,
      view: { documentClient: db as never, tableName: "state", callbackSigningKey: callbackKey, repositoryGrants: issueOnlyRepositoryGrants(callbackKey), cloud: true, environmentName: TEST_ENV },
    });
    const coreDispatch = createProductionCoreDispatchHost({
      entry: async () => dispatcherEntry, documentClient: db as never, tableName: "state", installCompanyId: PEOPLE_ORG, enabled: () => coreEngineWanted(rootEnv),
      changeVisibility: async () => undefined, log,
    });
    const dispatcher = createDispatcherHandler({
      queueArn: "arn:aws:sqs:us-west-2:111122223333:agentx-staging-dispatch", coreQueueArn: QUEUE_ARN, coreDispatch,
      markDispatching: async () => { throw new Error("Cloud's path must not run for a core batch"); }, markDelivered: async () => { throw new Error("Cloud's path"); }, markFailed: async () => { throw new Error("Cloud's path"); },
    });
    return { brokerEntry, dispatcherEntry, dispatcher };
  };
  // The project, as Cloud registers it: its revision (with the ec2-ebs binding) and its catalog row.
  db.set({ ...projectRevisionKey(PEOPLE_ORG, "payments", 1), entityType: "PROJECT", definition: { name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "demo", url: REPO, path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }] }, runtimeBinding: BINDING });
  db.set({ ...orgProjectCatalogKey(PEOPLE_ORG, "payments"), entityType: "PROJECT_CATALOG", latestRevision: 1 });
  const w = { people, db, sqs, s3, github, machines, logs, done: new Set<string>(), built: { value: undefined as { commit: string; tree: string } | undefined }, inputs, brokerResources, dispatcherResources, ...roots(env),
    /** The switch changed (a deploy): the next requests reach new containers built with this value. */
    switchTo(next: Record<string, string>) { Object.assign(w, roots(next)); } };
  return w;
}
type World = ReturnType<typeof world>;

/** The dispatcher Lambda's event source mapping: receive a batch from the core queue, hand it to the dispatcher, delete what it did not give back. */
async function dispatchBatch(w: World): Promise<number> {
  const received = await w.sqs.send(new ReceiveMessageCommand({ QueueUrl: QUEUE_URL, MaxNumberOfMessages: 10, AttributeNames: ["All"] })) as { Messages?: Array<{ MessageId: string; ReceiptHandle: string; Body: string; Attributes?: Record<string, string> }> };
  const messages = received.Messages ?? [];
  if (messages.length === 0) return 0;
  const event = { Records: messages.map((message) => ({ messageId: message.MessageId, receiptHandle: message.ReceiptHandle, body: message.Body, attributes: { ApproximateReceiveCount: message.Attributes?.["ApproximateReceiveCount"] ?? "1", SentTimestamp: String(Date.now()) }, eventSource: "aws:sqs", eventSourceARN: QUEUE_ARN })) };
  const answer = await (w.dispatcher as unknown as (event: unknown) => Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }>)(event);
  const failed = new Set(answer.batchItemFailures.map((failure) => failure.itemIdentifier));
  for (const message of messages) if (!failed.has(message.MessageId)) await w.sqs.send(new DeleteMessageCommand({ QueueUrl: QUEUE_URL, ReceiptHandle: message.ReceiptHandle }));
  return messages.length;
}

const job = (name: string) => ({ source: "agentx.core-job", job: name });

async function startCoreTask(w: World): Promise<string> {
  const owner = w.people.people.owner;
  const caller = { developerId: owner.developerId, sessionId: owner.sessionId, amr: owner.amr, name: owner.name, orgId: owner.orgId, orgRole: owner.role };
  const started = await w.brokerEntry.intentHook.start({
    caller: caller, request: { requestId: randomUUID(), source: "app", project: "payments", input: { text: "Add a /health endpoint" }, path: "QUICK" } as never, ownedTask: (async (_caller: unknown, taskId: string) => ({ taskId })) as never,
  });
  expect(started, JSON.stringify(w.logs.slice(-3))).toBeDefined();
  return (started!.task as unknown as { taskId: string }).taskId;
}

/** Drives the task: the broker's scheduled jobs, the dispatcher's batches and a fake worker posting to the broker's callback router, until a pull request is recorded. */
async function drive(w: World, taskId: string, until?: (workflow: WorkflowSnapshot) => boolean): Promise<{ stages: string[]; workflow: WorkflowSnapshot }> {
  const stages: string[] = [];
  const done = w.done;
  let built = w.built.value;
  const base = w.github.branches.get("main")!;
  for (let round = 0; round < 30; round += 1) {
    await w.brokerEntry.handleScheduledJob(job("outbox-relay-backstop"));
    while (await dispatchBatch(w) > 0) { /* drain */ }
    await w.brokerEntry.handleScheduledJob(job("dispatch-sweep"));
    const task = w.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> | undefined;
    const workflow = task?.["workflow"] as WorkflowSnapshot;
    if (stages.at(-1) !== workflow.stage) stages.push(workflow.stage);
    if ((workflow.pullRequests ?? []).length > 0 || until?.(workflow) === true) return { stages, workflow };
    if (workflow.stage === "PLAN_REVIEW" && workflow.state === "WAITING") {
      const gate = (await w.brokerEntry.app.runtimeFor(PEOPLE_ORG)).inbound.clientGate!;
      const found = (await gate.requirement(PEOPLE_ORG, "workflow-document", taskId))!;
      const owner = w.people.people.owner;
      const decided = await gate.decide({ companyId: PEOPLE_ORG, kind: "workflow-document", subjectId: taskId, requestId: randomUUID(), outcome: "approve", seen: { revision: found.revision, artifactDigest: found.artifactDigest }, credentials: [{ method: BROWSER_SESSION_METHOD, token: owner.sessionId }], reason: "fine" });
      expect(decided, JSON.stringify(decided)).toMatchObject({ status: "decided" });
      continue;
    }
    for (const posted of w.machines.jobs.filter((each) => !done.has(each["operationId"] as string))) {
      done.add(posted["operationId"] as string);
      const post = async (action: string, body: unknown) => {
        const answer = await w.brokerEntry.routeCallback({ method: "POST", path: `/v1/internal/workspaces/${posted["workspaceId"] as string}/operations/${posted["operationId"] as string}/${action}`, headers: { "x-agentx-callback-capability": posted["callbackCapability"] as string, "content-type": "application/json" }, body: JSON.stringify(body) });
        expect(answer?.statusCode, `${action}: ${answer?.body}`).toBe(200);
      };
      const payload = posted["payload"] as Record<string, unknown>;
      const mode = payload["workflowMode"] as string | undefined;
      if (mode === undefined && payload["headBranch"] === undefined) {
        await post("result", { status: "SUCCEEDED", result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: base }] } });
      } else if (mode === "PLAN") {
        await post("artifacts", { name: "plan.md", mediaType: "text/markdown", content: planAnswer(planDocument({ title: "Health", why: [{ text: "Asked for.", author: "Maya" }], claims: [{ id: "1", text: "Add the endpoint." }], decisions: [] }), { checks: { checks: [], none_reason: "A fixture change needs no automated checks." } }) });
        await post("result", { status: "SUCCEEDED" });
      } else if (mode === "IMPLEMENT") {
        const commit = w.github.commit(base);
        built = { commit, tree: w.github.commits.get(commit)!.tree };
        w.built.value = built;
        const candidate = [{ repositoryId: "demo", commitSha: commit, treeSha: built.tree, baseCommitSha: base }];
        await post("result", { status: "SUCCEEDED", result: { conversationId: "conversation", checks: { status: "not_verified", notVerifiedReason: "no_checks", source: "none", preambleVersion: "1", preambleSha256: "a".repeat(64), checks: [], extraTry: "not_needed", agentClaim: "none" }, workflowCandidateRepositories: candidate, workflowCheckCandidateRepositories: candidate } });
      } else if (mode === "REVIEW") {
        const candidate = [{ repositoryId: "demo", commitSha: built!.commit, treeSha: built!.tree, baseCommitSha: base }];
        const roles = ((payload["workflowReviewers"] as string[] | undefined) ?? ["CRITIC", "SECURITY"]);
        await post("result", { status: "SUCCEEDED", result: { conversationId: "conversation", workflowCandidateRepositories: candidate, workflowReviews: roles.map((role) => ({ operationId: posted["operationId"], candidateDigest: createCandidateManifest(candidate).digest, role, provider: "examplehost-model", version: "1", readOnly: true, recordedAt: now(w).toISOString(), status: "PASS", findings: [], ...(role === "CRITIC" ? { risk: "low" } : {}) })) } });
      } else {
        const headBranch = String(payload["headBranch"]);
        w.github.branches.set(headBranch, built!.commit);
        await post("pull-request", { repository: "demo", repositoryUrl: REPO, headBranch, baseBranch: "main", commit: built!.commit, title: payload["title"], body: payload["body"] });
        const pull = w.github.pulls.find((each) => each.headBranch === headBranch)!;
        await post("result", { status: "SUCCEEDED", result: { repository: "demo", number: pull.number, url: `${REPO}/pull/${pull.number}`, headBranch, baseBranch: "main", commit: built!.commit, checks: [], reconciled: false, draft: true } });
      }
      w.machines.sessions.set(posted["workspaceId"] as string, { ...w.machines.sessions.get(posted["workspaceId"] as string)!, state: "READY" });
    }
  }
  const last = (w.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown>)["workflow"] as WorkflowSnapshot;
  const failedOps = [...w.db.items.values()].filter((item) => String(item["sk"]).startsWith("OPERATION#") && item["status"] === "FAILED").map((item) => ({ error: item["error"], kind: (item["dispatch"] as { kind?: string } | undefined)?.kind }));
  w.logs.push({ failedOps });
  throw new Error(`no pull request (stages ${stages.join(" > ")}; last ${last.stage}/${last.state} ${JSON.stringify({ blockReason: (last as unknown as { blockReason?: unknown }).blockReason, outcome: (last as unknown as { outcome?: unknown }).outcome })}; logs ${JSON.stringify(w.logs.slice(-3))}; github ${w.github.unmodelled.join(",")})`);
}
const now = (w: World) => new Date(w.people.routes.now());

describe("the production core inputs (S3-10)", () => {
  it("with the switch on: a core task starts, is dispatched through the core queue by the dispatcher, runs its steps and reaches a pull request", async () => {
    const w = world();
    const taskId = await startCoreTask(w);
    const { stages, workflow } = await drive(w, taskId);
    expect(workflow.pullRequests?.[0]).toMatchObject({ number: 1 });
    expect(stages).toContain("PLAN_REVIEW");
    expect(w.github.pulls).toHaveLength(1);
    // Every job reached the worker through the dispatcher's own adapter: signed with the invoke key (only the dispatcher signs) and posted to the worker's port.
    expect(w.machines.signed.length).toBe(w.machines.jobs.length);
    expect(w.machines.jobs.length).toBeGreaterThanOrEqual(4);
    // Nothing was left on the core queue or in its dead letters.
    expect((await w.sqs.send(new ReceiveMessageCommand({ QueueUrl: DEAD_URL, MaxNumberOfMessages: 10 })) as { Messages?: unknown[] }).Messages ?? []).toHaveLength(0);
    expect(w.github.unmodelled).toEqual([]);
  }, 60_000);

  it("review H1(a): a core task in flight when cc goes to drain still runs its steps on the core to a pull request, and no new task starts on the core", async () => {
    const w = world();
    const taskId = await startCoreTask(w);
    await drive(w, taskId, (workflow) => workflow.stage === "PLAN_REVIEW" && workflow.state === "WAITING");
    w.switchTo({ CLOUD_CORE_ENGINE: "drain" });
    expect(coreEngineWanted({ CLOUD_CORE_ENGINE: "drain" })).toBe(true);
    expect(w.brokerEntry.app.active).toBe(false);
    // A new start stays on Cloud's path (the hook answers nothing).
    const owner = w.people.people.owner;
    const another = await w.brokerEntry.intentHook.start({
      caller: { developerId: owner.developerId, sessionId: owner.sessionId, amr: owner.amr, name: owner.name, orgId: owner.orgId, orgRole: owner.role },
      request: { requestId: randomUUID(), source: "app", project: "payments", input: { text: "Another change" }, path: "QUICK" } as never, ownedTask: (async () => ({})) as never,
    });
    expect(another).toBeUndefined();
    // The running task's decision, steps, dispatch and callbacks are all still the core's.
    const { workflow } = await drive(w, taskId);
    expect(workflow.pullRequests?.[0]).toMatchObject({ number: 1 });
    expect(w.github.pulls).toHaveLength(1);
  }, 60_000);

  it("the registry the production deps build owes no point (queue, worker machines, check runner all wired)", () => {
    const w = world();
    expect(owedPoints(cloudModuleDepsFromHost({ documentClient: w.db, tableName: "state", routes: () => w.people.routes, installCompanyId: PEOPLE_ORG, resources: w.brokerResources, now: () => 0 }))).toEqual([]);
  });

  it("with the switch off nothing core related is wanted, and a dispatcher batch from the core queue is given back whole, never run on Cloud's path", async () => {
    expect(coreEngineWanted({})).toBe(false);
    expect(coreEngineWanted({ CLOUD_CORE_ENGINE: "off" })).toBe(false);
    expect(coreEngineWanted({ CLOUD_CORE_ENGINE: "on:org_aaaaaaaaaaaaaaaaaaaa" })).toBe(true);
    const w = world({ env: {} });
    const handler = w.dispatcher as unknown as (event: unknown) => Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }>;
    const body = JSON.stringify({ v: 1, workspaceId: randomUUID(), operationId: randomUUID() });
    const answer = await handler({ Records: [{ messageId: "m-1", receiptHandle: "r-1", body, attributes: {}, eventSource: "aws:sqs", eventSourceARN: QUEUE_ARN }] });
    expect(answer.batchItemFailures).toEqual([{ itemIdentifier: "m-1" }]);
    expect(w.machines.jobs).toHaveLength(0);
  });

  it("a batch from Cloud's own dispatch queue is never offered to the core's consumer, even a core-shaped message (the core has its own queue)", async () => {
    const w = world();
    let offered = 0;
    const counting = createDispatcherHandler({
      queueArn: "arn:aws:sqs:us-west-2:111122223333:agentx-staging-dispatch", coreQueueArn: QUEUE_ARN,
      coreDispatch: { take: () => { offered += 1; return new Set<string>(); }, handle: async () => ({ taken: new Set(), failures: [], reports: [] }) } as never,
      markDispatching: async () => false, markDelivered: async () => undefined, markFailed: async () => undefined,
    }) as unknown as (event: unknown) => Promise<unknown>;
    const body = JSON.stringify({ v: 1, workspaceId: randomUUID(), operationId: randomUUID() });
    await counting({ Records: [{ messageId: "m-1", receiptHandle: "r-1", body, attributes: {}, eventSource: "aws:sqs", eventSourceARN: "arn:aws:sqs:us-west-2:111122223333:agentx-staging-dispatch" }] }).catch(() => undefined);
    expect(offered).toBe(0);
    await counting({ Records: [{ messageId: "m-2", receiptHandle: "r-2", body, attributes: {}, eventSource: "aws:sqs", eventSourceARN: QUEUE_ARN }] });
    expect(offered).toBe(1);
    expect(w.machines.jobs).toHaveLength(0);
  });

  it("a non-broker function decides nobody and reads no repository: its people refuse and its code host refuses, in words", async () => {
    const w = world();
    const registry = await w.dispatcherEntry.app.registry();
    await expect(registry.require("identity").getPrincipal(PEOPLE_ORG, w.people.people.owner.developerId)).rejects.toThrow(/people are decided by the broker/u);
    const verdict = await registry.require("approvers").verify({ companyId: PEOPLE_ORG, kind: "plan", subject: { type: "task", id: randomUUID() }, artifactDigest: "a".repeat(64), revision: 1 } as never, { method: BROWSER_SESSION_METHOD, token: w.people.people.owner.sessionId } as never);
    expect(verdict.approved).toBe(false);
    await expect(refusingCodeHost().getBranchHead(REPO, "main", { orgId: PEOPLE_ORG })).rejects.toThrow(NO_CODE_HOST_HERE);
  });

  it("the broker's machine operations never start, sign or post (only the dispatcher may)", async () => {
    const ops = brokerMachineOps(() => fakeMachines().store as never);
    await expect(ops.sessions.ensureSession({ workspaceId: randomUUID(), binding: BINDING as never })).rejects.toThrow(/started by the dispatcher/u);
    await expect(ops.sign(new Uint8Array([1]))).rejects.toThrow(/could not be reached/u);
    await expect(ops.post("http://10.0.0.1:8080/invocations", { authorization: "x", body: "{}" })).rejects.toThrow(/could not be reached/u);
    expect(await ops.stopInstance("i-0123456789abcdef0")).toEqual({ gone: false });
  });

  it("a core workspace's binding is its project revision's, under the record's own company", async () => {
    const w = world();
    const workspaceId = randomUUID();
    w.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", companyId: PEOPLE_ORG, projectName: "payments", projectRevision: 1 });
    expect(await coreWorkspaceBinding(w.db, "state")(workspaceId)).toMatchObject({ launchTemplateId: BINDING.launchTemplateId });
    const stray = randomUUID();
    // A record with no company of its own is never placed under another one (not even its `orgId`, which a Cloud workspace carries): no binding.
    w.db.set({ pk: `WORKSPACE#${stray}`, sk: "META", orgId: PEOPLE_ORG, projectName: "payments", projectRevision: 1 });
    expect(await coreWorkspaceBinding(w.db, "state")(stray)).toBeUndefined();
  });

  it("prices come from Cloud's catalog; an unknown model has none (never $0)", () => {
    const table = cloudCatalogPriceTable();
    expect(table.models["anthropic/claude-sonnet-4-5"]?.inputMicrosPerMillionTokens).toBeGreaterThan(0);
    expect(table.models["nobody/no-model"]).toBeUndefined();
  });

  it("the dispatcher's production core host takes core records only while its own switch says on, and refuses to build without a named environment and the core queue", async () => {
    const callbackKey = randomBytes(32).toString("base64url");
    const machines = fakeMachines();
    const inputs = (env: Record<string, string>) => ({
      env, documentClient: createPeopleWorld().db as never, tableName: "state", installCompanyId: PEOPLE_ORG, sessions: machines.store as never,
      sign: machines.dispatcher.sign, post: machines.dispatcher.post, ping: machines.dispatcher.ping, log: () => undefined,
      clients: { secretsManager: { send: async () => ({ SecretString: callbackKey }) } as never, sqs: new FakeSqs() as never, ec2: { send: async () => ({}) }, dynamo: { send: async () => ({}) } as never, s3: { send: async () => ({}) } as never },
    });
    const named = { AGENTX_ENV: "staging", AWS_REGION: "us-west-2", CORE_DISPATCH_QUEUE_URL: QUEUE_URL, CORE_DISPATCH_DEAD_LETTER_URL: DEAD_URL };
    const record = { messageId: "m-1", body: JSON.stringify({ v: 1, workspaceId: randomUUID(), operationId: randomUUID() }) };
    expect((await createDispatcherCoreDispatch(inputs({ ...named, CLOUD_CORE_ENGINE: "on" }))).take([record]).size).toBe(1);
    expect((await createDispatcherCoreDispatch(inputs({ ...named, CLOUD_CORE_ENGINE: "off" }))).take([record]).size).toBe(0);
    expect((await createDispatcherCoreDispatch(inputs({ ...named }))).take([record]).size).toBe(0);
    await expect(createDispatcherCoreDispatch(inputs({ AWS_REGION: "us-west-2", CLOUD_CORE_ENGINE: "on" }))).rejects.toThrow(DISPATCHER_CORE_NOT_CONFIGURED);
  });

  it("the production CoreTierChecks host decides nobody: its module deps build with no developer API, and its people refuse in words", () => {
    const saved = { ...process.env };
    Object.assign(process.env, { STATE_TABLE_NAME: "state", ARTIFACT_BUCKET_NAME: "artifacts", AGENTX_ENV: "staging", MODEL_ACCESS_FUNCTION_NAME: "model-access", GITHUB_APP_CREDENTIAL_REF: "github-app", GITHUB_APP_PRIVATE_KEY_SECRET_ARN: "arn:aws:secretsmanager:us-west-2:111122223333:secret:app-key", AWS_REGION: "us-west-2", CORE_DISPATCH_QUEUE_URL: QUEUE_URL, CORE_DISPATCH_DEAD_LETTER_URL: DEAD_URL });
    try {
      const view = coreTierChecksView(process.env);
      const deps = view.cloudCore.moduleDeps();
      expect(() => (deps.people as unknown as { orgs: unknown }).orgs).toThrow(/people are decided by the broker/u);
      expect(deps.approvers.issuers).toEqual({});
      expect(owedPoints(deps)).toEqual([]);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it("the dispatcher loads nothing of the core while cc is off; on and drain load the host once, and again only after a failed build", async () => {
    let builds = 0;
    const build = async () => { builds += 1; if (builds === 1) throw new Error("first build fails"); return { take: () => new Set<string>(), handle: async () => ({ taken: new Set<string>(), failures: [], reports: [] }) } as never; };
    expect(coreDispatchLoaderFor({}, build)).toBeUndefined();
    expect(coreDispatchLoaderFor({ CLOUD_CORE_ENGINE: "off" }, build)).toBeUndefined();
    expect(coreDispatchLoaderFor({ CLOUD_CORE_ENGINE: "drain" }, build)).toBeTypeOf("function");
    const load = coreDispatchLoaderFor({ CLOUD_CORE_ENGINE: "on" }, build)!;
    await expect(load()).rejects.toThrow("first build fails");
    await load();
    await load();
    expect(builds).toBe(2);
  });

  it("lists what is refused for now, each with its refusal", () => {
    expect(CORE_REFUSED_FOR_NOW.length).toBeGreaterThan(0);
    for (const row of CORE_REFUSED_FOR_NOW) expect(row.refusal.length).toBeGreaterThan(10);
  });
});

export type { CloudCoreEntry };
