// Plan 2, Task 15: the installation lifecycle (GitHub's own uninstall, suspend and repository changes), the org's list, disconnect and repository
// listing, and the check in front of every token an org's work mints. Everything runs against a fake table and a fake GitHub that records every
// request, so "no token was minted" is read off the record rather than assumed.
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PROJECT_REVISION_SK_PREFIX, agentXError, projectRevisionKey, githubAuditKey, githubInstallationEverBoundKey, githubInstallationKey, orgGithubInstallationKey, projectPk, type GithubInstallationRecord, type OrgId,
} from "@agentx/contracts";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { handleGithubWebhook } from "../../packages/broker/src/aws/github-webhooks.js";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/github-app.js";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import {
  applyInstallationLifecycle, disconnectGithubInstallation, installationBindingCheck, listGithubInstallations, requireInstallationBound, requireRepositoriesConnected,
  requireRepositoryConnected, type GithubConnectionDependencies, type RepositoryGateDependencies,
} from "../../packages/broker/src/org/github-connection.js";
import { githubNotConnectedMessage } from "../../packages/broker/src/org/project-settings.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, ensureWorkspace } from "../support/slack-broker.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const SECRET = "whsec-installations";
const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const ADMIN = { subject: "admin-subject", admin: true };
const NOT_CONNECTED = githubNotConnectedMessage("example/demo");
const SCOPE_A = { orgId: TEST_ORG } as const;

/** The error's own message carries its code; what a person is told (the HTTP body) is the text after it. */
const refusal = async (action: Promise<unknown>) => {
  const caught = await action.then(() => undefined, (thrown: unknown) => thrown as { code: string; message: string; statusCode: number });
  if (caught === undefined) throw new Error("expected a refusal");
  return { code: caught.code, statusCode: caught.statusCode, message: caught.message.replace(/^[A-Z_]+: /, "") };
};

let privateKey = "";
beforeAll(() => {
  privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});
const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Repo { id: number; full_name: string; private: boolean; default_branch: string }
const repo = (name: string, id: number, isPrivate = true): Repo => ({ id, full_name: `example/${name}`, private: isPrivate, default_branch: "main" });

/** GitHub as the provider sees it: which installation covers each owner, and every request made, recorded as `METHOD path`. */
function fakeGithub(options: { installationOf?: Record<string, number>; repositories?: Record<number, Repo[]> } = {}) {
  const installationOf = options.installationOf ?? { example: 55 };
  const repositories = options.repositories ?? { 55: [repo("demo", 9001), repo("website", 9002)] };
  const requests: string[] = [];
  const tokenInstallation = new Map<string, number>();
  /** Repositories (`owner/name`) the installation no longer reaches: GitHub answers 404 for their installation and 422 to a token asked for them. */
  const uncovered = new Set<string>();
  /** How the repository-installation lookup fails, when it does: GitHub answering 502, or the request timing out as `fetch` reports it. */
  const lookupFault: { current?: "http-502" | "timeout" } = {};
  const minted = () => requests.filter((request) => /^POST \/app\/installations\/\d+\/access_tokens/.test(request));
  const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}${url.search}`);
    let match = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(url.pathname);
    if (match !== null) {
      if (lookupFault.current === "http-502") return Response.json({ message: "Bad Gateway" }, { status: 502 });
      if (lookupFault.current === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      const id = uncovered.has(`${match[1]}/${match[2]}`) ? undefined : installationOf[match[1]!];
      return id === undefined ? Response.json({ message: "Not Found" }, { status: 404 }) : Response.json({ id, account: { login: match[1] } });
    }
    match = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (match !== null) {
      const asked = (JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { repositories?: string[] }).repositories ?? [];
      if (asked.some((name) => uncovered.has(`example/${name}`))) return Response.json({ message: "Unprocessable" }, { status: 422 });
      const token = `token-${String(minted().length)}`;
      tokenInstallation.set(token, Number(match[1]));
      return Response.json({ token }, { status: 201 });
    }
    if (url.pathname === "/installation/repositories") {
      const id = tokenInstallation.get((init?.headers as Record<string, string>)["authorization"]!.replace("Bearer ", "")) ?? 0;
      const page = Number(url.searchParams.get("page") ?? "1");
      const all = repositories[id] ?? [];
      return Response.json({ total_count: all.length, repositories: all.slice((page - 1) * 100, page * 100) });
    }
    match = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(url.pathname);
    if (match !== null) return new Response("file text", { status: 200 });
    match = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (match !== null) return Response.json({ id: 9001, full_name: `${match[1]}/${match[2]}`, default_branch: "main" });
    return Response.json({ message: "unexpected" }, { status: 500 });
  }) as typeof fetch;
  return { fetchImplementation, requests, minted, installationOf, uncovered, lookupFault };
}

type World = Awaited<ReturnType<typeof world>>;

/** A cloud broker over a table, with the real GitHub App provider wired to the fake GitHub and (cloud) the binding check, as production wires it. */
async function world(options: { cloud?: boolean; bound?: false | { orgId?: OrgId; status?: GithubInstallationRecord["status"]; selection?: "all" | "selected" }; github?: Parameters<typeof fakeGithub>[0] } = {}) {
  const cloud = options.cloud ?? true;
  const github = fakeGithub(options.github);
  const ref: { db?: FakeDynamoDb } = {};
  const provider = new GitHubAppCredentialProvider({
    credentialRef: "github-app", appId: "123", getPrivateKey: async () => privateKey, fetchImplementation: github.fetchImplementation, now: () => NOW,
    ...(cloud ? { requireInstallationBound: (orgId, installationId, repository) => installationBindingCheck({ documentClient: ref.db!, tableName: "state" })(orgId, installationId, repository) } : {}),
  });
  const grants = new RepositoryGrantService(Buffer.alloc(32, 4), (reference, url, access, scope) => provider.resolve(reference, url, access, scope));
  const harness = await createDeveloperTaskBroker({
    brokerExtra: {
      ...(cloud ? { cloud: true, cloudProjects: { githubCredentialRef: "github-app", runtimeBinding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" } } } : {}), githubWebhookSecret: async () => SECRET, repositoryGrants: grants,
      githubPullRequests: Object.assign(provider, { /* the real provider answers every method the broker asks of it */ }),
    },
  });
  const db = harness.db;
  ref.db = db;
  seedMembership(db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
  const bind = (id: number, over: { orgId?: OrgId; status?: GithubInstallationRecord["status"]; selection?: "all" | "selected" } = {}) => {
    const orgId = over.orgId ?? TEST_ORG;
    const record: GithubInstallationRecord = {
      installationId: id, orgId, accountLogin: "example", accountId: 900, accountType: "Organization", repositorySelection: over.selection ?? "selected",
      installedByGithubUserId: "4343", boundByDeveloperId: OMAR.developerId, status: over.status ?? "active", boundAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    };
    db.set({ ...githubInstallationKey(id), entityType: "GITHUB_INSTALLATION", ...record });
    db.set({ ...orgGithubInstallationKey(orgId, id), entityType: "ORG_GITHUB_INSTALLATION", ...record });
    db.set({ ...githubInstallationEverBoundKey(id), entityType: "GITHUB_INSTALLATION_EVER_BOUND", firstBoundAt: "2026-10-01T00:00:00.000Z", firstOrgId: orgId });
  };
  if (cloud && options.bound !== false) bind(55, options.bound === undefined ? {} : options.bound);
  const signed = (event: string, payload: object, deliveryId: string = randomUUID()) => {
    const raw = JSON.stringify(payload);
    return harness.handler({
      version: "2.0", routeKey: "POST /v1/github/webhooks", rawPath: "/v1/github/webhooks", rawQueryString: "",
      headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`, "x-github-delivery": deliveryId, "x-github-event": event },
      body: raw, requestContext: { requestId: randomUUID(), http: { method: "POST" } },
    });
  };
  const lifecycle = (action: string, id = 55, deliveryId?: string, installation: Record<string, unknown> = {}) => signed("installation", { action, installation: { id, ...installation }, sender: { id: 777, login: "gh-admin" } }, deliveryId);
  const start = (extra: Record<string, unknown> = {}) => harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code", ...extra });
  const bindingOf = () => db.get(githubInstallationKey(55)) as (GithubInstallationRecord & Record<string, unknown>) | undefined;
  const copyOf = () => db.get(orgGithubInstallationKey(TEST_ORG, 55)) as (GithubInstallationRecord & Record<string, unknown>) | undefined;
  return { ...harness, db, github, provider, grants, bind, signed, lifecycle, start, bindingOf, copyOf };
}

