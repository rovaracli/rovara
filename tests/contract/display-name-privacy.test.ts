// Release 0.4.16: a person's email is never their name to anyone else. The sign-in provider's name (or its lack: the email-code sign-in names
// a person by their address) is stored as a placeholder; a person may choose their own name; a sign-in never overwrites a chosen name; and
// every place that shows a name reads it through the email-safe rule, a stored email included. Names and roles are visible to members;
// emails, join dates and sign-in methods are for owners and admins (owner decision, option A).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentSessionKey, auditEventId, cleanSessionName, containsEmailAddress, emailSafeName, SetMyNameBodySchema, sessionEventId, withoutEmailAddresses } from "../../packages/contracts/src/index.js";
import { auditOccurrence } from "../../packages/broker/src/audit/events.js";
import { placeholderDisplayName, safeDisplayName } from "../../packages/broker/src/developer/person-name.js";
import { personNameForText } from "../../packages/broker/src/developer/requester-text.js";
import { startMessage } from "../../packages/broker/src/developer/share-messages.js";
import { readableTaskComment } from "../../packages/broker/src/developer/page-comments.js";
import { plainName } from "../../packages/broker/src/aws/task-web.js";
import { effectiveTaskOwner } from "../../packages/broker/src/developer/task-records.js";
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
import { OIDC_ISSUER, identityHarness } from "../support/developer-fakes.js";
import { TEST_ORG } from "../support/orgs.js";

const PLACEHOLDER = /^Member [0-9a-f]{4}$/;
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
    const store = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => now, audit: audit.audit });
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
    expect(h.db.get(`DEVELOPER#${MAYA.developerId}`, "META")).toMatchObject({ displayName: "Maya C", displayNameChosen: true });
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
    expect(h.db.get(`DEVELOPER#${OMAR.developerId}`, "META")).toMatchObject({ displayName: "Omar Diaz" });
    await setName(h, OMAR, { name: "Omar D" });
    expect(h.db.get(`DEVELOPER#${MAYA.developerId}`, "META")).toMatchObject({ displayName: "Maya C" });
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
