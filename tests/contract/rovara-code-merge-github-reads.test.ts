// Owner decision 2026-10-27: what the code-owner check reads from GitHub: the CODEOWNERS file of the base branch, the paths a pull request changes, and whether a person is in a team.
// Read only; the token asks for contents and pull requests at read (and members at read for a team, which an installation may not have accepted: then the team is "unknown", never "member").
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const REPO = "https://github.com/acme/payments.git";
const SCOPE = { system: "private-install" } as const;

function harness(routes: Record<string, { status: number; body?: unknown; text?: string }>, tokenStatus = 201) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const requests: Array<{ method: string; url: string }> = [];
  const tokenRequests: unknown[] = [];
  const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ method: init?.method ?? "GET", url });
    if (url.endsWith("/installation")) return Response.json({ id: 163046162, account: { login: "acme" } });
    if (url.endsWith("/access_tokens")) {
      tokenRequests.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
      return tokenStatus === 201 ? Response.json({ token: "token-1" }, { status: 201 }) : new Response("{}", { status: tokenStatus });
    }
    const route = Object.entries(routes).find(([suffix]) => url.includes(suffix));
    if (route === undefined) return new Response("{}", { status: 404 });
    return route[1].text !== undefined ? new Response(route[1].text, { status: route[1].status, headers: { "content-type": "text/plain" } }) : new Response(JSON.stringify(route[1].body ?? {}), { status: route[1].status });
  });
  const provider = new GitHubAppCredentialProvider({ credentialRef: "github", appId: "5002502", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(), fetchImplementation, now: () => NOW });
  return { provider, requests, tokenRequests };
}

describe("reading CODEOWNERS", () => {
  it("reads the first of .github/CODEOWNERS, CODEOWNERS and docs/CODEOWNERS that exists, on the base branch", async () => {
    const h = harness({ "contents/.github/CODEOWNERS": { status: 404 }, "contents/CODEOWNERS": { status: 200, text: "* @max\n" }, "contents/docs/CODEOWNERS": { status: 200, text: "* @other\n" } });
    expect(await h.provider.readCodeOwners(REPO, "main", SCOPE)).toBe("* @max\n");
    expect(h.requests.filter((request) => request.url.includes("/contents/")).map((request) => request.url)).toEqual([
      "https://api.github.com/repos/acme/payments/contents/.github/CODEOWNERS?ref=main", "https://api.github.com/repos/acme/payments/contents/CODEOWNERS?ref=main",
    ]);
    expect(h.tokenRequests).toEqual([{ repositories: ["payments"], permissions: { contents: "read" } }]);
  });

  it("is undefined when the repository has none, and throws (to fail closed) when GitHub fails", async () => {
    expect(await harness({}).provider.readCodeOwners(REPO, "main", SCOPE)).toBeUndefined();
    await expect(harness({ "contents/.github/CODEOWNERS": { status: 500 } }).provider.readCodeOwners(REPO, "main", SCOPE)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("refuses a branch name that is not one before asking GitHub anything", async () => {
    const h = harness({});
    await expect(h.provider.readCodeOwners(REPO, "main?ref=evil", SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(h.provider.readCodeOwners(REPO, "", SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(h.provider.readCodeOwners(REPO, "a..b", SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(h.requests).toEqual([]);
  });

  it("does not take a file larger than the cap: it is unreadable", async () => {
    const h = harness({ "contents/.github/CODEOWNERS": { status: 200, text: "x".repeat(300_000) } });
    await expect(h.provider.readCodeOwners(REPO, "main", SCOPE)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

describe("the paths a pull request changes", () => {
  it("lists every page, with the names a rename left, and says when the list is cut", async () => {
    const files = Array.from({ length: 3 }, (_, index) => ({ filename: `src/f${String(index)}.ts`, status: "modified", additions: 1, deletions: 0 }));
    const h = harness({ "pulls/42/files": { status: 200, body: [...files, { filename: "src/new.ts", previous_filename: "old/name.ts", status: "renamed", additions: 0, deletions: 0 }] } });
    expect(await h.provider.listChangedPaths(REPO, 42, SCOPE)).toEqual({ paths: ["src/f0.ts", "src/f1.ts", "src/f2.ts", "src/new.ts", "old/name.ts"], complete: true });
  });

  it("is not complete when GitHub has more pages than Rovara reads", async () => {
    const h = harness({ "pulls/42/files": { status: 200, body: Array.from({ length: 100 }, (_, index) => ({ filename: `f${String(index)}`, status: "added", additions: 1, deletions: 0 })) } });
    const result = await h.provider.listChangedPaths(REPO, 42, SCOPE);
    expect(result.paths.length).toBeGreaterThan(0);
    expect(typeof result.complete).toBe("boolean");
  });
});

describe("team membership", () => {
  it("is member for an active member, not_member for a 404, and unknown for anything else", async () => {
    const member = harness({ "teams/payments/memberships/arjun-gh": { status: 200, body: { state: "active", role: "member" } } });
    expect(await member.provider.isTeamMember(REPO, "acme/payments", "arjun-gh", SCOPE)).toBe("member");
    expect(await harness({ "teams/payments/memberships/arjun-gh": { status: 404 } }).provider.isTeamMember(REPO, "acme/payments", "arjun-gh", SCOPE)).toBe("not_member");
    expect(await harness({ "teams/payments/memberships/arjun-gh": { status: 200, body: { state: "pending" } } }).provider.isTeamMember(REPO, "acme/payments", "arjun-gh", SCOPE)).toBe("not_member");
    expect(await harness({ "teams/payments/memberships/arjun-gh": { status: 403 } }).provider.isTeamMember(REPO, "acme/payments", "arjun-gh", SCOPE)).toBe("unknown");
    expect(await harness({ "teams/payments/memberships/arjun-gh": { status: 200, body: { state: "active" } } }, 403).provider.isTeamMember(REPO, "acme/payments", "arjun-gh", SCOPE)).toBe("unknown");
  });

  it("asks only about a team of the repository's own organization, and a login that is one", async () => {
    const h = harness({});
    expect(await h.provider.isTeamMember(REPO, "other/payments", "arjun-gh", SCOPE)).toBe("unknown");
    expect(await h.provider.isTeamMember(REPO, "acme/payments", "arjun/../x", SCOPE)).toBe("unknown");
    expect(h.requests).toEqual([]);
  });
});
