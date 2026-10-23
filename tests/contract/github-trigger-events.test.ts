// Plan 4 Task 21: GitHub's events reach triggers through the one webhook the App already has. The signature is checked by the existing verifier; after it, an event that can start work
// is mapped (only through the org's own installation, the repositories that installation holds and the projects whose latest revision pins both) and handed to Task 20's dispatch. Nothing
// here starts work by itself: these tests read what dispatch did. The loop guard, the replay guard and the org boundaries are the points a reviewer looks at first.
import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TriggerEvent } from "@agentx/contracts";
import { githubInstallationKey, githubRepoProjectKey, hookEventKey, orgGithubInstallationKey, orgProjectCatalogKey, projectRevisionKey } from "../../packages/contracts/src/index.js";
import type { OrgId } from "../../packages/contracts/src/org.js";
import { GithubWebhookRetryableError, handleGithubWebhook } from "../../packages/broker/src/aws/github-webhooks.js";
import { dispatchTriggerEvent } from "../../packages/broker/src/triggers/dispatch.js";
import { deliverGithubTriggerEvents, githubTriggerEvents, type GithubTriggerDependencies } from "../../packages/broker/src/triggers/github-events.js";
import { GITHUB_WEBHOOK_EVENTS, githubAppManifest, githubWebhookUrl } from "../../packages/cli/src/init/github-app.js";
import { githubWebhookChecks } from "../../packages/cli/src/doctor/github.js";
import { doctorContext, doctorServices } from "../support/doctor-fakes.js";
import { fakeGitHubApi } from "../support/init-fakes.js";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { FakeHookSecrets } from "../support/hook-fixtures.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { DANA, ORG_A, ORG_B, PRIYA, disposeGateWorlds, setupTriggerWorld, type TriggerWorld } from "../support/trigger-world.js";
import type { ChainDefinitionInput } from "../../packages/contracts/src/chains.js";

beforeAll(async () => { await loadSlackBroker(); });
afterEach(() => disposeGateWorlds());

const SECRET = "whsec-github-triggers";
const SLUG = "rovara-app";
const ONE_STEP: ChainDefinitionInput = { start: "look", steps: [{ kind: "agent", id: "look", name: "Look", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }], limits: { maxRunUsd: 5 } };
const PR_OPENED = { kind: "event" as const, source: "github" as const, type: "pull_request.opened" };
const NOW = "2026-10-22T09:00:00.000Z";
const FIXED = "2026-10-22T08:59:00Z";
/** The time a payload says it happened: a minute before the trigger world's clock, or (through the broker, which reads the real clock) a minute before now. */
const stamp = { value: FIXED };
const fresh = () => stamp.value;

const sign = (raw: string) => `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
const headers = (raw: string, event: string, delivery: string = randomUUID()) => ({ "x-hub-signature-256": sign(raw), "x-github-delivery": delivery, "x-github-event": event });

// ---- payloads as GitHub sends them (only the fields Rovara reads)
const repository = (id = 101, fullName = "acme/web") => ({ id, full_name: fullName, html_url: `https://github.com/${fullName}` });
const user = (login: string, type = "User") => ({ login, type });
function pullRequest(over: { action?: string; installation?: number; repo?: number; number?: number; sender?: { login: string; type: string }; association?: string; labels?: string[]; base?: string; updatedAt?: string; title?: string } = {}) {
  return {
    action: over.action ?? "opened", installation: { id: over.installation ?? 55 }, repository: repository(over.repo ?? 101), sender: over.sender ?? user("alice"),
    pull_request: {
      number: over.number ?? 42, title: over.title ?? "Fix the login redirect", html_url: `https://github.com/acme/web/pull/${String(over.number ?? 42)}`, updated_at: over.updatedAt ?? fresh(),
      author_association: over.association ?? "MEMBER", labels: (over.labels ?? ["bug"]).map((name) => ({ name })), base: { ref: over.base ?? "main" }, user: over.sender ?? user("alice"),
    },
  };
}
const issue = (over: { association?: string; labels?: string[]; number?: number; asPullRequest?: boolean } = {}) => ({
  action: "opened", installation: { id: 55 }, repository: repository(), sender: user("alice"),
  issue: {
    number: over.number ?? 7, title: "Checkout fails", html_url: `https://github.com/acme/web/issues/${String(over.number ?? 7)}`, created_at: fresh(), updated_at: fresh(),
    author_association: over.association ?? "MEMBER", labels: (over.labels ?? ["bug"]).map((name) => ({ name })), user: user("alice"),
    ...(over.asPullRequest === true ? { pull_request: { url: "https://api.github.com/repos/acme/web/pulls/7" } } : {}),
  },
});
const deploymentStatus = (state: string, over: { id?: number; sender?: { login: string; type: string } } = {}) => ({
  action: "created", installation: { id: 55 }, repository: repository(), sender: over.sender ?? user("deployer"),
  deployment_status: { id: over.id ?? 9001, state, environment: "production", created_at: fresh(), description: "shipped", target_url: "https://example.com/deploy" },
  deployment: { id: 77, environment: "production", creator: user("deployer") },
});
const workflowRun = (over: { id?: number; attempt?: number; conclusion?: string; actor?: { login: string; type: string } } = {}) => ({
  action: "completed", installation: { id: 55 }, repository: repository(), sender: user("alice"),
  workflow_run: {
    id: over.id ?? 5001, run_attempt: over.attempt ?? 1, name: "CI", conclusion: over.conclusion ?? "failure", head_branch: "main", updated_at: fresh(), html_url: "https://github.com/acme/web/actions/runs/5001",
    actor: over.actor ?? user("alice"), triggering_actor: over.actor ?? user("alice"),
  },
});

