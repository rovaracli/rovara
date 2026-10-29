// Release 0.4.16: a person's email is never their name to anyone else. The sign-in provider's name (or its lack: the email-code sign-in names
// a person by their address) is stored as a placeholder; a person may choose their own name; a sign-in never overwrites a chosen name; and
// every place that shows a name reads it through the email-safe rule, a stored email included. Names and roles are visible to members;
// emails, join dates and sign-in methods are for owners and admins (owner decision, option A).
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SLACK_OIDC_ISSUER, agentSessionKey, orgMetaKey, auditEventId, cleanSessionName, containsEmailAddress, emailSafeName, SetMyNameBodySchema, sessionEventId, withoutEmailAddresses } from "../../packages/contracts/src/index.js";
import { auditOccurrence } from "../../packages/broker/src/audit/events.js";
import { placeholderDisplayName, readableDeveloper, safeDisplayName } from "../../packages/broker/src/developer/person-name.js";
import { personNameForText } from "../../packages/broker/src/developer/requester-text.js";
import { startMessage } from "../../packages/broker/src/developer/share-messages.js";
import { readableTaskComment } from "../../packages/broker/src/developer/page-comments.js";
import { plainName } from "../../packages/broker/src/aws/task-web.js";
import { effectiveTaskOwner } from "../../packages/broker/src/developer/task-records.js";
import { loadTaskPeople } from "../../packages/broker/src/developer/task-people.js";
import { checkTaskPersonIdentity } from "../../packages/broker/src/developer/task-person-identity.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { createWriteApprovalRecord, getAnyApproval, listApprovalsFor, runOfApproval, forbiddenText } from "../../packages/broker/src/agents/approvals-store.js";
import { approvalView } from "../../packages/broker/src/agents/approval-routes.js";
import { webRouteAllowed } from "../../packages/broker/src/aws/web-auth.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { appNav } from "../../packages/broker/src/app-nav/nav.js";
import { sessionFromItem } from "../../packages/broker/src/agent-sessions/store.js";
import { sessionView, type SessionReadDependencies } from "../../packages/broker/src/agent-sessions/read.js";
import { appendSessionEvent, readSessionEvents } from "../../packages/broker/src/agent-sessions/events.js";
import { ARJUN, CELL, ORG_A, PRIYA, sessionWorld } from "../support/agent-session-world.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { MAYA, OMAR, createDeveloperTaskBroker, grantProject, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { OIDC_ISSUER, httpEvent, identityHarness } from "../support/developer-fakes.js";
import { TEST_ORG } from "../support/orgs.js";

const PLACEHOLDER = /^Member [0-9a-f]{8}$/;
const EMAIL = "omar.diaz@example.com";
const idOf = (letter: string) => letter.repeat(64);

describe("the email-safe name rule", () => {
  it("finds an email address anywhere in a text", () => {
    expect(containsEmailAddress("maya@example.com")).toBe(true);
    expect(containsEmailAddress("Maya <maya@example.com>")).toBe(true);
    expect(containsEmailAddress("Maya Chen")).toBe(false);
    expect(containsEmailAddress("maya@localhost")).toBe(false);
    expect(withoutEmailAddresses("Maya <maya@example.com>")).toBe("Maya");
  });

  it("keeps a real name, drops the email from a name that has one, and leaves nothing for an address alone", () => {
    expect(emailSafeName("Maya Chen")).toBe("Maya Chen");
    expect(emailSafeName("  Maya   Chen ")).toBe("Maya Chen");
    expect(emailSafeName("Maya (maya@example.com)")).toBe("Maya");
    expect(emailSafeName("maya@example.com")).toBeUndefined();
    expect(emailSafeName("")).toBeUndefined();
    expect(emailSafeName("<maya@example.com>")).toBeUndefined();
  });

  it("makes session names email-safe too", () => {
    expect(cleanSessionName("Maya Chen")).toBe("Maya Chen");
    expect(cleanSessionName("maya@example.com")).toBeUndefined();
    expect(cleanSessionName("Maya maya@example.com")).toBe("Maya");
  });

  it("derives a stable placeholder that names nobody", () => {
    const placeholder = placeholderDisplayName(idOf("a"));
    expect(placeholder).toMatch(PLACEHOLDER);
    expect(placeholderDisplayName(idOf("a"))).toBe(placeholder);
    expect(placeholderDisplayName(idOf("b"))).not.toBe(placeholder);
    expect(placeholder).not.toContain("aaaa".repeat(2));
  });

  it("reads a stored name safely: a real name stays, an email or an empty name becomes the placeholder", () => {
    expect(safeDisplayName("Omar Diaz", idOf("e"))).toBe("Omar Diaz");
    expect(safeDisplayName(EMAIL, idOf("e"))).toBe(placeholderDisplayName(idOf("e")));
    expect(safeDisplayName("", idOf("e"))).toBe(placeholderDisplayName(idOf("e")));
    expect(safeDisplayName(undefined, idOf("e"))).toBe(placeholderDisplayName(idOf("e")));
    expect(safeDisplayName("Omar omar@example.com", idOf("e"))).toBe("Omar");
  });
});

