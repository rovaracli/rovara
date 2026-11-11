// Plan 4 Task 28: the world the isolation and runaway suites stand on. It is the REAL broker (its handler, its routes, its stores, its dispatch and its chain runner) with two orgs on
// one fake table, a fake of the one thing each of the broker's ports reaches (Secrets Manager for the connections and the hooks, EventBridge Scheduler, the SNS network, Sentry's API and
// a Linear MCP server) and nothing else faked. Org A has everything the plan names: a published chain C (INVESTIGATE_THEN_FIX) with three triggers (GitHub pull request opened, a Sentry
// hook, a weekly schedule), a run R waiting at its gate, a Sentry connection N and a connector `sentry` on `web`. Org B has a project `web` of its own and nothing else.
import { createHmac, randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import { agentGuardrailsKey, approvalKey, orgProjectCatalogKey, projectMemberKey, projectAgentKey, projectMetaKey, projectRevisionKey, DEFAULT_AGENT_GUARDRAILS, type OrgId } from "@rovara-code/contracts";
import { type OrgRole } from "@agentx/cloud-contracts";
import { issueCapability } from "../../packages/broker/src/aws/cancellation.js";
import { call as callHandler } from "./slack-broker.js";
import { onTaskEnded } from "../../packages/broker/src/agents/task-end.js";
import { recipeDigest, type RecipeOverlay } from "@rovara-code/contracts";
import { OrgSecrets } from "../../packages/broker/src/connections/org-secrets.js";
import { createChainScheduler } from "../../packages/broker/src/triggers/schedules.js";
import type { TriggerScheduler } from "../../packages/broker/src/triggers/ports.js";
import { TriggerStore, type TriggerRecord } from "../../packages/broker/src/triggers/store.js";
import { AgentStore, resolveAgent } from "../../packages/broker/src/agents/store.js";
import { checkEndpointUrl } from "../../packages/broker/src/connections/endpoint-check.js";
import { BUILT_IN_CONNECTOR_TYPES } from "../../packages/broker/src/aws/connector-types.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";
import type { ChainDefinitionInput } from "@rovara-code/contracts";
import { OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "./developer-task-broker.js";
import { routeFetch } from "./developer-fakes.js";
import { FAKE_CONNECTOR_ROLE_ARN, FakeOrgSecrets } from "./fake-org-secrets.js";
import { fakeSentry } from "./fake-vendor-apis.js";
import { FakeSchedulerClient } from "./fake-scheduler.js";
import { CHARTERARC_TEAM_ID, linearViaFake, startFakeLinearMcp } from "./fake-linear-mcp.js";
import { FakeHookSecrets } from "./hook-fixtures.js";
import { FakeSnsNetwork, SNS_ACCOUNT } from "./sns-fixtures.js";
import { INVESTIGATE_THEN_FIX } from "./chain-examples.js";
import { fakeModelAccess } from "./fake-model-access.js";
import { TEST_ORG } from "./orgs.js";

export const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
export const ORG_A = TEST_ORG;
export const ENV = "staging";
export const CELL = "https://abc123.execute-api.us-east-1.amazonaws.com";
export const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
/** Org A: Dana administers it, Max maintains `web`, Carl contributes to it, Arjun is a member with a contributor's role (the one who starts runs). */
export const DANA = person("1", "Dana");
export const MAX = person("2", "Max");
export const CARL = person("3", "Carl");
export const ARJUN = person("6", "Arjun");
/** Org B: Omar is a member who maintains B's `web` (the strongest caller B has without owning the org), Beth owns B. */
export const BETH = person("7", "Beth");
export const B_PEOPLE = [OMAR, BETH];
export const orgResolver: OrgResolver = async (subject) => (B_PEOPLE.some((who) => who.developerId === subject.developerId) ? ORG_B : ORG_A);

export const SENTRY_TOKEN = "sntrys_ISOLATIONSUITETOKEN0123456789";
export const LINEAR_KEY = "lin_api_ISOLATIONSUITEKEY0123456789";
export const HOOK_SECRET_A = "sentry-client-secret-of-org-a-0123456789";
export const HOOK_SECRET_B = "sentry-client-secret-of-org-b-0123456789";
export const INSTALLATION_A = "33333333-3333-4333-8333-333333333333";
export const INSTALLATION_A2 = "44444444-4444-4444-8444-444444444444";
export const INSTALLATION_B = "55555555-5555-4555-8555-555555555555";
const BINDING = {
  deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3",
} as const;
export const SCHEDULE_SETTINGS = {
  groupName: "agentx-staging-chain-triggers", roleArn: "arn:aws:iam::123456789012:role/r", functionArn: "arn:aws:lambda:us-east-1:123456789012:function:f", queueArn: "arn:aws:sqs:us-east-1:123456789012:q",
};

export type Reply = { status: number; body: Record<string, unknown> };
export type Item = Record<string, unknown>;
export const WRITES = /^(Put|Update|Delete|TransactWrite|BatchWrite)Command$/;

/** A project as registration writes it: revision 1, its catalog entry and its META. `connectors` are the project's integrations. */
export function seedProject(db: { set(item: Item): void }, orgId: OrgId, name: string, creator: string, connectors: unknown[] = []): void {
  const command = (executable: string, args: string[], timeoutSeconds: number) => ({ cwd: "repo/web", executable, args, timeoutSeconds });
  db.set({
    ...projectRevisionKey(orgId, name, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING,
    definition: {
      name, revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [command("npm", ["ci"], 900)], readiness: [command("npm", ["test"], 1800)], orchestratorInstructions: "Delegate work.",
      ...(connectors.length === 0 ? {} : { integrations: { connectors } }),
    },
  });
  db.set({ ...orgProjectCatalogKey(orgId, name), entityType: "PROJECT_CATALOG", name, latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
  db.set({ ...projectMetaKey(orgId, name), entityType: "PROJECT_META", name, status: "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: creator });
}

export const sentryBody = (installation: string, id: string, title = "Refund errors") => JSON.stringify({
  action: "created", installation: { uuid: installation }, data: { issue: { id, firstSeen: new Date().toISOString(), title, level: "error", web_url: `https://acme.sentry.io/issues/${id}/` } },
});
export const sentrySignature = (raw: Buffer | string, secret: string): string => createHmac("sha256", secret).update(raw).digest("hex");

/** One weekly schedule, as a person saves it. */
export const WEEKLY = { kind: "schedule", schedule: { kind: "weekly", at: "09:00", day: "MON" }, timezone: "UTC", missed: "run_once" } as const;

/** The harness's own fields the suites use, named here so this module's declaration holds none of the broker's input types. */
export interface HarnessView {
  handler: (event: unknown) => Promise<{ statusCode: number; headers: Record<string, string>; body: string }>;
  finish: (workspaceId: string, operationId: string, status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED", detail?: { result?: unknown; error?: string }) => Promise<Record<string, unknown>>;
  dev: (who: Developer, method: string, path: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
  orgOf: (who: Developer) => Promise<unknown>;
  brokerInput: unknown;
}

export async function chainsBrokerWorld() {
  const secretsFake = new FakeOrgSecrets({ env: ENV, now: Date.now });
  const secrets = new OrgSecrets({ env: ENV, roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: secretsFake.sts, secretsFor: secretsFake.secretsFor, now: Date.now });
  const fakeLinear = await startFakeLinearMcp();
  const { type: linearType } = linearViaFake(fakeLinear);
  const sentryApi = fakeSentry({ token: SENTRY_TOKEN });
  const nativeFetch = routeFetch(sentryApi.handler);
  const hookSecrets = new FakeHookSecrets();
  const schedulerClient = new FakeSchedulerClient();
  const scheduler: TriggerScheduler = createChainScheduler({ client: schedulerClient, settings: SCHEDULE_SETTINGS });
  const sns = new FakeSnsNetwork();
  const connectedAwsAccounts = new Set<string>();
  const access = fakeModelAccess();
  const holder: { db?: { send(command: unknown): Promise<unknown> } } = {};
  const checkEndpoint = vi.fn(async (url: string) => { await checkEndpointUrl(url, async () => ["52.1.2.3"]); });
  const h = await createDeveloperTaskBroker({
    orgResolver, register: false,
    brokerExtra: {
      cloud: true, modelAccess: { access, proxyUrl: "http://internal-proxy.example.test:4000" }, cloudProjects: { runtimeBinding: BINDING, githubCredentialRef: "github-app" }, checkRepositoryAccess: vi.fn(async () => undefined),
      connectorTypes: { ...BUILT_IN_CONNECTOR_TYPES, linear: linearType }, nativeFetch,
      orgConnections: { documentClient: { send: (command: unknown) => holder.db!.send(command) }, tableName: "state", env: ENV, secrets, now: Date.now },
      connectionChecks: { checkEndpoint, listMcpTools: vi.fn(async () => [{ name: "a" }]), fetch: vi.fn(async () => new Response(JSON.stringify({ data: { viewer: { id: "lin-user-1" } } }), { status: 200 })) },
      agents: {
        registerChainRunner: true, triggerSchedules: scheduler,
        eventHooks: { secrets: hookSecrets, snsFetch: sns.fetch, awsAccounts: { isConnected: async (org: string, account: string) => connectedAwsAccounts.has(`${org}|${account}`) } },
      },
    },
  });
  holder.db = h.db;
  const { db } = h;
  const triggers = new TriggerStore({ documentClient: db, tableName: "state", now: Date.now });
  const agents = new AgentStore({ documentClient: db, tableName: "state", now: Date.now });

  const enroll = async (who: Developer, role: OrgRole, orgId: OrgId) => {
    db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(who);
    seedMembership(db, who.developerId, { orgId, role });
  };
  await enroll(DANA, "admin", ORG_A);
  for (const who of [MAX, CARL, ARJUN]) await enroll(who, "member", ORG_A);
  await enroll(OMAR, "member", ORG_B);
  await enroll(BETH, "owner", ORG_B);
  const grant = (orgId: OrgId, who: Developer, project: string, projectRole: "maintainer" | "contributor") =>
    db.set({ ...projectMemberKey(orgId, who.developerId, project), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: project, grantId: randomUUID(), role: "developer", projectRole, grantedAt: "2026-10-01T00:00:00.000Z" });
  for (const orgId of [ORG_A, ORG_B]) {
    db.set({
      ...agentGuardrailsKey(orgId), entityType: "AGENT_GUARDRAILS", revision: 1, updatedBy: DANA.developerId, updatedAt: "2026-10-21T00:00:00.000Z",
      guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxAutonomy: "run" },
    });
  }

  const api = async (who: Developer, method: string, path: string, body?: Record<string, unknown>, requestId: string = randomUUID()): Promise<Reply> => {
    const reply = await h.dev(who, method, path, body === undefined ? undefined : { requestId, ...body });
    const { requestId: _requestId, ...rest } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id is not part of an answer
    return { status: reply.status, body: rest };
  };
  const created = async (reply: Promise<Reply>, status = 201): Promise<Record<string, unknown>> => {
    const answered = await reply;
    expect(answered.status, JSON.stringify(answered.body)).toBe(status);
    return answered.body;
  };

  /** A chain made, published and (when `budgetUsd` is given) budgeted through the routes, by `who`. */
  const chainOf = async (who: Developer, definition: ChainDefinitionInput, options: { name?: string; budgetUsd?: number } = {}): Promise<string> => {
    const body = await created(api(who, "POST", "/v1/app/chains", { name: options.name ?? `Chain ${randomUUID().slice(0, 8)}`, definition }));
    const chainId = (body.chain as { chainId: string }).chainId;
    const draft = await api(who, "GET", `/v1/app/chains/${chainId}/draft`);
    const published = await api(who, "POST", `/v1/app/chains/${chainId}/publish`, { expectedDraftRevision: (draft.body.draft as { revision: number }).revision });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    if (options.budgetUsd !== undefined) expect((await api(who, "PUT", `/v1/app/chains/${chainId}/budget`, { monthlyUsd: options.budgetUsd })).status).toBe(200);
    return chainId;
  };

  /** A custom agent of Max's, published and on web's roster, with `overlay`. */
  const agentOf = async (overlay: RecipeOverlay, name: string, orgId: OrgId = ORG_A, by: Developer = MAX): Promise<string> => {
    const body = await created(api(by, "POST", "/v1/app/agents", { name, overlay }));
    const agentId = (body.agent as { agentId: string }).agentId;
    const draft = (await agents.getDraft(orgId, agentId))!;
    await agents.saveDraft({ orgId, agentId: agentId, overlay, expectedRevision: draft.revision, by: by.developerId });
    const agent = (await agents.get(orgId, agentId))!;
    await agents.publish({ orgId, agentId: agent.agentId, expectedDraftRevision: agent.draftRevision, digest: recipeDigest(await resolveAgent(agents, orgId, agent.agentId, "draft")), by: by.developerId });
    db.set({ ...projectAgentKey(orgId, "web", agentId), entityType: "PROJECT_AGENT", orgId, project: "web", agentId, addedBy: by.developerId, addedAt: "2026-10-01T00:00:00.000Z" });
    return agentId;
  };

  /** A Sentry hook on `web` of org A for the installation, made through the route as Max. The secret is the vendor's, pasted in. */
  const sentryHook = async (installation: string, secret: string, who: Developer = MAX): Promise<string> => {
    const body = await created(api(who, "POST", "/v1/app/projects/web/event-hooks", { source: "sentry", tenant: { installationUuid: installation }, secret }));
    return (body.hook as { hookId: string }).hookId;
  };

  /** A delivery to the hook endpoint through the broker's own handler, with the body signed by `secret` unless told otherwise. */
  const deliver = (source: string, hookId: string, raw: string, options: { secret?: string | null; headers?: Record<string, string>; base64?: boolean; ip?: string; resource?: string } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", "sentry-hook-resource": options.resource ?? "issue", ...options.headers };
    if (options.secret !== null && options.secret !== undefined) headers["sentry-hook-signature"] = sentrySignature(raw, options.secret);
    return h.handler({
      version: "2.0", routeKey: "POST /v1/hooks/{source}/{hookId}", rawPath: `/v1/hooks/${source}/${hookId}`, rawQueryString: "", headers,
      body: options.base64 === false ? raw : Buffer.from(raw, "utf8").toString("base64"), isBase64Encoded: options.base64 !== false,
      requestContext: { requestId: randomUUID(), http: { method: "POST", sourceIp: options.ip ?? "203.0.113.9" } },
    }) as Promise<{ statusCode: number; headers: Record<string, string>; body: string }>;
  };

  /** Adds a connector (in the stored form a registration writes) to the project's latest revision, as the next revision: what a maintainer's confirmed change leaves. */
  const addConnector = (orgId: OrgId, project: string, connector: Record<string, unknown>): number => {
    const pk = projectRevisionKey(orgId, project, 1).pk;
    const latest = (db.find((item) => item.pk === pk && item.entityType === "PROJECT") as Array<Item & { sk: string; definition: { revision: number; integrations?: { connectors: unknown[] } } }>).sort((x, y) => x.sk.localeCompare(y.sk)).at(-1)!;
    const revision = latest.definition.revision + 1;
    db.set({ ...latest, ...projectRevisionKey(orgId, project, revision), definition: { ...latest.definition, revision, integrations: { connectors: [...(latest.definition.integrations?.connectors ?? []), connector] } } });
    return revision;
  };

  /** A delivery with the headers and body exactly as given (an SNS message, for instance), through the broker's handler. */
  const deliverRaw = (source: string, hookId: string, raw: string, headers: Record<string, string>, ip = "205.251.233.1") => h.handler({
    version: "2.0", routeKey: "POST /v1/hooks/{source}/{hookId}", rawPath: `/v1/hooks/${source}/${hookId}`, rawQueryString: "", headers,
    body: Buffer.from(raw, "utf8").toString("base64"), isBase64Encoded: true, requestContext: { requestId: randomUUID(), http: { method: "POST", sourceIp: ip } },
  }) as Promise<{ statusCode: number; headers: Record<string, string>; body: string }>;

  /** The step task of a chain run (the latest one), read from the table. */
  const stepTask = (runId: string, stepId?: string) => {
    const tasks = db.find((item) => item.entityType === "DEVELOPER_TASK" && (item.chain as { chainRunId?: string; stepId?: string } | undefined)?.chainRunId === runId && (stepId === undefined || (item.chain as { stepId: string }).stepId === stepId));
    return tasks.at(-1) as (Item & { taskId: string; workspaceId: string }) | undefined;
  };
  /** Ends a step's task as the agent's run would, through Plan 3's single place a task ends, so the chain runner's own handler hears it. */
  const endStep = async (runId: string, detail: { finalReport?: string; branch?: string } = {}, stepId?: string) => {
    const task = stepTask(runId, stepId);
    if (task === undefined) throw new Error(`run ${runId} has no step task`);
    return onTaskEnded({ documentClient: db, tableName: "state", now: Date.now }, db.get(`DEVTASK#${task.taskId}`, "META") as never, "succeeded", { finalReport: "The report.", ...detail }, { record: true });
  };

  const runItem = (runId: string) => db.find((item) => item.entityType === "CHAIN_RUN" && item.runId === runId)[0] as Item | undefined;
  const attempts = (runId: string) => db.find((item) => item.entityType === "CHAIN_RUN_STEP" && item.runId === runId) as Item[];
  const approvals = () => db.find((item) => item.entityType === "APPROVAL") as Item[];

  return {
    // The harness's own fields the tests use, by name: the whole harness would carry the broker's input types into this module's declaration.
    h: { handler: h.handler, finish: h.finish, dev: h.dev, orgOf: h.orgOf, brokerInput: h.brokerInput } as unknown as HarnessView,
    db, api, created, enroll, grant, chainOf, agentOf, sentryHook, addConnector, deliver, deliverRaw, stepTask, endStep, runItem, attempts, approvals, triggers, agents, scheduler, schedulerClient, secretsFake, secrets, fakeLinear, sentryApi, nativeFetch,
    hookSecrets, sns, connectedAwsAccounts, access, checkEndpoint, call: api,
    seedProject: (orgId: OrgId, name: string, creator: string, connectors: unknown[] = []) => seedProject(db, orgId, name, creator, connectors),
    approvalKey, CHARTERARC_TEAM_ID, SNS_ACCOUNT, INVESTIGATE_THEN_FIX,
  };
}

export type ChainsWorld = Awaited<ReturnType<typeof chainsBrokerWorld>>;
export type { TriggerRecord };

// ---- the isolation world: everything of org A the suites ask B for
export const stable = (_key: string, value: unknown): unknown => (value instanceof Set ? { set: [...value].sort() } : value);
export const SENTRY_CONNECTOR = (credentialRef: string) => ({
  name: "sentry", type: "sentry", credentialRef, scopes: [{ alias: "web", projectSlug: "web-app" }], tools: [{ name: "list_issues", access: "read" }, { name: "get_issue", access: "read" }],
});

/** Everything of org A the suite asks B for. */
export async function isolationWorld() {
  const w = await chainsBrokerWorld();
  const { db } = w;
  w.seedProject(ORG_A, "web", DANA.developerId);
  w.seedProject(ORG_B, "web", BETH.developerId);
  for (const who of [MAX]) w.grant(ORG_A, who, "web", "maintainer");
  for (const who of [CARL, ARJUN]) w.grant(ORG_A, who, "web", "contributor");
  w.grant(ORG_B, OMAR, "web", "maintainer");

  // A's connection N (Sentry) and connector `sentry` on web.
  const N = ((await w.created(w.api(DANA, "POST", "/v1/app/connections", { connection: { type: "sentry", label: "A Sentry", access: "read", region: "us", orgSlug: "acme" }, secret: { authToken: SENTRY_TOKEN } }))).connection as { connectionId: string }).connectionId;
  const added = await w.api(MAX, "PUT", "/v1/app/projects/web/connectors/sentry", { expectedRevision: 1, connector: SENTRY_CONNECTOR(N) });
  expect(added.status, JSON.stringify(added.body)).toBeLessThan(300);

  // A's Linear connection L and connector (a write tool among them), added the way a confirmed change leaves the project.
  const L = ((await w.created(w.api(DANA, "POST", "/v1/app/connections", { connection: { type: "linear", label: "A Linear", access: "read_write", identity: "service" }, secret: { apiKey: LINEAR_KEY } }))).connection as { connectionId: string }).connectionId;
  // The check records the account the key belongs to: the events that account causes are Rovara's own, and no trigger starts work for them.
  const checked = await w.api(DANA, "POST", `/v1/app/connections/${L}/check`, {});
  expect(checked.status, JSON.stringify(checked.body)).toBe(200);
  expect(checked.body.ok, JSON.stringify(checked.body)).toBe(true);
  w.addConnector(ORG_A, "web", { name: "linear", type: "linear", credentialRef: L, scopes: [{ alias: "eng", teamId: w.CHARTERARC_TEAM_ID }], tools: [{ name: "get_issue", access: "read" }, { name: "save_issue", access: "write" }] });

  // The permission-leak chain: an investigator granted Sentry (read) and Linear (read and write), then a summarizer granted nothing.
  const step = { id: "look", name: "Look", kind: "agent", workspace: "read" } as const;
  const investigator = await w.agentOf({ instructions: "Investigate.", sequence: [step], tools: [{ connector: { type: "sentry" }, access: "read" }, { connector: { type: "linear" }, access: "read_write" }] }, "Investigator");
  const summarizer = await w.agentOf({ instructions: "Summarize.", sequence: [step] }, "Summarizer");
  const P = await w.chainOf(MAX, {
    start: "investigate", limits: { maxRunUsd: 5 },
    steps: [
      { kind: "agent", id: "investigate", name: "Investigate", agent: { agentId: investigator, version: "current" }, next: { kind: "go", to: "summarize" } },
      { kind: "agent", id: "summarize", name: "Summarize", agent: { agentId: summarizer, version: "current" }, next: { kind: "end" } },
    ],
  } as never, { name: "Investigate then summarize", budgetUsd: 20 });

  // A's chain C, published and budgeted, and its triggers.
  const C = await w.chainOf(MAX, w.INVESTIGATE_THEN_FIX, { name: "Investigate then fix", budgetUsd: 50 });
  const H = await w.sentryHook(INSTALLATION_A, HOOK_SECRET_A);
  const H2 = await w.sentryHook(INSTALLATION_A2, HOOK_SECRET_A);
  const triggerId = (letter: string) => `ctr_${letter.repeat(20)}`;
  const seedTrigger = (id: string, over: Partial<Parameters<typeof w.triggers.create>[0]["record"]>) => w.triggers.create({
    record: { orgId: ORG_A, triggerId: id, target: { kind: "chain", chainId: C }, project: "web", spec: { kind: "event", source: "sentry", type: "issue.created" }, enabled: true, maxRunsPerHour: 30, createdBy: MAX.developerId, ...over },
  });
  const T = {
    github: await seedTrigger(triggerId("g"), { spec: { kind: "event", source: "github", type: "pull_request.opened" } }),
    hook: await seedTrigger(triggerId("h"), { hookId: H }),
    hook2: await seedTrigger(triggerId("i"), { hookId: H2 }),
    schedule: await seedTrigger(triggerId("s"), { spec: { ...WEEKLY }, scheduleStatus: "ok" }),
  };
  await w.scheduler.put({ orgId: ORG_A, triggerId: T.schedule.triggerId, spec: T.schedule.spec });

  // B's own things, so B's answers are B's and not merely empty.
  const BH = await w.sentryHook(INSTALLATION_B, HOOK_SECRET_B, OMAR);
  const BC = await w.chainOf(OMAR, w.INVESTIGATE_THEN_FIX, { name: "B chain", budgetUsd: 50 });

  // A's run R at its gate G (started by Max; the investigation chose `fix`).
  const started = await w.api(MAX, "POST", `/v1/app/chains/${C}/runs`, { project: "web" });
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const R = (started.body.run as { runId: string }).runId;
  await w.endStep(R, { branch: "fix" });
  const gate = w.attempts(R).find((attempt) => attempt.kind === "gate" && attempt.status === "waiting")!;
  const G = String(gate.approvalId);
  expect(G).toMatch(/^apr_/u);

  const fingerprint = (): string => JSON.stringify(db.find(() => true).map((item) => [item.pk, item.sk, item]).sort((a, b) => `${String(a[0])}|${String(a[1])}`.localeCompare(`${String(b[0])}|${String(b[1])}`)), stable);
  /** Org A's own items (everything that names A's org), in key order. */
  const aState = (): string => JSON.stringify(db.find((item) => JSON.stringify(item, stable).includes(ORG_A)).map((item) => [item.pk, item.sk, item]).sort((a, b) => `${String(a[0])}|${String(a[1])}`.localeCompare(`${String(b[0])}|${String(b[1])}`)), stable);
  return { w, N, L, C, P, investigator, summarizer, H, H2, BH, BC, T, R, G, fingerprint, aState };
}
export type IsolationWorld = Awaited<ReturnType<typeof isolationWorld>>;

// ---- a step's task, prepared, with the capability its agent step holds
const SIGNING = { callbackSigningKey: "c".repeat(64) };
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
/** The step's task, its preparation finished, and the capability its agent step would hold. */
export async function stepCapability(x: IsolationWorld, runId: string, stepId: string) {
  const task = x.w.stepTask(runId, stepId)!;
  const workspaceId = task.workspaceId;
  const operations = () => x.w.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION") as Array<Item & { id: string; kind: string; status: string; fence: number; programStepId?: string }>;
  const prepare = operations().find((operation) => operation.kind === "prepare")!;
  await x.w.h.finish(workspaceId, prepare.id, "SUCCEEDED", PREPARED);
  const active = String((x.w.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  const operation = operations().find((entry) => entry.id === active)!;
  const capability = issueCapability(SIGNING, workspaceId, active, operation.fence, { agentTools: true });
  const headers = { "x-agentx-callback-capability": capability };
  return {
    taskId: task.taskId, workspaceId, operationId: active, operation,
    tools: () => callHandler(x.w.h.handler, { method: "GET", path: "/v1/internal/agent-tools", headers }),
    callTool: (body: Record<string, unknown>) => callHandler(x.w.h.handler, { method: "POST", path: "/v1/internal/agent-tools/call", headers, body }),
  };
}

