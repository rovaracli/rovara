// Rovara Code (Plan 6 Task 19): a small company for the merge and code-settings tests. It is Plan 5's session world (org A: Priya owns the task and is its requester, Arjun is a
// contributor, Max is a maintainer, Ola an org admin) with a Rovara Code task waiting for its merge, the pull requests it opened, the tracking items merge tracking kept for
// them, the GitHub accounts of the people (linked to members), a fake GitHub that reads and merges, and Plan 3's confirmation page, so a test presses Merge and decides it the way
// a person does.
import { createHash, randomUUID } from "node:crypto";
import { developerOrgKey, orgMetaKey, mergeTrackingDecisionDigest, type MergeTrackingItem } from "@agentx/cloud-contracts";
import { projectRevisionKey, agentXError, mergeTrackingKey, type CodeSettings, type OrgId } from "@rovara-code/contracts";
import type { PullRequestStatus } from "../../packages/broker/src/github-pull-status.js";
import { approvalDecideKind } from "../../packages/broker/src/agents/approval-decide-kind.js";
import { getAnyApproval, type ApprovalDependencies } from "../../packages/broker/src/agents/approvals.js";
import { registerAgentApprovals } from "../../packages/broker/src/agents/changes.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { routeDecidePage } from "../../packages/broker/src/aws/decide-web.js";
import type { DecideKinds } from "../../packages/broker/src/developer/decide-kinds.js";
import { DECIDE_COOKIE, DecideStore, csrfTokenFor, mintConfirmUrl, type DecideRequestContext } from "../../packages/broker/src/developer/decide-session.js";
import { githubWorkflowPullRequestKey, taskKey } from "../../packages/broker/src/developer/task-records.js";
import type { SessionShareDependencies } from "../../packages/broker/src/agent-sessions/shares.js";
import { linkGithubMember } from "../../packages/broker/src/rovara-code/github-members.js";
import type { CodeMergeHost } from "../../packages/broker/src/rovara-code/merge.js";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import type { CodeHost } from "@rovara-code/contracts";
import { registerMergeApprovals } from "../../packages/broker/src/rovara-code/merge.js";
import { registerCodeSettingsApprovals } from "../../packages/broker/src/rovara-code/code-settings.js";
import type { MergePullRequestResult } from "../../packages/broker/src/github-app.js";
import { codeSettingsKey } from "@rovara-code/contracts";
import { ARJUN, CELL, MAX, OLA, ORG_A, PRIYA, sessionWorld } from "./agent-session-world.js";
import { capturingAuditDeps, type AuditCapture } from "./audit-capture.js";

export const HEAD_A = "a".repeat(40);
export const HEAD_B = "b".repeat(40);
export const HEAD_C = "c".repeat(40);
export const OLD_HEAD = "1".repeat(40);

/** GitHub accounts: Priya (the requester), Arjun (a reviewer who is a member), Max (a maintainer), Ola (an org admin); `stranger` has write access but no Rovara account. */
export const GH = { priya: "1001", arjun: "1004", max: "1002", ola: "1003", stranger: "2999", bot: "9001", reader: "2998" } as const;
export const LOGIN = { priya: "priya-gh", arjun: "arjun-gh", max: "max-gh", ola: "ola-gh", stranger: "stranger-gh", bot: "github-actions[bot]", reader: "reader-gh" } as const;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * A GitHub that answers what the merge needs: a pull request's status, a person's permission, and the merge itself (every call is kept). It stands where the GitHub App provider stands:
 * the merge goes through the GitHub CodeHost adapter (`githubCodeHost`) over it, exactly as the broker wires it.
 */