describe("the name a person chooses (request body)", () => {
  it("trims and accepts a name of 1 to 80 characters", () => {
    expect(SetMyNameBodySchema.parse({ name: "  Maya C  " })).toEqual({ name: "Maya C" });
    expect(SetMyNameBodySchema.parse({ name: "x".repeat(80) }).name).toHaveLength(80);
  });
  it.each([
    ["empty", ""], ["blank", "   "], ["too long", "x".repeat(81)], ["an email", "maya@example.com"], ["an email inside", "Maya (maya@example.com)"],
    ["a control character", "May\u0000a"], ["a newline", "Maya\nChen"], ["a tab", "Maya\tChen"], ["symbols only", "!!!"],
  ])("refuses %s", (_label, name) => {
    expect(SetMyNameBodySchema.safeParse({ name }).success).toBe(false);
  });
  it("refuses a body that names another person or anything else", () => {
    expect(SetMyNameBodySchema.safeParse({ name: "Maya", developerId: idOf("e") }).success).toBe(false);
    expect(SetMyNameBodySchema.safeParse({}).success).toBe(false);
  });
});

describe("the sign-in table", () => {
  const T0 = Date.parse("2026-10-27T09:00:00.000Z");
  const profile = (displayName: string) => ({ developerId: idOf("c"), provider: "cloud" as const, issuer: "https://idp.example.test", subject: "sub-1", displayName, email: "c@example.com" });
  const world = (audit = capturingAuditDeps()) => {
    const db = new FakeDynamoDb();
    audit.attach(db);
    let now = T0;
    const store = new DeveloperSignInStore({ documentClient: db, tableName: "signin", nameTableName: "state", now: () => now, audit: audit.audit });
    return { db, store, audit, tick: (ms: number) => { now += ms; } };
  };

  it("stores a placeholder, marked as not chosen, when the provider's name is the person's email", async () => {
    const { db, store } = world();
    const record = await store.upsertDeveloper(profile("c@example.com"));
    expect(record.displayName).toMatch(PLACEHOLDER);
    expect(record.displayNameChosen).toBe(false);
    expect(JSON.stringify(db.get(`DEVELOPER#${idOf("c")}`, "META")?.displayName)).not.toContain("@");
  });

  it("stores a name that merely contains an email without the email", async () => {
    const { store } = world();
    expect((await store.upsertDeveloper(profile("Cy <c@example.com>"))).displayName).toBe("Cy");
  });

  it("keeps the provider's real name, not chosen", async () => {
    const { store } = world();
    const record = await store.upsertDeveloper(profile("Cy Fernandez"));
    expect(record).toMatchObject({ displayName: "Cy Fernandez", displayNameChosen: false });
  });

  it("reads a name stored as an email (a record from before this release) as the placeholder", async () => {
    const { db, store } = world();
    db.set({ pk: `DEVELOPER#${idOf("c")}`, sk: "META", developerId: idOf("c"), provider: "cloud", displayName: "c@example.com", email: "c@example.com", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    const record = (await store.getDeveloper(idOf("c")))!;
    expect(record.displayName).toBe(placeholderDisplayName(idOf("c")));
    expect(record.displayNameChosen).toBeFalsy();
    expect(record.email).toBe("c@example.com");
  });

  it("sets the name a person chooses, marks it chosen, and a later sign-in does not overwrite it", async () => {
    const { store, tick } = world();
    await store.upsertDeveloper(profile("c@example.com"));
    tick(1000);
    await store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "Cy F" });
    tick(1000);
    const after = await store.upsertDeveloper(profile("Someone Else"));
    expect(after).toMatchObject({ displayName: "Cy F", displayNameChosen: true });
    expect(after.lastSignInAt).toBe(new Date(T0 + 2000).toISOString());
    const again = await store.upsertDeveloper(profile("c@example.com"));
    expect(again.displayName).toBe("Cy F");
  });

  it("refuses to choose a name that is an email or empty, even when called directly", async () => {
    const { store, db } = world();
    await store.upsertDeveloper(profile("Cy"));
    await expect(store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "c@example.com" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "  " })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(db.get(`DEVELOPER#${idOf("c")}`, "META")).toMatchObject({ displayName: "Cy" });
  });

  it("refuses to choose a name for a person with no record", async () => {
    const { store } = world();
    await expect(store.setChosenDisplayName({ developerId: idOf("9"), orgId: TEST_ORG, name: "Nobody" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("records member.renamed once per change, with no name in the record", async () => {
    const { store, audit, tick } = world();
    await store.upsertDeveloper(profile("Cy"));
    tick(500);
    await store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "Cy F" });
    const at = new Date(T0 + 500).toISOString();
    expect(audit.recordedBy("member.renamed")).toEqual([{
      eventId: auditEventId("member.renamed", auditOccurrence(idOf("c"), at)), orgId: TEST_ORG, action: "member.renamed",
      actor: { kind: "member", id: idOf("c") }, target: { kind: "member", id: idOf("c") }, occurredAt: at,
    }]);
    expect(JSON.stringify(audit.recorded())).not.toContain("Cy F");
  });
});

describe("a sign-in with a provider that gives no name", () => {
  it("stores the placeholder for the person's email, never the email, and the account is not marked chosen", async () => {
    const h = identityHarness({ slack: false, oidc: {}, oidcUsers: [{ sub: "okta-1", email: "ravi@example.com", email_verified: true }] });
    const back = await h.signIn("oidc", "okta-1");
    expect(back.searchParams.get("code")).not.toBeNull();
    const developerId = ownerKeyForSubject(OIDC_ISSUER, "okta-1");
    const record = h.db.get(`DEVELOPER#${developerId}`, "META")!;
    expect(record.displayName).toMatch(PLACEHOLDER);
    expect(record.displayNameChosen).toBe(false);
    expect(record.email).toBe("ravi@example.com");
  });
});

/** The broker with Omar an owner and Maya a member of the install's org, and a ledger. */
async function broker() {
  const audit = capturingAuditDeps();
  const h = await createDeveloperTaskBroker({ audit });
  seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
  return { ...h, audit };
}
type Broker = Awaited<ReturnType<typeof broker>>;
const setName = (h: Broker, who: Developer, body: unknown, headers?: Record<string, string>) => h.dev(who, "PUT", "/v1/app/me/name", body, headers);

describe("PUT /v1/app/me/name", () => {
  it("sets the caller's own name, answers it, and every read of that person shows it", async () => {
    const h = await broker();
    const answer = await setName(h, MAYA, { name: "  Maya C  " });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body).toMatchObject({ name: "Maya C", nameChosen: true });
    // Release 0.4.18: the chosen name is an item in the State table; the sign-in record is not written.
    expect(h.db.get(`DEVELOPER_NAME#${MAYA.developerId}`, "NAME")).toMatchObject({ name: "Maya C", developerId: MAYA.developerId });
    expect(h.db.get(`DEVELOPER#${MAYA.developerId}`, "META")).toMatchObject({ displayName: "Maya Chen" });
    expect(h.db.get(`DEVELOPER#${MAYA.developerId}`, "META")).not.toHaveProperty("displayNameChosen", true);
    const me = await h.dev(MAYA, "GET", "/v1/app/me");
    expect(me.body.developer).toMatchObject({ name: "Maya C", nameChosen: true });
    const members = (await h.dev(OMAR, "GET", "/v1/app/org/members")).body.members as Array<{ developerId: string; name: string }>;
    expect(members.find((member) => member.developerId === MAYA.developerId)?.name).toBe("Maya C");
  });

  it("audits the change once, naming the caller and no name", async () => {
    const h = await broker();
    await setName(h, MAYA, { name: "Maya C" });
    expect(h.audit.recordedBy("member.renamed")).toEqual([expect.objectContaining({ orgId: TEST_ORG, actor: { kind: "member", id: MAYA.developerId }, target: { kind: "member", id: MAYA.developerId } })]);
    expect(JSON.stringify(h.audit.recorded())).not.toContain("Maya C");
  });

  it.each([
    ["an empty name", { name: "" }], ["a blank name", { name: "   " }], ["81 characters", { name: "x".repeat(81) }], ["an email", { name: "maya@example.com" }],
    ["a name with an email", { name: "Maya maya@example.com" }], ["a control character", { name: "May\u0007a" }], ["no name", {}], ["another person's id", { name: "Maya", developerId: OMAR.developerId }],
  ])("refuses %s and changes nothing", async (_label, body) => {
    const h = await broker();
    const answer = await setName(h, MAYA, body);
    expect(answer.status).toBe(400);
    expect(h.db.get(`DEVELOPER#${MAYA.developerId}`, "META")).toMatchObject({ displayName: "Maya Chen" });
    expect(h.audit.recorded()).toEqual([]);
  });

  it("changes only the caller's own record, whoever they are", async () => {
    const h = await broker();
    await setName(h, MAYA, { name: "Maya C" });
    expect(h.db.get(`DEVELOPER_NAME#${OMAR.developerId}`, "NAME")).toBeUndefined();
    await setName(h, OMAR, { name: "Omar D" });
    expect(h.db.get(`DEVELOPER_NAME#${MAYA.developerId}`, "NAME")).toMatchObject({ name: "Maya C" });
    expect(h.db.get(`DEVELOPER_NAME#${OMAR.developerId}`, "NAME")).toMatchObject({ name: "Omar D" });
  });

  it("needs a signed-in session", async () => {
    const h = await broker();
    const answer = await h.handler({ version: "2.0", rawPath: "/v1/app/me/name", rawQueryString: "", headers: {}, body: JSON.stringify({ name: "Maya C" }), requestContext: { requestId: randomUUID(), http: { method: "PUT" } } });
    expect(answer.statusCode).toBe(401);
    expect(h.db.get(`DEVELOPER#${MAYA.developerId}`, "META")).toMatchObject({ displayName: "Maya Chen" });
  });

  it("answers 404 to other methods on the path", async () => {
    const h = await broker();
    expect((await h.dev(MAYA, "POST", "/v1/app/me/name", { name: "Maya C" })).status).toBe(404);
    expect((await h.dev(MAYA, "DELETE", "/v1/app/me/name")).status).toBe(404);
  });
});

describe("what a member is shown", () => {
  /** Another person in the install's org, whose name was stored as their email by the email-code sign-in. */
  function omarByEmail(h: Broker) {
    h.db.set({ pk: `DEVELOPER#${OMAR.developerId}`, sk: "META", developerId: OMAR.developerId, provider: "oidc", displayName: EMAIL, email: EMAIL, firstSignInAt: "2026-09-01T00:00:00.000Z", lastSignInAt: "x", revoked: false });
  }

  it("GET /v1/app/me: the caller's own email is theirs, and a stored email is not their name", async () => {
    const h = await broker();
    h.db.set({ pk: `DEVELOPER#${MAYA.developerId}`, sk: "META", developerId: MAYA.developerId, provider: "slack", displayName: "maya@example.com", email: "maya@example.com", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    const me = (await h.dev(MAYA, "GET", "/v1/app/me")).body.developer as Record<string, unknown>;
    expect(me.name).toBe(placeholderDisplayName(MAYA.developerId));
    expect(me.nameChosen).toBe(false);
    expect(me.email).toBe("maya@example.com");
  });

  it("the account header (navigation) names the person without their email, whoever built the caller", async () => {
    const sources = {
      projects: async () => [], rosters: async () => [], live: async () => [], home: async () => ({ total: 0 }), sharedAgents: async () => [], sharedSessions: async () => [],
      org: async () => ({ name: "Acme", plan: "team" as const }),
    };
    const nav = await appNav({ sources, now: () => 1000, webFeatures: "", localAgents: false }, { orgId: TEST_ORG, developerId: MAYA.developerId, name: "maya@example.com", orgRole: "member" });
    expect(nav.me.name).toBe(placeholderDisplayName(MAYA.developerId));
    expect(JSON.stringify(nav)).not.toContain("@");
  });

  it("GET /v1/app/org/members: a member sees names and roles, never emails, join dates or sign-in methods", async () => {
    const h = await broker();
    omarByEmail(h);
    const answer = await h.dev(MAYA, "GET", "/v1/app/org/members");
    expect(answer.status).toBe(200);
    const members = answer.body.members as Array<Record<string, unknown>>;
    expect(members.map((member) => member.name).sort()).toEqual(["Maya Chen", placeholderDisplayName(OMAR.developerId)].sort());
    expect(members.find((member) => member.developerId === OMAR.developerId)).toEqual({ developerId: OMAR.developerId, name: placeholderDisplayName(OMAR.developerId), role: "owner" });
    expect(JSON.stringify(answer.body)).not.toContain("@");
    expect(JSON.stringify(answer.body)).not.toContain("joinedAt");
    expect(JSON.stringify(answer.body)).not.toContain("identities");
  });

  it("GET /v1/app/org/members: an owner sees emails, join dates and sign-in methods, and still a safe name", async () => {
    const h = await broker();
    omarByEmail(h);
    seedMembership(h.db, MAYA.developerId, { orgId: TEST_ORG, role: "member" });
    const owner = await h.dev(OMAR, "GET", "/v1/app/org/members");
    const members = owner.body.members as Array<Record<string, unknown>>;
    expect(members.find((member) => member.developerId === OMAR.developerId)).toMatchObject({ name: placeholderDisplayName(OMAR.developerId), email: EMAIL, role: "owner", identities: ["oidc"] });
    expect(members.find((member) => member.developerId === OMAR.developerId)?.joinedAt).toEqual(expect.any(String));
  });

  it("GET /v1/app/org/members: an admin sees the same as an owner", async () => {
    const h = await broker();
    omarByEmail(h);
    seedMembership(h.db, MAYA.developerId, { orgId: TEST_ORG, role: "admin" });
    const members = (await h.dev(MAYA, "GET", "/v1/app/org/members")).body.members as Array<Record<string, unknown>>;
    expect(members.find((member) => member.developerId === OMAR.developerId)).toMatchObject({ email: EMAIL, identities: ["oidc"] });
  });

  it("GET /v1/app/projects/{name}/members: names are safe, and a member who is no admin sees no emails", async () => {
    const h = await broker();
    omarByEmail(h);
    h.db.set({ pk: `DEVELOPER#${MAYA.developerId}`, sk: "META", developerId: MAYA.developerId, provider: "slack", displayName: "Maya Chen", email: "maya@example.com", slackUserId: MAYA.slackUserId, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    grantProject(h.db, MAYA);
    grantProject(h.db, OMAR);
    const asMember = await h.dev(MAYA, "GET", "/v1/app/projects/payments/members");
    expect(asMember.status, JSON.stringify(asMember.body)).toBe(200);
    expect(JSON.stringify(asMember.body)).not.toContain("@");
    expect(JSON.stringify(asMember.body)).toContain(placeholderDisplayName(OMAR.developerId));
    // The owner sees the emails, and still the safe name.
    const asOwner = await h.dev(OMAR, "GET", "/v1/app/projects/payments/members");
    expect(asOwner.status).toBe(200);
    const rows = asOwner.body.members as Array<Record<string, unknown>>;
    expect(rows.find((row) => row.developerId === MAYA.developerId)).toMatchObject({ name: "Maya Chen", email: "maya@example.com" });
    expect(rows.find((row) => row.developerId === OMAR.developerId)).toMatchObject({ name: placeholderDisplayName(OMAR.developerId) });
    expect(rows.some((row) => row.name === EMAIL)).toBe(false);
  });
});

describe("a session's stored names", () => {
  function world() {
    const w = sessionWorld();
    const deps: SessionReadDependencies = {
      documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
      taskView: async (task) => ({ taskId: task.taskId, title: "Bump the Stripe SDK", project: task.project, status: "RUNNING", startingRevision: 1, client: "test", shared: false, createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:05:00.000Z", events: [] }) as never,
    };
    return { w, deps };
  }

  it("reads a session owner stored as an email as a member in the view's owner and payer", async () => {
    const { w, deps } = world();
    const { sessionId } = w.seedSession({ owner: PRIYA });
    const meta = w.db.get(agentSessionKey(ORG_A, sessionId, "META"))!;
    w.db.set({ ...meta, owner: { developerId: PRIYA, name: EMAIL } });
    w.db.set({ pk: `DEVELOPER#${PRIYA}`, sk: "META", developerId: PRIYA, provider: "oidc", displayName: EMAIL, email: EMAIL, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    const view = await sessionView(deps, w.caller(ARJUN), sessionId).catch(async () => sessionView(deps, w.caller(PRIYA), sessionId));
    expect(JSON.stringify(view)).not.toContain("@");
    expect(view.owner.name).not.toContain("@");
    expect(view.cost.payer.name).not.toContain("@");
  });

  it("reads a stored session record's owner without the email", () => {
    const { w } = world();
    const { sessionId } = w.seedSession({ owner: PRIYA });
    const meta = w.db.get(agentSessionKey(ORG_A, sessionId, "META"))!;
    const parsed = sessionFromItem({ ...meta, owner: { developerId: PRIYA, name: EMAIL } });
    expect(parsed?.owner.name).not.toContain("@");
    expect(sessionFromItem({ ...meta, owner: { developerId: PRIYA, name: "Priya" } })?.owner.name).toBe("Priya");
  });

  it("reads an event's actor and text without a stored email", async () => {
    const { w, deps } = world();
    const { sessionId } = w.seedSession({ owner: PRIYA });
    await appendSessionEvent(deps, ORG_A, sessionId, {
      eventId: sessionEventId("shared", "x1"), at: "2026-10-22T09:30:00.000Z", type: "shared", actor: { kind: "member", developerId: ARJUN, name: EMAIL }, text: `${EMAIL} shared this session with Mia (can view)`,
    });
    const page = await readSessionEvents(deps, w.caller(PRIYA), sessionId, {});
    expect(JSON.stringify(page.events)).not.toContain("@");
    expect(page.events).toHaveLength(1);
  });
});

describe("the other places a person is named", () => {
  it("the task page's plain name drops an email address", () => {
    expect(plainName("Maya Chen")).toBe("Maya Chen");
    expect(plainName("Maya maya@example.com")).toBe("Maya");
    expect(plainName(EMAIL)).toBeUndefined();
  });

  it("a task page comment stored under the author's email reads under the placeholder; others are as stored", () => {
    const comment = (name: string) => ({ schemaVersion: 1, taskId: randomUUID(), commentId: "c1", author: { kind: "person", developerId: idOf("d"), name, owner: false }, text: "hi", createdAt: "2026-10-01T00:00:00.000Z", rev: 1 }) as never;
    const read = readableTaskComment(comment(EMAIL)) as { author: { name: string } };
    expect(read.author.name).toBe(placeholderDisplayName(idOf("d")));
    const same = comment("Maya Chen");
    expect(readableTaskComment(same)).toBe(same);
  });

  it("a task that records its owner by email names them with the placeholder", () => {
    const owner = effectiveTaskOwner({ taskId: randomUUID(), developerId: idOf("d"), developerName: EMAIL, provider: "oidc" } as never);
    expect(owner.name).toBe(placeholderDisplayName(idOf("d")));
    expect(effectiveTaskOwner({ taskId: randomUUID(), developerId: idOf("d"), developerName: "Dee", provider: "oidc" } as never).name).toBe("Dee");
  });

  it("a text on GitHub names a person with only the placeholder by their GitHub login, else leaves them unnamed", () => {
    const placeholder = placeholderDisplayName(idOf("d"));
    expect(personNameForText(placeholder, "dee-dev")).toBe("dee-dev");
    expect(personNameForText(placeholder)).toBeUndefined();
    expect(personNameForText("Dee", "dee-dev")).toBe("Dee");
    expect(personNameForText(EMAIL, "dee-dev")).toBe("dee-dev");
  });

  it("the Slack start message of a shared thread never prints an email", () => {
    const text = startMessage({ developerName: EMAIL, client: "Rovara app", title: "Fix it", project: "payments", mode: "view", status: "RUNNING", sharedReason: "requested" });
    expect(text).not.toContain("@");
    expect(text).not.toContain(EMAIL);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Review round 1 (Opus review of abd4a061): C1, I1, I2, I3 and the cheap minors.
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("C1: a task's stored People rows from before 0.4.16 stay readable", () => {
  const taskId = "11111111-1111-4111-8111-111111111111";
  const slackUserId = "U0BOB0001";
  const bob = developerIdForSlackUser(slackUserId);

  it("loads a People list that holds a person named by their email, and shows that person without it", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [
      { developerId: bob, slackUserId, name: "bob@example.com", role: "owner" },
      { developerId: idOf("a"), slackUserId: "U0ANN0001", name: "Ann Lee", role: "commenter" },
    ] });
    const people = await loadTaskPeople({ documentClient: db, tableName: "state" }, taskId);
    expect(people?.people.map((person) => person.developerId)).toEqual([bob, idOf("a")]);
    expect(people?.people[0]?.role).toBe("owner");
    expect(JSON.stringify(people)).not.toContain("@");
    expect(people?.people[1]?.name).toBe("Ann Lee");
  });

  it("still refuses a People row whose name is not a name at all", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [{ developerId: bob, slackUserId, name: "Bob\u0000", role: "owner" }] });
    await expect(loadTaskPeople({ documentClient: db, tableName: "state" }, taskId)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
  });

  it("reads a task-person registry row stored under an email, comparing the stored identity, and returns the name without the email", async () => {
    const db = new FakeDynamoDb();
    const personId = "22222222-2222-4222-8222-222222222222";
    const owner = idOf("c");
    db.set({ pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, project: "payments", developerId: owner, provider: "slack", slackUserId: "U0OWNER01" });
    db.set({ pk: `DEVTASK#${taskId}`, sk: `PERSON#${personId}`, schemaVersion: 1, personId, createdAt: "2026-10-01T00:00:00.000Z", developerId: bob, slackUserId, name: "bob@example.com", method: "slack", issuer: SLACK_OIDC_ISSUER, subject: slackUserId });
    db.set({ pk: `DEVTASK#${taskId}`, sk: `PERSON_SUBJECT#${bob}`, schemaVersion: 1, personId, developerId: bob, createdAt: "2026-10-01T00:00:00.000Z" });
    const deps = {
      documentClient: db as never, tableName: "state", slackTeamId: "T0TEAM1", now: () => Date.now(), uuid: () => randomUUID(),
      taskPersonProof: async () => ({ ok: false as const, error: "ineligible" as const }),
      developerRecord: async () => undefined, projectChannelIds: async () => [], targetProjectAccess: async () => undefined,
    };
    const task = db.get(`DEVTASK#${taskId}`, "META") as never;
    const result = await checkTaskPersonIdentity(deps, task, bob);
    expect(result.eligible).toBe(false);
    expect(result.identity).toMatchObject({ developerId: bob, slackUserId, method: "slack", issuer: SLACK_OIDC_ISSUER, subject: slackUserId });
    expect(result.identity.name).not.toContain("@");
  });
});

describe("I1: an approval made before 0.4.16 for an owner stored as an email", () => {
  const approvalId = "apr_aaaaaaaaaaaaaaaaaaaa";
  async function legacy() {
    const db = new FakeDynamoDb();
    const deps = { documentClient: db as never, tableName: "state", now: Date.now };
    const created = await createWriteApprovalRecord(deps, {
      orgId: TEST_ORG, approvalId, kind: "write", subject: { kind: "agent_run", taskId: randomUUID(), stepId: "work" }, operationId: randomUUID(), connector: "linear", connectorType: "linear",
      tool: "save_issue", toolAccess: "write", scope: "eng", schemaHash: "a".repeat(64), projectRevision: 1, scopeDigest: "b".repeat(64), arguments: {}, argumentsHash: "c".repeat(64),
      summary: "Create an issue", class: "consequential", approvers: { kind: "ids", ids: [idOf("d")] }, status: "PENDING", project: "payments", owner: { developerId: idOf("d"), name: EMAIL },
      attempts: 0, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    } as never, [], 8);
    expect(created).toBe("created");
    return { db, deps, record: (await getAnyApproval(deps, TEST_ORG, approvalId))! };
  }

  it("shows the owner without the email in the approval view", async () => {
    const { record } = await legacy();
    const view = approvalView({ confirmOrigin: "https://cell.example" }, record) as { owner: { name: string } };
    expect(view.owner.name).toBe(placeholderDisplayName(idOf("d")));
    expect(JSON.stringify(view)).not.toContain("@");
  });

  it("names the owner without the email in the refusal text and the run view", async () => {
    const { deps, record } = await legacy();
    expect(forbiddenText(record)).toBe(`Only ${placeholderDisplayName(idOf("d"))} or a project maintainer can decide this.`);
    expect((await runOfApproval(deps, record))?.owner.name).toBe(placeholderDisplayName(idOf("d")));
  });
});

describe("I2: a default organization name made from an email", () => {
  const legacyName = `${EMAIL}'s team`;

  it("reads as 'New team' from the organization store, an invite and the join answers", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [] });
    const orgId = await h.orgs.createOrgWithOwner({ name: legacyName, developerId: idOf("e") });
    expect((await h.orgs.getOrg(orgId))?.name).toBe("New team");
    const token = (await h.orgs.createInvite({ orgId, createdBy: idOf("e"), role: "member" })).token;
    expect((await h.orgs.describeInvite(token))?.orgName).toBe("New team");
    const json = await h.http({ ...httpEvent("GET", `/v1/auth/join?invite=${token}`), headers: { accept: "application/json" } });
    expect(JSON.parse(json.body)).toMatchObject({ orgName: "New team" });
    const page = await h.http({ ...httpEvent("GET", `/v1/auth/join?invite=${token}`), headers: { accept: "text/html" } });
    expect(page.body).not.toContain(EMAIL);
  });

  it("is what GET /v1/app/me says for a member of such an organization; a real name is untouched", async () => {
    const h = await broker();
    h.db.set({ ...h.db.get(orgMetaKey(TEST_ORG))!, name: legacyName });
    const me = (await h.dev(MAYA, "GET", "/v1/app/me")).body as { org: { name: string } };
    expect(me.org.name).toBe("New team");
    expect(JSON.stringify((await h.dev(MAYA, "GET", "/v1/app/org")).body)).not.toContain("@");
    h.db.set({ ...h.db.get(orgMetaKey(TEST_ORG))!, name: "Acme" });
    expect(((await h.dev(MAYA, "GET", "/v1/app/me")).body as { org: { name: string } }).org.name).toBe("Acme");
    const store = new OrgStore({ documentClient: h.db, tableName: "state", now: Date.now });
    expect((await store.getOrg(TEST_ORG))?.name).toBe("Acme");
  });
});

describe("I3: the placeholder is long enough, and a chosen name cannot be someone's placeholder", () => {
  it("has 32 bits, so two people in one org almost never share one", () => {
    expect(placeholderDisplayName(idOf("a"))).toMatch(/^Member [0-9a-f]{8}$/);
    const names = new Set(Array.from({ length: 5000 }, (_, i) => placeholderDisplayName(createHashHex(String(i)))));
    expect(names.size).toBe(5000);
  });

  it.each(["Member 3fa9", "member 3FA9", "Member 3fa9c1d2", "MEMBER  3fa9c1d2", "Member abcdef"])("refuses %s as a chosen name", (name) => {
    expect(SetMyNameBodySchema.safeParse({ name }).success).toBe(false);
  });

  it("still accepts names that only start with Member", () => {
    expect(SetMyNameBodySchema.safeParse({ name: "Member of Staff" }).success).toBe(true);
    expect(SetMyNameBodySchema.safeParse({ name: "Member 3fa9 Jr" }).success).toBe(true);
  });

  it("treats a provider name of that shape as no name, and keeps a person's own placeholder", () => {
    expect(safeDisplayName("Member 3fa9", idOf("e"))).toBe(placeholderDisplayName(idOf("e")));
    expect(safeDisplayName("Member 3fa9c1d2", idOf("e"))).toBe(placeholderDisplayName(idOf("e")));
    expect(safeDisplayName(placeholderDisplayName(idOf("e")), idOf("e"))).toBe(placeholderDisplayName(idOf("e")));
  });

  it("stores no impersonating provider name", async () => {
    const db = new FakeDynamoDb();
    const store = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: Date.now });
    const stolen = placeholderDisplayName(idOf("e"));
    const record = await store.upsertDeveloper({ developerId: idOf("c"), provider: "cloud", issuer: "https://idp.example.test", subject: "s", displayName: stolen });
    expect(record.displayName).toBe(placeholderDisplayName(idOf("c")));
  });
});

describe("minors", () => {
  it("M1: a revoked or merged person cannot rename", async () => {
    const db = new FakeDynamoDb();
    const store = new DeveloperSignInStore({ documentClient: db, tableName: "signin", nameTableName: "state", now: Date.now });
    await store.upsertDeveloper({ developerId: idOf("c"), provider: "cloud", issuer: "https://idp.example.test", subject: "s", displayName: "Cy" });
    db.set({ ...db.get(`DEVELOPER#${idOf("c")}`, "META")!, revoked: true });
    await expect(store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "Cy F" })).rejects.toBeTruthy();
    db.set({ ...db.get(`DEVELOPER#${idOf("c")}`, "META")!, revoked: false, mergedInto: idOf("d") });
    await expect(store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "Cy F" })).rejects.toBeTruthy();
    expect(db.get(`DEVELOPER#${idOf("c")}`, "META")).toMatchObject({ displayName: "Cy" });
  });

  it("M2: choosing the name already chosen writes and audits nothing more", async () => {
    const audit = capturingAuditDeps();
    const db = new FakeDynamoDb();
    audit.attach(db);
    let now = Date.parse("2026-10-27T09:00:00.000Z");
    const store = new DeveloperSignInStore({ documentClient: db, tableName: "signin", nameTableName: "state", now: () => now, audit: audit.audit });
    await store.upsertDeveloper({ developerId: idOf("c"), provider: "cloud", issuer: "https://idp.example.test", subject: "s", displayName: "Cy" });
    await store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "Cy F" });
    now += 1000;
    const again = await store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "Cy F" });
    expect(again).toMatchObject({ displayName: "Cy F", displayNameChosen: true });
    expect(audit.recordedBy("member.renamed")).toHaveLength(1);
  });

  it("M2: an audit failure that is not a missing record is not reported as one", async () => {
    const db = new FakeDynamoDb();
    const store = new DeveloperSignInStore({ documentClient: db, tableName: "signin", nameTableName: "state", now: Date.now });
    await store.upsertDeveloper({ developerId: idOf("c"), provider: "cloud", issuer: "https://idp.example.test", subject: "s", displayName: "Cy" });
    db.injectFault({ command: "TransactWriteCommand", error: { name: "ThrottlingException" } });
    await expect(store.setChosenDisplayName({ developerId: idOf("c"), orgId: TEST_ORG, name: "Cy F" })).rejects.toMatchObject({ name: "ThrottlingException" });
  });

  it("M3: a fullwidth @ does not hide an address", () => {
    expect(containsEmailAddress("maya＠example.com")).toBe(true);
    expect(emailSafeName("maya＠example.com")).toBeUndefined();
    expect(SetMyNameBodySchema.safeParse({ name: "maya＠example.com" }).success).toBe(false);
  });

  it("M5: a plain member's list is ordered by name, not by join date", async () => {
    const h = await broker();
    h.db.set({ pk: `DEVELOPER#${OMAR.developerId}`, sk: "META", developerId: OMAR.developerId, provider: "oidc", displayName: "Aaron", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    const names = ((await h.dev(MAYA, "GET", "/v1/app/org/members")).body.members as Array<{ name: string }>).map((member) => member.name);
    expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right)));
  });

  it("M6: the browser allowlist for /me is exactly GET me and PUT me/name", () => {
    expect(webRouteAllowed("GET", "/v1/web/me")).toBe(true);
    expect(webRouteAllowed("PUT", "/v1/web/me/name")).toBe(true);
    for (const [method, path] of [["POST", "/v1/web/me/identities/cloud"], ["DELETE", "/v1/web/me/identities/cloud"], ["PUT", "/v1/web/me/identities/cloud"], ["POST", "/v1/web/me/name"],
      ["DELETE", "/v1/web/me/name"], ["PUT", "/v1/web/me"], ["PUT", "/v1/web/me/name/x"], ["GET", "/v1/web/me/name"], ["PATCH", "/v1/web/me/name"]] as const) {
      expect(webRouteAllowed(method, path), `${method} ${path}`).toBe(false);
    }
  });
});

