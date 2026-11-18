// DEC 254zzz84 (5): the Members page's removal with a hand-over (member-routes.ts), through the real handler and a fake Code that serves Code's own
// removal routes with Code's rules (company-member-routes.ts on code/next): the company is the caller's live membership, a plain member gets 404, another
// company's person and nobody both get "member not found", nobody removes themselves, only an owner removes an owner, the successor is a live member of
// the same company, the role the screen showed must still hold, the last owner is kept, and the request id makes a repeat answer the same. Covers Cloud's
// early refusals (each proven by Code never being asked), Code's refusals reaching the app as fixed sentences (never Code's words or the request's), two
// companies, the app's readers, and leak checks. No step-up anywhere (DEC 254zzz73).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CODE_MEMBERS_PATH, CodeClient, LocalSessionStore, LocalWorkSessionStore, REMOVAL_WORDS, createCloudHandler, type CloudRequest } from "../../packages/cloud-server/src/index.js";
import { MemberRemovalPreviewReaderSchema, MemberRemovalStartedReaderSchema } from "../../packages/contracts/src/member-removal-web.js";

const CODE = "https://code.example.test";
const ORIGIN = "https://cloud.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const START = Date.parse("2026-11-18T12:00:00.000Z");
const SECRET = ["SECRET", "CANARY", "84"].join("-");
type Role = "owner" | "admin" | "member";
interface Member { personId: string; name: string; companyId: string; role: Role; revokedAt?: string; agents: number; tasks: number }
const id = (c: string) => c.repeat(64);
const PEOPLE: Record<string, Omit<Member, "agents" | "tasks">> = {
  olga: { personId: id("1"), name: "Olga", companyId: A, role: "owner" },
  otto: { personId: id("2"), name: "Otto", companyId: A, role: "owner" },
  ada: { personId: id("3"), name: "Ada", companyId: A, role: "admin" },
  mia: { personId: id("4"), name: "Mia", companyId: A, role: "member" },
  bea: { personId: id("6"), name: "Bea", companyId: B, role: "admin" },
};
type Answer = Record<string, unknown> & { error: { code: string; message: string } };
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
let tokens = 0;