export class MergeGithub {
  readonly statuses = new Map<number, PullRequestStatus>();
  readonly permissions = new Map<string, "admin" | "write" | "read" | "none">();
  readonly mergeCalls: Array<{ number: number; sha: string; method: "squash" | "merge" }> = [];
  readonly calls: string[] = [];
  readonly results = new Map<number, MergePullRequestResult | Error>();
  /** The paths each pull request changes (default: one ordinary file), the CODEOWNERS text the base branch holds (none by default) and who is in which team (`org/team` to logins). */
  readonly changedPaths = new Map<number, string[]>();
  codeOwners: string | undefined | Error;
  readonly teams = new Map<string, string[] | Error>();
  /** The provider reads the changed files a page at a time; the consumer reads them through the port's `changedFiles`. */
  async listPullRequestFiles(_url: string, number: number, options: { page: number }): Promise<{ files: Array<{ filename: string; status: string; additions: number; deletions: number }>; nextPage?: number }> {
    if (options.page > 1) return { files: [] };
    return { files: (this.changedPaths.get(number) ?? ["src/index.ts"]).map((filename) => ({ filename, status: "modified", additions: 1, deletions: 0 })) };
  }
  async readCodeOwners(): Promise<string | undefined> {
    if (this.codeOwners instanceof Error) throw this.codeOwners;
    return this.codeOwners;
  }
  async isTeamMember(_url: string, team: string, login: string): Promise<"member" | "not_member" | "unknown"> {
    const members = this.teams.get(team);
    if (members === undefined || members instanceof Error) return "unknown";
    return members.includes(login) ? "member" : "not_member";
  }
  /** A hook run at the start of each merge call (a test uses it to race a second handler or to change a pull request under the first). */
  onMerge: ((number: number) => Promise<void> | void) | undefined;
  async getPullRequestStatus(_url: string, number: number): Promise<PullRequestStatus> {
    this.calls.push(`status:${String(number)}`);
    const found = this.statuses.get(number);
    if (found === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "no such pull request");
    return structuredClone(found);
  }
  async getRepositoryStanding(_url: string, login: string): Promise<{ permission: "admin" | "write" | "read" | "none"; userType?: string }> {
    this.calls.push(`permission:${login}`);
    return { permission: this.permissions.get(login) ?? "none" };
  }
  async getRepositoryPermission(url: string, login: string): Promise<"admin" | "write" | "read" | "none"> {
    return (await this.getRepositoryStanding(url, login)).permission;
  }
  async mergePullRequest(_url: string, number: number, input: { sha: string; method: "squash" | "merge" }): Promise<MergePullRequestResult> {
    this.calls.push(`merge:${String(number)}`);
    this.mergeCalls.push({ number, sha: input.sha, method: input.method });
    await this.onMerge?.(number);
    const planned = this.results.get(number);
    if (planned instanceof Error) throw planned;
    if (planned !== undefined) {
      if (planned.outcome === "merged") this.statuses.set(number, { ...this.statuses.get(number)!, state: "merged" });
      return planned;
    }
    this.statuses.set(number, { ...this.statuses.get(number)!, state: "merged" });
    return { outcome: "merged", method: input.method, fellBack: false };
  }
}

export function pullStatus(number: number, overrides: Partial<PullRequestStatus> = {}): PullRequestStatus {
  return {
    number, state: "open", draft: false, headSha: HEAD_A, baseBranch: "main", mergeableState: "clean", mergeable: true, behindBy: 0,
    checks: [{ name: "test", status: "completed", conclusion: "success", required: false, url: "https://example.test/1" }],
    requiredChecks: [], baseHasRequiredChecks: false, headHasWorkflowFiles: true, requestedReviewers: 1,
    reviews: [{ githubUserId: GH.arjun, login: LOGIN.arjun, userType: "User", state: "APPROVED", commitId: HEAD_A, submittedAt: "2026-10-22T08:40:00.000Z" }],
    ...overrides,
  };
}

/** The GitHub CodeHost adapter over a GitHub-shaped fake: what the broker registers for a repository whose record names GitHub. */
export const githubHostOver = (github: MergeGithub): CodeHost => githubCodeHost(github as never, { credentialRef: "github" });

export interface MergeWorldOptions {
  /** The code host the repositories live on, in place of the GitHub adapter over `MergeGithub`. The repositories keep their GitHub addresses. */
  codeHost?: CodeHost;
  pullRequests?: Array<{ repositoryId: string; number: number }>;
  allowSelfApproval?: boolean;
  mergeMethod?: "squash" | "merge";
  /** Who has a linked GitHub account; default: Priya, Arjun, Max and Ola. */
  linked?: Array<keyof typeof GH>;
}