// ---- the stored world
function bindInstallation(db: FakeDynamoDb, installationId: number, orgId: OrgId, status = "active") {
  const record = { installationId, orgId, accountLogin: "acme", status, repositorySelection: "all" };
  db.set({ ...githubInstallationKey(installationId), entityType: "GITHUB_INSTALLATION", ...record });
  db.set({ ...orgGithubInstallationKey(orgId, installationId), entityType: "ORG_GITHUB_INSTALLATION", ...record });
}
/** A project whose latest revision pins `installationId` and `repositoryId`, with the index row GitHub's events find it by. */
function registerProject(db: FakeDynamoDb, orgId: OrgId, project: string, pin: { installationId: number; repositoryId: number }, options: { index?: boolean } = {}) {
  db.set({
    ...projectRevisionKey(orgId, project, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: {},
    definition: {
      name: project, revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
      repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app", installationId: pin.installationId, githubRepositoryId: pin.repositoryId }],
    },
  });
  db.set({ ...orgProjectCatalogKey(orgId, project), entityType: "PROJECT_CATALOG", name: project, latestRevision: 1 });
  if (options.index !== false) db.set({ ...githubRepoProjectKey(pin.repositoryId, orgId, project), entityType: "GITHUB_REPO_PROJECT", orgId, project, installationId: pin.installationId, githubRepositoryId: pin.repositoryId });
}

// ---- layer 1: the handler over the trigger world, with Task 20's real dispatch
function world() {
  stamp.value = FIXED;
  const v = setupTriggerWorld();
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  (v.routeDeps as { log?: unknown }).log = (event: string, fields: Record<string, unknown>) => logs.push({ event, fields });
  bindInstallation(v.db, 55, ORG_A);
  bindInstallation(v.db, 66, ORG_B);
  registerProject(v.db, ORG_A, "web", { installationId: 55, repositoryId: 101 });
  const slug: { value: string | undefined } = { value: SLUG };
  const dispatched: Array<{ orgId: string; event: TriggerEvent }> = [];
  const failures: Error[] = [];
  const github: GithubTriggerDependencies = {
    documentClient: v.db, tableName: "T", now: () => v.clock.now, githubAppSlug: async () => slug.value,
    log: (event, fields) => logs.push({ event, fields }),
    dispatch: async (orgId, event) => {
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      dispatched.push({ orgId, event });
      return dispatchTriggerEvent(v.routeDeps as never, orgId, event);
    },
  };
  const deliver = (payload: object, eventName: string, delivery?: string, secret = SECRET) => {
    const raw = JSON.stringify(payload);
    return handleGithubWebhook({
      documentClient: v.db, tableName: "T", rawBody: raw, headers: headers(raw, eventName, delivery), secret,
      authorizeRepository: async () => false, process: async () => undefined, now: () => NOW,
      triggerEvents: (input) => deliverGithubTriggerEvents(github, input),
    });
  };
  const runs = () => v.db.find((item) => String(item["pk"]).includes("#CHAIN_RUN#") && item["sk"] === "META");
  const chainTrigger = async (over: Parameters<TriggerWorld["seed"]>[0] extends infer T ? Partial<NonNullable<T>> : never = {}) => {
    const chain = await v.budgetedChain(ONE_STEP);
    return v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: PR_OPENED, createdBy: DANA, ...over } as never);
  };
  return { v, logs, github, dispatched, failures, slug, deliver, runs, chainTrigger };
}

