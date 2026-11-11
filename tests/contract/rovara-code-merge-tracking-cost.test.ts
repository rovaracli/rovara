// Rovara Code (Plan 6 Task 14, review C1): the real App provider, a fetch that COUNTS every request (installation lookups and token mints included, as the sweep's
// budget does), and a whole tracking pass over a draft pull request that five people reviewed. The pass must finish inside its allowance, mark the draft ready and
// decide the approval, on the first pass and without a retry.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";
import { reconcileTrackingTask, trackingRequestCap } from "../../packages/broker/src/rovara-code/merge-tracking.js";
import { codeSettingsKey, mergeTrackingKey } from "@rovara-code/contracts";
import { HEAD_A, NOW, TASK_ID, world } from "../support/rovara-code-tracking.js";
import { TEST_ORG } from "../support/orgs.js";

interface Counting {
  provider: GitHubAppCredentialProvider;
  fetched: string[];
  mints: number;
  state: { draft: boolean; requested: number };
  budget: { signal: AbortSignal; beforeRequest(): void; used(): number };
}

function counting(options: { reviewers: number; permission?: (login: string) => number; checksToken?: number } = { reviewers: 5 }): Counting {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const state = { draft: true, requested: 0 };
  const fetched: string[] = [];
  const counts = { mints: 0 };
  const reviews = Array.from({ length: options.reviewers }, (_, index) => ({
    user: { id: 100 + index, login: `person${String(index)}`, type: "User" }, state: "APPROVED", commit_id: HEAD_A, submitted_at: `2026-10-25T0${String(index % 9)}:00:00Z`,
  }));
  const fetchImplementation = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    fetched.push(`${method} ${url}`);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    if (url.endsWith("/installation")) return Response.json({ id: 77, account: { login: "acme" } });
    if (url.endsWith("/access_tokens")) {
      counts.mints += 1;
      if (options.checksToken !== undefined && JSON.stringify(body).includes('"checks"')) return new Response("{}", { status: options.checksToken });
      return Response.json({ token: `token-${String(counts.mints)}` }, { status: 201 });
    }
    if (url === "https://api.github.com/graphql") {
      const query = (body as { query: string }).query;
      if (query.includes("markPullRequestReadyForReview")) { state.draft = false; return Response.json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }); }
      return Response.json({ data: { repository: { nameWithOwner: "acme/payments", pullRequest: { number: 7, headRefOid: HEAD_A, commits: { nodes: [{ commit: { oid: HEAD_A, statusCheckRollup: {
        state: "SUCCESS", contexts: { nodes: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://example.test/1", databaseId: 5, isRequired: false }], pageInfo: { hasNextPage: false, endCursor: null } } } } }] } } } } });
    }
    if (/\/pulls\/7$/.test(url)) return Response.json({
      number: 7, html_url: "https://github.com/acme/payments/pull/7", node_id: "PR_7", state: "open", merged: false, draft: state.draft, merge_commit_sha: null, mergeable_state: "clean", mergeable: true,
      requested_reviewers: Array.from({ length: state.requested }), requested_teams: [], head: { ref: "agentx/op", sha: HEAD_A, repo: { full_name: "acme/payments" } },
      base: { ref: "main", repo: { full_name: "acme/payments" } }, title: "T", body: "B",
    });
    if (/\/pulls\/7\/reviews/.test(url)) return Response.json(reviews);
    if (/\/contents\/\.github\/workflows/.test(url)) return Response.json([{ name: "ci.yml" }]);
    if (/\/rules\/branches\/main$/.test(url)) return Response.json([]);
    if (/\/branches\/main$/.test(url)) return Response.json({ name: "main", protected: false });
    if (/\/compare\//.test(url)) return Response.json({ behind_by: 0 });
    const permission = /\/collaborators\/([^/]+)\/permission$/.exec(url);
    if (permission !== null) return Response.json({ permission: "write", role_name: "write" });
    if (/\/requested_reviewers$/.test(url)) { state.requested = 1; return Response.json({}, { status: 201 }); }
    return new Response("{}", { status: 404 });
  };
  const provider = new GitHubAppCredentialProvider({
    credentialRef: "github", appId: "5002502", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(), fetchImplementation, now: () => NOW,
  });
  let used = 0;
  const budget = { signal: new AbortController().signal, beforeRequest: () => { used += 1; }, used: () => used };
  return { provider, fetched, get mints() { return counts.mints; }, state, budget };
}

function setup(github: Counting) {
  const w = world({ deps: { github: github.provider } });
  w.db.set({ ...codeSettingsKey(TEST_ORG, "web"), allowSelfApproval: false, mergeMethod: "squash", codeReviewers: ["alice"], revision: 1 });
  return w;
}

describe("a tracking pass over a draft that five people reviewed (the real provider, every request counted)", () => {
  it("finishes inside its allowance on the first pass, marks the draft ready, asks for the reviewers and decides the approval", async () => {
    const github = counting({ reviewers: 5 });
    const w = setup(github);
    const result = await reconcileTrackingTask({ ...w.deps, observeMerge: async () => ({ kind: "OBSERVED" }) }, TASK_ID, github.budget);
    expect(result.kind).toBe("OBSERVED");
    expect(github.state.draft).toBe(false);
    expect(w.db.get(mergeTrackingKey(TASK_ID, "payments", 7))).toMatchObject({
      draft: false, ci: "passing", review: "approved", approval: { githubUserId: String(104), login: "person4" }, version: 1,
    });
    expect(w.db.get(mergeTrackingKey(TASK_ID, "payments", 7))?.readyAt).toBeDefined();
    expect(w.db.get(mergeTrackingKey(TASK_ID, "payments", 7))?.reviewersRequestedAt).toBeDefined();
    // The count the sweep's budget saw is every request the fetch got.
    expect(github.budget.used()).toBe(github.fetched.length);
    expect(github.budget.used()).toBeLessThanOrEqual(trackingRequestCap(1));
    // Three kinds of token, each minted once, and one installation lookup.
    expect(github.mints).toBe(3);
    // The rulesets are read too: one more request in the status read.
    expect(github.fetched.filter((request) => /\/rules\/branches\/main$/.test(request))).toHaveLength(1);
    expect(github.fetched.filter((request) => request.endsWith("/installation"))).toHaveLength(1);
  });

  it("makes no further write request on the next pass", async () => {
    const github = counting({ reviewers: 5 });
    const w = setup(github);
    const deps = { ...w.deps, observeMerge: async () => ({ kind: "OBSERVED" as const }) };
    await reconcileTrackingTask(deps, TASK_ID, github.budget);
    github.fetched.length = 0;
    await reconcileTrackingTask(deps, TASK_ID, { signal: new AbortController().signal, beforeRequest: () => undefined });
    expect(github.fetched.filter((request) => !request.startsWith("GET ") && !request.endsWith("/access_tokens") && !request.endsWith("/graphql"))).toEqual([]);
    expect(github.fetched.some((request) => /requested_reviewers|markPullRequestReady/.test(request))).toBe(false);
  });

  it("fits eight reviewers (the most it looks up) in the allowance, and a ninth reviewer reads as not trusted rather than costing more", async () => {
    const eight = counting({ reviewers: 8 });
    const w8 = setup(eight);
    const result = await reconcileTrackingTask({ ...w8.deps, observeMerge: async () => ({ kind: "OBSERVED" }) }, TASK_ID, eight.budget);
    expect(result.kind).toBe("OBSERVED");
    expect(eight.budget.used()).toBeLessThanOrEqual(trackingRequestCap(1));
    expect(w8.db.get(mergeTrackingKey(TASK_ID, "payments", 7))).toMatchObject({ review: "approved" });
    const nine = counting({ reviewers: 9 });
    const w9 = setup(nine);
    await reconcileTrackingTask({ ...w9.deps, observeMerge: async () => ({ kind: "OBSERVED" }) }, TASK_ID, nine.budget);
    expect(w9.db.get(mergeTrackingKey(TASK_ID, "payments", 7))).toMatchObject({ review: "requested", draft: false });
    expect(nine.fetched.some((request) => request.includes("/collaborators/"))).toBe(false);
  });

  it("reads and decides everything but the checks for an installation that has not accepted the checks and statuses permissions: never passing, never ready, merge observation still run", async () => {
    const github = counting({ reviewers: 2, checksToken: 422 });
    const w = setup(github);
    let observed = 0;
    const result = await reconcileTrackingTask({ ...w.deps, observeMerge: async () => { observed += 1; return { kind: "OBSERVED" as const }; } }, TASK_ID, github.budget);
    expect(result.kind).toBe("OBSERVED");
    expect(observed).toBe(1);
    expect(w.db.get(mergeTrackingKey(TASK_ID, "payments", 7))).toMatchObject({ ci: "pending", draft: true, review: "approved" });
    expect(w.db.get(mergeTrackingKey(TASK_ID, "payments", 7))?.readyAt).toBeUndefined();
    expect(github.state.draft).toBe(true);
  });
});
