// Review groups (owner decision 9): the routes through the real dispatcher (`routeDeveloperRequest`): writes are browser-only and refused before the token is even checked; the
// Auditor reaches none of them; the browser's route list carries the exact task shapes; the wiring asks the code host through the project's own port for the claimer's login.
// And the rule the whole feature rests on: a claim never grants approval (the merge reads nothing of it; code-host eligibility and CODEOWNERS still decide).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { developerOrgKey, editionPolicy, orgMemberKey, orgMetaKey, REVIEW_GROUP_MESSAGES, MERGE_NOT_READY_MESSAGES as M, type OrgRole } from "@agentx/cloud-contracts";
import { AgentXError, type OrgId } from "@rovara-code/contracts";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { webRouteAllowed } from "../../packages/broker/src/aws/web-auth.js";
import { requireAuditorRoute, AUDITOR_REFUSED } from "../../packages/broker/src/org/auditor.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { realTaskOwners, reviewClaimDepsOf } from "../../packages/broker/src/review-groups/routes.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { humanApprovalOf } from "../../packages/broker/src/rovara-code/approval.js";
import { mergeReadiness } from "../../packages/broker/src/rovara-code/merge.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const org = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId, actor = "a".repeat(64), sessionId = "11111111-1111-4111-8111-111111111111";
const TASK = "33333333-3333-4333-8333-333333333333";
const REPO = resolve(import.meta.dirname, "..", "..");

afterEach(() => vi.restoreAllMocks());

function fixture(role: OrgRole) {
  const db = new FakeDynamoDb(), audit = capturingAuditDeps({ db, now: () => Date.parse("2026-11-11T12:00:00Z") });
  db.set({ ...orgMemberKey(org, actor), orgId: org, developerId: actor, role, joinedAt: "2026-10-01T00:00:00Z" });
  db.set({ ...developerOrgKey(actor), orgId: org, developerId: actor, role });
  db.set({ pk: `DEVELOPER#${actor}`, sk: "META", developerId: actor, displayName: "Priya", provider: "oidc" });
  db.set({ pk: `SESSION#${sessionId}`, sk: "META", developerId: actor, amr: "oidc", endsAt: Math.floor(audit.audit.now() / 1000) + 3600, reviewExpiresAt: Math.floor(audit.audit.now() / 1000) + 3600, startedAt: "2026-11-11T11:00:00Z" });
  db.set({ ...orgMetaKey(org), orgId: org, name: "Acme", plan: "team" });
  const claims = { iss: "https://cell.example/v1/auth", aud: "agentx-developer", sub: actor, sid: sessionId, amr: "oidc", env: "test", org, org_role: role };
  const verifyAccessToken = vi.fn(async () => claims);
  const deps: DeveloperRouteDependencies = {
    tableName: "state", now: audit.audit.now, documentClient: db, audit: { ...audit.audit, tableName: "state" }, editionPolicy: editionPolicy("enterprise"),
    developer: { issuer: "https://cell.example/v1/auth", env: "test", methods: { slack: false, oidc: true, cloud: false }, signInTableName: "state", verifyAccessToken, channelMembers: async () => ({ ok: true, memberOf: [] }) },
    orgs: new OrgStore({ documentClient: db, tableName: "state", now: audit.audit.now }),
    tasks: {} as never,
  };
  const caller: DeveloperCaller = { orgId: org, developerId: actor, orgRole: role, name: "Priya", amr: "oidc", sessionId: "fixture" };
  async function call(method: string, path: string, body?: unknown, token = false) {
    const request = { method, path, headers: {}, body: body === undefined ? "" : JSON.stringify(body), requestId: "test" };
    try { return { result: await routeDeveloperRequest(deps, request, new URL(path, "https://cell.example"), token ? undefined : { caller: { ...caller, browserSession: true }, csrf: "csrf" }) }; }
    catch (error) { if (!(error instanceof AgentXError)) throw error; return { code: error.code, message: error.message }; }
  }
  return { db, deps, caller, call, verifyAccessToken };
}

describe("through the route dispatcher", () => {
  it("refuses a token's write (groups, claim, release, reassign) before the token is checked, and writes nothing", async () => {
    const f = fixture("owner");
    const writes = f.db.transactions().length;
    for (const [method, path] of [["PUT", "/v1/app/projects/web/review-groups"], ...["claim", "release", "reassign"].map((action) => ["POST", `/v1/app/tasks/${TASK}/review/${action}`])] as const) {
      expect(await f.call(method, path, { requestId: "x" }, true), path).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining(REVIEW_GROUP_MESSAGES.browserOnly) as unknown });
    }
    expect(f.verifyAccessToken).not.toHaveBeenCalled();
    expect(f.db.transactions().length).toBe(writes);
  });

  it("serves a browser session: an owner (a maintainer of every project) is told a project it can't find is not found, the same as any missing project", async () => {
    const f = fixture("owner");
    expect(await f.call("GET", "/v1/app/projects/web/review-groups")).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(await f.call("PUT", "/v1/app/projects/web/review-groups", { requestId: "22222222-2222-4222-8222-222222222222", expectedRevision: 0, groups: [] })).toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });
});