const error = (response: { body: Record<string, unknown> }) => response.body.error as { code: string; message: string };
/** What a start would have written for a task. */
const taskWrites = (w: World) => w.db.find((item) => item.entityType === "DEVELOPER_TASK" || item.entityType === "OPERATION" || (typeof item.pk === "string" && (item.pk.startsWith("WORKSPACE#") || item.pk.includes("DEVELOPER_LIMIT"))));

describe("the installation lifecycle webhooks", () => {
  it("installation.deleted marks the binding removed on both of its keys, audits it, answers 202, and the next task start is refused with the exact message and writes nothing", async () => {
    const w = await world();
    expect((await w.start()).status).toBe(200);
    const before = taskWrites(w).length;
    const commands = w.db.commandNames().length;

    const reply = await w.lifecycle("deleted");
    expect(reply.statusCode).toBe(202);
    expect(w.bindingOf()).toMatchObject({ status: "removed", orgId: TEST_ORG });
    expect(w.copyOf()).toMatchObject({ status: "removed" });
    expect(w.db.find((item) => item.pk === githubAuditKey(TEST_ORG, "x", "y").pk)).toEqual([expect.objectContaining({ action: "installation_removed", installationId: 55 })]);

    const refused = await w.start();
    expect(refused.status).toBe(403);
    expect(error(refused)).toEqual({ code: "GITHUB_NOT_CONNECTED", message: NOT_CONNECTED });
    expect(error(refused).message).toBe("Rovara can't reach example/demo through your organization's GitHub connection. Connect it with: agentx github connect");
    // No workspace, operation or limit-charge item, and no transaction at all after the webhook's own.
    expect(taskWrites(w)).toHaveLength(before);
    expect(w.db.commandNames().slice(commands).filter((name) => name === "TransactWriteCommand")).toHaveLength(1);
  });

  it("a new Slack thread is new work too: with the installation removed, ensuring its workspace is refused and writes no workspace", async () => {
    const w = await world();
    const thread = (ts: string) => `${SLACK_TEAM}/${SLACK_CHANNEL}/${ts}`;
    const control = await ensureWorkspace(w.handler, thread("1695500000.000001"), MAYA.slackUserId!);
    expect(control.status).toBe(200);
    const workspaces = () => w.db.find((item) => typeof item.pk === "string" && item.pk.startsWith("WORKSPACE#") && item.sk === "META").length;
    const before = workspaces();
    expect((await w.lifecycle("deleted")).statusCode).toBe(202);
    const refused = await ensureWorkspace(w.handler, thread("1695500000.000002"), MAYA.slackUserId!);
    expect(refused.status).toBe(403);
    expect(error(refused)).toEqual({ code: "GITHUB_NOT_CONNECTED", message: NOT_CONNECTED });
    expect(workspaces()).toBe(before);
  });

  it("suspend refuses starts the same way, and unsuspend restores them; a removed installation never comes back", async () => {
    const w = await world();
    expect((await w.lifecycle("suspend")).statusCode).toBe(202);
    expect(w.bindingOf()).toMatchObject({ status: "suspended" });
    expect(error(await w.start())).toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    expect((await w.lifecycle("unsuspend")).statusCode).toBe(202);
    expect(w.bindingOf()).toMatchObject({ status: "active" });
    expect((await w.start()).status).toBe(200);

    expect((await w.lifecycle("deleted")).statusCode).toBe(202);
    for (const action of ["unsuspend", "suspend"]) await w.lifecycle(action);
    expect(w.bindingOf()).toMatchObject({ status: "removed" });
    expect(w.copyOf()).toMatchObject({ status: "removed" });
  });

  it("installation_repositories updates repositorySelection on both keys; a delivery that changes nothing is ignored", async () => {
    const w = await world();
    const change = (selection: "all" | "selected", id = randomUUID()) => w.signed("installation_repositories", { action: "added", installation: { id: 55 }, repository_selection: selection, sender: { id: 777, login: "gh-admin" } }, id);
    expect((await change("all")).statusCode).toBe(202);
    expect(w.bindingOf()).toMatchObject({ repositorySelection: "all" });
    expect(w.copyOf()).toMatchObject({ repositorySelection: "all" });
    const audits = () => w.db.find((item) => item.pk === githubAuditKey(TEST_ORG, "x", "y").pk).length;
    expect(audits()).toBe(1);
    expect((await change("all")).statusCode).toBe(202);
    expect(audits()).toBe(1);
    expect((await change("selected")).statusCode).toBe(202);
    expect(w.bindingOf()).toMatchObject({ repositorySelection: "selected" });
  });

  it("a delivery for an installation nobody bound is logged and ignored: 202, no write", async () => {
    const w = await world();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const before = structuredClone([...w.db.items]);
    const reply = await w.lifecycle("deleted", 999);
    expect(reply.statusCode).toBe(202);
    expect([...w.db.items]).toEqual(before);
    expect(log.mock.calls.map((entry) => String(entry[0]))).toContainEqual(expect.stringContaining("github.installation_unbound"));
  });

  it("answers a replay of the same delivery without changing anything again, and checks the signature as every delivery is", async () => {
    const w = await world();
    const id = randomUUID();
    await w.lifecycle("suspend", 55, id);
    await w.lifecycle("unsuspend", 55, randomUUID());
    // The replay of the first delivery must not suspend an installation that was unsuspended since.
    expect((await w.lifecycle("suspend", 55, id)).statusCode).toBe(202);
    expect(w.bindingOf()).toMatchObject({ status: "active" });

    const raw = JSON.stringify({ action: "deleted", installation: { id: 55 }, sender: { id: 1, login: "x" } });
    const forged = await w.handler({
      version: "2.0", routeKey: "POST /v1/github/webhooks", rawPath: "/v1/github/webhooks", rawQueryString: "",
      headers: { "x-hub-signature-256": `sha256=${"0".repeat(64)}`, "x-github-delivery": randomUUID(), "x-github-event": "installation" },
      body: raw, requestContext: { requestId: randomUUID(), http: { method: "POST" } },
    });
    expect(forged.statusCode).toBe(403);
    expect(w.bindingOf()).toMatchObject({ status: "active" });
  });

  it("an action Rovara does not follow is accepted and changes nothing; the same event on an install without the handler stays unsupported", async () => {
    const w = await world();
    const before = structuredClone([...w.db.items]);
    expect((await w.lifecycle("new_permissions_accepted")).statusCode).toBe(202);
    expect([...w.db.items]).toEqual(before);

    const raw = JSON.stringify({ action: "deleted", installation: { id: 55 }, sender: { id: 1, login: "x" } });
    await expect(handleGithubWebhook({
      documentClient: w.db, tableName: "state", rawBody: raw, secret: SECRET, now: () => new Date(NOW).toISOString(),
      headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`, "x-github-delivery": randomUUID(), "x-github-event": "installation" },
      authorizeRepository: async () => false, process: async () => undefined, installationCreated: async () => undefined,
    })).rejects.toThrow("unsupported or incomplete");
  });

  it("an org copy that is missing still lets the binding every token checks change", async () => {
    const w = await world();
    w.db.delete(orgGithubInstallationKey(TEST_ORG, 55));
    expect((await w.lifecycle("deleted")).statusCode).toBe(202);
    expect(w.bindingOf()).toMatchObject({ status: "removed" });
    const deps = { documentClient: w.db, tableName: "state", now: () => NOW };
    expect(await applyInstallationLifecycle(deps, randomUUID(), { kind: "installation", action: "deleted", installationId: 55 })).toBe("ignored");
  });
});

describe("requireInstallationBound", () => {
  const deps = (w: World) => ({ documentClient: w.db, tableName: "state" });

  it("passes only for an active binding to this org, and names the repository when it has one", async () => {
    const w = await world();
    await expect(requireInstallationBound(deps(w), TEST_ORG, 55)).resolves.toBeUndefined();
    for (const [label, mutate] of [
      ["another org", () => w.bind(55, { orgId: ORG_B })],
      ["suspended", () => w.bind(55, { status: "suspended" })],
      ["removed", () => w.bind(55, { status: "removed" })],
      ["missing", () => w.db.delete(githubInstallationKey(55))],
    ] as const) {
      mutate();
      expect(await refusal(requireInstallationBound(deps(w), TEST_ORG, 55, { owner: "example", name: "demo" })), label).toEqual({ code: "GITHUB_NOT_CONNECTED", statusCode: 403, message: NOT_CONNECTED });
      await expect(requireInstallationBound(deps(w), TEST_ORG, 55), label).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED", statusCode: 403 });
    }
  });

  it("an installation bound to org B refuses a mint scoped to org A, and mints nothing", async () => {
    const w = await world({ bound: { orgId: ORG_B } });
    await expect(w.provider.getPullRequest("https://github.com/example/demo.git", 1, SCOPE_A)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    expect(w.github.minted()).toEqual([]);
    // Org B's own scope passes the check (the fake GitHub then has no such pull request: any failure but GITHUB_NOT_CONNECTED will do).
    await expect(w.provider.getPullRequest("https://github.com/example/demo.git", 1, { orgId: ORG_B })).rejects.not.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    expect(w.github.minted().length).toBeGreaterThan(0);
  });
});

describe("requireRepositoryConnected and requireRepositoriesConnected", () => {
  const gate = (w: World, over: Partial<RepositoryGateDependencies> = {}): RepositoryGateDependencies => ({
    documentClient: w.db, tableName: "state", cloud: true,
    app: {
      installationForRepository: (owner, name, options) => w.provider.installationForRepository(owner, name, options),
      repositoryIdentity: (url, scope) => w.provider.getRepositoryIdentity(url, scope),
    },
    ...over,
  });

  it("returns the installation and GitHub's id of the repository, after the binding was checked", async () => {
    const w = await world();
    expect(await requireRepositoryConnected(gate(w), TEST_ORG, "example", "demo")).toEqual({ installationId: 55, githubRepositoryId: 9001 });
    w.bind(55, { orgId: ORG_B });
    expect(await refusal(requireRepositoryConnected(gate(w), TEST_ORG, "example", "demo"))).toMatchObject({ code: "GITHUB_NOT_CONNECTED", message: NOT_CONNECTED });
  });

  it("a repository the App is not installed on is not connected", async () => {
    const w = await world({ github: { installationOf: {} } });
    expect(await refusal(requireRepositoryConnected(gate(w), TEST_ORG, "example", "demo"))).toMatchObject({ code: "GITHUB_NOT_CONNECTED", message: NOT_CONNECTED });
    await expect(requireRepositoriesConnected(gate(w), TEST_ORG, { repositories: [{ url: "https://github.com/example/demo.git" }] })).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
  });

  it("a project entry that pins installation 55, with the repository now under installation 77 bound to the same org, is refused; an unpinned entry is not", async () => {
    const w = await world({ github: { installationOf: { example: 77 } }, bound: false });
    w.bind(77);
    const project = (installationId?: number) => ({ repositories: [{ url: "https://github.com/example/demo.git", ...(installationId === undefined ? {} : { installationId }) }] });
    expect(await refusal(requireRepositoriesConnected(gate(w), TEST_ORG, project(55)))).toMatchObject({ code: "GITHUB_NOT_CONNECTED", message: NOT_CONNECTED });
    await expect(requireRepositoryConnected(gate(w), TEST_ORG, "example", "demo", 55)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    await expect(requireRepositoriesConnected(gate(w), TEST_ORG, project(77))).resolves.toBeUndefined();
    await expect(requireRepositoriesConnected(gate(w), TEST_ORG, project())).resolves.toBeUndefined();
  });

  it("through the broker: a task start in a project whose entry pins installation 55 is refused when the repository is under 77", async () => {
    const w = await world({ github: { installationOf: { example: 77 } }, bound: false });
    w.bind(77);
    const register = (revision: number, installationId: number) => call(w.handler, {
      method: "POST", path: "/v1/admin/projects", user: ADMIN,
      body: {
        definition: {
          name: "payments", revision,
          repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app", installationId, githubRepositoryId: 9001 }],
          setup: [], readiness: [], orchestratorInstructions: "Delegate work.", developerTasks: {},
        },
        runtimeBinding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" },
      },
    });
    expect((await register(2, 55)).status).toBe(201);
    const refused = await w.start();
    expect(refused.status).toBe(403);
    expect(error(refused)).toEqual({ code: "GITHUB_NOT_CONNECTED", message: NOT_CONNECTED });
    expect((await register(3, 77)).status).toBe(201);
    expect((await w.start()).status).toBe(200);
  });

  it("not cloud: it returns after the lookups, reading no binding", async () => {
    const w = await world({ cloud: false });
    const reads = vi.spyOn(w.db, "send");
    expect(await requireRepositoryConnected(gate(w, { cloud: false }), TEST_ORG, "example", "demo", 1)).toEqual({ installationId: 55, githubRepositoryId: 9001 });
    await expect(requireRepositoriesConnected(gate(w, { cloud: false }), TEST_ORG, { repositories: [{ url: "https://github.com/example/demo.git" }] })).resolves.toBeUndefined();
    expect(reads).not.toHaveBeenCalled();
  });
});

describe("every token an org's work mints", () => {
  it("after DELETE, a continue on an existing task is refused, and the fake GitHub saw no token request", async () => {
    const w = await world();
    const started = await w.start();
    expect(started.status).toBe(200);
    const taskId = (started.body.task as { taskId: string }).taskId;
    const task = w.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    const finishActive = async () => w.finish(task.workspaceId, String((w.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId), "SUCCEEDED");
    // The preparation, then the task's first turn: after both the task waits for its next instruction.
    await finishActive();
    await finishActive();

    const continued = () => w.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "Keep going" });
    expect((await continued()).status).toBe(200);
    // Finish that turn too, so only the connection can stand in the way of the next one.
    await finishActive();

    // The owner disconnects through the route, which is what a real disconnect does.
    const deleted = await w.dev(OMAR, "DELETE", "/v1/app/github/installations/55");
    expect(deleted.status).toBe(200);
    const mintsBefore = w.github.minted().length;
    const refused = await continued();
    expect(refused.status).toBe(403);
    expect(error(refused)).toEqual({ code: "GITHUB_NOT_CONNECTED", message: NOT_CONNECTED });
    expect(w.github.minted()).toHaveLength(mintsBefore);
  });

  it("after DELETE, the worker's repository credential exchange, a publication and a feedback review are each refused, and no token is requested", async () => {
    const w = await world();
    const started = await w.start();
    const taskId = (started.body.task as { taskId: string }).taskId;
    const task = w.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    const outbox = w.db.find((item) => item.entityType === "OUTBOX")[0] as { operationId: string; invocation: { callbackCapability: string; payload: { repositoryGrant: string } } };
    const exchange = () => call(w.handler, {
      method: "POST", path: `/v1/internal/workspaces/${task.workspaceId}/operations/${outbox.operationId}/repository-credentials`,
      headers: { "x-agentx-repository-grant": outbox.invocation.payload.repositoryGrant, "x-agentx-callback-capability": outbox.invocation.callbackCapability },
      body: { credentialRef: "github-app", repositoryUrl: "https://github.com/example/demo.git", access: "clone" },
    });
    // Control: connected, the exchange mints (and the answer carries the token).
    const connected = await exchange();
    expect(connected.status).toBe(200);
    expect(w.github.minted()).toHaveLength(1);

    expect((await w.dev(OMAR, "DELETE", "/v1/app/github/installations/55")).status).toBe(200);
    const url = "https://github.com/example/demo.git";
    const refused = await exchange();
    expect(refused.status).toBe(403);
    expect(error(refused)).toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    await expect(w.provider.reconcilePullRequest({ repositoryUrl: url, headBranch: "agentx/x", baseBranch: "main", title: "t" }, SCOPE_A)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    await expect(w.provider.getPullRequestFeedback(url, 1, SCOPE_A)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    await expect(w.provider.updatePullRequest(url, 1, { state: "closed" }, SCOPE_A)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    await expect(w.provider.getCommitTree(url, "a".repeat(40), SCOPE_A)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    await expect(w.provider.issueCredentials({ credentialRef: "github-app", url }, "read", SCOPE_A)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    await expect(w.provider.captureE2ESourceSnapshot(url, "main", SCOPE_A)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    expect(w.github.minted()).toHaveLength(1);
  });

  it("a read token reused for 5 minutes is not reused after the disconnect: the check runs on every read", async () => {
    const w = await world();
    const url = "https://github.com/example/demo.git";
    const sha = "a".repeat(40);
    expect(await w.provider.getFileAtCommit(url, "src/a.ts", sha, SCOPE_A)).toBe("file text");
    expect(await w.provider.getFileAtCommit(url, "src/a.ts", sha, SCOPE_A)).toBe("file text");
    expect(w.github.minted()).toHaveLength(1);
    w.bind(55, { status: "removed" });
    const requests = w.github.requests.length;
    await expect(w.provider.getFileAtCommit(url, "src/b.ts", sha, SCOPE_A)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    // Only the installation lookup (a JWT call that mints nothing) happened: no content request carried the cached token.
    expect(w.github.requests.slice(requests).filter((request) => request.includes("/contents/"))).toEqual([]);
  });

  it("an App reinstalled over a cached installation (a new id) is found again: the refusal stands only when GitHub's current installation is not the org's either", async () => {
    const world_ = await world({ bound: false });
    world_.bind(55);
    const url = "https://github.com/example/demo.git";
    expect(await world_.provider.getFileAtCommit(url, "src/a.ts", "a".repeat(40), SCOPE_A)).toBe("file text");
    // The org disconnects installation 55 and connects the reinstalled App as 88; GitHub now answers 88 for the account.
    world_.db.delete(githubInstallationKey(55));
    world_.db.delete(orgGithubInstallationKey(TEST_ORG, 55));
    world_.bind(88);
    world_.github.installationOf.example = 88;
    expect(await world_.provider.getFileAtCommit(url, "src/b.ts", "a".repeat(40), SCOPE_A)).toBe("file text");
    expect(await requireRepositoryConnected({
      documentClient: world_.db, tableName: "state", cloud: true,
      app: { installationForRepository: (owner, name, options) => world_.provider.installationForRepository(owner, name, options), repositoryIdentity: (u, scope) => world_.provider.getRepositoryIdentity(u, scope) },
    }, TEST_ORG, "example", "demo")).toEqual({ installationId: 88, githubRepositoryId: 9001 });
    // GitHub's current installation is not the org's: still refused.
    world_.bind(88, { orgId: ORG_B });
    await expect(world_.provider.getFileAtCommit(url, "src/c.ts", "a".repeat(40), SCOPE_A)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
  });

  it("a webhook's own verification and a system scope are never checked against an org", async () => {
    const w = await world({ bound: false });
    // No binding at all, and the system scopes still work: they name no org.
    await expect(w.provider.verifyWebhookRepository("https://github.com/example/demo.git", { installationId: 55, repositoryId: 9001, fullName: "example/demo" })).resolves.toBe(true);
    expect(await w.provider.getFileAtCommit("https://github.com/example/demo.git", "src/a.ts", "a".repeat(40), { system: "webhook" })).toBe("file text");
  });

  it("on a private install the start check reads no binding, and tokens scoped private-install are minted as before", async () => {
    const w = await world({ cloud: false });
    const sent: string[] = [];
    const send = w.db.send.bind(w.db);
    w.db.send = async (command) => {
      const key = (command as { input?: { Key?: { pk?: string } } }).input?.Key?.pk;
      if (typeof key === "string" && key.startsWith("GITHUB_INSTALLATION#")) sent.push(key);
      return send(command);
    };
    const started = await w.start();
    expect(started.status).toBe(200);
    const task = w.db.get(`DEVTASK#${(started.body.task as { taskId: string }).taskId}`, "META") as { workspaceId: string };
    const outbox = w.db.find((item) => item.entityType === "OUTBOX")[0] as { operationId: string; invocation: { callbackCapability: string; payload: { repositoryGrant: string } } };
    const exchanged = await call(w.handler, {
      method: "POST", path: `/v1/internal/workspaces/${task.workspaceId}/operations/${outbox.operationId}/repository-credentials`,
      headers: { "x-agentx-repository-grant": outbox.invocation.payload.repositoryGrant, "x-agentx-callback-capability": outbox.invocation.callbackCapability },
      body: { credentialRef: "github-app", repositoryUrl: "https://github.com/example/demo.git", access: "clone" },
    });
    expect(exchanged.status).toBe(200);
    expect(w.github.minted()).toHaveLength(1);
    expect(sent).toEqual([]);
  });
});

describe("GET and DELETE /v1/app/github/installations", () => {
  it("any member lists the org's installations with their selection and status; another org's are not shown", async () => {
    const w = await world();
    w.bind(66, { status: "suspended", selection: "all" });
    w.db.set({ ...orgGithubInstallationKey(ORG_B, 77), entityType: "ORG_GITHUB_INSTALLATION", installationId: 77, orgId: ORG_B, accountLogin: "beta", accountId: 1, accountType: "User", repositorySelection: "all", status: "active" });
    const listed = await w.dev(MAYA, "GET", "/v1/app/github/installations");
    expect(listed.status).toBe(200);
    expect(listed.body.installations).toEqual([
      { installationId: 55, accountLogin: "example", accountType: "Organization", repositorySelection: "selected", status: "active", connectedBy: OMAR.developerId, connectedAt: "2026-10-01T00:00:00.000Z" },
      { installationId: 66, accountLogin: "example", accountType: "Organization", repositorySelection: "all", status: "suspended", connectedBy: OMAR.developerId, connectedAt: "2026-10-01T00:00:00.000Z" },
    ]);
    expect(await listGithubInstallations({ documentClient: w.db, tableName: "state" }, ORG_B)).toEqual({ installations: [expect.objectContaining({ installationId: 77, accountLogin: "beta" })] });
  });

  it("DELETE by a member is 403 and changes nothing; by the owner both keys are gone (the tombstone stays) and the answer says how to remove the access on GitHub", async () => {
    const w = await world();
    expect((await w.dev(MAYA, "DELETE", "/v1/app/github/installations/55")).status).toBe(403);
    expect(w.bindingOf()).toBeDefined();
    expect(w.copyOf()).toBeDefined();

    const deleted = await w.dev(OMAR, "DELETE", "/v1/app/github/installations/55");
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({
      installationId: 55, accountLogin: "example",
      message: "Rovara no longer uses example. To remove its access on GitHub too, uninstall the app in example's GitHub settings.",
    });
    expect(w.bindingOf()).toBeUndefined();
    expect(w.copyOf()).toBeUndefined();
    expect(w.db.get(githubInstallationEverBoundKey(55))).toBeDefined();
    expect(w.db.find((item) => item.pk === githubAuditKey(TEST_ORG, "x", "y").pk)).toEqual([expect.objectContaining({ action: "installation_disconnected", disconnectedBy: OMAR.developerId })]);
    // The account is free for another org's admin to claim again (Task 13's checks apply to that claim).
    expect((await w.dev(OMAR, "DELETE", "/v1/app/github/installations/55")).status).toBe(404);
    expect((await w.dev(MAYA, "GET", "/v1/app/github/installations")).body.installations).toEqual([]);
  });

  it("another org's installation is a 404, and an id that is not a number is no route; the function refuses a member and a private install", async () => {
    const w = await world({ bound: false });
    w.bind(55, { orgId: ORG_B });
    expect((await w.dev(OMAR, "DELETE", "/v1/app/github/installations/55")).status).toBe(404);
    expect(w.bindingOf()).toMatchObject({ orgId: ORG_B });
    expect((await w.dev(OMAR, "DELETE", "/v1/app/github/installations/abc")).status).toBe(404);
    const deps = { documentClient: w.db, tableName: "state", now: () => NOW, cloud: true, log: () => undefined } as unknown as GithubConnectionDependencies;
    await expect(disconnectGithubInstallation(deps, { developerId: "x", orgId: TEST_ORG, orgRole: "member" }, 55)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(disconnectGithubInstallation({ ...deps, cloud: false }, { developerId: "x", orgId: TEST_ORG, orgRole: "owner" }, 55)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("GET /v1/app/github/repositories", () => {
  it("lists what the installation reaches through a token minted for the org, and marks a repository that already belongs to a project", async () => {
    const w = await world();
    const listed = await w.dev(OMAR, "GET", "/v1/app/github/repositories?installation=55");
    expect(listed.status).toBe(200);
    expect(listed.body.repositories).toEqual([
      { fullName: "example/demo", githubRepositoryId: 9001, private: true, defaultBranch: "main", project: "payments" },
      { fullName: "example/website", githubRepositoryId: 9002, private: true, defaultBranch: "main" },
    ]);
    expect(w.github.minted()).toHaveLength(1);
    expect(w.github.requests.filter((request) => request.startsWith("GET /installation/repositories"))).toEqual(["GET /installation/repositories?per_page=100&page=1"]);
  });

  it("reads up to 10 pages of 100", async () => {
    const many = Array.from({ length: 1_050 }, (_, index) => repo(`r${String(index).padStart(4, "0")}`, 10_000 + index));
    const w = await world({ github: { repositories: { 55: many } } });
    const listed = await w.dev(OMAR, "GET", "/v1/app/github/repositories?installation=55");
    expect(listed.status).toBe(200);
    expect((listed.body.repositories as unknown[]).length).toBe(1_000);
    expect(w.github.requests.filter((request) => request.startsWith("GET /installation/repositories"))).toHaveLength(10);
  });

  it("an installation that is not this org's is 404 and mints nothing; a suspended one is GITHUB_NOT_CONNECTED before any token", async () => {
    const w = await world();
    w.bind(66, { orgId: ORG_B });
    for (const id of ["66", "12345"]) {
      const refused = await w.dev(OMAR, "GET", `/v1/app/github/repositories?installation=${id}`);
      expect(refused.status).toBe(404);
    }
    w.bind(55, { status: "suspended" });
    const suspended = await w.dev(OMAR, "GET", "/v1/app/github/repositories?installation=55");
    expect(suspended.status).toBe(403);
    expect(error(suspended).code).toBe("GITHUB_NOT_CONNECTED");
    expect(w.github.minted()).toEqual([]);
    expect((await w.dev(OMAR, "GET", "/v1/app/github/repositories")).status).toBe(400);
    expect((await w.dev(OMAR, "GET", "/v1/app/github/repositories?installation=abc")).status).toBe(400);
  });

  it("a plain member may not list private repositories", async () => {
    const w = await world();
    expect((await w.dev(MAYA, "GET", "/v1/app/github/repositories?installation=55")).status).toBe(403);
    expect(w.github.minted()).toEqual([]);
  });
});

describe("the project settings seam", () => {
  it("an added repository must be reached by the org's own connection: connected passes, another org's installation is GITHUB_NOT_CONNECTED, and no revision is written", async () => {
    const w = await world();
    const revisions = () => w.db.find((item) => item.pk === projectPk(TEST_ORG, "payments") && typeof item.sk === "string" && item.sk.startsWith(PROJECT_REVISION_SK_PREFIX)).length;
    const settings = (add: string) => w.dev(OMAR, "PUT", "/v1/app/projects/payments/settings", { requestId: randomUUID(), expectedRevision: 1, addRepositories: [add] });
    const before = revisions();
    w.bind(55, { orgId: ORG_B });
    const refused = await settings("example/website");
    expect(refused.status).toBe(403);
    expect(error(refused).code).toBe("GITHUB_NOT_CONNECTED");
    expect(revisions()).toBe(before);
    w.bind(55);
    const accepted = await settings("example/website");
    expect(accepted.status).toBe(200);
    expect(revisions()).toBe(before + 1);
  });

  it("Task 16: the added repository's entry pins the installation and GitHub's repository id, like a created project's", async () => {
    const w = await world();
    const saved = await w.dev(OMAR, "PUT", "/v1/app/projects/payments/settings", { requestId: randomUUID(), expectedRevision: 1, addRepositories: ["example/website"] });
    expect(saved.status).toBe(200);
    const revision = w.db.get(projectRevisionKey(TEST_ORG, "payments", 2));
    const repositories = (revision as { definition: { repositories: Array<Record<string, unknown>> } }).definition.repositories;
    expect(repositories.find((entry) => entry.name === "website")).toMatchObject({ installationId: 55, githubRepositoryId: 9001 });
  });
});

describe("Fix round 1", () => {
  const demo = "https://github.com/example/demo.git";

  it("a repository removed from a selected installation is refused at start even on a warm Lambda: nothing is charged or created", async () => {
    const w = await world();
    // Warm: the provider has cached installation 55 for the owner.
    expect(await w.provider.getFileAtCommit(demo, "src/a.ts", "a".repeat(40), SCOPE_A)).toBe("file text");
    w.github.uncovered.add("example/demo");
    const writes = taskWrites(w).length;
    const commands = w.db.commandNames().length;
    const mintsBefore = w.github.minted().length;
    const refused = await w.start();
    expect(refused.status).toBe(403);
    expect(error(refused)).toEqual({ code: "GITHUB_NOT_CONNECTED", message: NOT_CONNECTED });
    expect(taskWrites(w)).toHaveLength(writes);
    expect(w.db.commandNames().slice(commands)).not.toContain("TransactWriteCommand");
    expect(w.github.minted()).toHaveLength(mintsBefore);
  });

  it("the same for a new Slack thread and for a repository added in the settings", async () => {
    const w = await world();
    expect(await w.provider.getFileAtCommit(demo, "src/a.ts", "a".repeat(40), SCOPE_A)).toBe("file text");
    w.github.uncovered.add("example/demo");
    const thread = await ensureWorkspace(w.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000009`, MAYA.slackUserId!);
    expect(thread.status).toBe(403);
    expect(error(thread).code).toBe("GITHUB_NOT_CONNECTED");
    w.github.uncovered.delete("example/demo");
    w.github.uncovered.add("example/website");
    const settings = await w.dev(OMAR, "PUT", "/v1/app/projects/payments/settings", { requestId: randomUUID(), expectedRevision: 1, addRepositories: ["example/website"] });
    expect(settings.status).toBe(403);
    expect(error(settings).code).toBe("GITHUB_NOT_CONNECTED");
  });

  it("GitHub's 422 on a token for a repository the installation does not reach is GITHUB_NOT_CONNECTED for an org, not an outage", async () => {
    const w = await world();
    expect(await w.provider.getFileAtCommit(demo, "src/a.ts", "a".repeat(40), SCOPE_A)).toBe("file text");
    w.github.uncovered.add("example/demo");
    expect(await refusal(w.provider.getPullRequest(demo, 1, SCOPE_A))).toEqual({ code: "GITHUB_NOT_CONNECTED", statusCode: 403, message: NOT_CONNECTED });
  });

  it("follow-ups in an existing Slack thread are gated at entry", async () => {
    const w = await world();
    const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000011`;
    expect((await ensureWorkspace(w.handler, thread, MAYA.slackUserId!)).status).toBe(200);
    expect((await ensureWorkspace(w.handler, thread, MAYA.slackUserId!)).status).toBe(200);
    expect((await w.lifecycle("deleted")).statusCode).toBe(202);
    const followUp = await ensureWorkspace(w.handler, thread, MAYA.slackUserId!);
    expect(followUp.status).toBe(403);
    expect(error(followUp)).toEqual({ code: "GITHUB_NOT_CONNECTED", message: NOT_CONNECTED });
  });

  it("an old suspend that arrives after an unsuspend is logged as stale and ignored; a newer event applies", async () => {
    const w = await world();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();
    expect((await w.lifecycle("suspend", 55, undefined, { updated_at: at(10), suspended_at: at(10) })).statusCode).toBe(202);
    expect(w.bindingOf()).toMatchObject({ status: "suspended", githubUpdatedAt: NOW + 10_000 });
    expect(w.copyOf()).toMatchObject({ githubUpdatedAt: NOW + 10_000 });
    expect((await w.lifecycle("unsuspend", 55, undefined, { updated_at: at(20), suspended_at: null })).statusCode).toBe(202);
    expect(w.bindingOf()).toMatchObject({ status: "active", githubUpdatedAt: NOW + 20_000 });
    // The first suspend delivered again under another delivery id, after the unsuspend.
    expect((await w.lifecycle("suspend", 55, undefined, { updated_at: at(10), suspended_at: at(10) })).statusCode).toBe(202);
    expect(w.bindingOf()).toMatchObject({ status: "active", githubUpdatedAt: NOW + 20_000 });
    expect(log.mock.calls.map((entry) => String(entry[0]))).toContainEqual(expect.stringContaining("github.installation_event_stale"));
    expect((await w.lifecycle("suspend", 55, undefined, { updated_at: at(30), suspended_at: at(30) })).statusCode).toBe(202);
    expect(w.bindingOf()).toMatchObject({ status: "suspended" });
  });

  it("a provider call reads the binding once, not twice", async () => {
    const w = await world();
    const reads: string[] = [];
    const send = w.db.send.bind(w.db);
    w.db.send = async (command) => {
      const key = (command as { input?: { Key?: { pk?: string } } }).input?.Key?.pk;
      if (typeof key === "string" && key.startsWith("GITHUB_INSTALLATION#")) reads.push(key);
      return send(command);
    };
    await expect(w.provider.getPullRequest(demo, 1, SCOPE_A)).rejects.not.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    expect(reads).toEqual(["GITHUB_INSTALLATION#55"]);
    w.bind(55, { status: "removed" });
    reads.length = 0;
    await expect(w.provider.getPullRequest(demo, 1, SCOPE_A)).rejects.toMatchObject({ code: "GITHUB_NOT_CONNECTED" });
    expect(reads.length).toBeGreaterThan(0);
  });
});

describe("the contract", () => {
  it("GITHUB_NOT_CONNECTED is a 403 agentX error", () => {
    expect(agentXError("GITHUB_NOT_CONNECTED", "x").statusCode).toBe(403);
  });
});

describe("agentx github list | disconnect", () => {
  const CELL = "https://abc123.execute-api.us-east-1.amazonaws.com";
  const ISSUER = `${CELL}/v1/auth`;
  const INSTALLATIONS = [
    { installationId: 55, accountLogin: "Acme", accountType: "Organization", repositorySelection: "selected", status: "active" },
    { installationId: 66, accountLogin: "rhea", accountType: "User", repositorySelection: "all", status: "suspended" },
  ];
  const WAITING = { githubLogin: "omar", status: "waiting", accountLogin: "beta", requestedAt: "2026-10-21T10:00:00.000Z", expiresAt: "2026-10-28T10:00:00.000Z", requestedBy: { developerId: "d1", name: "Omar Diaz" } };

  async function cli(answer: (method: string, path: string) => Response | undefined) {
    const home = await mkdtemp(join(tmpdir(), "rovara-github-cli-"));
    homes.push(home);
    await saveDeveloperEnvironment(home, "staging", { url: CELL, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` });
    const tokenStore = new InMemoryTokenStore();
    await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "access", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
    const out: string[] = [];
    const calls: string[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
      const method = init?.method ?? "GET";
      calls.push(`${method} ${path}`);
      return answer(method, path) ?? new Response("unexpected", { status: 500 });
    });
    const run = (argv: string[]) => executeCli(argv, { fetchImplementation, tokenStore, environments: { home }, stdout: { write: (text: string) => out.push(text) }, stderr: { write: () => true } });
    return { run, out, calls };
  }

  it("list prints each connected account (the response shape the server sends) and each request still waiting", async () => {
    const h = await cli((method, path) => {
      if (method === "GET" && path === "/v1/app/github/installations") return Response.json({ installations: INSTALLATIONS, requestId: "r" });
      if (method === "GET" && path === "/v1/app/github/requests") return Response.json({ requests: [WAITING, { ...WAITING, githubLogin: "old", status: "expired" }], requestId: "r" });
      return undefined;
    });
    expect(await h.run(["github", "list"])).toBe(0);
    expect(h.out.join("")).toBe([
      `GitHub accounts of your organization on staging (${CELL}):`,
      "  Acme  organization  selected repositories  connected  installation 55",
      "  rhea  personal account  all repositories  suspended on GitHub  installation 66",
      "  waiting for a GitHub admin to approve the request for beta, asked by Omar Diaz (omar); it expires 2026-10-28T10:00:00.000Z",
      "",
    ].join("\n"));
  });

  it("list with nothing connected says how to connect, and an older control plane with no requests route still lists", async () => {
    const empty = await cli((method, path) => (method === "GET" && path === "/v1/app/github/installations" ? Response.json({ installations: [], requestId: "r" }) : undefined));
    expect(await empty.run(["github", "list"])).toBe(0);
    expect(empty.out.join("")).toBe("No GitHub account is connected to your organization on staging. Connect one with: agentx github connect\n");
  });

  it("disconnect finds the account without regard to case, sends one DELETE, and prints the server's words", async () => {
    const h = await cli((method, path) => {
      if (method === "GET" && path === "/v1/app/github/installations") return Response.json({ installations: INSTALLATIONS, requestId: "r" });
      if (method === "DELETE" && path === "/v1/app/github/installations/55") {
        return Response.json({ installationId: 55, accountLogin: "Acme", message: "Rovara no longer uses Acme. To remove its access on GitHub too, uninstall the app in Acme's GitHub settings.", requestId: "r" });
      }
      return undefined;
    });
    expect(await h.run(["github", "disconnect", "acme"])).toBe(0);
    expect(h.calls.filter((call) => call.startsWith("DELETE"))).toEqual(["DELETE /v1/app/github/installations/55"]);
    expect(h.out.join("")).toBe("Rovara no longer uses Acme. To remove its access on GitHub too, uninstall the app in Acme's GitHub settings.\n");
  });

  it("disconnect of an account that is not connected is refused before any DELETE", async () => {
    const h = await cli((method, path) => (method === "GET" && path === "/v1/app/github/installations" ? Response.json({ installations: INSTALLATIONS, requestId: "r" }) : undefined));
    expect(await h.run(["github", "disconnect", "nobody"])).not.toBe(0);
    expect(h.calls.filter((call) => call.startsWith("DELETE"))).toEqual([]);
  });

  it("the installations route answers the shape the connect poll reads, which is the shape list prints", async () => {
    const w = await world();
    const listed = await w.dev(MAYA, "GET", "/v1/app/github/installations");
    const entry = (listed.body.installations as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(entry).sort()).toEqual(["accountLogin", "accountType", "connectedAt", "connectedBy", "installationId", "repositorySelection", "status"]);
    expect(typeof entry.installationId).toBe("number");
  });
});

describe("Task 16 fold-ins from the Task 15 re-check: lifecycle ordering", () => {
  const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();

  it("installation.deleted is terminal: it applies whatever its timestamp, even older than a stored suspend", async () => {
    const w = await world();
    expect((await w.lifecycle("suspend", 55, undefined, { updated_at: at(10), suspended_at: at(10) })).statusCode).toBe(202);
    expect(w.bindingOf()).toMatchObject({ status: "suspended", githubUpdatedAt: NOW + 10_000 });
    expect((await w.lifecycle("deleted", 55, undefined, { updated_at: at(5) })).statusCode).toBe(202);
    expect(w.bindingOf()).toMatchObject({ status: "removed" });
    expect(w.copyOf()).toMatchObject({ status: "removed" });
    // The stored stamp is not wound back by a late terminal event.
    expect(w.bindingOf()).toMatchObject({ githubUpdatedAt: NOW + 10_000 });
  });

  it("an equal stamp is not stale: an unsuspend stamped in the same second as the suspend before it still applies", async () => {
    const w = await world();
    expect((await w.lifecycle("suspend", 55, undefined, { updated_at: at(10), suspended_at: at(10) })).statusCode).toBe(202);
    expect(w.bindingOf()).toMatchObject({ status: "suspended" });
    expect((await w.lifecycle("unsuspend", 55, undefined, { updated_at: at(10), suspended_at: null })).statusCode).toBe(202);
    expect(w.bindingOf()).toMatchObject({ status: "active" });
    expect(w.copyOf()).toMatchObject({ status: "active" });
  });
});

describe("Task 16 fold-ins: the registration check asks GitHub afresh on cloud", () => {
  const demo = "https://github.com/example/demo.git";
  const reference = { credentialRef: "github-app", url: demo };

  it("a repository removed from the installation is refused at registration even on a warm Lambda", async () => {
    const w = await world();
    expect(await w.provider.getFileAtCommit(demo, "src/a.ts", "a".repeat(40), SCOPE_A)).toBe("file text");
    await expect(w.provider.checkRepository(reference, SCOPE_A)).resolves.toBeUndefined();
    w.github.uncovered.add("example/demo");
    await expect(w.provider.checkRepository(reference, SCOPE_A)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("a private install keeps the cached lookup: no extra GitHub call per check", async () => {
    const w = await world({ cloud: false });
    await w.provider.checkRepository(reference, { system: "private-install" });
    const lookups = () => w.github.requests.filter((request) => request.endsWith("/installation")).length;
    const before = lookups();
    await w.provider.checkRepository(reference, { system: "private-install" });
    expect(lookups()).toBe(before);
  });
});

describe("Task 16 fold-ins: a fresh lookup that fails at the start gate never lets work through", () => {
  for (const fault of ["http-502", "timeout"] as const) {
    it(`a ${fault === "timeout" ? "timeout" : "5xx"} from GitHub at the start gate is 503 and writes nothing`, async () => {
      const w = await world();
      w.github.lookupFault.current = fault;
      const writes = taskWrites(w).length;
      const commands = w.db.commandNames().length;
      const refused = await w.start();
      expect(refused.status).toBe(503);
      expect(error(refused).code).toBe("RUNTIME_UNAVAILABLE");
      expect(taskWrites(w)).toHaveLength(writes);
      expect(w.db.commandNames().slice(commands)).not.toContain("TransactWriteCommand");
      expect(w.github.minted()).toHaveLength(0);
    });
  }
});

describe("Task 16 fold-ins: scopes", () => {
  const demo = "https://github.com/example/demo.git";

  it("GitHub's 422 on a token for a system scope stays an outage (RUNTIME_UNAVAILABLE), not GITHUB_NOT_CONNECTED", async () => {
    const w = await world();
    expect(await w.provider.getFileAtCommit(demo, "src/a.ts", "a".repeat(40), { system: "webhook" })).toBe("file text");
    w.github.uncovered.add("example/demo");
    expect(await refusal(w.provider.getPullRequest(demo, 1, { system: "webhook" }))).toMatchObject({ code: "RUNTIME_UNAVAILABLE", statusCode: 503 });
  });

  it("organizationMembership refuses an org scope before anything is minted", async () => {
    const w = await world();
    const asked = await refusal((w.provider.organizationMembership as unknown as (id: number, org: string, login: string, scope: unknown) => Promise<unknown>).call(w.provider, 55, "example", "maya", { orgId: TEST_ORG }));
    expect(asked.code).toBe("CONFIG_INVALID");
    expect(w.github.minted()).toHaveLength(0);
  });
});