describe("a pull request event starts the right org's work", () => {
  it("starts the trigger whose filter it meets, with the pull request as the subject", async () => {
    const w = world();
    const bug = await w.chainTrigger({ spec: { ...PR_OPENED, filter: { label: ["bug"], baseBranch: ["main"] } } });
    const docs = await w.chainTrigger({ spec: { ...PR_OPENED, filter: { label: ["docs"] } } });
    const result = await w.deliver(pullRequest(), "pull_request");
    expect(result.status).toBe("ACCEPTED");
    expect(w.runs()).toHaveLength(1);
    expect((await w.v.triggers.listActivity(ORG_A, bug.triggerId)).map((entry) => entry.outcome)).toEqual(["started"]);
    expect(await w.v.triggers.listActivity(ORG_A, docs.triggerId)).toEqual([]);
    expect(w.dispatched[0]).toMatchObject({ orgId: ORG_A, event: { source: "github", type: "pull_request.opened", project: "web", subject: { kind: "pull_request", id: "42", title: "Fix the login redirect", url: "https://github.com/acme/web/pull/42" } } });
    expect(w.dispatched[0]!.event.hookId).toBeUndefined();
  });

  it("starts only the org the installation belongs to when two orgs each have a project called web with the same trigger", async () => {
    const w = world();
    registerProject(w.v.db, ORG_B, "web", { installationId: 66, repositoryId: 202 });
    const mine = await w.chainTrigger();
    const theirs = await w.v.triggers.create({ record: { orgId: ORG_B, triggerId: "ctr_bbbbbbbbbbbbbbbbbbbb", target: { kind: "agent", agentId: "code-reviewer" }, project: "web", spec: PR_OPENED, enabled: true, maxRunsPerHour: 30, createdBy: PRIYA } });
    await w.deliver(pullRequest(), "pull_request");
    expect((await w.v.triggers.listActivity(ORG_A, mine.triggerId)).map((entry) => entry.outcome)).toEqual(["started"]);
    // Org B's trigger was never dispatched: nothing, not even a refusal, was recorded for it.
    expect(await w.v.triggers.listActivity(ORG_B, theirs.triggerId)).toEqual([]);
    expect(w.dispatched.map((entry) => entry.orgId)).toEqual([ORG_A]);
    // And the other way round: org B's repository goes to org B.
    await w.deliver(pullRequest({ installation: 66, repo: 202 }), "pull_request");
    expect(w.dispatched.map((entry) => entry.orgId)).toEqual([ORG_A, ORG_B]);
  });

  it("ignores and logs a stale index row that names another org for a repository now under this installation, and one whose project pins another installation or repository", async () => {
    const w = world();
    await w.chainTrigger();
    w.v.db.set({ ...githubRepoProjectKey(101, ORG_B, "web"), entityType: "GITHUB_REPO_PROJECT", orgId: ORG_B, project: "web", installationId: 66, githubRepositoryId: 101 });
    registerProject(w.v.db, ORG_A, "other", { installationId: 99, repositoryId: 101 });
    registerProject(w.v.db, ORG_A, "moved", { installationId: 55, repositoryId: 555 }, { index: false });
    w.v.db.set({ ...githubRepoProjectKey(101, ORG_A, "moved"), entityType: "GITHUB_REPO_PROJECT", orgId: ORG_A, project: "moved", installationId: 55, githubRepositoryId: 101 });
    const found = await githubTriggerEvents(w.github, { eventName: "pull_request", payload: pullRequest(), installationId: 55 });
    expect(found.map((entry) => [entry.orgId, entry.event.project])).toEqual([[ORG_A, "web"]]);
    const stale = w.logs.filter((entry) => entry.event === "github.trigger_stale_index").map((entry) => `${String(entry.fields["orgId"])}/${String(entry.fields["project"])}`);
    expect(stale.sort()).toEqual([`${ORG_A}/moved`, `${ORG_A}/other`, `${ORG_B}/web`].sort());
    await w.deliver(pullRequest(), "pull_request");
    expect(w.dispatched.map((entry) => entry.event.project)).toEqual(["web"]);
  });

  it("starts nothing for an installation that is suspended, unknown, or bound to nothing, and says it was unbound", async () => {
    const w = world();
    await w.chainTrigger();
    bindInstallation(w.v.db, 55, ORG_A, "suspended");
    expect((await w.deliver(pullRequest(), "pull_request")).status).not.toBe("IN_PROGRESS");
    expect(w.runs()).toEqual([]);
    expect(await githubTriggerEvents(w.github, { eventName: "pull_request", payload: pullRequest({ installation: 12345 }), installationId: 12345 })).toEqual([]);
    expect(w.logs.filter((entry) => entry.event === "github.trigger_unbound")).toHaveLength(2);
  });

  it("starts no second run when the same signed body arrives under a new delivery id", async () => {
    const w = world();
    await w.chainTrigger();
    await w.deliver(pullRequest(), "pull_request");
    const again = await w.deliver(pullRequest(), "pull_request");
    expect(again.status).toBe("DUPLICATE");
    expect(w.runs()).toHaveLength(1);
    // A later edit of the pull request has another updated_at, so it is another event: it is for the subject guard, not the replay guard.
    expect((await githubTriggerEvents(w.github, { eventName: "pull_request", payload: pullRequest({ updatedAt: "2026-10-22T08:59:30Z" }), installationId: 55 }))[0]!.event.eventKey)
      .not.toBe((await githubTriggerEvents(w.github, { eventName: "pull_request", payload: pullRequest(), installationId: 55 }))[0]!.event.eventKey);
  });

  it("de-duplicates per project: two projects of one org on the same repository each start their own", async () => {
    const w = world();
    registerProject(w.v.db, ORG_A, "web2", { installationId: 55, repositoryId: 101 });
    w.v.projectMembers.grant(ORG_A, "web2", PRIYA, "contributor");
    const chain = await w.v.budgetedChain(ONE_STEP);
    for (const project of ["web", "web2"]) await w.v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: PR_OPENED, createdBy: DANA, project });
    await w.deliver(pullRequest(), "pull_request");
    expect(w.dispatched.map((entry) => entry.event.project).sort()).toEqual(["web", "web2"]);
    expect(w.runs()).toHaveLength(2);
    expect(w.v.db.get(hookEventKey(ORG_A, "github", `web\0${w.dispatched[0]!.event.eventKey}`))).toMatchObject({ status: "dispatched" });
  });

  it("skips a pull request opened by Rovara's own bot as caused_by_rovara, and one whose workflow Rovara's bot triggered", async () => {
    const w = world();
    const pr = await w.chainTrigger();
    const run = await w.chainTrigger({ spec: { kind: "event", source: "github", type: "workflow_run.completed" } });
    await w.deliver(pullRequest({ sender: user(`${SLUG}[bot]`, "Bot") }), "pull_request");
    await w.deliver(workflowRun({ actor: user(`${SLUG}[bot]`, "Bot") }), "workflow_run");
    expect(await w.v.triggers.listActivity(ORG_A, pr.triggerId)).toMatchObject([{ outcome: "skipped", reason: "caused_by_rovara" }]);
    expect(await w.v.triggers.listActivity(ORG_A, run.triggerId)).toMatchObject([{ outcome: "skipped", reason: "caused_by_rovara" }]);
    expect(w.runs()).toEqual([]);
    // Another app's bot is not Rovara.
    await w.deliver(pullRequest({ number: 43, sender: user("dependabot[bot]", "Bot") }), "pull_request");
    expect(w.runs()).toHaveLength(1);
  });

  it("treats every bot as Rovara's when the App's slug can't be known, rather than risk a loop", async () => {
    const w = world();
    w.slug.value = undefined;
    await w.chainTrigger();
    await w.deliver(pullRequest({ sender: user("dependabot[bot]", "Bot") }), "pull_request");
    expect(w.runs()).toEqual([]);
    await w.deliver(pullRequest({ number: 44 }), "pull_request");
    expect(w.runs()).toHaveLength(1);
  });

  it("filters on the author's association: a stranger's pull request or issue is skipped by a trigger limited to members, and starts one with no such filter", async () => {
    const w = world();
    const limited = await w.chainTrigger({ spec: { ...PR_OPENED, filter: { authorAssociation: ["MEMBER", "OWNER", "COLLABORATOR"] } } });
    const open = await w.chainTrigger();
    const issueLimited = await w.chainTrigger({ spec: { kind: "event", source: "github", type: "issues.opened", filter: { authorAssociation: ["MEMBER", "OWNER", "COLLABORATOR"] } } });
    const issueOpen = await w.chainTrigger({ spec: { kind: "event", source: "github", type: "issues.opened" } });
    await w.deliver(pullRequest({ association: "NONE" }), "pull_request");
    await w.deliver(issue({ association: "NONE" }), "issues");
    expect(await w.v.triggers.listActivity(ORG_A, limited.triggerId)).toEqual([]);
    expect(await w.v.triggers.listActivity(ORG_A, issueLimited.triggerId)).toEqual([]);
    expect((await w.v.triggers.listActivity(ORG_A, open.triggerId)).map((entry) => entry.outcome)).toEqual(["started"]);
    expect((await w.v.triggers.listActivity(ORG_A, issueOpen.triggerId)).map((entry) => entry.outcome)).toEqual(["started"]);
    await w.deliver(pullRequest({ number: 50, association: "MEMBER" }), "pull_request");
    expect((await w.v.triggers.listActivity(ORG_A, limited.triggerId)).map((entry) => entry.outcome)).toEqual(["started"]);
  });

  it("drops an event dated more than a day back, and answers a failed dispatch with a retryable fault after forgetting the event so the retry starts it", async () => {
    const w = world();
    await w.chainTrigger();
    await w.deliver(pullRequest({ updatedAt: "2026-10-20T08:00:00Z" }), "pull_request");
    expect(w.runs()).toEqual([]);
    expect(w.logs.some((entry) => entry.event === "github.trigger_stale")).toBe(true);
    w.failures.push(Object.assign(new Error("down"), { name: "ServiceUnavailable" }));
    await expect(w.deliver(pullRequest(), "pull_request")).rejects.toBeInstanceOf(GithubWebhookRetryableError);
    expect(w.runs()).toEqual([]);
    expect((await w.deliver(pullRequest(), "pull_request")).status).toBe("ACCEPTED");
    expect(w.runs()).toHaveLength(1);
  });

  it("still rejects a bad signature, and reads the body only after it verified", async () => {
    const w = world();
    await w.chainTrigger();
    await expect(w.deliver(pullRequest(), "pull_request", undefined, "another-secret")).rejects.toThrow("GitHub webhook signature is invalid");
    expect(w.runs()).toEqual([]);
    expect(w.dispatched).toEqual([]);
  });
});

