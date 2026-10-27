// Rovara Code (Plan 6 Task 19): the merge itself, through the App's provider with a fake HTTP layer. It merges with the checked head (`sha`), falls back only between squash and merge,
// and on a refusal reads the pull request again to say what happened.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";

const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const MERGE_COMMIT = "c".repeat(40);
const REPO = "https://github.com/acme/payments.git";
const SCOPE = { system: "private-install" } as const;

interface MergeAnswer { status: number; body?: Record<string, unknown>; headers?: Record<string, string> }
interface Fixture {
  /** The answers to successive `PUT …/merge` calls. */
  merges: MergeAnswer[];
  /** What the pull request looks like when it is read again after a refusal. */
  pull?: Record<string, unknown>;
  pullStatus?: number;
  tokenStatus?: number;
}

const pull = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 42, html_url: "https://github.com/acme/payments/pull/42", node_id: "PR_node_42", state: "open", merged: false, draft: false, merge_commit_sha: null,
  mergeable_state: "clean", mergeable: true, requested_reviewers: [], requested_teams: [],
  head: { ref: "agentx/op", sha: HEAD, repo: { full_name: "acme/payments" } }, base: { ref: "main", repo: { full_name: "acme/payments" } }, title: "Title", body: "Body", ...extra,
});

function harness(fixture: Fixture) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const requests: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  const tokenRequests: unknown[] = [];
  const answers = [...fixture.merges];
  const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    requests.push({ method, url, ...(body === undefined ? {} : { body }) });
    if (url.endsWith("/installation")) return Response.json({ id: 163046162, account: { login: "acme" } });
    if (url.endsWith("/access_tokens")) {
      tokenRequests.push(body);
      return fixture.tokenStatus === undefined ? Response.json({ token: "token-1" }, { status: 201 }) : new Response("{}", { status: fixture.tokenStatus });
    }
    if (method === "PUT" && /\/pulls\/42\/merge$/.test(url)) {
      const next = answers.shift() ?? { status: 500 };
      return new Response(JSON.stringify(next.body ?? {}), { status: next.status, ...(next.headers === undefined ? {} : { headers: next.headers }) });
    }
    if (/\/pulls\/42$/.test(url)) return new Response(JSON.stringify(fixture.pull ?? pull()), { status: fixture.pullStatus ?? 200 });
    return new Response("{}", { status: 404 });
  });
  const provider = new GitHubAppCredentialProvider({
    credentialRef: "github", appId: "5002502", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(), fetchImplementation, now: () => NOW,
  });
  const merges = () => requests.filter((request) => request.method === "PUT");
  return { provider, requests, tokenRequests, merges };
}

