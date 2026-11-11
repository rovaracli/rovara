// Rovara Code (Plan 6 Task 14): the GitHub reads and writes merge tracking uses, through the App's provider with a fake HTTP layer.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubAppCredentialProvider, GithubMergeRateLimitError } from "../../packages/broker/src/github-app.js";

const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const HEAD = "a".repeat(40);
const REPO = "https://github.com/acme/payments.git";
const SCOPE = { system: "install" } as const;

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
  /** The status of the token request that asks for the checks and statuses permissions (the installation has not accepted them). */
  checksTokenStatus?: number;
  compareStatus?: number;
  workflowStatus?: number;
  branchStatus?: number;
  /** The body of `rules/branches/main` (the rulesets that apply to the base), and its status. */
  rules?: unknown;
  rulesStatus?: number;
  /** Reviews as pages of the reviews list (a Link header names the next page). */
  reviewPages?: unknown[][];
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
      if (fixture.checksTokenStatus !== undefined && JSON.stringify(body).includes('"checks"')) return new Response("{}", { status: fixture.checksTokenStatus });
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
    if (/\/pulls\/42\/reviews/.test(url) && fixture.reviewPages !== undefined) {
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      const more = page < fixture.reviewPages.length;
      return new Response(JSON.stringify(fixture.reviewPages[page - 1] ?? []), { status: 200, headers: more ? { link: `<https://api.github.com/repos/acme/payments/pulls/42/reviews?per_page=100&page=${String(page + 1)}>; rel="next"` } : {} });
    }
    if (/\/pulls\/42\/reviews/.test(url)) return Response.json(fixture.reviews ?? []);
    if (/\/rules\/branches\/main$/.test(url)) return new Response(JSON.stringify(fixture.rules ?? []), { status: fixture.rulesStatus ?? 200 });
    if (/\/contents\/\.github\/workflows/.test(url) && fixture.workflowStatus !== undefined) return new Response("{}", { status: fixture.workflowStatus });
    if (/\/contents\/\.github\/workflows/.test(url)) return fixture.workflowFiles === undefined ? new Response("{}", { status: 404 }) : Response.json(fixture.workflowFiles);
    if (/\/branches\/main$/.test(url) && fixture.branchStatus !== undefined) return new Response("{}", { status: fixture.branchStatus });
    if (/\/branches\/main$/.test(url)) return Response.json(fixture.branch ?? { name: "main", protected: false });
    if (/\/compare\//.test(url) && fixture.compareStatus !== undefined) return new Response("{}", { status: fixture.compareStatus });
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
      pull: pull({ draft: true, mergeable_state: "blocked", requested_reviewers: [{ id: 1, type: "User" }], requested_teams: [{ id: 2 }] }),
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
      requiredChecks: [{ name: "build" }], baseHasRequiredChecks: true, headHasWorkflowFiles: true, requestedReviewers: 2, requestedReviewerIds: ["1"],
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
    // More than five pages would be an incomplete list: the checks are said to be unavailable (never read as passing), the rest of the status is still read.
    const many = harness({ rollupPages: Array.from({ length: 6 }, (_, index) => page(`c${String(index)}`)) });
    expect(await many.provider.getPullRequestStatus(REPO, 42, SCOPE, many.budget)).toMatchObject({ checks: [], checksUnavailable: true, number: 42 });
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
      { reviews: [{ user: { id: "x", login: "a", type: "User" }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-10-25T11:00:00Z" }] },
      { reviews: [{ user: { id: 1, login: "a", type: "User" }, state: "APPROVED", commit_id: "short", submitted_at: "2026-10-25T11:00:00Z" }] },
      { pull: pull({ number: 7 }) },
    ] as Fixture[]) {
      const h = harness(bad);
      await expect(h.provider.getPullRequestStatus(REPO, 42, SCOPE, h.budget)).rejects.toThrow();
    }
  });

  it("says the checks are unavailable, and reads everything else, when the list cannot be read or does not fit", async () => {
    for (const bad of [
      { rollup: [{ __typename: "Mystery" }] },
      { rollup: [rollupNode({ conclusion: "SHRUGGED" })] },
      { graphqlBody: () => ({ errors: [{ message: "denied" }] }) },
      { graphqlStatus: 403 },
    ] as Fixture[]) {
      const h = harness({ ...bad, reviews: [{ user: { id: 1, login: "a", type: "User" }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-10-25T11:00:00Z" }] });
      const status = await h.provider.getPullRequestStatus(REPO, 42, SCOPE, h.budget);
      expect(status).toMatchObject({ number: 42, checks: [], checksUnavailable: true });
      expect(status.reviews).toHaveLength(1);
    }
  });

  it("reads everything but the checks with a token that asks for less when the installation has not accepted the checks and statuses permissions", async () => {
    const h = harness({ checksTokenStatus: 422, rollup: [rollupNode({})] });
    const status = await h.provider.getPullRequestStatus(REPO, 42, SCOPE, h.budget);
    expect(status).toMatchObject({ number: 42, checks: [], checksUnavailable: true });
    expect(h.tokenRequests).toEqual([
      { repositories: ["payments"], permissions: { contents: "read", pull_requests: "read", checks: "read", statuses: "read" } },
      { repositories: ["payments"], permissions: { contents: "read", pull_requests: "read" } },
    ]);
    expect(h.requests.some((request) => request.url.endsWith("/graphql"))).toBe(false);
  });

  it("degrades one refused item (the comparison, the workflow files, the base branch) and not the whole read; any other failure still throws", async () => {
    const compare = harness({ compareStatus: 403 });
    expect((await compare.provider.getPullRequestStatus(REPO, 42, SCOPE, compare.budget)).behindBy).toBeUndefined();
    const files = harness({ workflowStatus: 403 });
    expect((await files.provider.getPullRequestStatus(REPO, 42, SCOPE, files.budget)).headHasWorkflowFiles).toBe(true);
    const branch = harness({ branchStatus: 403 });
    expect(await branch.provider.getPullRequestStatus(REPO, 42, SCOPE, branch.budget)).toMatchObject({ checksUnavailable: true, requiredChecks: [] });
    for (const broken of [{ compareStatus: 500 }, { workflowStatus: 500 }] as Fixture[]) {
      const h = harness(broken);
      await expect(h.provider.getPullRequestStatus(REPO, 42, SCOPE, h.budget)).rejects.toThrow();
    }
  });

  it("names the checks branch protection requires, from the contexts and the checks, whether or not they have reported", async () => {
    const h = harness({ branch: { name: "main", protected: true, protection: { enabled: true, required_status_checks: { contexts: ["legacy"], checks: [{ context: "build" }, { context: "legacy" }] } } } });
    const status = await h.provider.getPullRequestStatus(REPO, 42, SCOPE, h.budget);
    expect(status.requiredChecks).toEqual([{ name: "legacy" }, { name: "build" }]);
    expect(status.baseHasRequiredChecks).toBe(true);
  });

  it("names the app a required check must come from when protection or a ruleset names one, and any app for -1 or null", async () => {
    const h = harness({
      branch: { name: "main", protected: true, protection: { enabled: true, required_status_checks: { contexts: [], checks: [{ context: "build", app_id: 15368 }, { context: "lint", app_id: -1 }, { context: "docs", app_id: null }] } } },
      rules: [{ type: "required_status_checks", ruleset_id: 3, parameters: { required_status_checks: [{ context: "deploy", integration_id: 99 }, { context: "smoke" }] } }],
    });
    const status = await h.provider.getPullRequestStatus(REPO, 42, SCOPE, h.budget);
    expect(status.requiredChecks).toEqual([{ name: "build", appId: 15368 }, { name: "lint" }, { name: "docs" }, { name: "deploy", appId: 99 }, { name: "smoke" }]);
  });

  it("takes the checks a ruleset requires as well as branch protection's (the union), and counts that read as one more request", async () => {
    const h = harness({
      branch: { name: "main", protected: true, protection: { enabled: true, required_status_checks: { contexts: ["build"], checks: [] } } },
      rules: [{ type: "pull_request", parameters: {} }, { type: "required_status_checks", ruleset_id: 3, parameters: { required_status_checks: [{ context: "deploy" }, { context: "build" }] } }],
    });
    const status = await h.provider.getPullRequestStatus(REPO, 42, SCOPE, h.budget);
    expect(status.requiredChecks).toEqual([{ name: "build" }, { name: "deploy" }]);
    expect(status.baseHasRequiredChecks).toBe(true);
    expect(h.requests.filter((request) => /\/rules\/branches\/main$/.test(request.url))).toHaveLength(1);
    expect(h.count()).toBe(h.requests.length);
  });

  it("reads the checks as unavailable when the rulesets or the base branch cannot be read or do not parse (a missing branch is not 'no protection')", async () => {
    for (const unreadable of [
      { rulesStatus: 403 }, { rulesStatus: 404 }, { rulesStatus: 500 }, { rules: { not: "a list" } },
      { rules: [{ type: "required_status_checks", parameters: { required_status_checks: "nope" } }] },
      { branchStatus: 404 }, { branchStatus: 403 }, { branchStatus: 500 },
      { branch: { name: "main", protected: true, protection: { enabled: true, required_status_checks: "nope" } } },
    ] as Fixture[]) {
      const h = harness({ ...unreadable, rollup: [rollupNode({})] });
      const status = await h.provider.getPullRequestStatus(REPO, 42, SCOPE, h.budget);
      expect(status, JSON.stringify(unreadable)).toMatchObject({ checksUnavailable: true, number: 42 });
    }
  });

  it("reads the app of each check run from the list", async () => {
    const h = harness({ rollup: [rollupNode({ name: "build", checkSuite: { app: { databaseId: 15368 } } }), rollupNode({ name: "other", checkSuite: { app: null } })] });
    const status = await h.provider.getPullRequestStatus(REPO, 42, SCOPE, h.budget);
    expect(status.checks.map((check) => [check.name, check.appId])).toEqual([["build", 15368], ["other", undefined]]);
  });

  it("reads at most five pages of reviews, and says the reviews are incomplete when there are more", async () => {
    const review = (id: number) => ({ user: { id, login: `p${String(id)}`, type: "User" }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-10-25T11:00:00Z" });
    const six = harness({ reviewPages: Array.from({ length: 6 }, (_, page) => [review(page + 1)]) });
    const capped = await six.provider.getPullRequestStatus(REPO, 42, SCOPE, six.budget);
    expect(capped.reviewsIncomplete).toBe(true);
    expect(capped.reviews).toHaveLength(5);
    expect(six.requests.filter((request) => /\/reviews/.test(request.url))).toHaveLength(5);
    const three = harness({ reviewPages: Array.from({ length: 3 }, (_, page) => [review(page + 1)]) });
    const all = await three.provider.getPullRequestStatus(REPO, 42, SCOPE, three.budget);
    expect(all.reviews).toHaveLength(3);
    expect(all).not.toHaveProperty("reviewsIncomplete");
    const five = harness({ reviewPages: Array.from({ length: 5 }, (_, page) => [review(page + 1)]) });
    expect(await five.provider.getPullRequestStatus(REPO, 42, SCOPE, five.budget)).not.toHaveProperty("reviewsIncomplete");
  });

  it("mints each kind of token once a pass: a status read, five permission lookups, marking ready and asking for reviewers cost three mints", async () => {
    const h = harness({ pull: pull({ draft: true }) });
    await h.provider.getPullRequestStatus(REPO, 42, SCOPE, h.budget);
    for (const login of ["a", "b", "c", "d", "e"]) await h.provider.getRepositoryPermission(REPO, login, SCOPE, h.budget);
    await h.provider.markPullRequestReady(REPO, 42, SCOPE, h.budget);
    await h.provider.requestReviewers(REPO, 42, ["alice"], SCOPE, h.budget);
    expect(h.tokenRequests).toHaveLength(3);
    // Every request is counted, mints and the installation lookup included.
    expect(h.count()).toBe(h.requests.length);
    expect(h.requests.filter((request) => request.url.endsWith("/installation"))).toHaveLength(1);
    // Another pass (another budget) mints for itself; a read with no budget keeps nothing.
    const other = { signal: new AbortController().signal, beforeRequest: () => undefined };
    await h.provider.getRepositoryPermission(REPO, "a", SCOPE, other);
    expect(h.tokenRequests).toHaveLength(4);
    await h.provider.getRepositoryPermission(REPO, "a", SCOPE);
    await h.provider.getRepositoryPermission(REPO, "a", SCOPE);
    expect(h.tokenRequests).toHaveLength(6);
  });

  it("does not keep a token whose mint was refused", async () => {
    const h = harness({ tokenStatus: 500 });
    await expect(h.provider.getRepositoryPermission(REPO, "a", SCOPE, h.budget)).rejects.toThrow();
    await expect(h.provider.getRepositoryPermission(REPO, "a", SCOPE, h.budget)).rejects.toThrow();
    expect(h.tokenRequests).toHaveLength(2);
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

  it("reads a 403 as none (the App may not ask about that person, who then does not count)", async () => {
    const h = harness({ permission: { status: 403, body: {} } });
    await expect(h.provider.getRepositoryPermission(REPO, "someone", SCOPE, h.budget)).resolves.toBe("none");
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
    // A team of another organization is never asked for: `other-org/admins` would otherwise reach this repository's own `admins`.
    await expect(provider.requestReviewers(REPO, 42, ["other-org/admins"], SCOPE, budget)).rejects.toThrow(/organization/);
    await expect(provider.requestReviewers(REPO, 42, ["Acme/admins"], SCOPE, budget)).resolves.toBe("refused");
    await expect(provider.requestReviewers(REPO, 42, [], SCOPE, budget)).rejects.toThrow();
  });
});