type PullRequestRef = { repositoryId: string; number: number };
/** What `mergeWorld` adds to Plan 5's session world (named, so the world's type does not drag in modules by their package paths). */
export interface MergeWorldExtras {
  sessionId: string;
  taskId: string;
  orgId: OrgId;
  github: MergeGithub;
  host: CodeMergeHost;
  deps: ApprovalDependencies;
  kind: ReturnType<typeof approvalDecideKind>;
  context: (kinds?: DecideKinds) => DecideRequestContext;
  browser: (developerId: string, approvalId: string, agoSeconds?: number) => Promise<string>;
  decide: (approvalId: string, cookie: string, decision?: "approve" | "decline") => ReturnType<typeof routeDecidePage>;
  approvalOf: (url: string) => Promise<Awaited<ReturnType<typeof getAnyApproval>> & object>;
  approvalIdOf: (url: string) => string;
  requestId: () => string;
  /** Every audit event the world's actions recorded. */
  audited: () => Array<{ action: string; proof?: unknown }>;
  prs: PullRequestRef[];
  seedTracking: (overrides?: Partial<MergeTrackingItem> | ((pr: PullRequestRef) => Partial<MergeTrackingItem>)) => void;
  trackingOf: (pr: PullRequestRef) => (MergeTrackingItem & Record<string, unknown>) | undefined;
  trackingItem: (pr: PullRequestRef, overrides?: Partial<MergeTrackingItem>) => MergeTrackingItem;
  settings: (change?: Partial<CodeSettings>) => void;
  linkAll: () => Promise<void>;
  setWorkflow: (change: Record<string, unknown>) => void;
  setPullRequests: (list: Array<Record<string, unknown>>) => void;
  store: AgentStore;
  shareDeps: SessionShareDependencies;
  decideStore: DecideStore;
  /** The Audit Ledger's outbox and queue, wired into the approvals the world decides with. */
  audit: AuditCapture;
}
export type MergeWorld = ReturnType<typeof sessionWorld> & MergeWorldExtras;

