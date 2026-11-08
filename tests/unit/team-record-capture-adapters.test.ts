// Lessons capture lane: the one interface learning reads a code host through. A host adds itself by registering an adapter; the registry picks by host name and by pull request address.
import { describe, expect, it } from "vitest";
import type { ChangeRequestFeedback, CodeHost } from "@agentx/contracts";
import { captureAdapterOf, createCaptureAdapters, githubPullRequestAddress } from "../../packages/broker/src/team-record/sources/capture-adapters.js";
import type { CodeHostDiff } from "../../packages/broker/src/team-record/sources/codehost.js";

const feedback = (comments: ChangeRequestFeedback["comments"]): Pick<CodeHost, "feedback"> => ({
  feedback: async () => ({ comments, threads: [], changeRequest: {} as never }),
});
const comment = (id: string, kind: "review" | "review_comment" | "discussion", over: Record<string, unknown> = {}) => ({ id, kind, url: "", author: "x", updatedAt: "2026-11-01T00:00:00.000Z", body: "secret words", ...over }) as ChangeRequestFeedback["comments"][number];
const gitfarm = (comments: ChangeRequestFeedback["comments"], diffs?: { compare(): Promise<CodeHostDiff | undefined> }) => captureAdapterOf({
  host: "codehost:gitfarm", codeHost: feedback(comments),
  pullRequestAddress: (url) => { const m = /^https:\/\/gitfarm\.example\/cr\/(\d+)$/u.exec(url); return m === null ? undefined : { host: "codehost:gitfarm", repository: "pkg/api", number: Number(m[1]) }; },
  refOf: (address, url) => ({ repository: { url: `https://gitfarm.example/${address.repository}` }, id: String(address.number), url }),
  scopeOf: (workspaceId) => ({ orgId: workspaceId }), ...(diffs === undefined ? {} : { diffs: diffs }),
});

describe("the registry", () => {
  it("finds an adapter by host and by pull request address, and reports what each host supports", () => {
    const adapters = createCaptureAdapters();
    adapters.register(gitfarm([]));
    adapters.register({ host: "github", supports: { pullRequestComments: false, commentOutdated: false, humanEdits: false, authorship: "none", mergeCommit: true }, pullRequestAddress: githubPullRequestAddress });
    expect(adapters.forHost("codehost:gitfarm")?.host).toBe("codehost:gitfarm");
    expect(adapters.addressOf("https://gitfarm.example/cr/9")).toMatchObject({ address: { number: 9, repository: "pkg/api" } });
    expect(adapters.addressOf("https://github.com/Acme/Api/pull/7")?.address).toEqual({ host: "github", repository: "acme/api", number: 7 });
    expect(adapters.addressOf("https://elsewhere.example/pull/1")).toBeUndefined();
    expect(Object.keys(adapters.support()).sort()).toEqual(["codehost:gitfarm", "github"]);
    expect(adapters.support()["codehost:gitfarm"]).toMatchObject({ pullRequestComments: true, humanEdits: false, authorship: "none" });
  });
  it("a second adapter for the same host is refused", () => {
    const adapters = createCaptureAdapters();
    adapters.register(gitfarm([]));
    expect(() => adapters.register(gitfarm([]))).toThrow();
  });
  it("the diff reader picks the adapter by the repository's host; a host with no reader gives no diff", async () => {
    const adapters = createCaptureAdapters();
    const diff: CodeHostDiff = { status: "ahead", commits: [], files: [], truncated: false };
    adapters.register(gitfarm([], { compare: async () => diff }));
    adapters.register({ host: "github", supports: { pullRequestComments: false, commentOutdated: false, humanEdits: false, authorship: "none", mergeCommit: false }, pullRequestAddress: githubPullRequestAddress });
    const repo = (host: string) => ({ host, id: "1", fullName: "a/b", isPrivate: false, workspaceId: "w" });
    expect(await adapters.diffs.compare({ repo: repo("codehost:gitfarm"), base: "a", head: "b" })).toBe(diff);
    expect(await adapters.diffs.compare({ repo: repo("github"), base: "a", head: "b" })).toBeUndefined();
    expect(await adapters.diffs.compare({ repo: repo("unknown"), base: "a", head: "b" })).toBeUndefined();
  });
});