describe("merging a pull request", () => {
  it("merges with the checked head and the chosen method, asking only for contents and pull requests at write", async () => {
    const h = harness({ merges: [{ status: 200, body: { merged: true, sha: MERGE_COMMIT, message: "Pull Request successfully merged" } }] });
    await expect(h.provider.mergePullRequest(REPO, 42, { sha: HEAD, method: "squash" }, SCOPE)).resolves.toEqual({ outcome: "merged", method: "squash", fellBack: false, mergeCommitSha: MERGE_COMMIT });
    expect(h.merges()).toEqual([{ method: "PUT", url: "https://api.github.com/repos/acme/payments/pulls/42/merge", body: { sha: HEAD, merge_method: "squash" } }]);
    expect(h.tokenRequests).toEqual([{ repositories: ["payments"], permissions: { contents: "write", pull_requests: "write" } }]);
  });

  it("refuses a sha that is not a commit and a method that is not squash or merge, before asking GitHub anything", async () => {
    const h = harness({ merges: [] });
    await expect(h.provider.mergePullRequest(REPO, 42, { sha: "main", method: "squash" }, SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(h.provider.mergePullRequest(REPO, 42, { sha: HEAD, method: "rebase" as never }, SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(h.provider.mergePullRequest(REPO, 0, { sha: HEAD, method: "squash" }, SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(h.requests).toEqual([]);
  });

  it("falls back from squash to merge, and from merge to squash, when GitHub says the method is not allowed, and never to rebase", async () => {
    for (const [asked, other] of [["squash", "merge"], ["merge", "squash"]] as const) {
      const h = harness({ merges: [{ status: 405, body: { message: `${asked === "squash" ? "Squash merges" : "Merge commits"} are not allowed on this repository.` } }, { status: 200, body: { merged: true, sha: MERGE_COMMIT } }] });
      await expect(h.provider.mergePullRequest(REPO, 42, { sha: HEAD, method: asked }, SCOPE)).resolves.toEqual({ outcome: "merged", method: other, fellBack: true, mergeCommitSha: MERGE_COMMIT });
      expect(h.merges().map((request) => request.body?.merge_method)).toEqual([asked, other]);
    }
  });

  it("stops after one fallback: when the other method is not allowed either, nothing merges", async () => {
    const h = harness({ merges: [
      { status: 405, body: { message: "Squash merges are not allowed on this repository." } },
      { status: 405, body: { message: "Merge commits are not allowed on this repository." } },
    ] });
    await expect(h.provider.mergePullRequest(REPO, 42, { sha: HEAD, method: "squash" }, SCOPE)).resolves.toMatchObject({ outcome: "refused", reason: "not_mergeable" });
    expect(h.merges()).toHaveLength(2);
  });

  it("reads the pull request again after a 405 that is not about the method, and reports what it finds", async () => {
    const notMergeable = harness({ merges: [{ status: 405, body: { message: "Pull Request is not mergeable" } }] });
    await expect(notMergeable.provider.mergePullRequest(REPO, 42, { sha: HEAD, method: "squash" }, SCOPE)).resolves.toMatchObject({ outcome: "refused", reason: "not_mergeable" });
    expect(notMergeable.merges()).toHaveLength(1);
    const merged = harness({ merges: [{ status: 405, body: { message: "Pull Request is not mergeable" } }], pull: pull({ state: "closed", merged: true, merge_commit_sha: MERGE_COMMIT }) });
    await expect(merged.provider.mergePullRequest(REPO, 42, { sha: HEAD, method: "squash" }, SCOPE)).resolves.toEqual({ outcome: "already_merged" });
    const closed = harness({ merges: [{ status: 405, body: { message: "Pull Request is not mergeable" } }], pull: pull({ state: "closed" }) });
    await expect(closed.provider.mergePullRequest(REPO, 42, { sha: HEAD, method: "squash" }, SCOPE)).resolves.toMatchObject({ outcome: "refused", reason: "closed" });
  });

  it("says the head changed when GitHub answers 409, or when the head it reads is not the checked one", async () => {
    const conflict = harness({ merges: [{ status: 409, body: { message: "Head branch was modified. Review and try the merge again." } }], pull: pull({ head: { ref: "agentx/op", sha: MOVED, repo: { full_name: "acme/payments" } } }) });
    await expect(conflict.provider.mergePullRequest(REPO, 42, { sha: HEAD, method: "squash" }, SCOPE)).resolves.toMatchObject({ outcome: "refused", reason: "head_changed" });
    const same = harness({ merges: [{ status: 409, body: { message: "Head branch was modified" } }] });
    await expect(same.provider.mergePullRequest(REPO, 42, { sha: HEAD, method: "squash" }, SCOPE)).resolves.toMatchObject({ outcome: "refused", reason: "not_mergeable" });
  });

  it("says GitHub would not let the App merge when it answers 403, and leaves a failing GitHub for a retry", async () => {
    const forbidden = harness({ merges: [{ status: 403, body: { message: "Resource not accessible by integration" } }] });
    await expect(forbidden.provider.mergePullRequest(REPO, 42, { sha: HEAD, method: "squash" }, SCOPE)).resolves.toMatchObject({ outcome: "refused", reason: "forbidden" });
    const down = harness({ merges: [{ status: 502 }] });
    await expect(down.provider.mergePullRequest(REPO, 42, { sha: HEAD, method: "squash" }, SCOPE)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    const noToken = harness({ merges: [], tokenStatus: 500 });
    await expect(noToken.provider.mergePullRequest(REPO, 42, { sha: HEAD, method: "squash" }, SCOPE)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("leaves a rate limit for a retry, whether GitHub says it with a 403 or a 429", async () => {
    const limited = harness({ merges: [{ status: 403, body: { message: "API rate limit exceeded" }, headers: { "retry-after": "30", "x-ratelimit-remaining": "0" } }] });
    await expect(limited.provider.mergePullRequest(REPO, 42, { sha: HEAD, method: "squash" }, SCOPE)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    const tooMany = harness({ merges: [{ status: 429, body: {} }] });
    await expect(tooMany.provider.mergePullRequest(REPO, 42, { sha: HEAD, method: "squash" }, SCOPE)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("does not take a 200 that does not say merged as a merge", async () => {
    const h = harness({ merges: [{ status: 200, body: { merged: false, message: "queued" } }], pull: pull() });
    await expect(h.provider.mergePullRequest(REPO, 42, { sha: HEAD, method: "squash" }, SCOPE)).resolves.toMatchObject({ outcome: "refused", reason: "not_mergeable" });
  });

  it("carries GitHub's reason on a refusal so a person can read why (branch protection, a required check, a ruleset), cleaned: no token, no mention, no markup, one line, 200 characters", async () => {
    const protectedBranch = harness({ merges: [{ status: 405, body: { message: "Required status check \"build\" is expected." } }] });
    await expect(protectedBranch.provider.mergePullRequest(REPO, 42, { sha: HEAD, method: "squash" }, SCOPE)).resolves.toEqual({ outcome: "refused", reason: "not_mergeable", githubMessage: "Required status check \"build\" is expected." });
    const forbidden = harness({ merges: [{ status: 403, body: { message: "Repository rule violations found\n\nChanges must be made through a pull request." } }] });
    await expect(forbidden.provider.mergePullRequest(REPO, 42, { sha: HEAD, method: "squash" }, SCOPE)).resolves.toEqual({ outcome: "refused", reason: "forbidden", githubMessage: "Repository rule violations found Changes must be made through a pull request." });
    const dirty = harness({ merges: [{ status: 405, body: { message: "ghp_secrettoken123456789012345678901234567890 @everyone <b>do not</b> merge " + "x".repeat(400) } }] });
    const result = await dirty.provider.mergePullRequest(REPO, 42, { sha: HEAD, method: "squash" }, SCOPE);
    expect(result.outcome).toBe("refused");
    const message = (result as { githubMessage?: string }).githubMessage ?? "";
    expect(message).not.toContain("ghp_");
    expect(message).not.toContain("@");
    expect(message).not.toContain("<");
    expect(message.length).toBeLessThanOrEqual(200);
    expect(message).not.toMatch(/[\r\n]/u);
  });

  it("says nothing of GitHub's words when it gave none, or when the pull request moved on (closed, head changed)", async () => {
    const none = harness({ merges: [{ status: 405, body: {} }] });
    expect(await none.provider.mergePullRequest(REPO, 42, { sha: HEAD, method: "squash" }, SCOPE)).toEqual({ outcome: "refused", reason: "not_mergeable" });
    const closed = harness({ merges: [{ status: 405, body: { message: "Pull Request is not mergeable" } }], pull: pull({ state: "closed" }) });
    expect(await closed.provider.mergePullRequest(REPO, 42, { sha: HEAD, method: "squash" }, SCOPE)).toEqual({ outcome: "refused", reason: "closed" });
  });
});