describe("the events GitHub sends and how they map", () => {
  it("maps each event to its type, key, subject and fields from the signed body", async () => {
    const w = world();
    const map = async (eventName: string, payload: object) => (await githubTriggerEvents(w.github, { eventName, payload, installationId: 55 })).map((entry) => entry.event);
    expect(await map("pull_request", pullRequest({ labels: ["bug", "p1"], base: "release" }))).toMatchObject([{
      type: "pull_request.opened", eventKey: "gh:pr:101:42:opened:2026-10-22T08:59:00Z", occurredAt: "2026-10-22T08:59:00.000Z", actor: { kind: "external", id: "alice" },
      fields: { baseBranch: ["release"], label: ["bug", "p1"], authorAssociation: ["MEMBER"] },
    }]);
    expect(await map("pull_request", pullRequest({ action: "ready_for_review" }))).toMatchObject([{ type: "pull_request.ready_for_review", eventKey: "gh:pr:101:42:ready_for_review:2026-10-22T08:59:00Z" }]);
    expect(await map("pull_request", pullRequest({ action: "closed" }))).toEqual([]);
    expect(await map("issues", issue({ labels: ["ui"] }))).toMatchObject([{ type: "issues.opened", eventKey: "gh:issue:101:7:opened", subject: { kind: "issue", id: "7", title: "Checkout fails", url: "https://github.com/acme/web/issues/7" }, fields: { label: ["ui"], authorAssociation: ["MEMBER"] } }]);
    // An issue that is a pull request is the pull request's event, not an issue's.
    expect(await map("issues", issue({ asPullRequest: true }))).toEqual([]);
    expect(await map("deployment_status", deploymentStatus("error"))).toMatchObject([{ type: "deployment_status.failure", eventKey: "gh:depstatus:9001", subject: { kind: "deployment" }, fields: { environment: ["production"] } }]);
    expect(await map("deployment_status", deploymentStatus("failure")))
      .toMatchObject([{ type: "deployment_status.failure" }]);
    expect(await map("deployment_status", deploymentStatus("success"))).toMatchObject([{ type: "deployment_status.success" }]);
    expect(await map("deployment_status", deploymentStatus("pending"))).toEqual([]);
    expect(await map("workflow_run", workflowRun({ attempt: 2 }))).toMatchObject([{
      type: "workflow_run.completed", eventKey: "gh:run:5001:2", subject: { kind: "workflow_run", id: "5001", url: "https://github.com/acme/web/actions/runs/5001" }, fields: { workflow: ["CI"], conclusion: ["failure"], branch: ["main"] },
    }]);
    expect(await map("workflow_run", { ...workflowRun(), action: "requested" })).toEqual([]);
    expect(await map("issue_comment", pullRequest())).toEqual([]);
  });

  it("takes only https github.com links as a subject url, and cuts and cleans the title", async () => {
    const w = world();
    const payload = pullRequest({ title: `${"T".repeat(400)}\u0007` });
    (payload.pull_request as { html_url: string }).html_url = "https://evil.example/pull/42";
    const [found] = await githubTriggerEvents(w.github, { eventName: "pull_request", payload, installationId: 55 });
    expect(found!.event.subject.url).toBeUndefined();
    expect([...found!.event.subject.title]).toHaveLength(300);
    expect(found!.event.subject.title).not.toContain("\u0007");
  });

  it("refuses a body that does not carry what the mapping reads, with no throw", async () => {
    const w = world();
    expect(await githubTriggerEvents(w.github, { eventName: "pull_request", payload: { action: "opened", installation: { id: 55 } }, installationId: 55 })).toEqual([]);
    expect(await githubTriggerEvents(w.github, { eventName: "pull_request", payload: "nope", installationId: 55 })).toEqual([]);
  });
});