function world() {
  const members = new Map<string, Member>(Object.values(PEOPLE).map((person) => [person.personId, { ...person, agents: 0, tasks: 0 }]));
  members.get(PEOPLE.mia!.personId)!.agents = 2; members.get(PEOPLE.mia!.personId)!.tasks = 3;
  const byToken = new Map<string, string>();
  const codeCalls: Array<{ method: string; path: string; body?: unknown }> = [];
  const receipts = new Map<string, { key: string; answer: unknown }>();
  let override: { status: number; body: unknown } | undefined;
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const refuse = (code: string, message: string, status: number) => respond(status, { error: { code, message } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const auth = ((init?.headers as Record<string, string> | undefined)?.authorization ?? "").replace(/^Bearer /u, "");
    const personId = byToken.get(auth);
    if (personId === undefined) return respond(401, { error: { code: "AUTH_REQUIRED" } });
    const me = members.get(personId)!;
    if (url.pathname === "/v1/dev/access") {
      return respond(200, { developerId: me.personId, displayName: me.name, administrator: false, projects: [], notices: [], ...(me.revokedAt === undefined ? { companyId: me.companyId, companyRole: me.role } : {}) });
    }
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    codeCalls.push({ method, path: url.pathname + url.search, ...(body === undefined ? {} : { body }) });
    if (override !== undefined) return respond(override.status, override.body);
    if (me.role !== "admin" && me.role !== "owner") return refuse("NOT_FOUND", "not found", 404);
    const match = /^\/v1\/dev\/company\/members\/([^/]+)\/(removal|removal-preview)$/u.exec(url.pathname);
    if (match === null) return refuse("NOT_FOUND", "not found", 404);
    const target = members.get(match[1]!);
    if (target === undefined || target.companyId !== me.companyId) return refuse("NOT_FOUND", "member not found", 404);
    if (target.personId === me.personId) return refuse("FORBIDDEN", "you cannot change your own role or remove yourself here", 403);
    const successorId = match[2] === "removal" ? String(body?.["successorId"]) : url.searchParams.get("successorId") ?? me.personId;
    const successor = members.get(successorId);
    if (successor === undefined || successor.companyId !== me.companyId || successor.revokedAt !== undefined || successorId === target.personId) return refuse("SUCCESSOR_INVALID", "pick someone who is still in the company to take over", 409);
    if (match[2] === "removal-preview") {
      if (target.revokedAt !== undefined) return refuse("NOT_FOUND", "member not found", 404);
      return respond(200, { personId: target.personId, role: target.role, name: target.name, openTasks: target.tasks, awaitingTheirDecision: 0, ownedProjects: ["alpha"], projectGrants: ["beta"], mayRemove: true,
        successor: { personId: successorId, name: successor.name }, handOver: { agents: target.agents, chains: 0, projects: 1, tasks: successor.role === "member" ? 0 : target.tasks, tasksLeft: successor.role === "member" ? target.tasks : 0 } });
    }
    const requestId = String(body?.["requestId"]).toLowerCase(), key = `${target.personId}|${successorId}|${String(body?.["expectedRole"])}|${me.personId}`;
    const receipt = receipts.get(requestId);
    if (receipt !== undefined) return receipt.key === key ? respond(200, receipt.answer) : refuse("IDEMPOTENCY_CONFLICT", "this request id was already used for another removal; start the removal again", 409);
    if ((target.role === "owner" || body?.["expectedRole"] === "owner") && me.role !== "owner") return refuse("FORBIDDEN", "only an owner can change or remove an owner", 403);
    if (target.revokedAt !== undefined) return refuse("MEMBER_ALREADY_REMOVED", "restore this member before changing their role", 409);
    if (target.role !== body?.["expectedRole"]) return refuse("CHANGE_STALE", "this person's role changed; review the removal again", 409);
    if (target.role === "owner" && ![...members.values()].some((m) => m.companyId === me.companyId && m.role === "owner" && m.revokedAt === undefined && m.personId !== target.personId)) {
      return refuse("LAST_OWNER", "a company must keep at least one active owner", 409);
    }
    target.revokedAt = new Date(START).toISOString();
    const answer = { removalId: requestId, state: "DONE", successorId, moved: { agents: target.agents, chains: 0, projects: 1, tasks: target.tasks, tasksLeft: 0 } };
    successor.agents += target.agents; target.agents = 0;
    receipts.set(requestId, { key, answer });
    return respond(200, answer);
  }) as typeof fetch;
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: `${ORIGIN}/callback`, scopes: "", fetch: fetchImpl });
  const sessions = new LocalSessionStore(undefined, { now: () => START, environment: {} });
  const handler = createCloudHandler({ client, store: sessions, org: { orgId: "rovara", name: "Rovara", plan: "cloud" }, callbackPath: "/callback", secureCookies: false, work: new LocalWorkSessionStore(), origin: ORIGIN, now: () => new Date(START), log: () => undefined });
  const signIn = async (who: string) => {
    const person = PEOPLE[who]!;
    tokens += 1;
    const token = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ sub: person.personId, iat: START / 1000, exp: START / 1000 + 3600, jti: String(tokens) })}.c2ln`;
    byToken.set(token, person.personId);
    const cookie = `cookie-${String(tokens)}`;
    await sessions.create(cookie, { accessToken: token, access: { developerId: person.personId, displayName: person.name, administrator: false, projects: [], notices: [] }, csrf: `csrf-${cookie}`, signedInAt: new Date(START).toISOString() });
    return { cookie };
  };
  const call = async (as: { cookie: string }, method: string, path: string, body?: unknown) => {
    const request: CloudRequest = {
      method, path: `/v1/web${path.split("?")[0]!}`, query: new URLSearchParams(path.split("?")[1] ?? ""),
      headers: { cookie: `rovara_cloud_session=${as.cookie}`, "x-rovara-csrf": `csrf-${as.cookie}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    };
    const answer = await handler(request);
    return { status: answer!.status, body: JSON.parse(answer!.body) as Answer, raw: answer!.body };
  };
  const remove = (as: { cookie: string }, who: string, extra: Record<string, unknown> = {}) =>
    call(as, "POST", `/org/members/${PEOPLE[who]?.personId ?? who}/removal`, { requestId: randomUUID(), expectedRole: PEOPLE[who]?.role ?? "member", ...extra });
  const preview = (as: { cookie: string }, who: string, successor?: string) => call(as, "GET", `/org/members/${PEOPLE[who]?.personId ?? who}/removal-preview${successor === undefined ? "" : `?successorId=${successor}`}`);
  const removed = (who: string) => members.get(PEOPLE[who]!.personId)!.revokedAt !== undefined;
  return { signIn, call, remove, preview, removed, codeCalls, members, setOverride: (answer: typeof override) => { override = answer; } };
}
const words = (answer: { status: number; body: unknown }) => ({ status: answer.status, body: answer.body });
const codeAsked = (w: ReturnType<typeof world>) => w.codeCalls.filter((call) => call.path.includes("/removal"));

