// Meta repo lane F (F3): a label or an assignment on a Jira or GitHub issue asks Rovara Code for work. The vendors' deliveries are read by the existing, signed paths (Jira's hook route,
// GitHub's one App webhook) into events of their own (`issue.labeled`, `issue.assigned`, `issues.labeled`, `issues.assigned`); a Rovara Code trigger on one starts nothing by itself:
// dispatch hands the ticket to the intake engine, where WHO did it decides. The label and the assignee are only routing hints.
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { HookRecord, OrgId, TriggerEvent } from "@rovara-code/contracts";
import { githubInstallationKey, githubRepoProjectKey, orgGithubInstallationKey } from "@agentx/cloud-contracts";
import { orgAutonomousKey, orgProjectCatalogKey, projectRevisionKey, triggerRateKey } from "@rovara-code/contracts";
import { jiraProvider } from "../../packages/broker/src/triggers/providers/jira.js";
import { githubTriggerEvents, type GithubTriggerDependencies } from "../../packages/broker/src/triggers/github-events.js";
import { dispatchTriggerEvent } from "../../packages/broker/src/triggers/dispatch.js";
import { ingestIntake, type IntakeCandidate, type IntakeOutcome, type IntakePorts } from "../../packages/broker/src/intake/engine.js";
import { listWaitingIntakeItems } from "../../packages/broker/src/intake/store.js";
import { intakeCandidateOf } from "../../packages/broker/src/triggers/intake-dispatch.js";
import { triggerProblems } from "../../packages/broker/src/triggers/requirements.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { DANA, MAX, ORG_A, disposeGateWorlds, setupTriggerWorld } from "../support/trigger-world.js";

afterEach(() => disposeGateWorlds());

const NOW = Date.parse("2026-10-31T10:00:00.000Z");
const MEMBER = "a".repeat(64);

// ---- Jira
const HOOK = { source: "jira", project: "web", hookId: `hk_${"1".repeat(26)}`, orgId: ORG_A, tenant: { siteHost: "acme.atlassian.net", projectKey: "PAY" } } as unknown as HookRecord;
interface JiraOver { event?: string; items?: Array<Record<string, unknown>>; host?: string; project?: string; account?: string; accountType?: string; description?: unknown; changeId?: string | null; summary?: string }
function jiraUpdate(over: JiraOver = {}): Record<string, unknown> {
  return {
    timestamp: NOW - 5_000, webhookEvent: over.event ?? "jira:issue_updated",
    user: { accountId: over.account ?? "acct-dana", accountType: over.accountType ?? "atlassian", displayName: "Dana" },
    issue: {
      id: "10042", key: "PAY-12", self: `https://${over.host ?? "acme.atlassian.net"}/rest/api/2/issue/10042`,
      fields: { summary: over.summary ?? "Refunds fail", description: "description" in over ? over.description : "Refunds over 100 fail.", project: { key: over.project ?? "PAY" }, issuetype: { name: "Bug" }, labels: ["bug"] },
    },
    changelog: { ...(over.changeId === null ? {} : { id: over.changeId ?? "10124" }), items: over.items ?? [{ field: "labels", fromString: "bug", toString: "bug rovara" }] },
  };
}
const eventsOf = (body: unknown) => {
  const result = jiraProvider.normalize(body, {}, HOOK);
  if (!("events" in result)) throw new Error(`no events: ${JSON.stringify(result)}`);
  return result.events;
};