export function mergeWorld(options: MergeWorldOptions = {}): MergeWorld {
  const w = sessionWorld();
  // The fake member roster already grants "web". Keep its registered project identity real as well:
  // G3 publication reads the canonical definition and registeredAt rather than trusting roster names.
  w.db.set({...projectRevisionKey(ORG_A,"web",1),entityType:"PROJECT",registeredAt:new Date(w.clock.now).toISOString(),definition:{name:"web",revision:1,repositories:[{name:"web",url:"https://github.com/acme/web.git",path:"repo/web",defaultBranch:"main",credentialRef:"github-app"}],setup:[],readiness:[],orchestratorInstructions:"Delegate work."}});
  // Match real company membership pointers and open-org identity for transactional model fences.
  w.db.set({...orgMetaKey(ORG_A),entityType:"ORG",orgId:ORG_A,name:"test",plan:"team"});
  for(const row of w.db.find(row=>row.entityType==="ORG_MEMBER"&&row.orgId===ORG_A)) if(typeof row.developerId==="string") w.db.set({...developerOrgKey(row.developerId),entityType:"DEVELOPER_ORG",orgId:ORG_A,role:row.role});
  const prs = options.pullRequests ?? [{ repositoryId: "payments", number: 7 }];
  const seeded = w.seedSession();
  const { sessionId, taskId } = seeded;
  const github = new MergeGithub();
  const now = () => w.clock.now;
  const stamp = new Date(w.clock.now).toISOString();
  const orgId = ORG_A;

  const workflowPrs = prs.map((pr) => ({
    repositoryId: pr.repositoryId, number: pr.number, url: `https://github.com/acme/${pr.repositoryId}/pull/${String(pr.number)}`, headSha: HEAD_A, headTreeSha: "d".repeat(40),
    candidateDigest: "c".repeat(64), required: true, state: "OPEN",
  }));
  const workflow = {
    schemaVersion: 1, definitionId: "agentx-task-to-pr", definitionVersion: "1.1.0", taskId, revision: 9, stage: "WAIT_FOR_MERGE", state: "WAITING", path: "QUICK",
    pullRequests: workflowPrs, updatedAt: stamp,
    // The risk of the code (a small change): the Merge section shows it and a browser press must have seen it.
    risk: { level: "low", reasons: ["A small change with no sensitive paths, dependency changes or open concerns."], candidateDigest: "c".repeat(64) },
  };
  const task = w.db.get(taskKey(taskId))!;
  w.db.set({ ...task, startingRevision: 1, workspaceId: "ws-1", workflow });
  const setWorkflow = (change: Record<string, unknown>) => { const current = w.db.get(taskKey(taskId))!; w.db.set({ ...current, workflow: { ...(current.workflow as object), ...change } }); };
  const setPullRequests = (list: Array<Record<string, unknown>>) => setWorkflow({ pullRequests: list });

  for (const pr of prs) {
    github.statuses.set(pr.number, pullStatus(pr.number));
    w.db.set({
      ...githubWorkflowPullRequestKey(`acme/${pr.repositoryId}`, pr.number), entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: `acme/${pr.repositoryId}`, repositoryId: pr.repositoryId,
      number: pr.number, url: `https://github.com/acme/${pr.repositoryId}/pull/${String(pr.number)}`, taskId, workspaceId: "ws-1", candidateDigest: "c".repeat(64), createdAt: stamp,
    });
  }
  for (const login of [LOGIN.priya, LOGIN.arjun, LOGIN.max, LOGIN.ola, LOGIN.stranger]) github.permissions.set(login, "write");
  github.permissions.set(LOGIN.reader, "read");

  const linked = options.linked ?? ["priya", "arjun", "max", "ola"];
  const developerOf = { priya: PRIYA, arjun: ARJUN, max: MAX, ola: OLA } as const;
  const linkAll = async () => {
    for (const who of linked) if (who in developerOf) await linkGithubMember({ documentClient: w.db, tableName: "state", now }, orgId, developerOf[who as keyof typeof developerOf], GH[who]);
  };

  const trackingItem = (pr: { repositoryId: string; number: number }, overrides: Partial<MergeTrackingItem> = {}): MergeTrackingItem => {
    const fields = {
      orgId, taskId, repositoryId: pr.repositoryId, number: pr.number, headSha: HEAD_A, draft: false, state: "open" as const, baseBranch: "main", ci: "passing" as const,
      ciBasis: "all_checks" as const, checksEverSeen: true, failingChecks: [], review: "approved" as const,
      approval: { githubUserId: GH.arjun, login: LOGIN.arjun, commitId: HEAD_A }, branch: "up_to_date" as const, headByRovara: true,
      nudges: { count: 0 }, syncs: { day: "2026-10-22", count: 0 }, readyAt: stamp, ...overrides,
    };
    return { ...fields, version: 1, decisionDigest: mergeTrackingDecisionDigest(fields), observedAt: stamp };
  };
  const seedTracking = (overrides: Partial<MergeTrackingItem> | ((pr: { repositoryId: string; number: number }) => Partial<MergeTrackingItem>) = {}) => {
    for (const pr of prs) {
      const item = trackingItem(pr, typeof overrides === "function" ? overrides(pr) : overrides);
      w.db.set({ ...mergeTrackingKey(taskId, pr.repositoryId, pr.number), entityType: "MERGE_TRACKING", ...item });
    }
  };
  const trackingOf = (pr: { repositoryId: string; number: number }) => w.db.get(mergeTrackingKey(taskId, pr.repositoryId, pr.number)) as unknown as (MergeTrackingItem & Record<string, unknown>) | undefined;
  const settings = (change: Partial<CodeSettings> = {}) => w.db.set({
    ...codeSettingsKey(orgId, "web"), entityType: "CODE_SETTINGS", allowSelfApproval: options.allowSelfApproval ?? false, mergeMethod: options.mergeMethod ?? "squash", codeReviewers: [], revision: 1, ...change,
  });
  if (options.allowSelfApproval !== undefined || options.mergeMethod !== undefined) settings();

  const codeHost = options.codeHost ?? githubHostOver(github);
  const host: CodeMergeHost = {
    // Every repository of the project is on the one code host of the world; team membership is outside the port (GitHub's only).
    repository: async (_project, _revision, repositoryId) => {
      const url = `https://github.com/acme/${repositoryId}`;
      return { url, codeHost, isTeamMember: async (team, login) => github.isTeamMember(url, team, login) };
    },
    scope: (id) => ({ orgId: id }),
    loadTask: async (id) => w.db.get(taskKey(id)) as never,
    repositoryUrl: async (_project, _revision, repositoryId) => `https://github.com/acme/${repositoryId}`,
    recordedBase: async () => "main",
  };
  const store = new AgentStore({ documentClient: w.db, tableName: "state", now });
  const shareDeps: SessionShareDependencies = { documentClient: w.db, tableName: "state", now, projectMembers: w.members, signInStore: w.signInStore };
  const decideStore = new DecideStore({ documentClient: w.db, tableName: "signin", now });
  const deps = {
    modelSignInTableName:"state",store, projectMembers: w.members, documentClient: w.db, tableName: "state", signInStore: w.signInStore, now, confirmOrigin: CELL, log: () => undefined,
    agentSessions: shareDeps, codeMerge: host,
  } as unknown as ApprovalDependencies;
  const kind = approvalDecideKind(deps);
  const context = (kinds: DecideKinds = { apr: kind }): DecideRequestContext => ({
    store: decideStore, now, cellOrigin: CELL, kinds,
    authenticateBearer: async (authorization) => {
      const found = new Map<string, { developerId: string; orgId: OrgId }>([["Bearer priya", { developerId: PRIYA, orgId: ORG_A }], ["Bearer ola", { developerId: OLA, orgId: ORG_A }], ["Bearer max", { developerId: MAX, orgId: ORG_A }]]).get(authorization);
      if (found === undefined) throw agentXError("AUTH_REQUIRED", "a valid sign-in is required");
      return found;
    },
  });
  const audit = capturingAuditDeps({ db: w.db, now });
  (deps as { audit?: unknown }).audit = audit.audit;
  deps.mintConfirmUrl = (who, approvalId) => mintConfirmUrl(context(), { developerId: who.developerId, orgId: who.orgId }, approvalId);
  registerAgentApprovals();
  registerMergeApprovals();
  registerCodeSettingsApprovals();

  let counter = 0;
  const browser = async (developerId: string, approvalId: string, agoSeconds = 30) => {
    counter += 1;
    const cookie = `cookie-${String(counter)}-${"x".repeat(40)}`;
    const signedInAt = Math.floor(w.clock.now / 1000) - agoSeconds;
    await decideStore.putSession(cookie, { orgId: ORG_A, developerId, approvalId, signedInAt, method: "email_code", csrfHash: sha256(csrfTokenFor(cookie)), expiresAt: signedInAt + 3600 });
    return cookie;
  };
  const decide = (approvalId: string, cookie: string, decision: "approve" | "decline" = "approve") => routeDecidePage(context(), {
    method: "POST", path: `/v1/app/approve/${approvalId}`, requestId: "r",
    headers: { cookie: `${DECIDE_COOKIE}=${cookie}`, origin: CELL, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ decision, csrf: csrfTokenFor(cookie) }).toString(),
  }, new URL(`${CELL}/v1/app/approve/${approvalId}`));
  const approvalIdOf = (url: string) => new URL(url).pathname.split("/").pop()!;
  const approvalOf = async (url: string) => (await getAnyApproval(deps, ORG_A, approvalIdOf(url)))!;
  const requestId = () => randomUUID();
  return {
    ...w, sessionId, taskId, orgId, github, host, deps, kind, context, browser, decide, approvalOf, approvalIdOf, requestId, audited: () => audit.recorded(), prs, seedTracking, trackingOf, trackingItem, settings, linkAll,
    setWorkflow, setPullRequests, store, shareDeps, decideStore, audit,
  };
}
