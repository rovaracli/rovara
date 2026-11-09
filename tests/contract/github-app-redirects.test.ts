// Redirects and hangs on the GitHub requests that carry an installation or user token (0.5.12, L7A-5). A fake fetch that behaves the way the real one does: a request with
// `redirect: "error"` that meets a 302 fails; any other request follows it to the other host with the same headers (so the token would leak). A hanging answer ends only when the request's signal aborts.
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";
import { ProviderUnavailableError, githubSignInProvider } from "../../packages/broker/src/developer/providers.js";

const REPO = "https://github.com/ps06756/personal-website-test.git";
const API = "https://api.github.com/repos/ps06756/personal-website-test";
const OTHER_HOST = "https://elsewhere.example/stolen";
const SCOPE = { system: "private-install" } as const;
const COMMIT = "e".repeat(40);
const TOKEN = ["installation", "token", "for", "tests"].join("-");

const pullRequest = (): Record<string, unknown> => ({
  number: 42, html_url: "https://github.com/ps06756/personal-website-test/pull/42", state: "open", merged: false, merge_commit_sha: null,
  head: { ref: "agentx/00000000-0000-4000-8000-000000000001", sha: "a".repeat(40), repo: { full_name: "ps06756/personal-website-test" } },
  base: { ref: "main", repo: { full_name: "ps06756/personal-website-test" } }, title: "Current title", body: "Current body",
});

type Seen = { url: string; method: string; authorization: string | null; redirect: string | undefined };
type Mode = "ok" | "redirect" | "hang";

/** `modeOf` says what each API request meets; everything else (the token mint, the installation lookup) answers at once. */
function world(modeOf: (method: string, url: string) => Mode) {
  const seen: Seen[] = [];
  const signals: AbortSignal[] = [];
  const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    seen.push({ url, method, authorization: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
    if (url.endsWith("/installation")) return new Response(JSON.stringify({ id: 163046162, account: { login: "ps06756" } }), { status: 200 });
    if (url.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: TOKEN, expires_at: "2030-01-01T00:00:00Z" }), { status: 201 });
    if (url === OTHER_HOST) return new Response("{}", { status: 200 });
    const mode = url.startsWith(API) ? modeOf(method, url) : "ok";
    if (mode === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // no deadline: the test itself times out, which is the failure
        signals.push(signal);
        signal.addEventListener("abort", () => { reject(new Error("the request's deadline passed")); });
      });
    }
    if (mode === "redirect") {
      if (init?.redirect === "error") throw new TypeError("fetch failed: a redirect was refused");
      if (init?.redirect === "manual") return new Response(null, { status: 302, headers: { location: OTHER_HOST } });
      return fetchImplementation(OTHER_HOST, init); // followed, with the same headers
    }
    if (url.includes("/pulls?")) return new Response("[]", { status: 200 });
    if (method === "POST") return new Response(JSON.stringify({ number: 43, html_url: "https://github.com/ps06756/personal-website-test/pull/43" }), { status: 201 });
    if (url.endsWith(`/git/commits/${COMMIT}`)) return new Response(JSON.stringify({ sha: COMMIT, tree: { sha: "d".repeat(40) } }), { status: 200 });
    return new Response(JSON.stringify({ ...pullRequest(), ...(method === "PATCH" ? { state: "closed" } : {}) }), { status: 200 });
  }) as typeof fetch;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const provider = new GitHubAppCredentialProvider({ credentialRef: "github-agentx-sdlc", appId: "5002502", getPrivateKey: async () => pem, fetchImplementation });
  return { provider, seen, signals };
}

/** Every deadline is cut to 20 ms so a hang ends fast; the value each request asked for is kept, keyed by its signal. */
function shortDeadlines() {
  const asked = new Map<AbortSignal, number>();
  const real = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => { const signal = real(20); asked.set(signal, ms); return signal; });
  return asked;
}

afterEach(() => { vi.restoreAllMocks(); });

type Call = (provider: GitHubAppCredentialProvider) => Promise<unknown>;
const input = { repositoryUrl: REPO, headBranch: "agentx/00000000-0000-4000-8000-000000000001", baseBranch: "main", title: "Publish change" };
const methods: Array<{ name: string; call: Call; hit: (method: string, url: string) => boolean; seconds: number }> = [
  { name: "the open pull request lookup (reconcilePullRequest)", call: (p) => p.reconcilePullRequest(input, SCOPE), hit: (m, u) => m === "GET" && u.includes("/pulls?"), seconds: 8 },
  { name: "the pull request create (reconcilePullRequest)", call: (p) => p.reconcilePullRequest(input, SCOPE), hit: (m, u) => m === "POST" && u === `${API}/pulls`, seconds: 15 },
  { name: "the pull request read (getPullRequest)", call: (p) => p.getPullRequest(REPO, 42, SCOPE), hit: (m, u) => m === "GET" && u === `${API}/pulls/42`, seconds: 8 },
  { name: "the pull request update (updatePullRequest)", call: (p) => p.updatePullRequest(REPO, 42, { state: "closed" }, SCOPE), hit: (m) => m === "PATCH", seconds: 15 },
  { name: "the commit tree read (getCommitTree)", call: (p) => p.getCommitTree(REPO, COMMIT, SCOPE), hit: (_m, u) => u.endsWith(`/git/commits/${COMMIT}`), seconds: 8 },
];