// ---- layer 2: through the broker's own endpoint
async function brokerWorld() {
  stamp.value = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, "Z");
  const dispatched: Array<{ orgId: string; event: TriggerEvent }> = [];
  const fail = { next: false };
  const members = new FakeProjectMembers();
  members.addProject(TEST_ORG, "web");
  const h = await createDeveloperTaskBroker({
    register: false, cloud: true,
    brokerExtra: {
      cloud: true,
      githubWebhookSecret: async () => SECRET,
      githubPullRequests: { reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(), verifyWebhookRepository: vi.fn(async () => false), appSlug: async () => SLUG },
      agents: { projectMembers: members, eventHooks: { secrets: new FakeHookSecrets(), providers: {}, dispatch: async (orgId: string, event: TriggerEvent) => { if (fail.next) { fail.next = false; throw new Error("down"); } dispatched.push({ orgId, event }); } } },
    },
  } as never);
  bindInstallation(h.db, 55, TEST_ORG);
  registerProject(h.db, TEST_ORG, "web", { installationId: 55, repositoryId: 101 });
  const post = (payload: object, eventName: string, over: { signature?: string; delivery?: string } = {}) => {
    const raw = JSON.stringify(payload);
    return h.handler({
      version: "2.0", routeKey: "POST /v1/github/webhooks", rawPath: "/v1/github/webhooks", rawQueryString: "",
      headers: { ...headers(raw, eventName, over.delivery), ...(over.signature === undefined ? {} : { "x-hub-signature-256": over.signature }) }, body: raw,
      requestContext: { requestId: randomUUID(), http: { method: "POST" } },
    }) as Promise<{ statusCode: number; body: string }>;
  };
  return { h, dispatched, post, fail };
}

