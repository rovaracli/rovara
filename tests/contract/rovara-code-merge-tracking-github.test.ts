// Rovara Code (Plan 6 Task 14): the GitHub reads and writes merge tracking uses, through the App's provider with a fake HTTP layer.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubAppCredentialProvider, GithubMergeRateLimitError } from "../../packages/broker/src/github-app.js";

const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const HEAD = "a".repeat(40);
const REPO = "https://github.com/acme/payments.git";
const SCOPE = { system: "private-install" } as const;

interface Fixture {
  pull?: Record<string, unknown>;
  reviews?: unknown[];
  rollup?: unknown[];
  rollupPages?: unknown[][];
  workflowFiles?: unknown;
  branch?: Record<string, unknown>;
  compare?: Record<string, unknown>;
  permission?: { status: number; body: Record<string, unknown> };
  graphqlStatus?: number;
  graphqlBody?: (query: string, variables: Record<string, unknown>) => Record<string, unknown> | undefined;
  tokenStatus?: number;
}

function pull(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42, html_url: "https://github.com/acme/payments/pull/42", node_id: "PR_node_42", state: "open", merged: false, draft: false, merge_commit_sha: null,
    mergeable_state: "clean", mergeable: true, requested_reviewers: [], requested_teams: [],
    head: { ref: "agentx/op", sha: HEAD, repo: { full_name: "acme/payments" } }, base: { ref: "main", repo: { full_name: "acme/payments" } },
    title: "Title", body: "Body", ...extra,
  };
}

function rollupNode(extra: Record<string, unknown>): Record<string, unknown> {
  return { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/acme/payments/actions/runs/1/job/77", databaseId: 77, isRequired: false, ...extra };
}

function harness(fixture: Fixture = {}, options: { beforeRequest?: () => void } = {}) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const requests: Array<{ method: string; url: string; body?: unknown; token?: string }> = [];
  const tokenRequests: unknown[] = [];
  const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
    requests.push({ method, url, ...(body === undefined ? {} : { body }), ...(authorization === undefined ? {} : { token: authorization.replace("Bearer ", "") }) });
    if (url.endsWith("/installation")) return Response.json({ id: 163046162, account: { login: "acme" } });
    if (url.endsWith("/access_tokens")) {
      tokenRequests.push(body);
      return fixture.tokenStatus === undefined ? Response.json({ token: `token-${String(tokenRequests.length)}` }, { status: 201 }) : new Response("{}", { status: fixture.tokenStatus });
    }
    if (url === "https://api.github.com/graphql") {
      const query = (body as { query: string }).query;
      const variables = (body as { variables: Record<string, unknown> }).variables;
      if (fixture.graphqlStatus !== undefined) return new Response("{}", { status: fixture.graphqlStatus });
      const custom = fixture.graphqlBody?.(query, variables);
      if (custom !== undefined) return Response.json(custom);
      if (query.includes("markPullRequestReadyForReview")) return Response.json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
      const pages = fixture.rollupPages ?? [fixture.rollup ?? []];
      const cursor = variables.cursor;
      const index = typeof cursor === "string" ? Number(cursor.replace("c", "")) : 0;
      return Response.json({ data: { repository: { nameWithOwner: "acme/payments", pullRequest: { number: 42, headRefOid: HEAD, commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: {
        state: "SUCCESS", contexts: { nodes: pages[index] ?? [], pageInfo: { hasNextPage: index + 1 < pages.length, endCursor: `c${String(index + 1)}` } } } } }] } } } } });
    }
    if (/\/pulls\/42$/.test(url)) return Response.json(fixture.pull ?? pull());
    if (/\/pulls\/42\/reviews/.test(url)) return Response.json(fixture.reviews ?? []);
    if (/\/contents\/\.github\/workflows/.test(url)) return fixture.workflowFiles === undefined ? new Response("{}", { status: 404 }) : Response.json(fixture.workflowFiles);
    if (/\/branches\/main$/.test(url)) return Response.json(fixture.branch ?? { name: "main", protected: false });
    if (/\/compare\//.test(url)) return Response.json(fixture.compare ?? { behind_by: 0, ahead_by: 1 });
    if (/\/collaborators\/[^/]+\/permission$/.test(url)) return new Response(JSON.stringify(fixture.permission?.body ?? { permission: "write" }), { status: fixture.permission?.status ?? 200 });
    if (/\/requested_reviewers$/.test(url)) return Response.json({}, { status: 201 });
    return new Response("{}", { status: 404 });
  });
  const provider = new GitHubAppCredentialProvider({
    credentialRef: "github", appId: "5002502", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(), fetchImplementation, now: () => NOW,
  });
  let count = 0;
  const controller = new AbortController();
  const budget = { signal: controller.signal, beforeRequest: options.beforeRequest ?? (() => { count += 1; }) };
  return { provider, requests, tokenRequests, budget, count: () => count };
}

