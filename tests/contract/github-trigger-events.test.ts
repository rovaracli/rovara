// Plan 4 Task 21: GitHub's events reach triggers through the one webhook the App already has. The signature is checked by the existing verifier; after it, an event that can start work
// is mapped (only through the org's own installation, the repositories that installation holds and the projects whose latest revision pins both) and handed to Task 20's dispatch. Nothing
// here starts work by itself: these tests read what dispatch did. The loop guard, the replay guard and the org boundaries are the points a reviewer looks at first.
import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TriggerEvent } from "@agentx/contracts";
import { githubInstallationKey, githubRepoProjectKey, hookEventKey, orgGithubInstallationKey, orgProjectCatalogKey, projectRevisionKey } from "../../packages/contracts/src/index.js";
import type { OrgId } from "../../packages/contracts/src/org.js";
import { GithubWebhookRetryableError, handleGithubWebhook } from "../../packages/broker/src/aws/github-webhooks.js";
import { getApprovalSubjectHandler } from "../../packages/broker/src/agents/approvals.js";
import { expireApprovals } from "../../packages/broker/src/agents/approvals-decide.js";
import { dispatchTriggerEvent } from "../../packages/broker/src/triggers/dispatch.js";
import { deliverGithubTriggerEvents, githubTriggerEvents, type AuthorQuery, type AuthorStanding, type GithubTriggerDependencies } from "../../packages/broker/src/triggers/github-events.js";
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
const repository = (id = 101, fullName = "acme/web") => ({ id, full_name: fullName, name: fullName.split("/")[1], owner: { login: fullName.split("/")[0], type: "Organization" }, html_url: `https://github.com/${fullName}` });
const user = (login: string, type = "User") => ({ login, type });
function pullRequest(over: { action?: string; installation?: number; repo?: number; number?: number; sender?: { login: string; type: string }; author?: { login: string; type: string }; association?: string; labels?: string[]; base?: string; updatedAt?: string; title?: string } = {}) {
  return {
    action: over.action ?? "opened", installation: { id: over.installation ?? 55 }, repository: repository(over.repo ?? 101), sender: over.sender ?? user("alice"),
    pull_request: {
      number: over.number ?? 42, title: over.title ?? "Fix the login redirect", html_url: `https://github.com/acme/web/pull/${String(over.number ?? 42)}`, updated_at: over.updatedAt ?? fresh(),
      author_association: over.association ?? "MEMBER", labels: (over.labels ?? ["bug"]).map((name) => ({ name })), base: { ref: over.base ?? "main" }, user: over.author ?? over.sender ?? user("alice"),
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
  // What GitHub's API would say of an author (the installation-token lookup the broker makes): by default nobody belongs.
  const standing = { calls: [] as AuthorQuery[], answer: (async () => "none") as (query: AuthorQuery) => Promise<AuthorStanding> };
  const github: GithubTriggerDependencies = {
    documentClient: v.db, tableName: "T", now: () => v.clock.now, githubAppSlug: async () => slug.value,
    log: (event, fields) => logs.push({ event, fields }),
    authorStanding: async (query) => { standing.calls.push(query); return standing.answer(query); }, authorCheckTimeoutMs: 40,
    dispatch: async (orgId, event, context) => {
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      dispatched.push({ orgId, event });
      return dispatchTriggerEvent(v.routeDeps as never, orgId, event, context);
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
  return { v, logs, github, dispatched, failures, slug, standing, deliver, runs, chainTrigger };
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

  it("ignores an index row whose attribute and key disagree about the org, whichever of the two names another org", async () => {
    const w = world();
    await w.chainTrigger();
    registerProject(w.v.db, ORG_A, "attr", { installationId: 55, repositoryId: 101 }, { index: false });
    registerProject(w.v.db, ORG_A, "key", { installationId: 55, repositoryId: 101 }, { index: false });
    // The attribute says org B, the key org A; and the other way round.
    w.v.db.set({ ...githubRepoProjectKey(101, ORG_A, "attr"), entityType: "GITHUB_REPO_PROJECT", orgId: ORG_B, project: "attr", installationId: 55, githubRepositoryId: 101 });
    w.v.db.set({ ...githubRepoProjectKey(101, ORG_B, "key"), entityType: "GITHUB_REPO_PROJECT", orgId: ORG_A, project: "key", installationId: 55, githubRepositoryId: 101 });
    const found = await githubTriggerEvents(w.github, { eventName: "pull_request", payload: pullRequest(), installationId: 55 });
    expect(found.map((entry) => entry.event.project)).toEqual(["web"]);
    expect(w.logs.filter((entry) => entry.event === "github.trigger_stale_index")).toHaveLength(2);
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

// The staging 0.4.6 check (4a): a PR author whose org membership is private reaches the webhook as CONTRIBUTOR or NONE, so the built-in `authorAssociation in OWNER/MEMBER/COLLABORATOR`
// filter skipped a member's pull request and nothing said so. The association in a payload is never enough to upgrade an author: only GitHub's API, asked now with the installation's token,
// can, and an error, a timeout or a "no" leaves the filter as it was.
describe("an author whose membership is private still starts the members-only triggers (staging 0.4.6, check 4a)", () => {
  const MEMBERS = { ...PR_OPENED, filter: { authorAssociation: ["OWNER", "MEMBER", "COLLABORATOR"] } };

  it("starts a members-only trigger for a private member GitHub reports as CONTRIBUTOR, after asking the API about the pull request's author", async () => {
    const w = world();
    const trigger = await w.chainTrigger({ spec: MEMBERS });
    w.standing.answer = async () => "member";
    const result = await w.deliver(pullRequest({ association: "CONTRIBUTOR" }), "pull_request");
    expect(result.status).toBe("ACCEPTED");
    expect((await w.v.triggers.listActivity(ORG_A, trigger.triggerId)).map((entry) => entry.outcome)).toEqual(["started"]);
    expect(w.runs()).toHaveLength(1);
    expect(w.standing.calls).toEqual([{ installationId: 55, owner: "acme", ownerType: "Organization", repo: "web", login: "alice" }]);
  });

  it("counts an outside collaborator with write access too", async () => {
    const w = world();
    await w.chainTrigger({ spec: MEMBERS });
    w.standing.answer = async () => "collaborator";
    await w.deliver(pullRequest({ association: "NONE" }), "pull_request");
    expect(w.runs()).toHaveLength(1);
  });

  it("starts a members-only issue trigger the same way", async () => {
    const w = world();
    const trigger = await w.chainTrigger({ spec: { kind: "event", source: "github", type: "issues.opened", filter: MEMBERS.filter } });
    w.standing.answer = async () => "member";
    await w.deliver(issue({ association: "CONTRIBUTOR" }), "issues");
    expect((await w.v.triggers.listActivity(ORG_A, trigger.triggerId)).map((entry) => entry.outcome)).toEqual(["started"]);
  });

  it("starts nothing for NONE with no membership, and logs the association, the membership result and the trigger id", async () => {
    const w = world();
    const trigger = await w.chainTrigger({ spec: MEMBERS });
    w.standing.answer = async () => "none";
    await w.deliver(pullRequest({ association: "NONE" }), "pull_request");
    expect(w.runs()).toEqual([]);
    expect(await w.v.triggers.listActivity(ORG_A, trigger.triggerId)).toEqual([]);
    const miss = w.logs.filter((entry) => entry.event === "trigger_dispatch.filter_miss");
    expect(miss).toHaveLength(1);
    expect(miss[0]!.fields).toMatchObject({ orgId: ORG_A, triggerId: trigger.triggerId, type: "pull_request.opened", authorAssociation: ["NONE"], membership: "none", filterKeys: ["authorAssociation"] });
  });

  it("starts nothing when the API fails, answers or not, and says the membership was an error; the delivery itself is accepted, not retried", async () => {
    const w = world();
    const trigger = await w.chainTrigger({ spec: MEMBERS });
    w.standing.answer = async () => { throw new Error("GitHub is down"); };
    expect((await w.deliver(pullRequest({ association: "CONTRIBUTOR" }), "pull_request")).status).toBe("ACCEPTED");
    expect(w.runs()).toEqual([]);
    expect(w.logs.find((entry) => entry.event === "trigger_dispatch.filter_miss")!.fields).toMatchObject({ triggerId: trigger.triggerId, authorAssociation: ["CONTRIBUTOR"], membership: "error" });
    // A lookup that never answers is cut off and counts the same.
    w.logs.length = 0;
    w.standing.answer = () => new Promise<AuthorStanding>(() => undefined);
    await w.deliver(pullRequest({ number: 43, association: "CONTRIBUTOR" }), "pull_request");
    expect(w.runs()).toEqual([]);
    expect(w.logs.find((entry) => entry.event === "trigger_dispatch.filter_miss")!.fields).toMatchObject({ membership: "error" });
  });

  it("does not take the payload's word: the API is asked about the author, not the sender, and a member who only marked a stranger's pull request ready does not lend it their standing", async () => {
    const w = world();
    await w.chainTrigger({ spec: { kind: "event", source: "github", type: "pull_request.ready_for_review", filter: MEMBERS.filter } });
    w.standing.answer = async (query) => (query.login === "dana-maintainer" ? "member" : "none");
    await w.deliver(pullRequest({ action: "ready_for_review", association: "NONE", sender: user("dana-maintainer"), author: user("stranger") }), "pull_request");
    expect(w.standing.calls.map((call) => call.login)).toEqual(["stranger"]);
    expect(w.runs()).toEqual([]);
  });

  it("never lets an unsafe login or repository name reach the API", async () => {
    const w = world();
    await w.chainTrigger({ spec: MEMBERS });
    w.standing.answer = async () => "member";
    await w.deliver(pullRequest({ association: "NONE", author: user("../../orgs/acme") }), "pull_request");
    expect(w.runs()).toEqual([]);
    expect(w.standing.calls).toEqual([]);
  });

  it("asks only when it can matter: not for a trusted association, a trigger without the filter, a miss on another key, or a filter that does not name a member", async () => {
    const w = world();
    await w.chainTrigger({ spec: { ...MEMBERS, filter: { ...MEMBERS.filter, label: ["docs"] } } });
    await w.chainTrigger({ spec: { ...PR_OPENED, filter: { authorAssociation: ["CONTRIBUTOR"] } } });
    await w.chainTrigger({ spec: { ...PR_OPENED, filter: { baseBranch: ["main"] } } });
    await w.deliver(pullRequest({ association: "CONTRIBUTOR" }), "pull_request");
    expect(w.standing.calls).toEqual([]);
    const members = await w.chainTrigger({ spec: MEMBERS });
    await w.deliver(pullRequest({ number: 60, association: "OWNER" }), "pull_request");
    expect((await w.v.triggers.listActivity(ORG_A, members.triggerId)).map((entry) => entry.outcome)).toEqual(["started"]);
    expect(w.standing.calls).toEqual([]);
  });

  it("asks once per delivery however many triggers and projects hold the repository", async () => {
    const w = world();
    registerProject(w.v.db, ORG_A, "web2", { installationId: 55, repositoryId: 101 });
    w.v.projectMembers.grant(ORG_A, "web2", PRIYA, "contributor");
    const chain = await w.v.budgetedChain(ONE_STEP);
    for (const project of ["web", "web2"]) for (let n = 0; n < 2; n += 1) await w.v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: MEMBERS, createdBy: DANA, project } as never);
    w.standing.answer = async () => "member";
    await w.deliver(pullRequest({ association: "CONTRIBUTOR" }), "pull_request");
    expect(w.standing.calls).toHaveLength(1);
    expect(w.runs()).toHaveLength(4);
  });

  it("still de-duplicates a replay: the same body under a new delivery id, and the same event dispatched again, start one run", async () => {
    const w = world();
    const trigger = await w.chainTrigger({ spec: MEMBERS });
    w.standing.answer = async () => "member";
    await w.deliver(pullRequest({ association: "CONTRIBUTOR" }), "pull_request");
    expect((await w.deliver(pullRequest({ association: "CONTRIBUTOR" }), "pull_request")).status).toBe("DUPLICATE");
    expect(w.runs()).toHaveLength(1);
    expect(w.standing.calls).toHaveLength(1);
    // Past the event memory, dispatch's own identity answers: the event is the same start.
    const again = await dispatchTriggerEvent(w.v.routeDeps as never, ORG_A, w.dispatched[0]!.event, { verifyAuthor: async () => "member" });
    expect(again).toMatchObject([{ triggerId: trigger.triggerId, outcome: "duplicate" }]);
    expect(w.runs()).toHaveLength(1);
  });

  it("logs nothing about a start that matched, and no log line carries a token", async () => {
    const w = world();
    await w.chainTrigger({ spec: MEMBERS });
    w.standing.answer = async () => "member";
    await w.deliver(pullRequest({ association: "CONTRIBUTOR" }), "pull_request");
    expect(w.logs.filter((entry) => entry.event === "trigger_dispatch.filter_miss")).toEqual([]);
    w.standing.answer = async () => { throw new Error("ghs_secrettoken123 rejected"); };
    await w.deliver(pullRequest({ number: 61, association: "NONE" }), "pull_request");
    expect(JSON.stringify(w.logs)).not.toMatch(/ghs_|token|Bearer/i);
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
    const payload = pullRequest({ title: `\u0007${"T".repeat(400)}` });
    (payload.pull_request as { html_url: string }).html_url = "https://evil.example/pull/42";
    const [found] = await githubTriggerEvents(w.github, { eventName: "pull_request", payload, installationId: 55 });
    expect(found!.event.subject.url).toBeUndefined();
    expect([...found!.event.subject.title]).toHaveLength(300);
    expect(found!.event.subject.title).not.toContain("\u0007");
  });

  it("leaves out a subject link that is not https, and still maps the event", async () => {
    const w = world();
    const payload = pullRequest();
    (payload.pull_request as { html_url: string }).html_url = "http://github.com/acme/web/pull/42";
    const [found] = await githubTriggerEvents(w.github, { eventName: "pull_request", payload, installationId: 55 });
    expect(found!.event.subject).toMatchObject({ id: "42" });
    expect(found!.event.subject.url).toBeUndefined();
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

  it("ignores, without a fault, a pull request event that names no installation", async () => {
    const w = await brokerWorld();
    const without: Record<string, unknown> = { ...pullRequest() };
    delete without["installation"];
    const reply = await w.post(without, "pull_request");
    expect(reply.statusCode).toBe(202);
    expect(JSON.parse(reply.body)).toMatchObject({ delivery: "IGNORED" });
    expect(w.dispatched).toEqual([]);
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
      expect(found.default_permissions, String(cloud)).toMatchObject({ contents: "write", pull_requests: "write", issues: "write", metadata: "read", actions: "read", deployments: "read", checks: "read", statuses: "read" });
      // Plan 6 Task 14: merge tracking follows checks and commit statuses.
      expect(found.default_events, String(cloud)).toEqual(expect.arrayContaining(["check_suite", "check_run", "status"]));
      // Meta repo lane A: a meta repo's config file changes by a push, which needs no permission beyond the contents read the App already has.
      expect(found.default_events, String(cloud)).toContain("push");
    }
    expect([...GITHUB_WEBHOOK_EVENTS]).toEqual(["pull_request", "pull_request_review", "pull_request_review_comment", "issue_comment", "deployment_status", "workflow_run", "issues", "check_suite", "check_run", "status", "push"]);
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
    // A reply that says nothing of permissions claims nothing missing.
    const silent = fakeGitHubApi({ installationId: 456, hookUrl: url });
    silent.getApp = async () => ({ slug: "agentx-acme-staging", owner: { login: "acme", type: "Organization" }, events: [...GITHUB_WEBHOOK_EVENTS] });
    expect((await githubWebhookChecks(doctorContext({ services: doctorServices({ github: silent }) })))[1]).toMatchObject({ status: "ok" });
    // A stronger permission than the one asked for is enough.
    expect((await githubWebhookChecks(context({ permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read", actions: "write", deployments: "write", checks: "write", statuses: "write" } })))[1]).toMatchObject({ status: "ok" });
    const noChecks = (await githubWebhookChecks(context({ permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read", actions: "read", deployments: "read" } })))[1]!;
    expect(noChecks).toMatchObject({ status: "warn" });
    expect(noChecks.detail).toContain("checks: read, statuses: read");
  });
});

// ---- Task 22 Step 0: a project registered before the index existed has no `GITHUB_REPO#` rows; turning a GitHub trigger on heals them
describe("turning a GitHub trigger on heals the repository index of its project (Plan 4 Task 22 Step 0)", () => {
  const TRIGGER = (letter: string) => `ctr_${letter.repeat(20)}`;
  const indexRows = (db: FakeDynamoDb) => db.find((item) => String(item["pk"]).startsWith("GITHUB_REPO#")).map((item) => `${String(item["pk"])}|${String(item["sk"])}`).sort();
  const own = (id: number, project = "web", org: OrgId = ORG_A) => `GITHUB_REPO#${String(id)}|${org}#${project}`;
  const pathOf = (chainId: string, triggerId: string) => `/v1/app/chains/${chainId}/triggers/${triggerId}`;
  /** A world whose project web was registered before the index: its revision pins the repository and no row names it. */
  async function legacy() {
    const w = world();
    w.v.db.delete(githubRepoProjectKey(101, ORG_A, "web"));
    expect(indexRows(w.v.db)).toEqual([]);
    const chain = await w.v.budgetedChain(ONE_STEP);
    return { w, chain };
  }

  it("writes the project's rows when a person confirms the trigger on the page, and a pull request then starts the run (not before)", async () => {
    const { w, chain } = await legacy();
    // Another org's project of the same name, also with no row: it must stay as it is.
    registerProject(w.v.db, ORG_B, "web", { installationId: 66, repositoryId: 303 }, { index: false });
    const asked = await w.v.chainCall(DANA, "PUT", pathOf(chain.chainId, TRIGGER("a")), { project: "web", spec: PR_OPENED });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    // Stored off and waiting: nothing is on yet, so nothing is healed.
    expect(indexRows(w.v.db)).toEqual([]);
    await w.deliver(pullRequest(), "pull_request");
    expect(w.runs()).toEqual([]);
    const approvalId = String(asked.body["confirmUrl"]).split("/").pop()!;
    expect((await w.v.decideAs(DANA, approvalId)).statusCode).toBe(200);
    expect(indexRows(w.v.db)).toEqual([own(101)]);
    expect(w.v.db.get(githubRepoProjectKey(101, ORG_A, "web"))).toMatchObject({ orgId: ORG_A, project: "web", installationId: 55, githubRepositoryId: 101 });
    expect((await w.deliver(pullRequest({ number: 77 }), "pull_request")).status).toBe("ACCEPTED");
    expect(w.runs()).toHaveLength(1);
  });

  it("writes them when a trigger that is already on is saved again and applied at once", async () => {
    const { w, chain } = await legacy();
    const on = await w.chainTrigger({ triggerId: TRIGGER("b"), target: { kind: "chain", chainId: chain.chainId } });
    expect(on.enabled).toBe(true);
    expect(indexRows(w.v.db)).toEqual([]);
    const saved = await w.v.chainCall(DANA, "PUT", pathOf(chain.chainId, on.triggerId), { project: "web", spec: PR_OPENED, enabled: true });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(indexRows(w.v.db)).toEqual([own(101)]);
  });

  it("writes nothing for a trigger that is turned off, nor for another source's trigger", async () => {
    const { w, chain } = await legacy();
    expect((await w.v.chainCall(DANA, "PUT", pathOf(chain.chainId, TRIGGER("c")), { project: "web", spec: PR_OPENED, enabled: false })).status).toBe(201);
    expect(indexRows(w.v.db)).toEqual([]);
    w.v.hook("sentry");
    const asked = await w.v.chainCall(DANA, "PUT", pathOf(chain.chainId, TRIGGER("d")), { project: "web", spec: { kind: "event", source: "sentry", type: "issue.created" }, hookId: `hk_${"a".repeat(26)}` });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect((await w.v.decideAs(DANA, String(asked.body["confirmUrl"]).split("/").pop()!)).statusCode).toBe(200);
    expect(indexRows(w.v.db)).toEqual([]);
  });

  it("writes only the rows of repositories the project pins, under its own org, and nothing when the project has no revision", async () => {
    const { w, chain } = await legacy();
    // The project's latest revision also holds a repository with no pin; and a project of another org pins the same repository.
    w.v.db.set({
      ...projectRevisionKey(ORG_A, "web", 2), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-02T00:00:00.000Z", runtimeBinding: {},
      definition: {
        name: "web", revision: 2, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
        repositories: [
          { name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app", installationId: 55, githubRepositoryId: 101 },
          { name: "docs", url: "https://github.com/acme/docs.git", path: "repo/docs", defaultBranch: "main", credentialRef: "github-app" },
        ],
      },
    });
    w.v.db.set({ ...orgProjectCatalogKey(ORG_A, "web"), entityType: "PROJECT_CATALOG", name: "web", latestRevision: 2 });
    registerProject(w.v.db, ORG_B, "web", { installationId: 66, repositoryId: 101 }, { index: false });
    const asked = await w.v.chainCall(DANA, "PUT", pathOf(chain.chainId, TRIGGER("e")), { project: "web", spec: PR_OPENED });
    await w.v.decideAs(DANA, String(asked.body["confirmUrl"]).split("/").pop()!);
    expect(indexRows(w.v.db)).toEqual([own(101)]);
    // A trigger on a project that has no revision stored heals nothing and does not fail.
    w.v.db.delete(projectRevisionKey(ORG_A, "web", 1));
    w.v.db.delete(projectRevisionKey(ORG_A, "web", 2));
    w.v.db.delete(githubRepoProjectKey(101, ORG_A, "web"));
    const again = await w.v.chainCall(DANA, "PUT", pathOf(chain.chainId, TRIGGER("e")), { project: "web", spec: PR_OPENED, enabled: true });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(indexRows(w.v.db)).toEqual([]);
  });

  it("heals the rows of the trigger's own project, whatever its name, and a confirmation told again after it was applied heals them again", async () => {
    const { w, chain } = await legacy();
    w.v.projectMembers.grant(ORG_A, "api", PRIYA, "contributor");
    registerProject(w.v.db, ORG_A, "api", { installationId: 55, repositoryId: 202 }, { index: false });
    const asked = await w.v.chainCall(DANA, "PUT", pathOf(chain.chainId, TRIGGER("h")), { project: "api", spec: PR_OPENED });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const approvalId = String(asked.body["confirmUrl"]).split("/").pop()!;
    await w.v.decideAs(DANA, approvalId);
    expect(indexRows(w.v.db)).toEqual([own(202, "api")]);
    // The sweep tells the handler again (it did not hear the first time) after the rows were lost: the handler finishes by writing them again.
    w.v.db.delete(githubRepoProjectKey(202, ORG_A, "api"));
    await getApprovalSubjectHandler("trigger_enable")!(w.v.routeDeps, await w.v.approval(approvalId));
    expect(indexRows(w.v.db)).toEqual([own(202, "api")]);
  });

  it("writes no row for a repository whose pin is only half there", async () => {
    const { w, chain } = await legacy();
    w.v.db.set({
      ...projectRevisionKey(ORG_A, "web", 2), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-02T00:00:00.000Z", runtimeBinding: {},
      definition: {
        name: "web", revision: 2, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
        repositories: [
          { name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app", installationId: 55 },
          { name: "docs", url: "https://github.com/acme/docs.git", path: "repo/docs", defaultBranch: "main", credentialRef: "github-app", githubRepositoryId: 303 },
        ],
      },
    });
    w.v.db.set({ ...orgProjectCatalogKey(ORG_A, "web"), entityType: "PROJECT_CATALOG", name: "web", latestRevision: 2 });
    const asked = await w.v.chainCall(DANA, "PUT", pathOf(chain.chainId, TRIGGER("i")), { project: "web", spec: PR_OPENED });
    await w.v.decideAs(DANA, String(asked.body["confirmUrl"]).split("/").pop()!);
    expect(indexRows(w.v.db)).toEqual([]);
  });

  it("turns nothing on while the rows can't be written, on the page and on the direct route, and goes through when it is tried again", async () => {
    const { w, chain } = await legacy();
    const asked = await w.v.chainCall(DANA, "PUT", pathOf(chain.chainId, TRIGGER("f")), { project: "web", spec: PR_OPENED });
    const approvalId = String(asked.body["confirmUrl"]).split("/").pop()!;
    w.v.db.injectFault({ command: "PutCommand", match: (input) => String((input["Item"] as { pk?: unknown }).pk).startsWith("GITHUB_REPO#"), error: { name: "InternalServerError" }, times: 1 });
    await w.v.decideAs(DANA, approvalId);
    // A fault of ours is not a refusal: the approval is not ended, nothing is on and no row is half written, and the sweep drives it again.
    expect((await w.v.approval(approvalId)).status).not.toBe("APPROVED_FAILED");
    expect((await w.v.triggers.get(ORG_A, TRIGGER("f")))?.enabled).toBe(false);
    expect(indexRows(w.v.db)).toEqual([]);
    await expireApprovals(w.v.deps, w.v.clock.now + 3_600_000);
    expect((await w.v.triggers.get(ORG_A, TRIGGER("f")))?.enabled).toBe(true);
    expect(indexRows(w.v.db)).toEqual([own(101)]);
    w.v.db.delete(githubRepoProjectKey(101, ORG_A, "web"));
    // A fault on the direct route is a refusal that stores nothing new, and the same request repeated goes through.
    w.v.db.injectFault({ command: "PutCommand", match: (input) => String((input["Item"] as { pk?: unknown }).pk).startsWith("GITHUB_REPO#"), error: { name: "InternalServerError" }, times: 1 });
    await w.chainTrigger({ triggerId: TRIGGER("g"), target: { kind: "chain", chainId: chain.chainId } });
    await expect(w.v.chainCall(DANA, "PUT", pathOf(chain.chainId, TRIGGER("g")), { project: "web", spec: PR_OPENED, enabled: true })).rejects.toMatchObject({ name: "InternalServerError" });
    expect(indexRows(w.v.db)).toEqual([]);
    expect((await w.v.chainCall(DANA, "PUT", pathOf(chain.chainId, TRIGGER("g")), { project: "web", spec: PR_OPENED, enabled: true })).status).toBe(200);
    expect(indexRows(w.v.db)).toEqual([own(101)]);
  });
});

// ---- Task 21 review minor 2: a table fault while the events are found or remembered is a retryable fault, so GitHub redelivers
describe("a DynamoDB fault while GitHub's events are handled is retried by GitHub (Plan 4 Task 22, Task 21 review)", () => {
  const indexRead = (input: Record<string, unknown>) => String((input["ExpressionAttributeValues"] as Record<string, unknown> | undefined)?.[":pk"]).startsWith("GITHUB_REPO#");
  const eventWrite = (input: Record<string, unknown>) => String((input["Item"] as { pk?: unknown } | undefined)?.pk).includes("#HOOK_EVENT#");

  it("makes a fault reading the repository's index a GithubWebhookRetryableError, and starts the event on the redelivery", async () => {
    const w = world();
    await w.chainTrigger();
    w.v.db.injectFault({ command: "QueryCommand", match: indexRead, error: { name: "InternalServerError" } });
    await expect(w.deliver(pullRequest(), "pull_request")).rejects.toBeInstanceOf(GithubWebhookRetryableError);
    expect(w.runs()).toEqual([]);
    expect(w.logs.filter((entry) => entry.event === "github.trigger_unavailable")).toEqual([{ event: "github.trigger_unavailable", fields: { error: "InternalServerError" } }]);
    expect((await w.deliver(pullRequest(), "pull_request")).status).toBe("ACCEPTED");
    expect(w.runs()).toHaveLength(1);
  });

  it("forgets the events it had already remembered when a later one can't be, so the redelivery starts both projects' work", async () => {
    const w = world();
    registerProject(w.v.db, ORG_A, "api", { installationId: 55, repositoryId: 101 });
    let writes = 0;
    w.v.db.injectFault({ command: "PutCommand", match: (input) => eventWrite(input) && ++writes === 2, error: { name: "InternalServerError" } });
    await expect(w.deliver(pullRequest(), "pull_request")).rejects.toBeInstanceOf(GithubWebhookRetryableError);
    expect(writes).toBe(2);
    expect(w.v.db.find((item) => String(item["pk"]).includes("#HOOK_EVENT#"))).toEqual([]);
    expect(await w.deliver(pullRequest(), "pull_request")).toMatchObject({ status: "ACCEPTED" });
    expect(w.v.db.find((item) => String(item["pk"]).includes("#HOOK_EVENT#"))).toHaveLength(2);
  });

  it("does the same for a fault reading the installation and for one remembering the event", async () => {
    const w = world();
    await w.chainTrigger();
    w.v.db.injectFault({ command: "GetCommand", match: (input) => String((input["Key"] as { pk?: unknown } | undefined)?.pk).startsWith("GITHUB_INSTALLATION#"), error: { name: "ProvisionedThroughputExceededException" } });
    await expect(w.deliver(pullRequest(), "pull_request")).rejects.toBeInstanceOf(GithubWebhookRetryableError);
    w.v.db.injectFault({ command: "PutCommand", match: eventWrite, error: { name: "InternalServerError" } });
    await expect(w.deliver(pullRequest(), "pull_request")).rejects.toBeInstanceOf(GithubWebhookRetryableError);
    expect(w.runs()).toEqual([]);
    expect((await w.deliver(pullRequest(), "pull_request")).status).toBe("ACCEPTED");
  });

  it("answers 503 through the broker, and 202 on the redelivery", async () => {
    const w = await brokerWorld();
    w.h.db.injectFault({ command: "QueryCommand", match: indexRead, error: { name: "InternalServerError" } });
    expect((await w.post(pullRequest(), "pull_request")).statusCode).toBe(503);
    expect(w.dispatched).toEqual([]);
    expect((await w.post(pullRequest(), "pull_request")).statusCode).toBe(202);
    expect(w.dispatched).toHaveLength(1);
  });
});