describe("Jira: a label added or an assignment is an event", () => {
  it("makes an issue.labeled event for the label that was added, with the person who added it and the description", () => {
    const [event] = eventsOf(jiraUpdate());
    expect(event).toMatchObject({
      source: "jira", type: "issue.labeled", eventKey: "jira:issue:10042:labeled:rovara:10124", project: "web",
      subject: { kind: "issue", id: "PAY-12", title: "Refunds fail", url: "https://acme.atlassian.net/browse/PAY-12", body: "Refunds over 100 fail." },
      fields: { label: ["rovara"], issueId: ["10042"] }, actor: { kind: "external", id: "acct-dana", accountId: "acct-dana" },
    });
  });

  it("makes one event for each label added, and none for a label that was already there", () => {
    const events = eventsOf(jiraUpdate({ items: [{ field: "labels", fromString: "bug urgent", toString: "bug urgent rovara docs" }] }));
    expect(events.map((event) => event.fields["label"])).toEqual([["rovara"], ["docs"]]);
    expect(new Set(events.map((event) => event.eventKey)).size).toBe(2);
  });

  it("makes at most five label events from one update", () => {
    const toString = ["l1", "l2", "l3", "l4", "l5", "l6", "l7"].join(" ");
    expect(eventsOf(jiraUpdate({ items: [{ field: "labels", fromString: "", toString }] }))).toHaveLength(5);
  });

  it("makes an issue.assigned event for the assignee, and nothing for an unassignment", () => {
    const [event] = eventsOf(jiraUpdate({ items: [{ field: "assignee", fromString: "A", toString: "Rovara", to: "acct-rovara" }] }));
    expect(event).toMatchObject({ type: "issue.assigned", fields: { assignee: ["acct-rovara"] }, eventKey: "jira:issue:10042:assigned:acct-rovara:10124" });
    expect(jiraProvider.normalize(jiraUpdate({ items: [{ field: "assignee", fromString: "A", toString: null, to: null }] }), {}, HOOK)).toEqual({ ignored: "an update that asks for nothing" });
  });

  it("reads an assignment whose changelog item leaves out the display name (a missing key is not the method every object has)", () => {
    const [event] = eventsOf(jiraUpdate({ items: [{ field: "assignee", to: "acct-rovara" }] }));
    expect(event).toMatchObject({ type: "issue.assigned", fields: { assignee: ["acct-rovara"] } });
  });

  it("ignores an update that changed neither a label nor the assignee", () => {
    expect(jiraProvider.normalize(jiraUpdate({ items: [{ field: "summary", fromString: "a", toString: "b" }] }), {}, HOOK)).toEqual({ ignored: "an update that asks for nothing" });
  });

  it("says an automation is one, and keeps the description out when it is not text", () => {
    const [bot] = eventsOf(jiraUpdate({ accountType: "app", description: { type: "doc", content: [] } }));
    expect(bot!.actor).toMatchObject({ kind: "external", bot: true });
    expect(bot!.subject.body).toBeUndefined();
  });

  it("never takes a Jira service-desk customer for a person who could be a member: no account id is carried (only the name, for the loop guard)", () => {
    const [customer] = eventsOf(jiraUpdate({ accountType: "customer" }));
    expect(customer!.actor).toEqual({ kind: "unknown", id: "acct-dana" });
  });

  it("keeps an app's account id (for the loop guard) and marks it an automation; a person (atlassian) keeps their id", () => {
    expect(eventsOf(jiraUpdate({ accountType: "app" }))[0]!.actor).toEqual({ kind: "external", id: "acct-dana", accountId: "acct-dana", bot: true });
    expect(eventsOf(jiraUpdate({ accountType: "atlassian" }))[0]!.actor).toEqual({ kind: "external", id: "acct-dana", accountId: "acct-dana" });
  });

  it("treats a Jira update with no known account type as unknown, not as a person", () => {
    const body = jiraUpdate();
    delete (body["user"] as Record<string, unknown>)["accountType"];
    expect(eventsOf(body)[0]!.actor).toEqual({ kind: "unknown", id: "acct-dana" });
  });

  it("keys a change by the changelog's id, and by the time when there is none", () => {
    expect(eventsOf(jiraUpdate({ changeId: null }))[0]!.eventKey).toBe(`jira:issue:10042:labeled:rovara:${String(NOW - 5_000)}`);
  });

  it("skips a label with a hidden character", () => {
    const toString = "bug ro​vara";
    expect(jiraProvider.normalize(jiraUpdate({ items: [{ field: "labels", fromString: "bug", toString }] }), {}, HOOK)).toEqual({ ignored: "an update that asks for nothing" });
  });

  it("skips a label or an assignee that is too long to be one (it would not fit an event key)", () => {
    expect(jiraProvider.normalize(jiraUpdate({ items: [{ field: "labels", fromString: "", toString: "x".repeat(150) }] }), {}, HOOK)).toEqual({ ignored: "an update that asks for nothing" });
    expect(jiraProvider.normalize(jiraUpdate({ items: [{ field: "assignee", to: "y".repeat(150) }] }), {}, HOOK)).toEqual({ ignored: "an update that asks for nothing" });
  });

  it("believes an update only for the hook's own site and project, as a created issue is", () => {
    expect(jiraProvider.normalize(jiraUpdate({ host: "evil.example.com" }), {}, HOOK)).toEqual({ tenantMismatch: true });
    expect(jiraProvider.normalize(jiraUpdate({ project: "OTHER" }), {}, HOOK)).toEqual({ tenantMismatch: true });
  });

  it("is verified by the same signature as a created issue: an update with a wrong signature is not believed", () => {
    const raw = Buffer.from(JSON.stringify(jiraUpdate()));
    const good = `sha256=${createHmac("sha256", "secret-one").update(raw).digest("hex")}`;
    expect(jiraProvider.verify(raw, { "x-hub-signature": good }, "secret-one")).toBe(true);
    expect(jiraProvider.verify(raw, { "x-hub-signature": good }, "secret-two")).toBe(false);
    expect(jiraProvider.verify(raw, {}, "secret-one")).toBe(false);
  });

  it("still ignores every other event, and still reads a created issue", () => {
    expect(jiraProvider.normalize(jiraUpdate({ event: "jira:issue_deleted" }), {}, HOOK)).toEqual({ ignored: "not an issue created" });
    const created = { ...jiraUpdate({ event: "jira:issue_created" }) };
    delete created["changelog"];
    expect(eventsOf(created)[0]).toMatchObject({ type: "issue.created" });
  });

  it("cuts a very long description", () => {
    const [event] = eventsOf(jiraUpdate({ description: "x".repeat(50_000) }));
    expect(event!.subject.body!.length).toBeLessThanOrEqual(20_000);
  });
});