describe("GitHub App requests that carry an installation token", () => {
  for (const { name, call, hit, seconds } of methods) {
    describe(name, () => {
      it("refuses a redirect and never sends the token to another host", async () => {
        const { provider, seen } = world((method, url) => hit(method, url) ? "redirect" : "ok");
        await expect(call(provider)).rejects.toThrow();
        const request = seen.find((entry) => entry.url.startsWith(API) && hit(entry.method, entry.url));
        expect(request?.redirect).toBe("error");
        expect(seen.filter((entry) => !entry.url.startsWith("https://api.github.com/") && !entry.url.endsWith("/installation"))).toEqual([]);
      });

      it(`times out a hanging answer (asks for ${String(seconds)} seconds)`, async () => {
        const asked = shortDeadlines();
        const { provider, signals } = world((method, url) => hit(method, url) ? "hang" : "ok");
        await expect(call(provider)).rejects.toThrow();
        expect(signals.length).toBeGreaterThan(0);
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        expect(asked.get(signals[0]!)).toBe(seconds * 1000);
      });
    });
  }

  it("refuses a redirect on the update's reconcile read too, so a failed update is not hidden by one", async () => {
    const { provider, seen } = world(() => "redirect");
    await expect(provider.updatePullRequest(REPO, 42, { state: "closed" }, SCOPE)).rejects.toThrow(/outcome is unknown/);
    expect(seen.filter((entry) => entry.url === OTHER_HOST)).toEqual([]);
  });
});

describe("the GitHub sign-in provider", () => {
  const SECRET_FIELD = ["client", "secret"].join("_");
  function signIn(modeOf: (url: string) => Mode) {
    const seen: Array<{ url: string; redirect: string | undefined; body: string }> = [];
    const fetchFn = (async (url: string, init?: RequestInit): Promise<Response> => {
      seen.push({ url, redirect: init?.redirect, body: typeof init?.body === "string" ? init.body : "" });
      if (url === OTHER_HOST) return new Response("{}", { status: 200 });
      const mode = modeOf(url);
      if (mode === "hang") return new Promise<Response>((_r, reject) => { init?.signal?.addEventListener("abort", () => { reject(new Error("the request's deadline passed")); }); });
      if (mode === "redirect") {
        if (init?.redirect === "error") throw new TypeError("fetch failed: a redirect was refused");
        return fetchFn(OTHER_HOST, init);
      }
      if (url.endsWith("/access_token")) return new Response(JSON.stringify({ access_token: TOKEN }), { status: 200 });
      if (url.endsWith("/user")) return new Response(JSON.stringify({ id: 4242, login: "ada", name: "Ada" }), { status: 200 });
      return new Response(JSON.stringify([{ email: "ada@example.com", primary: true, verified: true }]), { status: 200 });
    }) as typeof fetch;
    const provider = githubSignInProvider({ clientId: "cid", clientSecret: async () => "sign-in-secret", fetch: fetchFn, now: () => 0 });
    return { seen, complete: () => provider.complete({ code: "abc", nonce: "n", redirectUri: "https://example.test/cb" }) };
  }

  for (const [label, hit] of [
    ["the code exchange", (url: string) => url === "https://github.com/login/oauth/access_token"],
    ["the account read", (url: string) => url === "https://api.github.com/user"],
    ["the email read", (url: string) => url.startsWith("https://api.github.com/user/emails")],
  ] as const) {
    it(`refuses a redirect on ${label} and never sends the secret or token to another host`, async () => {
      const { seen, complete } = signIn((url) => hit(url) ? "redirect" : "ok");
      await expect(complete()).rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(seen.find((entry) => hit(entry.url))?.redirect).toBe("error");
      expect(seen.filter((entry) => entry.url === OTHER_HOST)).toEqual([]);
    });
  }

  it("still ends a hanging code exchange at its own deadline", async () => {
    shortDeadlines();
    const { seen, complete } = signIn((url) => url.endsWith("/access_token") ? "hang" : "ok");
    await expect(complete()).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(seen[0]?.body).toContain(SECRET_FIELD);
  });
});