describe("through the broker's webhook endpoint", () => {
  it("answers 202 IGNORED to a validly signed event no path uses, and 403 to a bad signature", async () => {
    const w = await brokerWorld();
    const comment = { action: "created", installation: { id: 55 }, repository: repository(), issue: { number: 9 }, comment: { id: 1, body: "hi", html_url: "https://github.com/acme/web/issues/9#issuecomment-1", user: { login: "bob" } } };
    const ignored = await w.post(comment, "issue_comment");
    expect(ignored.statusCode).toBe(202);
    expect(JSON.parse(ignored.body)).toMatchObject({ delivery: "IGNORED" });
    expect((await w.post(comment, "issue_comment", { signature: `sha256=${"0".repeat(64)}` })).statusCode).toBe(403);
    expect((await w.post(comment, "issue_comment", { signature: "nope" })).statusCode).toBe(403);
    expect(w.dispatched).toEqual([]);
  });

  it("hands a deployment_status, a workflow_run, an issue and an unlinked pull request to dispatch, each answered 202", async () => {
    const w = await brokerWorld();
    for (const [name, payload] of [["deployment_status", deploymentStatus("error")], ["workflow_run", workflowRun()], ["issues", issue()], ["pull_request", pullRequest()]] as const) {
      const reply = await w.post(payload, name);
      expect(reply.statusCode, name).toBe(202);
    }
    expect(w.dispatched.map((entry) => [entry.orgId, entry.event.type])).toEqual([
      [TEST_ORG, "deployment_status.failure"], [TEST_ORG, "workflow_run.completed"], [TEST_ORG, "issues.opened"], [TEST_ORG, "pull_request.opened"],
    ]);
    expect(w.dispatched[0]!.event.fields).toMatchObject({ environment: ["production"] });
    // The replay of a body under a new delivery id is answered as a duplicate and dispatched no more.
    const again = await w.post(deploymentStatus("error"), "deployment_status");
    expect(JSON.parse(again.body)).toMatchObject({ delivery: "DUPLICATE" });
    expect(w.dispatched).toHaveLength(4);
  });

  it("answers 202 for a suspended installation and dispatches nothing", async () => {
    const w = await brokerWorld();
    bindInstallation(w.h.db, 55, TEST_ORG, "suspended");
    expect((await w.post(pullRequest(), "pull_request")).statusCode).toBe(202);
    expect(w.dispatched).toEqual([]);
  });

  it("answers 503 when dispatch fails, so that GitHub's redelivery starts the event, and starts it then", async () => {
    const w = await brokerWorld();
    w.fail.next = true;
    expect((await w.post(pullRequest(), "pull_request")).statusCode).toBe(503);
    expect(w.dispatched).toEqual([]);
    expect((await w.post(pullRequest(), "pull_request")).statusCode).toBe(202);
    expect(w.dispatched).toHaveLength(1);
  });
});