describe("reading a pull request's status", () => {
  it("reads state, head, base, checks with their required flag, reviews and whether the head holds workflow files", async () => {
    const h = harness({
      pull: pull({ draft: true, mergeable_state: "blocked", requested_reviewers: [{ id: 1 }], requested_teams: [{ id: 2 }] }),
      rollup: [
        rollupNode({ name: "build", isRequired: true }),
        rollupNode({ name: "lint", status: "IN_PROGRESS", conclusion: null, databaseId: 78 }),
        { __typename: "StatusContext", context: "ci/external", state: "FAILURE", targetUrl: "https://ci.example.test/run/9", isRequired: false },
      ],
      reviews: [
        { user: { id: 501, login: "reviewer", type: "User" }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-10-25T11:00:00Z" },
        { user: { id: 502, login: "drafting", type: "User" }, state: "PENDING", commit_id: HEAD },
        { user: null, state: "COMMENTED", commit_id: HEAD, submitted_at: "2026-10-25T11:00:00Z" },
      ],
      workflowFiles: [{ name: "ci.yml", type: "file" }, { name: "README.md", type: "file" }],
      branch: { name: "main", protected: true, protection: { enabled: true, required_status_checks: { contexts: [], checks: [{ context: "build" }] } } },
      compare: { behind_by: 3 },
    });
    const status = await h.provider.getPullRequestStatus(REPO, 42, SCOPE, h.budget);
    expect(status).toEqual({
      number: 42, state: "open", draft: true, headSha: HEAD, baseBranch: "main", mergeableState: "blocked", mergeable: true, behindBy: 3,
      checks: [
        { name: "build", status: "completed", conclusion: "success", required: true, url: "https://github.com/acme/payments/actions/runs/1/job/77", jobId: "77" },
        { name: "lint", status: "pending", required: false, url: "https://github.com/acme/payments/actions/runs/1/job/77", jobId: "78" },
        { name: "ci/external", status: "completed", conclusion: "failure", required: false, url: "https://ci.example.test/run/9" },
      ],
      baseHasRequiredChecks: true, headHasWorkflowFiles: true, requestedReviewers: 2,
      reviews: [{ githubUserId: "501", login: "reviewer", userType: "User", state: "APPROVED", commitId: HEAD, submittedAt: "2026-10-25T11:00:00.000Z" }],
    });
  });

  it("asks only for read permissions and counts every request against the budget", async () => {
    const h = harness();
    await h.provider.getPullRequestStatus(REPO, 42, SCOPE, h.budget);
    expect(h.tokenRequests).toEqual([{ repositories: ["payments"], permissions: { contents: "read", pull_requests: "read", checks: "read", statuses: "read" } }]);
    expect(h.count()).toBe(h.requests.length);
    expect(h.requests.every((request) => request.method === "GET" || request.url.endsWith("/access_tokens") || request.url.endsWith("/graphql"))).toBe(true);
    const graphql = h.requests.find((request) => request.url.endsWith("/graphql"));
    expect((graphql?.body as { query: string }).query).not.toMatch(/mutation/);
  });

  it("pages the check list and refuses more than five pages", async () => {
    const page = (name: string) => [rollupNode({ name })];
    const two = harness({ rollupPages: [page("a"), page("b")] });
    expect((await two.provider.getPullRequestStatus(REPO, 42, SCOPE, two.budget)).checks.map((check) => check.name)).toEqual(["a", "b"]);
    const many = harness({ rollupPages: Array.from({ length: 6 }, (_, index) => page(`c${String(index)}`)) });
    await expect(many.provider.getPullRequestStatus(REPO, 42, SCOPE, many.budget)).rejects.toThrow(/too many checks/i);
  });

  it("works out whether the branch is behind only when GitHub's own state does not say", async () => {
    const dirty = harness({ pull: pull({ mergeable_state: "dirty" }) });
    expect((await dirty.provider.getPullRequestStatus(REPO, 42, SCOPE, dirty.budget)).behindBy).toBeUndefined();
    expect(dirty.requests.some((request) => request.url.includes("/compare/"))).toBe(false);
    const clean = harness({ compare: { behind_by: 0 } });
    expect((await clean.provider.getPullRequestStatus(REPO, 42, SCOPE, clean.budget)).behindBy).toBe(0);
    expect(clean.requests.some((request) => request.url.includes("/compare/main...") && request.url.endsWith(HEAD))).toBe(true);
  });

  it("reads a required check that has not reported as no required checks seen, and a ruleset-less unprotected base as none", async () => {
    const none = harness();
    expect((await none.provider.getPullRequestStatus(REPO, 42, SCOPE, none.budget)).baseHasRequiredChecks).toBe(false);
    const required = harness({ rollup: [rollupNode({ isRequired: true })] });
    expect((await required.provider.getPullRequestStatus(REPO, 42, SCOPE, required.budget)).baseHasRequiredChecks).toBe(true);
    const legacy = harness({ branch: { name: "main", protected: true, protection: { enabled: true, required_status_checks: { contexts: ["build"], checks: [] } } } });
    expect((await legacy.provider.getPullRequestStatus(REPO, 42, SCOPE, legacy.budget)).baseHasRequiredChecks).toBe(true);
  });

  it("refuses answers that do not fit instead of reading them as fine", async () => {
    for (const bad of [
      { rollup: [{ __typename: "Mystery" }] },
      { rollup: [rollupNode({ conclusion: "SHRUGGED" })] },
      { reviews: [{ user: { id: "x", login: "a", type: "User" }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-10-25T11:00:00Z" }] },
      { reviews: [{ user: { id: 1, login: "a", type: "User" }, state: "APPROVED", commit_id: "short", submitted_at: "2026-10-25T11:00:00Z" }] },
      { pull: pull({ number: 7 }) },
      { graphqlBody: () => ({ errors: [{ message: "denied" }] }) },
    ] as Fixture[]) {
      const h = harness(bad);
      await expect(h.provider.getPullRequestStatus(REPO, 42, SCOPE, h.budget)).rejects.toThrow();
    }
  });

  it("reads an unknown mergeable state as unknown and a missing workflow directory as no workflow files", async () => {
    const h = harness({ pull: pull({ mergeable_state: null, mergeable: null }) });
    const status = await h.provider.getPullRequestStatus(REPO, 42, SCOPE, h.budget);
    expect(status.mergeableState).toBe("unknown");
    expect(status).not.toHaveProperty("mergeable");
    expect(status.headHasWorkflowFiles).toBe(false);
  });

  it("stops at the budget and turns GitHub's rate limit into the shared rate-limit error", async () => {
    let allowed = 3;
    const limited = harness({}, { beforeRequest: () => { if (allowed-- <= 0) throw new Error("budget"); } });
    await expect(limited.provider.getPullRequestStatus(REPO, 42, SCOPE, limited.budget)).rejects.toThrow(/budget/);
    expect(limited.requests.length).toBeLessThanOrEqual(3);
    const rate = harness({ graphqlStatus: 429 });
    await expect(rate.provider.getPullRequestStatus(REPO, 42, SCOPE, rate.budget)).rejects.toBeInstanceOf(GithubMergeRateLimitError);
  });

  it("reads it again without a budget as a plain read (no counting)", async () => {
    const h = harness();
    await expect(h.provider.getPullRequestStatus(REPO, 42, SCOPE)).resolves.toMatchObject({ number: 42 });
    expect(h.count()).toBe(0);
  });
});

describe("a person's permission on the repository", () => {
  it.each([
    [{ permission: "admin" }, "admin"],
    [{ permission: "write", role_name: "write" }, "write"],
    [{ permission: "write", role_name: "maintain" }, "write"],
    [{ permission: "read", role_name: "triage" }, "read"],
    [{ permission: "none" }, "none"],
  ] as const)("reads %j as %s", async (body, expected) => {
    const h = harness({ permission: { status: 200, body } });
    await expect(h.provider.getRepositoryPermission(REPO, "reviewer", SCOPE, h.budget)).resolves.toBe(expected);
  });

  it("reads a 404 as none, refuses another failure, and refuses a login that is not one", async () => {
    const missing = harness({ permission: { status: 404, body: {} } });
    await expect(missing.provider.getRepositoryPermission(REPO, "ghost", SCOPE, missing.budget)).resolves.toBe("none");
    const broken = harness({ permission: { status: 500, body: {} } });
    await expect(broken.provider.getRepositoryPermission(REPO, "reviewer", SCOPE, broken.budget)).rejects.toThrow();
    const bad = harness();
    await expect(bad.provider.getRepositoryPermission(REPO, "a/../b", SCOPE, bad.budget)).rejects.toThrow();
    expect(bad.requests).toEqual([]);
  });
});

describe("marking a pull request ready and asking for reviewers", () => {
  it("marks a draft ready with a write token and leaves one that is ready alone", async () => {
    const draft = harness({ pull: pull({ draft: true }) });
    await expect(draft.provider.markPullRequestReady(REPO, 42, SCOPE, draft.budget)).resolves.toBe("ready");
    expect(draft.tokenRequests).toEqual([{ repositories: ["payments"], permissions: { contents: "read", pull_requests: "write" } }]);
    const mutation = draft.requests.find((request) => request.url.endsWith("/graphql"));
    expect(mutation?.body).toMatchObject({ variables: { id: "PR_node_42" } });
    const ready = harness({ pull: pull({ draft: false }) });
    await expect(ready.provider.markPullRequestReady(REPO, 42, SCOPE, ready.budget)).resolves.toBe("already_ready");
    expect(ready.requests.some((request) => request.url.endsWith("/graphql"))).toBe(false);
  });

  it("refuses when GitHub's mutation reports an error or leaves the pull request a draft", async () => {
    const errors = harness({ pull: pull({ draft: true }), graphqlBody: () => ({ errors: [{ message: "nope" }] }) });
    await expect(errors.provider.markPullRequestReady(REPO, 42, SCOPE, errors.budget)).rejects.toThrow();
    const stillDraft = harness({ pull: pull({ draft: true }), graphqlBody: () => ({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: true } } } }) });
    await expect(stillDraft.provider.markPullRequestReady(REPO, 42, SCOPE, stillDraft.budget)).rejects.toThrow();
  });

  it("requests people and teams in one call and reports a refused request without throwing", async () => {
    const h = harness();
    await expect(h.provider.requestReviewers(REPO, 42, ["alice", "acme/core"], SCOPE, h.budget)).resolves.toBe("requested");
    const request = h.requests.find((entry) => entry.url.endsWith("/requested_reviewers"));
    expect(request?.method).toBe("POST");
    expect(request?.body).toEqual({ reviewers: ["alice"], team_reviewers: ["core"] });
    expect(h.tokenRequests).toEqual([{ repositories: ["payments"], permissions: { contents: "read", pull_requests: "write" } }]);
  });

  it("answers refused for a 422 and refuses any reviewer name that is not a login or org/team", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const provider = new GitHubAppCredentialProvider({
      credentialRef: "github", appId: "5002502", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(), now: () => NOW,
      fetchImplementation: async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/installation")) return Response.json({ id: 1, account: { login: "acme" } });
        if (url.endsWith("/access_tokens")) return Response.json({ token: "t" }, { status: 201 });
        return new Response("{}", { status: 422 });
      },
    });
    const budget = { signal: new AbortController().signal, beforeRequest: () => undefined };
    await expect(provider.requestReviewers(REPO, 42, ["alice"], SCOPE, budget)).resolves.toBe("refused");
    await expect(provider.requestReviewers(REPO, 42, ["bad name"], SCOPE, budget)).rejects.toThrow();
    await expect(provider.requestReviewers(REPO, 42, ["a/b/c"], SCOPE, budget)).rejects.toThrow();
    await expect(provider.requestReviewers(REPO, 42, [], SCOPE, budget)).rejects.toThrow();
  });
});