// ---- GitHub
const repository = { id: 101, full_name: "Acme/Web", name: "Web", owner: { login: "Acme", type: "Organization" }, html_url: "https://github.com/Acme/Web" };
const stamp = "2026-10-31T09:59:00Z";
function issuePayload(over: { action?: string; label?: string; assignee?: string; sender?: Record<string, unknown>; body?: string | null; asPullRequest?: boolean; title?: string } = {}) {
  const action = over.action ?? "labeled";
  return {
    action, installation: { id: 55 }, repository, sender: over.sender ?? { login: "maya", type: "User", id: 12345 },
    ...(action === "labeled" ? { label: { name: over.label ?? "rovara" } } : {}), ...(action === "assigned" ? { assignee: { login: over.assignee ?? "rovara-bot", id: 777 } } : {}),
    issue: {
      number: 7, title: over.title ?? "Checkout fails", html_url: "https://github.com/Acme/Web/issues/7", created_at: stamp, updated_at: stamp, author_association: "NONE", user: { login: "eve", type: "User", id: 1 },
      labels: [{ name: "bug" }, { name: over.label ?? "rovara" }], body: over.body === undefined ? "Checkout returns 500." : over.body,
      ...(over.asPullRequest === true ? { pull_request: { url: "https://api.github.com/x" } } : {}),
    },
  };
}
function bindGithub(db: FakeDynamoDb, orgId: OrgId) {
  const record = { installationId: 55, orgId, accountLogin: "acme", status: "active", repositorySelection: "all" };
  db.set({ ...githubInstallationKey(55), entityType: "GITHUB_INSTALLATION", ...record });
  db.set({ ...orgGithubInstallationKey(orgId, 55), entityType: "ORG_GITHUB_INSTALLATION", ...record });
  db.set({
    ...projectRevisionKey(orgId, "web", 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: {},
    definition: {
      name: "web", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
      repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app", installationId: 55, githubRepositoryId: 101 }],
    },
  });
  db.set({ ...orgProjectCatalogKey(orgId, "web"), entityType: "PROJECT_CATALOG", name: "web", latestRevision: 1 });
  db.set({ ...githubRepoProjectKey(101, orgId, "web"), entityType: "GITHUB_REPO_PROJECT", orgId, project: "web", installationId: 55, githubRepositoryId: 101 });
}
function githubWorld(slug: string | undefined = "rovara-app") {
  const v = setupTriggerWorld();
  bindGithub(v.db, ORG_A);
  const deps: Pick<GithubTriggerDependencies, "documentClient" | "tableName" | "log" | "githubAppSlug"> = { documentClient: v.db, tableName: "T", log: () => undefined, githubAppSlug: async () => slug };
  const events = async (payload: object): Promise<TriggerEvent[]> => (await githubTriggerEvents(deps, { eventName: "issues", payload, installationId: 55 })).map((entry) => entry.event);
  return { v, events };
}

describe("GitHub: a label added or an assignment on an issue is an event", () => {
  it("makes an issues.labeled event for the label that was added (not every label on the issue), keyed by the change", async () => {
    const w = githubWorld();
    const [event] = await w.events(issuePayload());
    expect(event).toMatchObject({
      source: "github", type: "issues.labeled", project: "web", fields: { label: ["rovara"] },
      subject: { kind: "issue", id: "acme/web/7", title: "Checkout fails", url: "https://github.com/Acme/Web/issues/7", body: "Checkout returns 500." },
    });
    expect(event!.hookId).toBeUndefined();
    expect(event!.eventKey).toBe(`gh:issue:101:7:labeled:rovara:${stamp}`);
    const [other] = await w.events(issuePayload({ label: "docs" }));
    expect(other!.eventKey).not.toBe(event!.eventKey);
  });

  it("says who did it by their account id, which is what a linked member is found by", async () => {
    const w = githubWorld();
    const [event] = await w.events(issuePayload());
    expect(event!.actor).toEqual({ kind: "external", id: "maya", accountId: "12345" });
  });

  it("says an automation that is not Rovara's is one, and Rovara's own bot is Rovara", async () => {
    const w = githubWorld();
    const [bot] = await w.events(issuePayload({ sender: { login: "dependabot[bot]", type: "Bot", id: 49699333 } }));
    expect(bot!.actor).toEqual({ kind: "external", id: "dependabot[bot]", accountId: "49699333", bot: true });
    const [own] = await w.events(issuePayload({ sender: { login: "rovara-app[bot]", type: "Bot", id: 9 } }));
    expect(own!.actor).toMatchObject({ kind: "rovara" });
  });

  it("takes a sender that is an Organization or a Mannequin for an automation, not a person", async () => {
    const w = githubWorld();
    for (const type of ["Organization", "Mannequin"]) {
      const [event] = await w.events(issuePayload({ sender: { login: "someone", type, id: 5 } }));
      expect(event!.actor).toEqual({ kind: "external", id: "someone", accountId: "5", bot: true });
    }
    const [user] = await w.events(issuePayload({ sender: { login: "maya", type: "User", id: 5 } }));
    expect(user!.actor).toEqual({ kind: "external", id: "maya", accountId: "5" });
  });

  it("makes an issues.assigned event for who it was assigned to", async () => {
    const w = githubWorld();
    const [event] = await w.events(issuePayload({ action: "assigned", assignee: "Rovara-Bot" }));
    expect(event).toMatchObject({ type: "issues.assigned", fields: { assignee: ["Rovara-Bot"] } });
    expect(event!.eventKey).toBe(`gh:issue:101:7:assigned:Rovara-Bot:${stamp}`);
  });

  it("ignores a label that is too long to be one", async () => {
    const w = githubWorld();
    expect(await w.events(issuePayload({ label: "x".repeat(150) }))).toEqual([]);
  });

  it("ignores a pull request's label (it is the pull request's event), an unlabeling, and a label event with no label", async () => {
    const w = githubWorld();
    expect(await w.events(issuePayload({ asPullRequest: true }))).toEqual([]);
    expect(await w.events(issuePayload({ action: "unlabeled" }))).toEqual([]);
    const noLabel = issuePayload() as Record<string, unknown>;
    delete noLabel["label"];
    expect(await w.events(noLabel)).toEqual([]);
  });

  it("still makes the same issues.opened event it always did, without the new actor fields", async () => {
    const w = githubWorld();
    const [event] = await w.events({ ...issuePayload({ action: "opened" }) });
    expect(event).toMatchObject({ type: "issues.opened", subject: { id: "7" } });
    expect(event!.actor).toEqual({ kind: "external", id: "maya" });
    expect(event!.subject.body).toBeUndefined();
  });

  it("makes the event only for the org the installation is bound to", async () => {
    const w = githubWorld();
    const found = await githubTriggerEvents({ documentClient: w.v.db, tableName: "T", log: () => undefined }, { eventName: "issues", payload: issuePayload(), installationId: 999 });
    expect(found).toEqual([]);
  });
});

// ---- dispatch: a Rovara Code trigger hands the ticket to the intake engine
const LABELED: TriggerEvent = {
  source: "github", type: "issues.labeled", eventKey: `gh:issue:101:7:labeled:rovara:${stamp}`, occurredAt: new Date(NOW - 60_000).toISOString(), project: "web",
  subject: { kind: "issue", id: "acme/web/7", title: "Checkout fails", url: "https://github.com/Acme/Web/issues/7", body: "Checkout returns 500." },
  fields: { label: ["rovara"] }, actor: { kind: "external", id: "maya", accountId: "12345" },
};
const CODE = { kind: "agent" as const, agentId: "rovara-code" as const };
const SPEC = { kind: "event" as const, source: "github" as const, type: "issues.labeled", filter: { label: ["Rovara"] } };

function dispatchWorld(options: { members?: Record<string, string>; jiraMembers?: Record<string, string>; confirm?: () => Promise<"person" | "rovara" | "unverified"> } = {}) {
  const v = setupTriggerWorld();
  const started: Array<{ developerId: string; source: string; binding: unknown }> = [];
  const ingested: IntakeCandidate[] = [];
  const members = new Map(Object.entries(options.members ?? { "12345": MEMBER }));
  const confirm = options.confirm;
  const ports: IntakePorts = {
    table: { documentClient: v.db, tableName: "T", now: () => v.clock.now },
    log: () => undefined,
    memberOfAccount: async (_org, system, accountId) => (system === "github" ? members.get(accountId) : system === "jira" ? options.jiraMembers?.[accountId] : undefined),
    mayStart: async () => true,
    start: async (_org, developerId, request) => { started.push({ developerId, source: request.source, binding: request.binding }); return { task: { taskId: `task-${String(started.length)}` }, sessionId: `ses_${String(started.length).padStart(20, "0")}` }; },
    sessionOfTicket: async () => undefined,
  };
  const intake = { ingest: async (candidate: IntakeCandidate, options?: { admit?: () => Promise<boolean> }): Promise<IntakeOutcome> => { ingested.push(candidate); return ingestIntake(ports, candidate, { ...(options?.admit === undefined ? {} : { admit: options.admit }), ...(confirm === undefined ? {} : { confirmActor: confirm }) }); } };
  const dispatch = (event: TriggerEvent, withIntake = true) => dispatchTriggerEvent({ ...v.routeDeps, ...(withIntake ? { intake } : {}) } as Parameters<typeof dispatchTriggerEvent>[0], ORG_A, event);
  const trigger = (over: Record<string, unknown> = {}) => v.seed({ target: CODE, spec: SPEC, createdBy: DANA, ...over });
  return { v, started, ingested, ports, dispatch, trigger };
}

describe("a Jira webhook is believed only on Jira's own word (review I1)", () => {
  const jiraEvent = (hookId: string) => ({
    source: "jira", type: "issue.labeled", eventKey: "jira:forged", occurredAt: new Date(Date.now() - 60_000).toISOString(), project: "web", hookId,
    subject: { kind: "issue", id: "PAY-12", title: "Refunds fail", url: "https://acme.atlassian.net/browse/PAY-12" }, fields: { label: ["rovara"] },
    // The body names a linked member (an org admin's Jira account), and is correctly signed with the hook's secret.
    actor: { kind: "external", id: "acct-admin", accountId: "acct-admin" },
  }) as never;
  async function seeded(w: ReturnType<typeof dispatchWorld>) {
    const jira = await w.v.seed({ target: CODE, spec: { kind: "event", source: "jira", type: "issue.labeled", filter: { label: ["rovara"] } }, createdBy: DANA, hookId: `hk_${"b".repeat(26)}` } as never);
    w.v.hook("jira", jira.hookId);
    w.v.connection("jira", "acct-rovara");
    return jira.hookId as string;
  }

  it("waits and starts nothing when no one asked Jira (a forged, correctly signed body naming a linked member)", async () => {
    const w = dispatchWorld({ jiraMembers: { "acct-admin": MEMBER } });
    const [outcome] = await w.dispatch(jiraEvent(await seeded(w)));
    expect(outcome).toMatchObject({ outcome: "skipped", reason: "intake_unverified" });
    expect(w.started).toEqual([]);
    expect(await listWaitingIntakeItems(w.ports.table, ORG_A, "web")).toMatchObject([{ id: "PAY-12", reason: "unverified" }]);
  });

  it("waits when Jira's change log names someone else, and starts as the member only when Jira confirms them", async () => {
    const forged = dispatchWorld({ jiraMembers: { "acct-admin": MEMBER }, confirm: async () => "unverified" });
    expect((await forged.dispatch(jiraEvent(await seeded(forged))))[0]).toMatchObject({ outcome: "skipped", reason: "intake_unverified" });
    expect(forged.started).toEqual([]);
    const real = dispatchWorld({ jiraMembers: { "acct-admin": MEMBER }, confirm: async () => "person" });
    expect((await real.dispatch(jiraEvent(await seeded(real))))[0]).toMatchObject({ outcome: "started" });
    expect(real.started).toMatchObject([{ developerId: MEMBER }]);
  });
});

describe("a Rovara Code trigger on a label", () => {
  it("starts Rovara Code as the member who added the label, bound to the issue, through the intake engine", async () => {
    const w = dispatchWorld();
    const trigger = await w.trigger();
    const [outcome] = await w.dispatch(LABELED);
    expect(outcome).toMatchObject({ triggerId: trigger.triggerId, outcome: "started", taskId: "task-1" });
    expect(w.started).toEqual([{ developerId: MEMBER, source: "github_issue", binding: { kind: "tracker_item", system: "github", id: "acme/web/7", url: "https://github.com/Acme/Web/issues/7" } }]);
  });

  it("needs no monthly budget of its own for the agent (the member who did it pays), unlike an autonomous run", async () => {
    const w = dispatchWorld();
    const trigger = await w.trigger();
    expect(await triggerProblems(w.v.routeDeps as never, trigger)).toEqual([]);
  });

  it("makes the ticket wait when the person who added the label is not a linked member, and starts nothing", async () => {
    const w = dispatchWorld({ members: {} });
    const trigger = await w.trigger();
    const [outcome] = await w.dispatch(LABELED);
    expect(outcome).toMatchObject({ triggerId: trigger.triggerId, outcome: "skipped", reason: "intake_unlinked" });
    expect(w.started).toEqual([]);
    expect(await listWaitingIntakeItems(w.ports.table, ORG_A, "web")).toHaveLength(1);
  });

  it("makes the ticket wait when an automation added the label, even one with a linked id", async () => {
    const w = dispatchWorld();
    await w.trigger();
    const [outcome] = await w.dispatch({ ...LABELED, actor: { kind: "external", id: "bot[bot]", accountId: "12345", bot: true } });
    expect(outcome).toMatchObject({ outcome: "skipped", reason: "intake_bot" });
    expect(w.started).toEqual([]);
  });

  it("never reaches the engine for Rovara's own account (the loop guard)", async () => {
    const w = dispatchWorld();
    await w.trigger();
    const [outcome] = await w.dispatch({ ...LABELED, actor: { kind: "rovara", id: "rovara-app[bot]" } });
    expect(outcome).toMatchObject({ outcome: "skipped", reason: "caused_by_rovara" });
    expect(w.ingested).toEqual([]);
  });

  it("starts the same issue once, however many times the event is delivered, and once for a second label event", async () => {
    const w = dispatchWorld();
    await w.trigger();
    await w.dispatch(LABELED);
    await w.dispatch(LABELED);
    await w.dispatch({ ...LABELED, eventKey: "gh:issue:101:7:labeled:rovara:later" });
    expect(w.started).toHaveLength(1);
  });

  it("does not start on a label the trigger was not told to listen for, and listens to the label without regard to case", async () => {
    const w = dispatchWorld();
    await w.trigger();
    expect(await w.dispatch({ ...LABELED, fields: { label: ["docs"] } })).toEqual([]);
    expect(await w.dispatch({ ...LABELED, eventKey: "other", fields: { label: ["ROVARA"] } })).toHaveLength(1);
    expect(w.ingested).toHaveLength(1);
  });

  it("is turned off, and starts nothing, when it names no label (any label would start it)", async () => {
    const w = dispatchWorld();
    const trigger = await w.trigger({ spec: { kind: "event", source: "github", type: "issues.labeled" } });
    const problems = await triggerProblems(w.v.routeDeps, trigger);
    expect(problems.map((problem) => problem.path)).toEqual(["spec.filter.label"]);
    const [outcome] = await w.dispatch(LABELED);
    expect(outcome).toMatchObject({ outcome: "failed", reason: "trigger_invalid" });
    expect(w.ingested).toEqual([]);
    expect((await w.v.triggers.get(ORG_A, trigger.triggerId))?.enabled).toBe(false);
  });

  it("asks an assignment trigger to name the assignee", async () => {
    const w = dispatchWorld();
    const none = await w.trigger({ spec: { kind: "event", source: "github", type: "issues.assigned" } });
    expect((await triggerProblems(w.v.routeDeps as never, none)).map((problem) => problem.path)).toEqual(["spec.filter.assignee"]);
    const named = await w.trigger({ spec: { kind: "event", source: "github", type: "issues.assigned", filter: { assignee: ["rovara-bot"] } } });
    expect(await triggerProblems(w.v.routeDeps as never, named)).toEqual([]);
  });

  it("records a failure and starts nothing when the engine is not set up", async () => {
    const w = dispatchWorld();
    await w.trigger();
    const [outcome] = await w.dispatch(LABELED, false);
    expect(outcome).toMatchObject({ outcome: "failed", reason: "intake_unavailable" });
    expect(w.started).toEqual([]);
  });

  it("throws a fault that may pass, so the vendor sends the event again, and the retry starts it once", async () => {
    const w = dispatchWorld();
    await w.trigger();
    let fail = true;
    const original = w.ports.start.bind(w.ports);
    w.ports.start = async (...args) => { if (fail) { fail = false; throw new Error("away"); } return original(...args); };
    await expect(w.dispatch(LABELED)).rejects.toThrow();
    expect(w.started).toEqual([]);
    expect(await w.dispatch(LABELED)).toHaveLength(1);
    expect(w.started).toHaveLength(1);
  });

  it("is only for Rovara Code: another agent's trigger on the same event starts its own run, never the intake engine", async () => {
    const w = dispatchWorld();
    const custom = await w.v.triggerAgent("labeler", [{ kind: "event", source: "github", type: "issues.labeled" }], { budgetUsd: 20 });
    await w.v.seed({ target: { kind: "agent", agentId: custom.agentId }, spec: SPEC, createdBy: DANA });
    await w.dispatch(LABELED);
    expect(w.ingested).toEqual([]);
  });

  it("never starts work for a Jira customer or app even when a resolver would map every account to a member", async () => {
    // Jira confirms whoever it is asked about: only the atlassian person's act is ever asked about, and only it starts.
    const w = dispatchWorld({ confirm: async () => "person" });
    const jira = await w.v.seed({ target: CODE, spec: { kind: "event", source: "jira", type: "issue.labeled", filter: { label: ["rovara"] } }, createdBy: DANA, hookId: `hk_${"a".repeat(26)}` } as never);
    w.v.hook("jira", jira.hookId);
    w.v.connection("jira", "acct-rovara");
    w.ports.memberOfAccount = async () => MEMBER;
    for (const [n, accountType] of ["customer", "app", "atlassian"].entries()) {
      const [event] = eventsOf(jiraUpdate({ accountType, items: [{ field: "labels", fromString: "", toString: "rovara" }], changeId: String(n) }));
      const [outcome] = await w.dispatch({ ...event!, hookId: jira.hookId! });
      expect(outcome!.outcome === "started", accountType).toBe(accountType === "atlassian");
    }
    expect(w.started).toHaveLength(1);
  });

  it("shows the Jira ticket's reporter, not an opaque account id, as who asked", () => {
    const candidate = intakeCandidateOf(ORG_A, {
      source: "jira", type: "issue.labeled", eventKey: "k", occurredAt: new Date(NOW).toISOString(), project: "web", hookId: `hk_${"1".repeat(26)}`,
      subject: { kind: "issue", id: "PAY-12", title: "Refunds fail", url: "https://acme.atlassian.net/browse/PAY-12" }, fields: { label: ["rovara"] }, actor: { kind: "external", id: "5b10ac8d82e05b22cc7d4ef5", accountId: "5b10ac8d82e05b22cc7d4ef5" },
    });
    expect(candidate!.actor).toEqual({ kind: "person", accountId: "5b10ac8d82e05b22cc7d4ef5" });
    expect(candidate!.actor).not.toHaveProperty("display");
  });

  it("turns a Jira event into a Jira ticket, bound by its key", () => {
    const candidate = intakeCandidateOf(ORG_A, {
      source: "jira", type: "issue.labeled", eventKey: "k", occurredAt: new Date(NOW).toISOString(), project: "web", hookId: `hk_${"1".repeat(26)}`,
      subject: { kind: "issue", id: "PAY-12", title: "Refunds fail", url: "https://acme.atlassian.net/browse/PAY-12", body: "text" }, fields: { label: ["rovara"] }, actor: { kind: "external", id: "acct-dana", accountId: "acct-dana" },
    });
    expect(candidate).toMatchObject({ channel: "jira", externalRef: { system: "jira", id: "PAY-12", url: "https://acme.atlassian.net/browse/PAY-12" }, actor: { kind: "person", accountId: "acct-dana" } });
  });

  it("makes a Jira ticket wait, because no Jira account is linked to a member", async () => {
    const w = dispatchWorld();
    const jira = await w.v.seed({ target: CODE, spec: { kind: "event", source: "jira", type: "issue.labeled", filter: { label: ["rovara"] } }, createdBy: DANA, hookId: `hk_${"a".repeat(26)}` } as never);
    w.v.hook("jira", jira.hookId);
    w.v.connection("jira", "acct-rovara");
    const [outcome] = await w.dispatch({
      source: "jira", type: "issue.labeled", eventKey: "jira:k", occurredAt: new Date(NOW - 60_000).toISOString(), project: "web", hookId: jira.hookId!,
      subject: { kind: "issue", id: "PAY-12", title: "Refunds fail", url: "https://acme.atlassian.net/browse/PAY-12" }, fields: { label: ["rovara"] }, actor: { kind: "external", id: "acct-dana", accountId: "acct-dana" },
    });
    expect(outcome).toMatchObject({ outcome: "skipped", reason: "intake_unverified" });
    expect(w.started).toEqual([]);
  });
});

describe("a re-label after the task ended, through dispatch", () => {
  const again = (key: string): TriggerEvent => ({ ...LABELED, eventKey: key });
  function endable() {
    const w = dispatchWorld();
    const bound = new Map<string, string>();
    const ended = new Set<string>();
    const linked: string[] = [];
    const start = w.ports.start.bind(w.ports);
    w.ports.start = async (orgId, developerId, request) => {
      const answer = await start(orgId, developerId, request);
      if (request.binding?.kind === "tracker_item") bound.set(request.binding.id, answer.sessionId ?? "");
      return answer;
    };
    w.ports.sessionOfTicket = async (_o, binding) => { const sessionId = bound.get(binding.id); return sessionId === undefined ? undefined : { sessionId, ended: ended.has(sessionId) }; };
    w.ports.freeTicket = async (_o, sessionId) => { for (const [ticket, id] of bound) if (id === sessionId) bound.delete(ticket); };
    w.ports.linkPrevious = async (_o, next, previous) => { linked.push(`${next}<${previous}`); };
    return { w, bound, ended, linked };
  }

  it("starts a new task for a member's second label event, once, however often it is delivered", async () => {
    const { w, bound, ended, linked } = endable();
    await w.trigger();
    expect((await w.dispatch(LABELED))[0]).toMatchObject({ outcome: "started" });
    for (const id of bound.values()) ended.add(id);
    expect((await w.dispatch(again("gh:issue:101:7:labeled:rovara:second")))[0]).toMatchObject({ outcome: "started" });
    expect((await w.dispatch(again("gh:issue:101:7:labeled:rovara:second")))[0]).toMatchObject({ outcome: "duplicate" });
    expect((await w.dispatch(LABELED))[0]).toMatchObject({ outcome: "duplicate" });
    expect(w.started).toHaveLength(2);
    expect(linked).toHaveLength(1);
  });

  it("makes an outsider's second label wait, and a label seen while the task still runs a duplicate", async () => {
    const { w, bound, ended } = endable();
    await w.trigger();
    await w.dispatch(LABELED);
    expect((await w.dispatch(again("running")))[0]).toMatchObject({ outcome: "duplicate" });
    for (const id of bound.values()) ended.add(id);
    expect((await w.dispatch({ ...again("by-eve"), actor: { kind: "external", id: "eve", accountId: "999" } }))[0]).toMatchObject({ outcome: "skipped", reason: "intake_unlinked" });
    expect(w.started).toHaveLength(1);
  });
});

describe("the allowances (review I2): only a start that really starts work uses one", () => {
  const ticketEvent = (n: number, over: Partial<TriggerEvent> = {}): TriggerEvent => ({
    ...LABELED, eventKey: `gh:issue:101:${String(n)}:labeled:rovara:${stamp}`, subject: { ...LABELED.subject, id: `acme/web/${String(n)}`, url: `https://github.com/Acme/Web/issues/${String(n)}` }, ...over,
  });
  const hourKey = (w: ReturnType<typeof dispatchWorld>, triggerId: string) => triggerRateKey(ORG_A, triggerId, new Date(w.v.clock.now).toISOString().slice(0, 13));
  const dayKey = (w: ReturnType<typeof dispatchWorld>) => orgAutonomousKey(ORG_A, new Date(w.v.clock.now).toISOString().slice(0, 10));
  const outsider = { kind: "external" as const, id: "eve", accountId: "999" };

  it("uses neither the trigger's hour nor the org's day for tickets that only wait (a flood of outsiders' labels)", async () => {
    const w = dispatchWorld();
    const trigger = await w.trigger({ maxRunsPerHour: 2 });
    for (let n = 1; n <= 10; n += 1) expect((await w.dispatch(ticketEvent(n, { actor: outsider })))[0]).toMatchObject({ outcome: "skipped", reason: "intake_unlinked" });
    expect(w.v.db.get(hourKey(w, trigger.triggerId))).toBeUndefined();
    expect(w.v.db.get(dayKey(w))).toBeUndefined();
    expect(await listWaitingIntakeItems(w.ports.table, ORG_A, "web")).toHaveLength(10);
  });

  it("leaves other agents' triggers their allowance after such a flood", async () => {
    const w = dispatchWorld();
    await w.trigger({ maxRunsPerHour: 1 });
    for (let n = 1; n <= 10; n += 1) await w.dispatch(ticketEvent(n, { actor: outsider }));
    const chain = await w.v.budgetedChain({ start: "look", steps: [{ kind: "agent", id: "look", name: "Look", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }], limits: { maxRunUsd: 5 } });
    await w.v.seed({ target: { kind: "chain", chainId: chain.chainId }, spec: { kind: "event", source: "github", type: "pull_request.opened" }, createdBy: DANA });
    const [outcome] = await w.dispatch({
      source: "github", type: "pull_request.opened", eventKey: "gh:pr:1", occurredAt: new Date(NOW - 60_000).toISOString(), project: "web",
      subject: { kind: "pull_request", id: "1", title: "x", url: "https://github.com/Acme/Web/pull/1" }, fields: { baseBranch: ["main"], label: [], authorAssociation: ["MEMBER"] }, actor: { kind: "external", id: "maya" },
    });
    expect(outcome).toMatchObject({ outcome: "started" });
  });

  it("counts one run of each when a member's label really starts work", async () => {
    const w = dispatchWorld();
    const trigger = await w.trigger({ maxRunsPerHour: 5 });
    await w.dispatch(ticketEvent(1));
    expect(w.v.db.get(hourKey(w, trigger.triggerId))).toMatchObject({ count: 1 });
    expect(w.v.db.get(dayKey(w))).toMatchObject({ count: 1 });
  });

  it("makes a member's label wait, not vanish, when the trigger's hour is used up", async () => {
    const w = dispatchWorld();
    await w.trigger({ maxRunsPerHour: 1 });
    expect((await w.dispatch(ticketEvent(1)))[0]).toMatchObject({ outcome: "started" });
    const [second] = await w.dispatch(ticketEvent(2));
    expect(second).toMatchObject({ outcome: "skipped", reason: "intake_start_refused" });
    expect(w.started).toHaveLength(1);
    const waiting = await listWaitingIntakeItems(w.ports.table, ORG_A, "web");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ id: "acme/web/2", reason: "start_refused", lastRefusal: "RATE_LIMITED" });
  });

  it("makes a member's label wait when the org's day is used up", async () => {
    const w = dispatchWorld();
    await w.trigger();
    w.v.db.set({ ...dayKey(w), count: 500 });
    expect((await w.dispatch(ticketEvent(1)))[0]).toMatchObject({ outcome: "skipped", reason: "intake_start_refused" });
    expect(w.started).toEqual([]);
    expect(await listWaitingIntakeItems(w.ports.table, ORG_A, "web")).toHaveLength(1);
  });
});

