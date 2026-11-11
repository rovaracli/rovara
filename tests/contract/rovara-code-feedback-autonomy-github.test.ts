// Rovara Code (Plan 6 Task 16): the GitHub reads and writes automatic comment fixes use, through the App's provider with a fake HTTP layer: a person's permission together with the kind of
// account GitHub says they are, and the one reply Rovara leaves in a review thread (fixed text, replied to once, only with write access to pull requests, never an @-mention).
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const REPO = "https://github.com/acme/payments.git";
const SCOPE = { system: "install" } as const;

function harness(options: { permission?: { status: number; body: unknown }; reply?: { status: number } } = {}) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const requests: Array<{ method: string; url: string; body?: unknown }> = [];
  const tokenRequests: unknown[] = [];
  const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    requests.push({ method: init?.method ?? "GET", url, ...(body === undefined ? {} : { body }) });
    if (url.endsWith("/installation")) return Response.json({ id: 163046162, account: { login: "acme" } });
    if (url.endsWith("/access_tokens")) { tokenRequests.push(body); return Response.json({ token: "token-1" }, { status: 201 }); }
    if (/\/collaborators\/[^/]+\/permission$/.test(url)) return new Response(JSON.stringify(options.permission?.body ?? { permission: "write" }), { status: options.permission?.status ?? 200 });
    if (/\/pulls\/42\/comments\/\d+\/replies$/.test(url)) return Response.json({ id: 9 }, { status: options.reply?.status ?? 201 });
    return new Response("{}", { status: 404 });
  });
  const provider = new GitHubAppCredentialProvider({
    credentialRef: "github", appId: "5002502", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(), fetchImplementation, now: () => NOW,
  });
  let count = 0;
  const budget = { signal: new AbortController().signal, beforeRequest: () => { count += 1; } };
  return { provider, requests, tokenRequests, budget, count: () => count };
}

describe("a person's standing", () => {
  it("is their permission and the kind of account GitHub says they are", async () => {
    const h = harness({ permission: { status: 200, body: { permission: "write", role_name: "write", user: { login: "maya", type: "User" } } } });
    await expect(h.provider.getRepositoryStanding(REPO, "maya", SCOPE, h.budget)).resolves.toEqual({ permission: "write", userType: "User" });
    const bot = harness({ permission: { status: 200, body: { permission: "write", user: { login: "helper", type: "Bot" } } } });
    await expect(bot.provider.getRepositoryStanding(REPO, "helper", SCOPE, bot.budget)).resolves.toEqual({ permission: "write", userType: "Bot" });
  });

  it("has no kind when GitHub names none, and the permission alone is what getRepositoryPermission answers (maintain reads as write)", async () => {
    const none = harness({ permission: { status: 200, body: { permission: "write", role_name: "maintain" } } });
    await expect(none.provider.getRepositoryStanding(REPO, "maya", SCOPE, none.budget)).resolves.toEqual({ permission: "write" });
    await expect(none.provider.getRepositoryPermission(REPO, "maya", SCOPE, none.budget)).resolves.toBe("write");
  });

  it("a 404 or a 403 is none, another failure is refused, a login that is not one is refused before anything is asked, and each lookup is counted", async () => {
    for (const status of [404, 403]) {
      const h = harness({ permission: { status, body: {} } });
      await expect(h.provider.getRepositoryStanding(REPO, "ghost", SCOPE, h.budget)).resolves.toEqual({ permission: "none" });
    }
    const broken = harness({ permission: { status: 500, body: {} } });
    await expect(broken.provider.getRepositoryStanding(REPO, "maya", SCOPE, broken.budget)).rejects.toThrow();
    const bad = harness();
    await expect(bad.provider.getRepositoryStanding(REPO, "dependabot[bot]", SCOPE, bad.budget)).rejects.toThrow();
    expect(bad.requests).toEqual([]);
    const counted = harness();
    await counted.provider.getRepositoryStanding(REPO, "maya", SCOPE, counted.budget);
    expect(counted.count()).toBe(counted.requests.length);
  });
});

describe("the one reply Rovara leaves in a review thread", () => {
  it("posts its fixed text to the comment's replies, with a token that can write to pull requests and nothing more", async () => {
    const h = harness();
    await expect(h.provider.replyToReviewThread(REPO, 42, "1780000001", "Fixed in 0123456.", SCOPE, h.budget)).resolves.toBe("replied");
    expect(h.requests.filter((request) => request.method === "POST" && !request.url.endsWith("/access_tokens"))).toEqual([
      { method: "POST", url: "https://api.github.com/repos/acme/payments/pulls/42/comments/1780000001/replies", body: { body: "Fixed in 0123456." } },
    ]);
    expect(h.tokenRequests).toEqual([{ repositories: ["payments"], permissions: { contents: "read", pull_requests: "write" } }]);
    expect(h.count()).toBe(h.requests.length);
  });

  it("a comment or thread that is gone is not an error", async () => {
    for (const status of [404, 422]) {
      const h = harness({ reply: { status } });
      await expect(h.provider.replyToReviewThread(REPO, 42, "7", "Fixed in 0123456.", SCOPE, h.budget)).resolves.toBe("gone");
    }
  });

  it("another failure is an error (the reply is tried again), and a rate limit is not hidden", async () => {
    const h = harness({ reply: { status: 500 } });
    await expect(h.provider.replyToReviewThread(REPO, 42, "7", "Fixed in 0123456.", SCOPE, h.budget)).rejects.toThrow();
  });

  it("refuses an id that is not a comment id, and text that is not Rovara's short plain line (no control characters, no @-mention, bounded), before anything is sent", async () => {
    const h = harness();
    for (const id of ["abc", "0", "1/../2", "", "12345678901234567890"]) await expect(h.provider.replyToReviewThread(REPO, 42, id, "Fixed in 0123456.", SCOPE, h.budget)).rejects.toThrow();
    for (const text of ["", "x".repeat(201), "thanks @octocat", "line\nbreak"]) await expect(h.provider.replyToReviewThread(REPO, 42, "7", text, SCOPE, h.budget)).rejects.toThrow();
    expect(h.requests).toEqual([]);
  });
});