describe("an adapter made from a CodeHost port", () => {
  it("lists comment ids and lines, never the words or the people", async () => {
    const adapter = gitfarm([comment("review_comment:11", "review_comment", { line: 4, path: "a.ts" }), comment("22", "discussion"), comment("review:5", "review"), comment("review_comment:x1", "review_comment"), comment("discussion:9", "review_comment")]);
    const view = await adapter.pullRequestFeedback!({ workspaceId: "org", project: "p", taskId: "t", address: { host: "codehost:gitfarm", repository: "pkg/api", number: 9 }, url: "https://gitfarm.example/cr/9" });
    expect(view).toEqual({ comments: [{ kind: "review_comment", id: "11", line: 4 }, { kind: "discussion", id: "22" }, { kind: "review", id: "5" }] });
    expect(JSON.stringify(view)).not.toContain("secret words");
  });
  it("supports comments by default and human edits only when the host gives a compare; the merge commit comes from its events", () => {
    expect(gitfarm([]).supports).toEqual({ pullRequestComments: true, commentOutdated: true, humanEdits: false, authorship: "none", mergeCommit: true });
    expect(gitfarm([], { compare: async () => undefined }).supports).toMatchObject({ humanEdits: true, authorship: "verified_commits_and_push_chain" });
  });
  it("a host that fails to answer throws, so the caller can tell 'could not read' from 'no comments'", async () => {
    const adapter = captureAdapterOf({ host: "x", codeHost: { feedback: async () => { throw new Error("down"); } }, pullRequestAddress: () => undefined, refOf: () => ({} as never), scopeOf: () => ({ system: "webhook" }) });
    await expect(adapter.pullRequestFeedback!({ workspaceId: "o", project: "p", taskId: "t", address: { host: "x", repository: "r", number: 1 }, url: "u" })).rejects.toThrow();
  });
});

describe("the GitHub adapter", () => {
  it("reads a compare through the provider with the company's scope (or the private install's), lists comments through the port, and supports everything", async () => {
    const { githubCaptureAdapter } = await import("../../packages/broker/src/aws/broker/capture-adapters-wiring.js");
    const calls: unknown[] = [];
    const provider = { getRepositoryCompareJson: async (url: string, path: string, scope: unknown) => { calls.push([url, path, scope]); return { status: 404, body: undefined }; } };
    const adapter = githubCaptureAdapter({ provider, codeHost: feedback([comment("review_comment:5", "review_comment", { line: 3 })]), cloud: true });
    expect(adapter.supports).toEqual({ pullRequestComments: true, commentOutdated: true, humanEdits: true, authorship: "verified_commits_and_push_chain", mergeCommit: true });
    expect(adapter.repositoryAddress?.("acme/api")).toBe("https://github.com/acme/api");
    const repo = { host: "github", id: "1", fullName: "acme/api", isPrivate: true, workspaceId: "org_aaaaaaaaaaaaaaaaaaaa" };
    expect(await adapter.diffs!.compare({ repo, base: "a".repeat(40), head: "b".repeat(40) })).toBeUndefined();
    expect(calls).toEqual([["https://github.com/acme/api", `/repos/acme/api/compare/${"a".repeat(40)}...${"b".repeat(40)}?per_page=100`, { orgId: "org_aaaaaaaaaaaaaaaaaaaa" }]]);
    const privateInstall = githubCaptureAdapter({ provider, codeHost: feedback([]), cloud: false });
    await privateInstall.diffs!.compare({ repo, base: "a".repeat(40), head: "b".repeat(40) });
    expect(calls[1]).toMatchObject([expect.any(String), expect.any(String), { system: "private-install" }]);
    const view = await adapter.pullRequestFeedback!({ workspaceId: "org_aaaaaaaaaaaaaaaaaaaa", project: "p", taskId: "t", address: { host: "github", repository: "acme/api", number: 7 }, url: "https://github.com/acme/api/pull/7" });
    expect(view).toEqual({ comments: [{ kind: "review_comment", id: "5", line: 3 }] });
  });
});