describe("the GitHub App asks for what the events need", () => {
  const manifest = (cloud: boolean) => githubAppManifest({ appName: "Rovara", redirectUrl: "http://127.0.0.1:1/created", webhookUrl: "https://cp.example.test/v1/github/webhooks", cloud, installCallbackUrl: "https://cp.example.test/v1/github/install/callback" });

  it("subscribes to the three new events and reads actions and deployments, in the cloud and the private manifest", () => {
    for (const cloud of [true, false]) {
      const found = manifest(cloud);
      expect(found.default_events, String(cloud)).toEqual(expect.arrayContaining(["deployment_status", "workflow_run", "issues", "pull_request", "pull_request_review", "pull_request_review_comment", "issue_comment"]));
      expect(found.default_permissions, String(cloud)).toMatchObject({ contents: "write", pull_requests: "write", issues: "write", metadata: "read", actions: "read", deployments: "read" });
    }
    expect([...GITHUB_WEBHOOK_EVENTS]).toEqual(["pull_request", "pull_request_review", "pull_request_review_comment", "issue_comment", "deployment_status", "workflow_run", "issues"]);
  });

  it("makes agentx doctor name the events and permissions an older App lacks, and say nothing of a permission GitHub did not report", async () => {
    const url = githubWebhookUrl("https://abc123.execute-api.us-east-1.amazonaws.com");
    const context = (github: Parameters<typeof fakeGitHubApi>[0]) => doctorContext({ services: doctorServices({ github: fakeGitHubApi({ installationId: 456, hookUrl: url, ...github }) }) });
    const old = (await githubWebhookChecks(context({ events: ["pull_request", "pull_request_review", "pull_request_review_comment", "issue_comment"], permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read" } })))[1]!;
    expect(old).toMatchObject({ status: "warn" });
    expect(old.detail).toContain("deployment_status, workflow_run, issues");
    expect(old.detail).toContain("actions: read, deployments: read");
    expect(old.fix).toContain("/permissions");
    const partial = (await githubWebhookChecks(context({ permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read", actions: "read" } })))[1]!;
    expect(partial).toMatchObject({ status: "warn" });
    expect(partial.detail).toContain("deployments: read");
    expect(partial.detail).not.toContain("actions: read");
    // A stronger permission than the one asked for is enough.
    expect((await githubWebhookChecks(context({ permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read", actions: "write", deployments: "write" } })))[1]).toMatchObject({ status: "ok" });
  });
});