describe("the Auditor and the browser's route list", () => {
  it("the Auditor reaches none of the review group routes", () => {
    for (const [method, path] of [["GET", "/v1/app/projects/web/review-groups"], ["PUT", "/v1/app/projects/web/review-groups"], ["GET", `/v1/app/tasks/${TASK}/review`], ["POST", `/v1/app/tasks/${TASK}/review/claim`]] as const) {
      expect(() => requireAuditorRoute({ orgRole: "auditor" }, method, path), path).toThrow(AUDITOR_REFUSED);
    }
  });

  it("lets the browser reach the exact task shapes, and nothing near them", () => {
    expect(webRouteAllowed("GET", `/v1/web/tasks/${TASK}/review`)).toBe(true);
    for (const action of ["claim", "release", "reassign"]) {
      expect(webRouteAllowed("POST", `/v1/web/tasks/${TASK}/review/${action}`), action).toBe(true);
      expect(webRouteAllowed("GET", `/v1/web/tasks/${TASK}/review/${action}`), action).toBe(false);
    }
    for (const path of [`tasks/${TASK}/review/approve`, `tasks/${TASK}/review/claim/x`, `tasks/not-a-task/review`]) expect(webRouteAllowed("POST", `/v1/web/${path}`), path).toBe(false);
    expect(webRouteAllowed("PUT", "/v1/web/projects/web/review-groups")).toBe(true);
    expect(webRouteAllowed("GET", "/v1/web/projects/web/review-groups")).toBe(true);
  });
});

describe("the wiring asks the code host through the project's own port", () => {
  it("resolves the repository as the task's project pins it and requests exactly the claimer's login, once, with the company's scope", async () => {
    const f = fixture("member");
    const requestReviewers = vi.fn(async () => "requested" as const);
    const repository = vi.fn(async () => ({ url: "https://github.com/acme/web", codeHost: { requestReviewers } }));
    const scope = vi.fn(() => ({ orgId: org }));
    const deps = reviewClaimDepsOf({ ...f.deps, agents: { codeMerge: { repository, scope } } } as unknown as DeveloperRouteDependencies, f.caller);
    const task = { taskId: TASK, orgId: org, project: "web", startingRevision: 4 };
    expect(await deps.requestReviewer(task, { repositoryId: "repo_web", number: 12 }, "alice-gh")).toBe("requested");
    expect(repository).toHaveBeenCalledWith("web", 4, "repo_web", org);
    expect(requestReviewers).toHaveBeenCalledTimes(1);
    expect(requestReviewers).toHaveBeenCalledWith({ repository: { url: "https://github.com/acme/web" }, id: "12", url: "" }, ["alice-gh"], { orgId: org });
  });

  it("answers `unavailable` (never a request) when the install has no code host, the repository is not the project's, or the host can't ask", async () => {
    const f = fixture("member");
    const task = { taskId: TASK, orgId: org, project: "web", startingRevision: 4 };
    expect(await reviewClaimDepsOf(f.deps, f.caller).requestReviewer(task, { repositoryId: "r", number: 1 }, "a")).toBe("unavailable");
    const none = reviewClaimDepsOf({ ...f.deps, agents: { codeMerge: { repository: async () => undefined, scope: () => ({}) } } } as unknown as DeveloperRouteDependencies, f.caller);
    expect(await none.requestReviewer(task, { repositoryId: "r", number: 1 }, "a")).toBe("unavailable");
    const cannot = reviewClaimDepsOf({ ...f.deps, agents: { codeMerge: { repository: async () => ({ url: "https://github.com/acme/web", codeHost: {} }), scope: () => ({}) } } } as unknown as DeveloperRouteDependencies, f.caller);
    expect(await cannot.requestReviewer(task, { repositoryId: "r", number: 1 }, "a")).toBe("unavailable");
  });

  it("reads another person's live project role only for a writer company role: the Auditor and a non-member have none", async () => {
    const f = fixture("owner");
    f.db.set({ ...orgMemberKey(org, "b".repeat(64)), orgId: org, developerId: "b".repeat(64), role: "auditor" });
    // Even where the project-role reader would hand out a role, the company role decides first.
    const generous = { roleOf: async () => "contributor" as const, list: async () => [], projectsOf: async () => [] };
    const deps = reviewClaimDepsOf({ ...f.deps, projectMembers: generous }, f.caller);
    f.db.set({ ...orgMemberKey(org, "d".repeat(64)), orgId: org, developerId: "d".repeat(64), role: "member" });
    expect(await deps.liveProjectRole(org, "web", "d".repeat(64))).toBe("contributor");
    expect(await deps.liveProjectRole(org, "web", "b".repeat(64))).toBeUndefined();
    expect(await deps.liveProjectRole(org, "web", "c".repeat(64))).toBeUndefined();
  });
});

