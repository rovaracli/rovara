import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";

/**
 * Staging v0.4.9: a clone that asked for a token GitHub had just issued sometimes got "remote: Repository not found" and, a minute later, the same
 * repository cloned. The broker now checks the new token against GitHub's git endpoint (the one `git clone` calls first) before it hands the token to the
 * worker, and waits a little while GitHub answers 404 for it.
 */
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const REPOSITORY = "https://github.com/PrepLabsAI/Sample-Project-A.git";
const SCOPE = { system: "install" } as const;

function github(options: { probeStatuses?: Array<number | "throw">; readiness?: boolean; delaysMs?: number[] } = {}) {
  const probes: Array<{ url: string; headers: Record<string, string> }> = [];
  const statuses = [...(options.probeStatuses ?? [200])];
  const sleeps: number[] = [];
  const events: Array<Record<string, unknown>> = [];
  const mints: string[] = [];
  const fetchImplementation = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/installation$/.test(requestUrl)) {
      return new Response(JSON.stringify({ id: 173228775, account: { login: "PrepLabsAI" } }), { status: 200 });
    }
    if (requestUrl === "https://api.github.com/app/installations/173228775/access_tokens") {
      mints.push(typeof init?.body === "string" ? init.body : "");
      return new Response(JSON.stringify({ token: "ghs_secretvalue" }), { status: 201 });
    }
    if (requestUrl.startsWith("https://github.com/")) {
      probes.push({ url: requestUrl, headers: init?.headers as Record<string, string> });
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
      if (status === "throw") throw new Error("connect ETIMEDOUT");
      return new Response("", { status });
    }
    throw new Error(`unexpected request ${requestUrl}`);
  });
  const provider = new GitHubAppCredentialProvider({
    credentialRef: "github-agentx-sdlc", appId: "5389609", getPrivateKey: async () => pem, fetchImplementation,
    ...(options.readiness === false ? {} : {
      tokenReadiness: {
        ...(options.delaysMs === undefined ? {} : { delaysMs: options.delaysMs }),
        sleep: async (ms: number) => { sleeps.push(ms); },
        onProbe: (event) => { events.push({ ...event }); },
      },
    }),
  });
  return { provider, probes, sleeps, events, mints };
}

describe("a new repository token is accepted by GitHub's git endpoint before the worker gets it", () => {
  it("waits while GitHub answers 404 for the new token, then hands it over", async () => {
    const { provider, probes, sleeps, events } = github({ probeStatuses: [404, 404, 200], delaysMs: [100, 200, 400] });
    await expect(provider.resolve("github-agentx-sdlc", REPOSITORY, "clone", SCOPE)).resolves.toEqual({ username: "x-access-token", password: "ghs_secretvalue" });
    expect(probes).toHaveLength(3);
    expect(sleeps).toEqual([100, 200]);
    expect(probes[0]?.url).toBe("https://github.com/PrepLabsAI/Sample-Project-A.git/info/refs?service=git-upload-pack");
    expect(probes[0]?.headers.authorization).toBe(`Basic ${Buffer.from("x-access-token:ghs_secretvalue").toString("base64")}`);
    expect(events.map((event) => [event.attempt, event.status, event.outcome])).toEqual([[0, 404, "not_found"], [1, 404, "not_found"], [2, 200, "ready"]]);
    expect(events[2]).toMatchObject({ repository: "PrepLabsAI/Sample-Project-A", access: "clone" });
    // The token itself is never reported.
    expect(JSON.stringify(events)).not.toContain("ghs_secretvalue");
    expect(JSON.stringify(events)).not.toContain(Buffer.from("x-access-token:ghs_secretvalue").toString("base64"));
  });

  it("probes once, without waiting, when GitHub accepts the token at once", async () => {
    const { provider, probes, sleeps } = github({ probeStatuses: [200] });
    await provider.resolve("github-agentx-sdlc", REPOSITORY, "clone", SCOPE);
    expect(probes).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("checks a push token against the receive-pack service", async () => {
    const { provider, probes, mints } = github({ probeStatuses: [200] });
    await provider.resolve("github-agentx-sdlc", REPOSITORY, "push", SCOPE);
    expect(probes[0]?.url).toBe("https://github.com/PrepLabsAI/Sample-Project-A.git/info/refs?service=git-receive-pack");
    expect(JSON.parse(mints[0]!)).toEqual({ repositories: ["Sample-Project-A"], permissions: { contents: "write" } });
  });

  it("still hands the token over when GitHub keeps answering 404, so the worker reports GitHub's own error", async () => {
    const { provider, probes, sleeps, events } = github({ probeStatuses: [404], delaysMs: [100, 200] });
    await expect(provider.resolve("github-agentx-sdlc", REPOSITORY, "clone", SCOPE)).resolves.toEqual({ username: "x-access-token", password: "ghs_secretvalue" });
    expect(probes).toHaveLength(3);
    expect(sleeps).toEqual([100, 200]);
    expect(events.at(-1)).toMatchObject({ attempt: 2, status: 404, outcome: "not_found" });
  });

  it("stops waiting on any answer other than 404 and on a probe that fails", async () => {
    const forbidden = github({ probeStatuses: [403] });
    await forbidden.provider.resolve("github-agentx-sdlc", REPOSITORY, "clone", SCOPE);
    expect(forbidden.probes).toHaveLength(1);
    expect(forbidden.events[0]).toMatchObject({ status: 403, outcome: "other" });
    const failing = github({ probeStatuses: ["throw"] });
    await expect(failing.provider.resolve("github-agentx-sdlc", REPOSITORY, "clone", SCOPE)).resolves.toEqual({ username: "x-access-token", password: "ghs_secretvalue" });
    expect(failing.probes).toHaveLength(1);
    expect(failing.events[0]).toMatchObject({ outcome: "error" });
    expect(failing.events[0]).not.toHaveProperty("status");
  });

  it("does not probe unless the readiness check is configured", async () => {
    const { provider, probes } = github({ readiness: false });
    await provider.resolve("github-agentx-sdlc", REPOSITORY, "clone", SCOPE);
    expect(probes).toHaveLength(0);
  });
});