describe("removal with a hand-over: Code's routes as the person", () => {
  it("an admin previews and removes a member, picking who takes over; the app's readers read both answers; Code gets exactly the body", async () => {
    const w = world(); const ada = await w.signIn("ada");
    const shown = await w.preview(ada, "mia", PEOPLE.otto!.personId);
    expect(shown.status).toBe(200);
    expect(MemberRemovalPreviewReaderSchema.parse(shown.body)).toBeDefined();
    expect(shown.body).toEqual({
      member: { developerId: PEOPLE.mia!.personId, name: "Mia", role: "member" }, successor: { developerId: PEOPLE.otto!.personId, name: "Otto" },
      moves: { agents: 2, skills: 0, chains: 0, triggers: 0, approvals: 0, spendRequests: 0, tasks: 3, projects: 1 },
      ends: expect.any(Array) as unknown, duties: { wasRole: "member", projectGrants: 2, maintainerProjects: 0, invitesCreated: 0 }, warnings: [],
    });
    const requestId = randomUUID();
    const done = await w.remove(ada, "mia", { requestId, successorId: PEOPLE.otto!.personId });
    expect(done.status).toBe(200);
    expect(MemberRemovalStartedReaderSchema.parse(done.body)).toBeDefined();
    expect(done.body).toEqual({ removalId: requestId, state: "DONE", message: "Removed from the company. Handed over 2 agents, admin of 1 project, 3 open tasks." });
    expect(w.removed("mia")).toBe(true);
    expect(codeAsked(w).at(-1)).toEqual({ method: "POST", path: `${CODE_MEMBERS_PATH}/${PEOPLE.mia!.personId}/removal`, body: { requestId, expectedRole: "member", successorId: PEOPLE.otto!.personId } });
  });

  it("with no successor named the remover takes over, in the preview and the removal", async () => {
    const w = world(); const ada = await w.signIn("ada");
    expect((await w.preview(ada, "mia")).body["successor"]).toEqual({ developerId: PEOPLE.ada!.personId, name: "Ada" });
    await w.remove(ada, "mia");
    expect(codeAsked(w).at(-1)?.body).toMatchObject({ successorId: PEOPLE.ada!.personId });
  });

  it("the preview warns about tasks the successor can't take", async () => {
    const w = world(); const ada = await w.signIn("ada");
    w.members.set(id("8"), { personId: id("8"), name: "Max", companyId: A, role: "member", agents: 0, tasks: 0 });
    expect((await w.preview(ada, "mia", id("8"))).body["warnings"]).toEqual(["3 open tasks can't go to them (no access to the project) and will wait for someone with access to take over."]);
  });

  it("a repeat of the same request answers the same; the same id for another removal is refused in fixed words", async () => {
    const w = world(); const ada = await w.signIn("ada");
    const requestId = randomUUID();
    const first = await w.remove(ada, "mia", { requestId });
    expect(words(await w.remove(ada, "mia", { requestId }))).toEqual(words(first));
    expect(words(await w.remove(ada, "mia", { requestId, successorId: PEOPLE.otto!.personId }))).toEqual(words(REMOVAL_WORDS.reused));
  });
});

describe("Cloud's early refusals: Code is never asked", () => {
  it("a plain member, oneself, a malformed id, an admin removing a screen-owner, a successor who is the person", async () => {
    const w = world(); const mia = await w.signIn("mia"); const ada = await w.signIn("ada");
    expect(words(await w.remove(mia, "ada"))).toEqual(words(REMOVAL_WORDS.notAdmin));
    expect(words(await w.preview(mia, "ada"))).toEqual(words(REMOVAL_WORDS.notAdmin));
    expect(words(await w.remove(ada, "ada"))).toEqual(words(REMOVAL_WORDS.self));
    expect(words(await w.preview(ada, "ada"))).toEqual(words(REMOVAL_WORDS.self));
    expect(words(await w.remove(ada, SECRET))).toEqual(words(REMOVAL_WORDS.notFound));
    expect(words(await w.remove(ada, "olga"))).toEqual(words(REMOVAL_WORDS.ownerOnly));
    expect(words(await w.remove(ada, "mia", { successorId: PEOPLE.mia!.personId }))).toEqual(words(REMOVAL_WORDS.successor));
    expect(codeAsked(w)).toEqual([]);
    expect(w.removed("mia")).toBe(false);
  });

  it("bodies and queries are checked strictly and never echoed", async () => {
    const w = world(); const ada = await w.signIn("ada");
    const path = `/org/members/${PEOPLE.mia!.personId}/removal`;
    // (A body that is not JSON at all is the handler's own fixed refusal, before any route.)
    for (const body of [{}, [SECRET], { requestId: SECRET, expectedRole: "member" }, { requestId: randomUUID(), expectedRole: SECRET }, { requestId: randomUUID(), expectedRole: "auditor" },
      { requestId: randomUUID(), expectedRole: "member", successorId: SECRET }, { requestId: randomUUID(), expectedRole: "member", companyId: B }]) {
      const answer = await w.call(ada, "POST", path, body);
      expect(words(answer)).toEqual(words(REMOVAL_WORDS.badBody));
      expect(answer.raw).not.toContain(SECRET);
    }
    for (const query of [`?${SECRET}=1`, `?successorId=${SECRET}`, `?successorId=${PEOPLE.ada!.personId}&successorId=${PEOPLE.ada!.personId}`]) {
      const answer = await w.call(ada, "GET", `/org/members/${PEOPLE.mia!.personId}/removal-preview${query}`);
      expect(words(answer)).toEqual(words(REMOVAL_WORDS.badQuery));
      expect(answer.raw).not.toContain(SECRET);
    }
    expect(codeAsked(w)).toEqual([]);
  });
});

