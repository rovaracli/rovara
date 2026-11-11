// Lessons capture lane: the read the human-edit compare is made through. It mints a `contents: read` token for the one repository, reads one compare path, and refuses every other path.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hostRateLimitRetryAt } from "@rovara-code/contracts";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";
import { agentXError } from "@rovara-code/contracts";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as never;
const A = "a".repeat(40);
const B = "b".repeat(40);
const NOW = 1_800_000_000_000;
function setup(options: { installation?: number; bound?: boolean; compare?: () => Response } = {}) {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const urls: string[] = [];
  const tokenBodies: unknown[] = [];
  const provider = new GitHubAppCredentialProvider({
    credentialRef: "test", appId: "123", now: () => NOW, getPrivateKey: async () => key,
    ...(options.bound === false ? { requireInstallationBound: async () => { throw agentXError("GITHUB_NOT_CONNECTED", "not connected"); } } : {}),
    fetchImplementation: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/installation")) return options.installation === undefined ? Response.json({ id: 123, account: { login: "acme" } }) : new Response("{}", { status: options.installation });
      if (url.endsWith("/access_tokens")) { tokenBodies.push(JSON.parse(init?.body as string)); return Response.json({ token: "fake-test-only", expires_at: "2030-01-01T00:00:00Z" }); }
      urls.push(url);
      if (options.compare !== undefined) return options.compare();
      return Response.json({ status: "ahead", files: [] });
    },
  });
  return { provider, urls, tokenBodies };
}

describe("getRepositoryCompareJson", () => {
  it("reads one compare of the named repository with a contents-read token", async () => {
    const w = setup();
    const answer = await w.provider.getRepositoryCompareJson("https://github.com/acme/app", `/repos/acme/app/compare/${A}...${B}?per_page=100`, { orgId: ORG });
    expect(answer).toEqual({ status: 200, body: { status: "ahead", files: [] } });
    expect(w.urls).toEqual([`https://api.github.com/repos/acme/app/compare/${A}...${B}?per_page=100`]);
    expect(w.tokenBodies).toEqual([{ repositories: ["app"], permissions: { contents: "read" } }]);
  });
  it("L3: refuses a base that is not a full commit id (a `../` segment, a branch name) before GitHub is asked", async () => {
    const w = setup();
    for (const base of ["..%2F..%2Fpulls", "../..", "main", "a/b", A.slice(1), "A".repeat(40)]) {
      await expect(w.provider.getRepositoryCompareJson("https://github.com/acme/app", `/repos/acme/app/compare/${base}...${B}`, { orgId: ORG })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(w.urls).toEqual([]);
  });
  it("refuses any other path, another repository's compare, or a branch name for the head, before GitHub is asked", async () => {
    const w = setup();
    for (const path of ["/repos/acme/app/pulls/1", "/repos/acme/other/compare/" + A + "..." + B, "/repos/acme/app/compare/" + A + "...main", "/user", "/repos/acme/app/compare/" + A + "..." + B + "/../../x"]) {
      await expect(w.provider.getRepositoryCompareJson("https://github.com/acme/app", path, { orgId: ORG })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(w.urls).toEqual([]);
    expect(w.tokenBodies).toEqual([]);
  });
  it("F2: a repository the App no longer covers (removed from the installation, or the installation no longer bound to the company) is answered 404, never thrown; a fault of GitHub's own still throws", async () => {
    const path = `/repos/acme/app/compare/${A}...${B}?per_page=100`;
    const removed = setup({ installation: 404 });
    expect(await removed.provider.getRepositoryCompareJson("https://github.com/acme/app", path, { orgId: ORG })).toEqual({ status: 404, body: undefined });
    const unbound = setup({ bound: false });
    expect(await unbound.provider.getRepositoryCompareJson("https://github.com/acme/app", path, { orgId: ORG })).toEqual({ status: 404, body: undefined });
    expect(unbound.urls).toEqual([]);
    const down = setup({ installation: 503 });
    await expect(down.provider.getRepositoryCompareJson("https://github.com/acme/app", path, { orgId: ORG })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
  it("a 403 that is a rate limit THROWS a retryable rate-limit error (the primary limit: x-ratelimit-remaining 0 and a reset; the secondary: retry-after; the message alone), never 'no diff'", async () => {
    const path = `/repos/acme/app/compare/${A}...${B}?per_page=100`;
    const ask = async (compare: () => Response) => setup({ compare }).provider.getRepositoryCompareJson("https://github.com/acme/app", path, { orgId: ORG }).then(() => undefined, (error: unknown) => error);
    const primary = await ask(() => Response.json({ message: "API rate limit exceeded for installation" }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((NOW + 600_000) / 1000) } }));
    expect(primary).toMatchObject({ name: "GithubCompareRateLimitError" });
    expect(hostRateLimitRetryAt(primary)).toBe(NOW + 600_000);
    const secondary = await ask(() => Response.json({ message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." }, { status: 403, headers: { "retry-after": "120" } }));
    expect(hostRateLimitRetryAt(secondary)).toBe(NOW + 120_000);
    const messageOnly = await ask(() => Response.json({ message: "You have exceeded a secondary rate limit." }, { status: 403 }));
    expect(hostRateLimitRetryAt(messageOnly)).toBe(NOW + 60_000);
    const tooMany = await ask(() => Response.json({ message: "slow down" }, { status: 429, headers: { "retry-after": "30" } }));
    expect(hostRateLimitRetryAt(tooMany)).toBe(NOW + 30_000);
  });
  it("a plain 403 (no access: no rate-limit header, no rate-limit message) is still answered, so the reader says 'no diff'", async () => {
    const path = `/repos/acme/app/compare/${A}...${B}?per_page=100`;
    const w = setup({ compare: () => Response.json({ message: "Resource not accessible by integration" }, { status: 403, headers: { "x-ratelimit-remaining": "4999" } }) });
    expect(await w.provider.getRepositoryCompareJson("https://github.com/acme/app", path, { orgId: ORG })).toEqual({ status: 403, body: { message: "Resource not accessible by integration" } });
  });
});
