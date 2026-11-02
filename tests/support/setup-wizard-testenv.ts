// Setup wizard (E4) test bench: the whole broker with a project, an owner (Omar), a second admin (Maya), a setup draft that proposes a sandbox environment, and a browser session with a sign-in time the test controls.
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import {
  TestEnvironmentBodySchema, githubInstallationKey, orgGithubInstallationKey, orgProjectCatalogKey, orgMetaKey, projectMemberKey, projectMetaKey, projectRevisionKey, TEST_ENV_DRAFT_RESULT_KEY, testEnvDigest,
  type GithubInstallationRecord, type TestEnvDraft, type TestEnvironmentBody,
} from "../../packages/contracts/src/index.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";
import { APP_CSRF_HEADER, appCsrfTokenFor } from "../../packages/broker/src/developer/app-csrf.js";
import { DEV_ISSUER, MAYA, OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "./developer-task-broker.js";
import { TEST_ORG } from "./orgs.js";
import type { AuditCapture } from "./audit-capture.js";

export const NAME = "web";
export const ENV = `/v1/app/projects/${NAME}/test-environment`;
const BINDING = { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" } as const;
export const command = (executable: string, args: string[], timeoutSeconds: number, cwd = "repo/web") => ({ cwd, executable, args, timeoutSeconds });
const PREPARED = { result: { preparedBase: [{ repositoryId: "web", baseCommitSha: "e".repeat(40) }] } };
export type Reply = { status: number; body: Record<string, unknown> };
export const errorOf = (reply: Reply) => reply.body.error as { code: string; message: string };

export const draftBody = (over: Record<string, unknown> = {}): TestEnvironmentBody => TestEnvironmentBodySchema.parse({
  tier: "sandbox",
  repos: [{ repositoryId: "web", setupCommands: [command("make", ["old-setup"], 900)], checks: [{ id: "unit", label: "Unit tests", command: command("make", ["old-test"], 1800), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [".github/**"] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
  ...over,
});
export const draftOf = (environment = draftBody()): TestEnvDraft => ({ environment, valueSources: [{ field: "repos[0].checks[0]", source: "detector:node" }, { field: "repos[0].setupCommands[0]", source: { path: "Makefile", line: 3 } }], pendingServices: [], notes: ["Found a Makefile."], questions: [] });
const SETUP_PROPOSAL = { setup: [{ repo: "web", commands: ["npm ci"], confidence: "high", from: [{ kind: "inferred", repo: "web", note: "a package.json" }] }], tests: [], notes: "ok" };

/** The Team record's own table: a store of its own, apart from the State table, as in a deployed cell (`agentx-<env>-team-record`). A read of the wrong table finds nothing. */
export const TEAM_RECORD_TABLE = "agentx-staging-team-record";

export async function setupWizardBench(options: { agents?: boolean; teamRecord?: boolean; audit?: AuditCapture; /** The Team record's tracker-people calls (the mapping page), when a test reaches them. */ trackerPeople?: unknown } = {}) {
  const teamDb = new FakeDynamoDb();
  const h = await createDeveloperTaskBroker({
    register: false,
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    brokerExtra: {
      cloud: true, agents: options.agents === false ? undefined : {}, cloudProjects: { runtimeBinding: BINDING, githubCredentialRef: "github-app" },
      githubPullRequests: { reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(), getRepositoryIdentity: vi.fn(), getFileAtCommit: vi.fn(async () => undefined), getDefaultBranchHead: vi.fn(async () => "c".repeat(40)) },
      checkRepositoryAccess: vi.fn(async () => undefined),
      // The Team record is on (its table is separate from the State table) unless the test says otherwise. Only its table is used by the test-environment code; the rest is what other callers would find missing.
      ...(options.teamRecord === false ? {} : { teamRecord: { table: { documentClient: teamDb, tableName: TEAM_RECORD_TABLE }, taps: {}, erase: {}, jobs: {}, ...(options.trackerPeople === undefined ? {} : { trackerPeople: options.trackerPeople }) } }),
    },
  });
  seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
  const record: GithubInstallationRecord = { installationId: 7, orgId: TEST_ORG, accountLogin: "acme", accountId: 907, accountType: "Organization", repositorySelection: "all", installedByGithubUserId: "gh-1", boundByDeveloperId: OMAR.developerId, status: "active", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" } as never;
  h.db.set({ ...orgGithubInstallationKey(TEST_ORG, 7), entityType: "GITHUB_INSTALLATION", ...record });
  h.db.set({ ...githubInstallationKey(7), entityType: "GITHUB_INSTALLATION", ...record });
  h.db.set({
    ...projectRevisionKey(TEST_ORG, NAME, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING,
    definition: { name: NAME, revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }], setup: [command("make", ["old-setup"], 900)], readiness: [command("make", ["old-test"], 1800)], orchestratorInstructions: "Delegate work." },
  });
  h.db.set({ ...orgProjectCatalogKey(TEST_ORG, NAME), entityType: "PROJECT_CATALOG", name: NAME, latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
  h.db.set({ ...projectMetaKey(TEST_ORG, NAME), entityType: "PROJECT_META", name: NAME, status: "active", description: "The site", createdAt: "2026-10-02T00:00:00.000Z", createdBy: MAYA.developerId });

  /** Makes `who` a member of the company with `role` (and, for a member, a project grant). The company's approval counter is set so the second-person records are complete. */
  const person = async (who: Developer, role: "owner" | "admin" | "member", grant?: "viewer" | "contributor" | "maintainer") => {
    await h.orgOf(who);
    seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role });
    h.db.set({ ...(h.db.get(orgMetaKey(TEST_ORG)) as Record<string, unknown>), approvalMembershipVersion: 3, approvalTrackingSince: "2026-01-01T00:00:00.000Z" });
    if (grant !== undefined) h.db.set({ ...projectMemberKey(TEST_ORG, who.developerId, NAME), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: NAME, grantId: randomUUID(), role: grant === "viewer" ? "viewer" : "developer", projectRole: grant });
  };
  h.db.set({ ...(h.db.get(orgMetaKey(TEST_ORG)) as Record<string, unknown>), approvalMembershipVersion: 3, approvalTrackingSince: "2026-01-01T00:00:00.000Z" });

  const ask = (): Promise<Reply> => h.dev(OMAR, "POST", `/v1/app/projects/${NAME}/setup-draft`, { requestId: randomUUID() });
  const operations = (workspaceId: string) => h.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId) as Array<{ id: string; kind: string; status: string; workflowMode?: string }>;
  const taskOf = (): { taskId: string; workspaceId: string } => h.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.purpose === "setup_draft").at(-1) as never;
  /** A finished setup draft that reports `draft` as the environment it found. */
  const drafted = async (draft: TestEnvDraft = draftOf()) => {
    const reply = await ask();
    if (reply.status !== 202) throw new Error(`setup draft: ${JSON.stringify(reply.body)}`);
    const task = taskOf();
    await h.finish(task.workspaceId, operations(task.workspaceId).find((operation) => operation.kind === "prepare")!.id, "SUCCEEDED", PREPARED);
    const own = operations(task.workspaceId).find((operation) => operation.kind === "task")!;
    await h.finish(task.workspaceId, own.id, "SUCCEEDED", { result: { conversationId: randomUUID(), reopened: false, workflowMode: "SETUP_DRAFT", setupProposal: SETUP_PROPOSAL, [TEST_ENV_DRAFT_RESULT_KEY]: draft } });
  };
  /** The project's setup check, passed at `revision`. */
  const setupCheckPassed = (revision = 1, startedAt = new Date().toISOString()) => {
    h.db.set({ pk: "WORKSPACE#ws-check", sk: "META", status: "READY" });
    const meta = h.db.get(projectMetaKey(TEST_ORG, NAME)) as Record<string, unknown>;
    h.db.set({ ...meta, ...projectMetaKey(TEST_ORG, NAME), setupCheck: { workspaceId: "ws-check", revision, startedAt, startedBy: OMAR.developerId } });
  };

  // ---- browser sessions
  const sessions = new Map<string, string>();
  const browserSessionOf = (who: Developer): string => {
    let id = sessions.get(who.developerId);
    if (id === undefined) {
      id = randomUUID();
      h.db.set({ ...(h.db.get(`SESSION#${who.sessionId}`, "META") as Record<string, unknown>), pk: `SESSION#${id}`, sessionId: id, reviewExpiresAt: Math.floor(Date.now() / 1000) + 3600, authTime: new Date().toISOString() });
      sessions.set(who.developerId, id);
    }
    return id;
  };
  /** Makes the person's browser sign-in `minutes` old (undefined: a session with no sign-in time). */
  const ageSignIn = (who: Developer, minutes: number | undefined) => {
    const id = browserSessionOf(who);
    const record = { ...(h.db.get(`SESSION#${id}`, "META") as Record<string, unknown>) };
    if (minutes === undefined) delete record.authTime; else record.authTime = new Date(Date.now() - minutes * 60_000).toISOString();
    h.db.set(record);
  };
  /** A request the way the web app sends it: the session cookie, the origin and the CSRF header. */
  const web = async (who: Developer, method: string, path: string, body?: unknown): Promise<Reply> => {
    const id = browserSessionOf(who);
    const response = await h.handler({
      rawPath: path.replace("/v1/app/", "/v1/web/"), rawQueryString: "", routeKey: "ANY /v1/web/{proxy+}",
      headers: { cookie: `__Host-agentx_review_session=${id}`, "sec-fetch-site": "same-origin", origin: new URL(DEV_ISSUER).origin, [APP_CSRF_HEADER]: appCsrfTokenFor(id) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: "r", http: { method } },
    });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  const state = async (who: Developer = OMAR) => (await h.dev(who, "GET", ENV)).body as { approved?: { revision: number; digest: string }; draft: { status: string }; proposal?: { digest: string; source: string; risk: string; lessSafe: string[]; proved: boolean; needs: { freshSignIn: boolean; secondPerson: boolean }; approval: { status: string }; runs: Array<{ setup: string[]; checks: Array<{ command: string; selectArgs?: string[] }> }>; valueSources: Array<{ field: string; source: unknown }>; commandsNotInSettings: number } };
  /** Proposes the draft, proves it with a passing setup check and approves it as revision 1 (a sandbox environment: no second person). */
  const approveFirst = async (draft: TestEnvDraft = draftOf()): Promise<string> => {
    await drafted(draft);
    const proposed = await h.dev(OMAR, "POST", `${ENV}/propose`, {});
    if (proposed.status !== 200) throw new Error(`propose: ${JSON.stringify(proposed.body)}`);
    const digest = testEnvDigest(draft.environment);
    setupCheckPassed();
    const proved = await h.dev(OMAR, "POST", `${ENV}/prove`, { digest });
    if (proved.status !== 200) throw new Error(`prove: ${JSON.stringify(proved.body)}`);
    const approved = await h.dev(OMAR, "POST", `${ENV}/approve`, { digest, expectedRevision: 0 });
    if (approved.status !== 200) throw new Error(`approve: ${JSON.stringify(approved.body)}`);
    return digest;
  };
  const approvals = () => h.db.find((item) => item.entityType === "APPROVAL") as Array<Record<string, unknown> & { approvalId: string; status: string; subject: { kind: string; project: string; digest: string; expectedRevision: number }; requestedBy: string; approvers: { kind: string; rule?: string } }>;
  /**
   * What the confirmation page leaves in a card the second person confirmed: consent, with the fresh sign-in proof of that page. A card is decided ONCE: confirming one that was already decided throws, as the
   * real page would refuse it. `signedInMinutesBefore` is how long before confirming the person signed in; `confirmedMinutesAgo` is when they confirmed.
   */
  const confirmCard = (approvalId: string, by: Developer, when: { signedInMinutesBefore?: number; confirmedMinutesAgo?: number } = {}) => {
    const card = h.db.find((item) => item.entityType === "APPROVAL" && item.approvalId === approvalId)[0]!;
    if (card.status !== "PENDING") throw new Error(`the card was already decided (${String(card.status)})`);
    const decidedAt = Date.now() - (when.confirmedMinutesAgo ?? 0) * 60_000;
    h.db.set({ ...card, status: "APPROVED_DONE", decidedBy: by.developerId, decidedAt: new Date(decidedAt).toISOString(), decision: "APPROVE", decisionProof: { kind: "fresh_sign_in", method: "email_code", authTime: new Date(decidedAt - (when.signedInMinutesBefore ?? 0) * 60_000).toISOString(), sessionRef: "5".repeat(64) } });
  };
  return { ...h, teamDb, person, ask, drafted, setupCheckPassed, web, ageSignIn, state, approveFirst, approvals, confirmCard, operations };
}
export type Bench = Awaited<ReturnType<typeof setupWizardBench>>;

export const withSwitch = async <T>(value: string | undefined, run: () => Promise<T>): Promise<T> => {
  const before = process.env.TEST_ENVIRONMENT_ENABLED;
  if (value === undefined) delete process.env.TEST_ENVIRONMENT_ENABLED; else process.env.TEST_ENVIRONMENT_ENABLED = value;
  try { return await run(); } finally { if (before === undefined) delete process.env.TEST_ENVIRONMENT_ENABLED; else process.env.TEST_ENVIRONMENT_ENABLED = before; }
};
