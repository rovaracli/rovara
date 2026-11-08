// tests/contract/admin-health.test.ts
// Spec 025 A13: health from injected probes; a probe that is missing or fails never fails the route.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { orgFailureIndexKey } from "../../packages/contracts/src/org-scoped-keys.js";

const TEST_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const probes = {
  release: "0.0.6",
  alarms: async () => [{ name: "agentx-live25d-SlackDeadLetters", state: "OK" }, { name: "agentx-live25d-ConnectorBroken", state: "ALARM" }],
  queueDepths: async () => [{ name: "dispatch", depth: 0 }, { name: "slack-requests", depth: 2 }],
  slackAuthCheck: async () => ({ ok: true as const, teamId: "T0BSHLLUGBD" }),
  githubInstallations: async () => 1,
};

describe("GET /v1/admin/health (FR-030, A13)", () => {
  it("answers every section from the probes and the state table", async () => {
    const { db, admin } = await createAdminReadBroker({ brokerExtra: { adminReads: { health: probes } } });
    const at = new Date(Date.now() - 3_600_000).toISOString();
    db.set({ ...orgFailureIndexKey(TEST_ORG, at, "11111111-1111-4111-8111-111111111111"), operationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222",
      project: "payments", origin: "slack", requester: { kind: "none" }, kind: "task", status: "FAILED", category: "worker_unavailable", error: "RUNTIME_UNAVAILABLE: no capacity", endedAt: at });
    const answer = await admin("GET", "/v1/admin/health");
    expect(answer.body).toEqual({
      version: { developerApi: "1.2", adminApi: "1.1", release: "0.0.6" },
      alarms: [{ name: "agentx-live25d-ConnectorBroken", state: "ALARM" }, { name: "agentx-live25d-SlackDeadLetters", state: "OK" }],
      alarmsCheck: { status: "warn", detail: "1 alarm in ALARM" },
      deadLetterQueues: [{ name: "dispatch", depth: 0 }, { name: "slack-requests", depth: 2 }],
      deadLetterQueuesCheck: { status: "warn", detail: "1 queue holds messages" },
      slack: { status: "ok", detail: "the bot token works for team T0BSHLLUGBD" },
      github: { status: "ok", detail: "installed on 1 account" },
      workerModes: [{ mode: "ec2-ebs", configured: true, latestDispatchFailure: { at, operationId: "11111111-1111-4111-8111-111111111111", error: "RUNTIME_UNAVAILABLE: no capacity" } }],
      workspaces: {}, workspacesTruncated: false, requestId: expect.any(String) as unknown,
    });
  });

  it("says unknown, with a reason, for a probe that is not set up or fails, and still answers", async () => {
    const failing = { alarms: async () => { throw Object.assign(new Error("denied"), { name: "AccessDenied" }); }, slackAuthCheck: async () => ({ ok: false as const, error: "token_revoked" }) };
    const { admin } = await createAdminReadBroker({ brokerExtra: { adminReads: { health: failing } } });
    const answer = await admin("GET", "/v1/admin/health");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      version: { developerApi: "1.2", adminApi: "1.1" },
      alarms: [], alarmsCheck: { status: "unknown", detail: "could not read the alarms (AccessDenied)" },
      deadLetterQueues: [], deadLetterQueuesCheck: { status: "unknown", detail: "not set up in this deployment" },
      slack: { status: "failed", detail: "Slack refused the bot token (token_revoked)" },
      github: { status: "unknown", detail: "not set up in this deployment" },
    });
    expect(answer.body.version).not.toHaveProperty("release");
  });

  it("warns, never all clear, when a listed alarm is missing, and counts it beside firing ones (issue 206)", async () => {
    const answer = async (alarms: Array<{ name: string; state: string }>) => {
      const { admin } = await createAdminReadBroker({ brokerExtra: { adminReads: { health: { alarms: async () => alarms } } } });
      return (await admin("GET", "/v1/admin/health")).body.alarmsCheck;
    };
    expect(await answer([{ name: "agentx-live25d-SlackDeadLetters", state: "MISSING" }, { name: "agentx-live25d-TurnErrors", state: "OK" }]))
      .toStrictEqual({ status: "warn", detail: "1 alarm missing" });
    expect(await answer([{ name: "agentx-live25d-SlackDeadLetters", state: "MISSING" }, { name: "agentx-live25d-TestAlarm", state: "MISSING" }, { name: "agentx-live25d-TurnErrors", state: "ALARM" }]))
      .toStrictEqual({ status: "warn", detail: "1 alarm in ALARM, 2 alarms missing" });
    expect(await answer([{ name: "agentx-live25d-TurnErrors", state: "OK" }])).toStrictEqual({ status: "ok", detail: "1 alarms, none in ALARM" });
  });

  it("gives up on a slow probe after its time limit", async () => {
    const slow = { githubInstallations: () => new Promise<number>(() => undefined), timeoutMs: 20 };
    const { admin } = await createAdminReadBroker({ brokerExtra: { adminReads: { health: slow } } });
    expect((await admin("GET", "/v1/admin/health")).body.github).toEqual({ status: "unknown", detail: "did not answer within 0.02 seconds" });
  });

  it("fails the Slack check when the bot token belongs to another team than the environment's (R17)", async () => {
    const other = { slackAuthCheck: async () => ({ ok: true as const, teamId: "T0OTHERTEAM" }) };
    const recorded = await createAdminReadBroker({ brokerExtra: { adminReads: { health: other } } });
    expect((await recorded.admin("GET", "/v1/admin/health")).body.slack).toEqual({ status: "failed", detail: "the bot token belongs to team T0OTHERTEAM, not this environment's team T0BSHLLUGBD" });
    const unrecorded = await createAdminReadBroker({ slackTeamId: null, brokerExtra: { adminReads: { health: other } } });
    expect((await unrecorded.admin("GET", "/v1/admin/health")).body.slack).toEqual({ status: "ok", detail: "the bot token works for team T0OTHERTEAM" });
  });

  it("counts GitHub App installations with the App's own token", async () => {
    const fetch = vi.fn(async () => Response.json([{ id: 1 }, { id: 2 }]));
    const provider = new GitHubAppCredentialProvider({ credentialRef: "github-app", appId: "123", getPrivateKey: async () => TEST_PRIVATE_KEY, fetchImplementation: fetch });
    expect(await provider.installationCount()).toBe(2);
    expect(String((fetch.mock.calls[0] as unknown as [string])[0])).toBe("https://api.github.com/app/installations?per_page=100");
  });
});

