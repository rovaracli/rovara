// Rovara Code (staging 0.4.11, Bug G): a real broker handler with a Rovara Code task waiting for its merge, so the clients that press Merge (the CLI, the web app) run against the
// real routes and the real `json()` wrapper. Maya (the requester) is signed in; Omar approved the pull request on GitHub. GitHub is a fake that reads and merges.
import { createHash, randomUUID } from "node:crypto";
import { createCandidateManifest, mergeTrackingDecisionDigest, mergeTrackingKey, orgMemberKey, type MergeTrackingItem } from "../../packages/contracts/src/index.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { DECIDE_COOKIE, DecideStore, csrfTokenFor } from "../../packages/broker/src/developer/decide-session.js";
import { linkGithubMember } from "../../packages/broker/src/rovara-code/github-members.js";
import { builtinSettingsKey, codeSettingsKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { githubWorkflowPullRequestKey } from "../../packages/broker/src/developer/task-records.js";
import { DEV_ISSUER, MAYA, OMAR, bearerFor, createDeveloperTaskBroker } from "./developer-task-broker.js";
import { markReady } from "./slack-broker.js";
import { MergeGithub, pullStatus, HEAD_A, GH, LOGIN } from "./rovara-code-merge-world.js";
import { TEST_ORG } from "./orgs.js";

export { HEAD_A, LOGIN, GH, MAYA, OMAR, DEV_ISSUER };
const NOW = "2026-10-26T22:16:10.000Z";
export const CELL = DEV_ISSUER.replace(/\/v1\/auth$/, "");

export interface MergeButtonOptions {
  /** Changes to the tracking item merge tracking kept for the pull request. */
  tracking?: Partial<MergeTrackingItem>;
  allowSelfApproval?: boolean;
  /** Who approved on GitHub; default: Omar, who is not a requester. */
  approver?: "omar" | "maya" | "none";
}

/** The harness: the task is Maya's, in `WAIT_FOR_MERGE`, with one pull request (`demo` #7) that merge tracking read as approved by Omar on the current head, with passing checks. */
export async function mergeButtonBroker(options: MergeButtonOptions = {}) {
  const github = new MergeGithub();
  /** What GitHub's merge observation says of the pull request (the owner merging it on GitHub sets it to merged). */
  const observed: { state: "open" | "merged"; mergedBy?: string } = { state: "open" };
  const h = await createDeveloperTaskBroker({
    brokerExtra: {
      agents: {}, decide: {},
      githubPullRequests: {
        reconcilePullRequest: async () => { throw new Error("not used"); }, getPullRequest: async () => { throw new Error("not used"); }, updatePullRequest: async () => { throw new Error("not used"); },
        verifyWebhookRepository: async () => true,
        getPullRequestStatus: (url: string, number: number) => github.getPullRequestStatus(url, number),
        getRepositoryPermission: (url: string, login: string) => github.getRepositoryPermission(url, login),
        // Owner decision 50.4: the merge lists the files a pull request changes before it presses merge.
        listPullRequestFiles: (url: string, number: number, options: { page: number }) => github.listPullRequestFiles(url, number, options),
        mergePullRequest: (url: string, number: number, input: { sha: string; method: "squash" | "merge" }) => github.mergePullRequest(url, number, input),
        getPullRequestMergeObservation: async () => ({
          number: 7, url: "https://github.com/example/demo/pull/7", state: observed.state, headBranch: "agentx/limit", baseBranch: "main", headCommit: HEAD_A, headTreeSha: "d".repeat(40), title: "Rovara: Limit open tasks", body: "",
          ...(observed.state === "merged" ? { mergeCommit: "e".repeat(40), ...(observed.mergedBy === undefined ? {} : { mergedBy: observed.mergedBy }) } : {}),
        }),
      },
    },
  });
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
  await store.ensureBuiltinSettings(TEST_ORG, "rovara-code");
  h.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "test", updatedAt: NOW });
  const started = await h.dev(MAYA, "POST", "/v1/app/agents/rovara-code/runs", { requestId: randomUUID(), project: "payments", input: { text: "Limit open tasks" } });
  if (started.status !== 202) throw new Error(`the Rovara Code task did not start: ${JSON.stringify(started.body)}`);
  const taskId = (started.body.task as { taskId: string }).taskId;
  const record = () => h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; sessionId: string; workflow: Record<string, unknown> };
  const sessionId = String(record().sessionId);
  // The task's earlier runs are over (it waits for its merge), so the task view is the full read of a waiting task.
  for (const operation of h.db.find((item) => item.pk === `WORKSPACE#${record().workspaceId}` && item.entityType === "OPERATION")) h.db.set({ ...operation, status: "SUCCEEDED" });
  markReady(h.db, record().workspaceId);
  // ... the last of them a finished coding run, so the task reads as a waiting task, not one still starting.
  const prepare = h.db.find((item) => item.pk === `WORKSPACE#${record().workspaceId}` && item.entityType === "OPERATION" && item.kind === "prepare")[0]!;
  const coding = randomUUID();
  h.db.set({ ...prepare, sk: `OPERATION#${coding}`, id: coding, kind: "task", workflowMode: "IMPLEMENT", status: "SUCCEEDED", createdAt: "2026-10-26T22:10:00.000Z", updatedAt: "2026-10-26T22:14:00.000Z" });
  for (const pointer of h.db.find((item) => item.entityType === "DEVELOPER_TASK_POINTER" && item.taskId === taskId)) { const { pendingPrompt: _prompt, ...rest } = pointer; h.db.set(rest); } // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped on purpose
  const url = "https://github.com/example/demo/pull/7";
  const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: HEAD_A, treeSha: "d".repeat(40) }]);
  h.db.set({ ...record(), workflow: { ...record().workflow, stage: "WAIT_FOR_MERGE", state: "WAITING", revision: 9, candidate,
    verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "fixture", recordedAt: NOW, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: taskId, candidateDigest: candidate.digest, role, provider: "fixture", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: NOW })),
    pullRequests: [{ repositoryId: "demo", number: 7, url, candidateDigest: candidate.digest, required: true, state: "OPEN", headSha: HEAD_A, headTreeSha: "d".repeat(40) }],
  } });
  h.db.set({ pk: `WORKSPACE#${record().workspaceId}`, sk: `PULL_REQUEST#demo#${"7".padStart(12, "0")}`, entityType: "PULL_REQUEST", baseBranch: "main", number: 7, repository: "demo", repositoryId: "demo", url, state: "open", expectedHeadCommit: HEAD_A });
  h.db.set({ ...githubWorkflowPullRequestKey("example/demo", 7), entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "example/demo", repositoryId: "demo", number: 7, url, taskId, workspaceId: record().workspaceId, candidateDigest: candidate.digest, createdAt: NOW });
  github.statuses.set(7, pullStatus(7));
  for (const login of [LOGIN.arjun, LOGIN.priya]) github.permissions.set(login, "write");
  // The people's GitHub accounts: Maya (the requester) is linked; Omar approved from the account linked to him.
  const tableOf = { documentClient: h.db, tableName: "state", now: Date.now };
  await linkGithubMember(tableOf, TEST_ORG, MAYA.developerId, GH.priya);
  await linkGithubMember(tableOf, TEST_ORG, OMAR.developerId, GH.arjun);
  h.db.set({ ...orgMemberKey(TEST_ORG, OMAR.developerId), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: OMAR.developerId, role: "member", joinedAt: NOW });
  if (options.allowSelfApproval === true) h.db.set({ ...codeSettingsKey(TEST_ORG, "payments"), entityType: "CODE_SETTINGS", allowSelfApproval: true, mergeMethod: "squash", codeReviewers: [], revision: 1 });
  const approver = options.approver ?? "omar";
  const fields = {
    orgId: TEST_ORG, taskId, repositoryId: "demo", number: 7, headSha: HEAD_A, draft: false, state: "open" as const, baseBranch: "main", ci: "passing" as const, ciBasis: "required" as const,
    checksEverSeen: true, failingChecks: [] as string[], review: approver === "none" ? "not_requested" as const : "approved" as const,
    ...(approver === "none" ? {} : { approval: approver === "maya" ? { githubUserId: GH.priya, login: LOGIN.priya, commitId: HEAD_A } : { githubUserId: GH.arjun, login: LOGIN.arjun, commitId: HEAD_A } }),
    branch: "up_to_date" as const, headByRovara: true, nudges: { count: 0 }, syncs: { day: "2026-10-26", count: 0 }, readyAt: NOW, ...options.tracking,
  };
  const tracking = (change: Partial<MergeTrackingItem> = {}) => {
    const next = { ...fields, ...change };
    h.db.set({ ...mergeTrackingKey(taskId, "demo", 7), entityType: "MERGE_TRACKING", ...next, version: 1, decisionDigest: mergeTrackingDecisionDigest(next), observedAt: NOW });
  };
  tracking();

  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  /** The person opens the confirmation link in a browser they just signed in on and presses the button. */
  const decide = async (confirmUrl: string, who = MAYA, decision: "approve" | "decline" = "approve") => {
    const approvalId = new URL(confirmUrl).pathname.split("/").pop()!;
    const cookie = `cookie-${randomUUID()}-${"x".repeat(30)}`;
    const signedInAt = Math.floor(Date.now() / 1000) - 20;
    await new DecideStore({ documentClient: h.db, tableName: "signin", now: Date.now }).putSession(cookie, { orgId: TEST_ORG, developerId: who.developerId, approvalId, signedInAt, method: "email_code", csrfHash: sha(csrfTokenFor(cookie)), expiresAt: signedInAt + 3600 });
    const response = await h.handler({
      version: "2.0", rawPath: new URL(confirmUrl).pathname, rawQueryString: "",
      headers: { cookie: `${DECIDE_COOKIE}=${cookie}`, origin: CELL, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ decision, csrf: csrfTokenFor(cookie) }).toString(),
      requestContext: { requestId: randomUUID(), http: { method: "POST" } },
    });
    return { status: response.statusCode, body: response.body };
  };
  return { ...h, github, observed, taskId, sessionId, tracking, record, decide, bearer: async (who = MAYA) => bearerFor(who, await h.orgOf(who)) };
}
export type MergeButtonBroker = Awaited<ReturnType<typeof mergeButtonBroker>>;
