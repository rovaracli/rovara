// Lessons capture lane: the read the human-edit compare is made through. It mints a `contents: read` token for the one repository, reads one compare path, and refuses every other path.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as never;
const A = "a".repeat(40);
const B = "b".repeat(40);
function setup() {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const urls: string[] = [];
  const tokenBodies: unknown[] = [];
  const provider = new GitHubAppCredentialProvider({
    credentialRef: "test", appId: "123", getPrivateKey: async () => key,
    fetchImplementation: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/installation")) return Response.json({ id: 123, account: { login: "acme" } });
      if (url.endsWith("/access_tokens")) { tokenBodies.push(JSON.parse(String(init?.body))); return Response.json({ token: "fake-test-only", expires_at: "2030-01-01T00:00:00Z" }); }
      urls.push(url);
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
  it("refuses any other path, another repository's compare, or a branch name for the head, before GitHub is asked", async () => {
    const w = setup();
    for (const path of ["/repos/acme/app/pulls/1", "/repos/acme/other/compare/" + A + "..." + B, "/repos/acme/app/compare/" + A + "...main", "/user", "/repos/acme/app/compare/" + A + "..." + B + "/../../x"]) {
      await expect(w.provider.getRepositoryCompareJson("https://github.com/acme/app", path, { orgId: ORG })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(w.urls).toEqual([]);
    expect(w.tokenBodies).toEqual([]);
  });
});