// Fix round 1 (review of Task 12): R18's queue check, and the paths the first tests left open.
describe("GET /v1/admin/health, each check's other answers", () => {
  const health = async (probes: Record<string, unknown>, options: Parameters<typeof createAdminReadBroker>[0] = {}) => {
    const { admin } = await createAdminReadBroker({ ...options, brokerExtra: { adminReads: { health: probes } } });
    return (await admin("GET", "/v1/admin/health")).body;
  };

  it("says the dead-letter queues are empty, hold messages, could not be read, or did not answer (R18)", async () => {
    expect((await health({ queueDepths: async () => [{ name: "dispatch", depth: 0 }, { name: "slack-requests", depth: 0 }] })).deadLetterQueuesCheck).toEqual({ status: "ok", detail: "2 queues, all empty" });
    expect((await health({ queueDepths: async () => [{ name: "dispatch", depth: 3 }, { name: "slack-requests", depth: 1 }] })).deadLetterQueuesCheck).toEqual({ status: "warn", detail: "2 queues hold messages" });
    expect((await health({ queueDepths: async () => [{ name: "dispatch", depth: 0 }, { name: "slack-requests", depth: null }] })).deadLetterQueuesCheck).toEqual({ status: "unknown", detail: "1 of 2 queues could not be read" });
    expect((await health({ queueDepths: async () => [{ name: "dispatch", depth: 4 }, { name: "slack-requests", depth: null }] })).deadLetterQueuesCheck).toEqual({ status: "warn", detail: "1 queue holds messages; 1 could not be read" });
    expect((await health({ queueDepths: async () => [] })).deadLetterQueuesCheck).toEqual({ status: "unknown", detail: "no dead-letter queues were listed" });
    const failing = await health({ queueDepths: async () => { throw Object.assign(new Error("denied"), { name: "AccessDenied" }); } });
    expect(failing).toMatchObject({ deadLetterQueues: [], deadLetterQueuesCheck: { status: "unknown", detail: "could not read the dead-letter queues (AccessDenied)" } });
    const slow = await health({ queueDepths: () => new Promise<never>(() => undefined), timeoutMs: 20 });
    expect(slow).toMatchObject({ deadLetterQueues: [], deadLetterQueuesCheck: { status: "unknown", detail: "did not answer within 0.02 seconds" } });
  });

  it("shows the team record's erase and source-delete failures of the last 24 hours, for the caller's own company only (SRL-6)", async () => {
    // no probe (the record is off): no such check at all, so nothing new shows on an install without the record
    expect(await health({})).not.toHaveProperty("teamRecordCheck");
    const asked: string[] = [];
    const answer = (counts: { eraseSweep: number; tombstone: number; lastAt?: string }) => ({ teamRecordFailures: async (orgId: string) => { asked.push(orgId); return counts; } });
    expect((await health(answer({ eraseSweep: 0, tombstone: 0 }))).teamRecordCheck).toEqual({ status: "ok", detail: "no erase or source delete failures in the last 24 hours" });
    expect((await health(answer({ eraseSweep: 1, tombstone: 0, lastAt: "2026-11-05T10:00:00.000Z" }))).teamRecordCheck).toEqual({ status: "warn", detail: "1 erase second pass failed or stuck in the last 24 hours; latest 2026-11-05T10:00:00.000Z" });
    expect((await health(answer({ eraseSweep: 2, tombstone: 3 }))).teamRecordCheck).toEqual({ status: "warn", detail: "2 erase second passes failed or stuck, 3 source deletes not accepted in the last 24 hours" });
    // the probe is asked for the caller's company, never another
    expect(asked).toEqual([TEST_ORG, TEST_ORG, TEST_ORG]);
    const failing = await health({ teamRecordFailures: async () => { throw Object.assign(new Error("secret detail"), { name: "AccessDenied" }); } });
    expect(failing.teamRecordCheck).toEqual({ status: "unknown", detail: "could not read the team record's delete and erase failures (AccessDenied)" });
    expect(JSON.stringify(failing)).not.toContain("secret detail");
    const slow = await health({ teamRecordFailures: () => new Promise<never>(() => undefined), timeoutMs: 20 });
    expect(slow.teamRecordCheck).toEqual({ status: "unknown", detail: "did not answer within 0.02 seconds" });
  });

  it("counts open workspaces by status and leaves closed ones out", async () => {
    const harness = await createAdminReadBroker();
    for (const ts of ["1695500000.000501", "1695500000.000502", "1695500000.000503"]) await ensureWorkspace(harness.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/${ts}`, "U0PRIYA001");
    const [first, second, third] = harness.db.find((item) => item.entityType === "WORKSPACE");
    // WorkspaceInstanceSchema requires closedAt on a closed workspace, as the close path writes it.
    harness.db.set({ ...first!, status: "CLOSED", closedAt: new Date().toISOString() });
    harness.db.set({ ...second!, status: "STOPPED" });
    harness.db.set({ ...third!, status: "READY" });
    const body = (await harness.admin("GET", "/v1/admin/health")).body;
    expect(body.workspaces).toEqual({ READY: 1, STOPPED: 1 });
    expect(body.workspaces).not.toHaveProperty("CLOSED");
    expect(body.workspacesTruncated).toBe(false);
  });

  it("says ec2-ebs is not configured when no project binds it", async () => {
    expect((await health({}, { register: false })).workerModes).toEqual([{ mode: "ec2-ebs", configured: false }]);
  });

  it("fails the GitHub check when the App is installed nowhere, and says Slack could not be reached as unknown", async () => {
    const body = await health({ githubInstallations: async () => 0, slackAuthCheck: async () => ({ ok: false as const, error: "slack_unavailable" }) });
    expect(body.github).toEqual({ status: "failed", detail: "the GitHub App is installed on no account" });
    expect(body.slack).toEqual({ status: "unknown", detail: "Slack could not be reached" });
  });

  it("throws RUNTIME_UNAVAILABLE for a failed or malformed installations answer", async () => {
    const provider = (answer: Response) => new GitHubAppCredentialProvider({ credentialRef: "github-app", appId: "123", getPrivateKey: async () => TEST_PRIVATE_KEY, fetchImplementation: vi.fn(async () => answer) });
    await expect(provider(new Response("no", { status: 401 })).installationCount()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: "RUNTIME_UNAVAILABLE: GitHub App installations lookup failed with HTTP 401" });
    await expect(provider(Response.json({ installations: [] })).installationCount()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: "RUNTIME_UNAVAILABLE: GitHub returned an invalid installations response" });
  });
});

// SRL-5a: the App's webhook delivery list and redelivery request, with the App's own token.
describe("the GitHub App's webhook deliveries", () => {
  const provider = (fetch: typeof globalThis.fetch) => new GitHubAppCredentialProvider({ credentialRef: "github-app", appId: "123", getPrivateKey: async () => TEST_PRIVATE_KEY, fetchImplementation: fetch });

  it("lists a page newest first with the cursor of the next page, and leaves out an entry GitHub states badly", async () => {
    const good = { id: 11, guid: "00000000-0000-4000-8000-000000000011", delivered_at: "2026-11-08T10:00:00Z", redelivery: false, event: "issue_comment", action: "deleted", status_code: 503, installation_id: 5 };
    const fetch = vi.fn(async () => new Response(JSON.stringify([good, { ...good, id: "x" }, { ...good, id: 12, status_code: 0, action: null, redelivery: true }, { ...good, id: 13, delivered_at: "never" }]), {
      status: 200, headers: { link: '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=v1_abc%3D>; rel="next", <https://api.github.com/app/hook/deliveries?per_page=100&cursor=v1_zzz>; rel="prev"' },
    }));
    const page = await provider(fetch).listWebhookDeliveries({ perPage: 500, cursor: "v1_prev" });
    expect(page.entries).toEqual([
      { id: 11, guid: good.guid, deliveredAt: "2026-11-08T10:00:00.000Z", redelivery: false, event: "issue_comment", action: "deleted", statusCode: 503 },
      { id: 12, guid: good.guid, deliveredAt: "2026-11-08T10:00:00.000Z", redelivery: true, event: "issue_comment", action: null, statusCode: 0 },
    ]);
    expect(page.next).toBe("v1_abc=");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/app/hook/deliveries?per_page=100&cursor=v1_prev");
    expect(String((init.headers as Record<string, string>).authorization)).toMatch(/^Bearer /u);
  });

  it("has no next cursor on the last page, and throws (never an empty answer) when GitHub does not answer the list", async () => {
    expect((await provider((async () => Response.json([]))).listWebhookDeliveries({ perPage: 100 })).next).toBeUndefined();
    await expect(provider((async () => new Response("no", { status: 401 }))).listWebhookDeliveries({ perPage: 100 })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(provider((async () => Response.json({ not: "a list" }))).listWebhookDeliveries({ perPage: 100 })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("asks for a redelivery with a POST: 202 is requested, ONLY 404 is gone, and anything else (422 \"spammed\" included) throws", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 202 }));
    expect(await provider(fetch).redeliverWebhookDelivery(42)).toBe("requested");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/app/hook/deliveries/42/attempts");
    expect(init.method).toBe("POST");
    expect(await provider((async () => new Response("", { status: 404 }))).redeliverWebhookDelivery(42)).toBe("gone");
    for (const status of [422, 500, 403, 429, 301]) {
      await expect(provider((async () => new Response("", { status }))).redeliverWebhookDelivery(42), String(status)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    }
    await expect(provider(fetch).redeliverWebhookDelivery(0)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("ends a delivery call at the caller's deadline", async () => {
    const aborted = vi.fn(async (_url: unknown, init?: RequestInit) => { await new Promise((resolve) => init?.signal?.addEventListener("abort", resolve)); throw new Error("aborted"); });
    await expect(provider(aborted as never).listWebhookDeliveries({ perPage: 10, signal: AbortSignal.timeout(20) })).rejects.toThrow();
  });

  describe("what an installation still holds (the repository check)", () => {
    const repositoriesFetch = (options: { pages?: number[][]; direct?: Record<number, number>; tokenStatus?: number }) => vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/access_tokens")) return options.tokenStatus === undefined ? Response.json({ token: ["inst", "token"].join("-"), expires_at: "2099-01-01T00:00:00Z" }, { status: 201 }) : new Response("no", { status: options.tokenStatus });
      if (url.pathname === "/installation/repositories") {
        const page = Number(url.searchParams.get("page") ?? "1");
        return Response.json({ repositories: (options.pages?.[page - 1] ?? []).map((id) => ({ id, full_name: `acme/r${id}`, private: true, default_branch: "main" })) });
      }
      const direct = /^\/repositories\/(\d+)$/u.exec(url.pathname);
      if (direct !== null) return new Response("{}", { status: options.direct?.[Number(direct[1])] ?? 200 });
      return new Response("unexpected", { status: 500 });
    });

    it("opens an installation: the ids it reaches, whether the list is certainly complete (not when it filled every page), and ONE token for the list and every lookup", async () => {
      const fetch = repositoriesFetch({ pages: [[5, 6, 7]], direct: { 5: 200, 6: 404 } });
      const view = await provider(fetch).installationRepositoryView(9, { system: "private-install" });
      expect(view).toMatchObject({ ids: [5, 6, 7], complete: true });
      expect(await view.status(5)).toBe("exists");
      expect(await view.status(6)).toBe("missing");
      expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/access_tokens"))).toHaveLength(1);
      const full = Array.from({ length: 100 }, (_, index) => index + 1);
      const filled = await provider(repositoriesFetch({ pages: Array.from({ length: 10 }, () => full) })).installationRepositoryView(9, { system: "private-install" });
      expect(filled.complete).toBe(false);
    });

    it("answers a repository by id: 200 exists, 404 missing, and anything else (403, 429, 500, a redirect) throws, so it can never read as gone", async () => {
      const status = async (code: number) => (await provider(repositoriesFetch({ direct: { 5: code } })).installationRepositoryView(9, { system: "private-install" })).status(5);
      expect(await status(200)).toBe("exists");
      expect(await status(404)).toBe("missing");
      for (const code of [301, 403, 429, 500]) await expect(status(code), String(code)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    });

    it("throws when the installation token cannot be minted (an uninstalled App is not a deletion)", async () => {
      await expect(provider(repositoriesFetch({ tokenStatus: 404 })).installationRepositoryView(9, { system: "private-install" })).rejects.toBeDefined();
    });

    it("ends every call, the token mint, the list and a lookup, at the caller's deadline", async () => {
      const hang = vi.fn(async (_url: unknown, init?: RequestInit) => { await new Promise((resolve) => init?.signal?.addEventListener("abort", resolve)); throw new Error("aborted"); });
      const started = Date.now();
      await expect(provider(hang as never).installationRepositoryView(9, { system: "private-install" }, AbortSignal.timeout(50))).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(3_000);
    });
  });
});