function createHashHex(value: string): string {
  return createHash("sha256").update(`dev-${value}`).digest("hex");
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Hotfix: a DEVELOPER item written by a sign-in has its id only in `pk` (there is no `developerId` attribute), and a name stored as an email must still read.
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("records shaped as sign-ins wrote them: an email for a name and no developerId attribute", () => {
  const oldShaped = (developerId: string, extra: Record<string, unknown> = {}) => ({
    pk: `DEVELOPER#${developerId}`, sk: "META", entityType: "DEVELOPER", provider: "cloud", issuer: "https://idp.example.test", subject: "sub-1",
    displayName: "c@example.com", email: "c@example.com", firstSignInAt: "x", lastSignInAt: "x", revoked: false, ...extra,
  });

  it("a display helper never throws: with no id the placeholder is plain 'Member'", () => {
    expect(placeholderDisplayName(undefined as never)).toBe("Member");
    expect(placeholderDisplayName("")).toBe("Member");
    expect(safeDisplayName(EMAIL, undefined as never)).toBe("Member");
    expect(() => readableDeveloper({ displayName: EMAIL } as never)).not.toThrow();
  });

  it("getDeveloper reads the id from the key, and the name is the placeholder for that id", async () => {
    const db = new FakeDynamoDb();
    db.set(oldShaped(idOf("c")));
    const record = await new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: Date.now }).getDeveloper(idOf("c"));
    expect(record).toMatchObject({ developerId: idOf("c"), displayName: placeholderDisplayName(idOf("c")), email: "c@example.com" });
  });

  it("the members list answers 200 with the placeholder for such a member, for a member and for an owner", async () => {
    const h = await broker();
    h.db.set(oldShaped(OMAR.developerId, { provider: "oidc", subject: "o" }));
    for (const who of [MAYA, OMAR]) {
      const answer = await h.dev(who, "GET", "/v1/app/org/members");
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      const omar = (answer.body.members as Array<{ developerId: string; name: string }>).find((member) => member.developerId === OMAR.developerId);
      expect(omar?.name).toBe(placeholderDisplayName(OMAR.developerId));
    }
  });

  it("the approvals list and the approval view read such an owner without failing", async () => {
    const db = new FakeDynamoDb();
    db.set(oldShaped(idOf("d")));
    const deps = { documentClient: db as never, tableName: "state", now: Date.now };
    const id = "apr_bbbbbbbbbbbbbbbbbbbb";
    await createWriteApprovalRecord(deps, {
      orgId: TEST_ORG, approvalId: id, kind: "write", subject: { kind: "agent_run", taskId: randomUUID(), stepId: "work" }, operationId: randomUUID(), connector: "linear", connectorType: "linear",
      tool: "save_issue", toolAccess: "write", scope: "eng", schemaHash: "a".repeat(64), projectRevision: 1, scopeDigest: "b".repeat(64), arguments: {}, argumentsHash: "c".repeat(64),
      summary: "Create an issue", class: "consequential", approvers: { kind: "ids", ids: [idOf("d")] }, status: "PENDING", project: "payments", owner: { developerId: idOf("d"), name: EMAIL },
      attempts: 0, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    } as never, [], 8);
    const listed = await listApprovalsFor(deps as never, { orgId: TEST_ORG, developerId: idOf("d") } as never);
    expect(listed).toHaveLength(1);
    const view = approvalView({ confirmOrigin: "https://cell.example" }, listed[0]!) as { owner: { name: string } };
    expect(view.owner.name).toBe(placeholderDisplayName(idOf("d")));
    const owner = await new DeveloperSignInStore({ documentClient: db, tableName: "state", now: Date.now }).getDeveloper(idOf("d"));
    expect(owner?.displayName).toBe(placeholderDisplayName(idOf("d")));
  });
});