describe("Code's refusals reach the app as fixed sentences", () => {
  it("two companies: another company's person and nobody both answer 'not found'; a successor from another company is refused", async () => {
    const w = world(); const bea = await w.signIn("bea"); const ada = await w.signIn("ada");
    expect(words(await w.remove(bea, "mia"))).toEqual(words(REMOVAL_WORDS.notFound));
    expect(words(await w.preview(bea, "mia"))).toEqual(words(REMOVAL_WORDS.notFound));
    expect(words(await w.remove(ada, "mia", { successorId: PEOPLE.bea!.personId }))).toEqual(words(REMOVAL_WORDS.successor));
    expect(words(await w.preview(ada, "mia", PEOPLE.bea!.personId))).toEqual(words(REMOVAL_WORDS.successor));
    expect(w.removed("mia")).toBe(false);
  });

  it("the last owner, a stale role, an already removed person", async () => {
    const w = world(); const olga = await w.signIn("olga"); const ada = await w.signIn("ada");
    w.members.get(PEOPLE.otto!.personId)!.revokedAt = "2026-11-01T00:00:00.000Z";
    w.members.get(PEOPLE.olga!.personId)!.role = "owner";
    // Olga removes Ada while Otto is gone: fine. A stale screen role is refused.
    expect(words(await w.remove(olga, "ada", { expectedRole: "member" }))).toEqual(words(REMOVAL_WORDS.stale));
    expect((await w.remove(olga, "ada")).status).toBe(200);
    expect(words(await w.remove(olga, "ada"))).toEqual(words(REMOVAL_WORDS.removed));
    // Code's last-owner refusal, in the app's words.
    w.setOverride({ status: 409, body: { error: { code: "LAST_OWNER", message: SECRET } } });
    const last = await w.remove(olga, "mia");
    expect(words(last)).toEqual(words(REMOVAL_WORDS.lastOwner)); expect(last.raw).not.toContain(SECRET);
    void ada;
  });

  it("anything else from Code is the one 'try again' answer, never Code's words; a DONE that doesn't read is not reported as done", async () => {
    const w = world(); const ada = await w.signIn("ada");
    for (const answer of [{ status: 500, body: { error: { code: "X", message: SECRET } } }, { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: SECRET } } },
      { status: 200, body: { removalId: SECRET, state: "DONE", moved: {} } }, { status: 200, body: { ok: true } }]) {
      w.setOverride(answer);
      const removed = await w.remove(ada, "mia");
      expect(words(removed)).toEqual(words(REMOVAL_WORDS.unavailable)); expect(removed.raw).not.toContain(SECRET);
      const shown = await w.preview(ada, "mia");
      expect(shown.status).toBeGreaterThanOrEqual(400); expect(shown.raw).not.toContain(SECRET);
    }
    // A DONE for another successor than the one asked for is not this removal.
    const requestId = randomUUID();
    w.setOverride({ status: 200, body: { removalId: requestId, state: "DONE", successorId: PEOPLE.otto!.personId, moved: { agents: 0, chains: 0, projects: 0, tasks: 0, tasksLeft: 0 } } });
    expect(words(await w.remove(ada, "mia", { requestId }))).toEqual(words(REMOVAL_WORDS.unavailable));
    w.setOverride({ status: 400, body: { error: { code: "CONFIG_INVALID", message: "This person owns too much to hand over in one go. Hand some of it over first." } } });
    expect(words(await w.remove(ada, "mia"))).toEqual(words(REMOVAL_WORDS.tooMuch));
  });
});

describe("DEC 254zzz84 (2), (3): no self-leave and no member lookup route", () => {
  it("POST /org/leave and POST /org/members/lookup are not routes Cloud serves", async () => {
    const w = world(); const ada = await w.signIn("ada");
    for (const path of ["/org/leave", "/org/members/lookup"]) {
      const answer = await w.call(ada, "POST", path, { requestId: randomUUID(), email: "mia@example.test" });
      expect(answer.status, path).not.toBe(200);
    }
  });
});