describe("turning a Rovara Code suggestion on", () => {
  const path = (index: number) => `/v1/app/projects/web/builtin-triggers/rovara-code/${String(index)}`;

  it("lists the four suggestions of Rovara Code", async () => {
    const v = setupTriggerWorld();
    const listed = (await v.agentCall(MAX, "GET", "/v1/app/projects/web/builtin-triggers")).body["triggers"] as Array<Record<string, unknown>>;
    expect(JSON.stringify(listed.filter((entry) => entry["agentId"] === "rovara-code").map((entry) => entry["index"]))).toBe("[0,1,2,3]");
    const text = JSON.stringify(listed.filter((entry) => entry["agentId"] === "rovara-code"));
    for (const type of ["issues.labeled", "issues.assigned", "issue.labeled", "issue.assigned"]) expect(text).toContain(type);
  });

  it("is refused without the label that asks (any label would start it), and asked about with it", async () => {
    const v = setupTriggerWorld();
    const bare = await v.agentCall(MAX, "PUT", path(0), { enabled: true });
    expect(bare.status).toBe(400);
    expect(String(bare.body["message"])).toContain("name the label");
    expect(v.db.find((item) => item["entityType"] === "TRIGGER")).toHaveLength(0);
    const named = await v.agentCall(MAX, "PUT", path(0), { enabled: true, filter: { label: ["rovara"] } });
    expect(named.status).toBe(202);
  });

  it("is refused for an assignment without the assignee", async () => {
    const v = setupTriggerWorld();
    expect((await v.agentCall(MAX, "PUT", path(1), { enabled: true })).status).toBe(400);
    expect((await v.agentCall(MAX, "PUT", path(1), { enabled: true, filter: { assignee: ["rovara-bot"] } })).status).toBe(202);
  });
});