describe("the task's real owners, whoever asks", () => {
  const creator = "1".repeat(64), taker = "2".repeat(64), coOwner = "3".repeat(64), commenter = "4".repeat(64);
  const record = (over: Record<string, unknown> = {}) => ({ taskId: TASK, developerId: creator, developerName: "Cara", ...over }) as unknown as DeveloperTaskRecord;
  it("are the effective owner and every owner entry of the People list, never a commenter", () => {
    expect(realTaskOwners(record(), { people: [{ developerId: coOwner, role: "owner" }, { developerId: commenter, role: "commenter" }] })).toEqual([creator, coOwner]);
    expect(realTaskOwners(record(), undefined)).toEqual([creator]);
  });
  it("name the taker of a task taken over", () => {
    const taken = record({ currentOwner: { developerId: taker, name: "Tom", provider: "oidc", since: "2026-11-11T00:00:00Z" } });
    expect(realTaskOwners(taken, undefined)[0]).toBe(taker);
  });
  it("throw when the owner can't be read (the wiring answers `unknown` and the routes fail closed)", () => {
    expect(() => realTaskOwners(record({ currentOwner: { developerId: taker } }), undefined)).toThrow();
  });
});

describe("a claim never grants approval", () => {
  const head = "1".repeat(40);
  const pr = { repositoryId: "repo_web", number: 7, headSha: head, state: "open" as const, draft: false, baseBranch: "main", ci: "passing" as const, branch: "up_to_date" as const, behindRequired: false };
  const workflow = { stage: "WAIT_FOR_MERGE", state: "WAITING" };
  const base = { pullRequests: [pr], workflow, recordedBases: new Map([["repo_web#7", "main"]]), presser: { githubUserId: "500" }, allowSelfApproval: false, requesterName: "Owen" };
  const review = (state: "APPROVED" | "COMMENTED") => ({ reviewer: { login: "alice-gh", hostUserId: "101" }, login: "alice-gh", githubUserId: "101", state, commitId: head, submittedAt: "2026-11-11T12:00:00Z", userType: "User" });

  it("a claimer listed as the requested reviewer who has not approved counts as no approval, and the merge is refused", () => {
    const approval = humanApprovalOf({ reviews: [], headSha: head, ciPassingOnHead: true, permissions: new Map([["alice-gh", "write"]]), requesterGithubUserIds: ["900"], linkedGithubUserIds: new Set(["101"]), allowSelfApproval: false } as never);
    expect(approval).toEqual({ approved: false, reason: "none" });
    expect(mergeReadiness({ ...base, approvals: new Map([["repo_web#7", approval]]) })).toEqual({ ready: false, message: M.needsOtherApproval("Owen") });
  });

  it("a claimer without write access who approves on the host still doesn't count", () => {
    const approval = humanApprovalOf({ reviews: [review("APPROVED")], headSha: head, ciPassingOnHead: true, permissions: new Map([["alice-gh", "read"]]), requesterGithubUserIds: ["900"], linkedGithubUserIds: new Set(["101"]), allowSelfApproval: false } as never);
    expect(approval).toEqual({ approved: false, reason: "no_write" });
  });

  it("a claimer's counted approval still needs a CODEOWNER where the file covers the change: the panel says so", () => {
    const approval = humanApprovalOf({ reviews: [review("APPROVED")], headSha: head, ciPassingOnHead: true, permissions: new Map([["alice-gh", "write"]]), requesterGithubUserIds: ["900"], linkedGithubUserIds: new Set(["101"]), allowSelfApproval: false } as never);
    expect(approval.approved).toBe(true);
    const verdict = { ok: false as const, owners: "@acme/payments" };
    expect(mergeReadiness({ ...base, approvals: new Map([["repo_web#7", approval]]), codeOwners: new Map([["repo_web#7", verdict]]) })).toEqual({ ready: false, message: M.needsCodeOwner("@acme/payments") });
  });

  it("nothing that decides approval or merge reads the claim: no import of review-groups, no claim key, in the merge and approval modules", () => {
    for (const file of ["merge.ts", "approval.ts", "code-owners.ts", "merge-tracking.ts", "nudges.ts"]) {
      const source = readFileSync(resolve(REPO, "packages/broker/src/rovara-code", file), "utf8");
      expect(source, file).not.toMatch(/review-groups|reviewClaimKey|REVIEW_CLAIM/u);
    }
  });
});
