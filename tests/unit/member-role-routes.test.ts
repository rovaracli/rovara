// The Members page's routes (member-routes.ts, guided onboarding PR 12a) through the real handler and a fake Code that serves Code's own member
// routes with Code's rules (company-member-routes.ts on code/next): the company is the caller's live membership, a plain member gets 404, another
// company's person and nobody both get "member not found", only a live owner can step down, only an owner changes or makes another owner, no step-up
// (owner DEC 254zzz73), and the last active owner is kept. Covers Cloud's early refusals (each proven by Code never being asked), Code's refusals
// reaching the app as fixed sentences (never Code's words or the request's), two companies, the list's bounds, and leak checks.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CODE_MEMBERS_PATH, CodeClient, LocalSessionStore, LocalWorkSessionStore, MEMBER_LIST_PAGES_MAX, MEMBER_WORDS, createCloudHandler, type CloudRequest,
} from "../../packages/cloud-server/src/index.js";
import { AppOrgMembersResponseSchema, OrgMemberRoleChangeResponseSchema } from "../../packages/contracts/src/developer-web.js";

const CODE = "https://code.example.test";
const ORIGIN = "https://cloud.example.test";
const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const START = Date.parse("2026-11-17T12:00:00.000Z");
const SECRET = ["SECRET", "CANARY", "7f3a"].join("-");
type Role = "owner" | "admin" | "member";

interface Member { personId: string; name: string; companyId: string; role: Role; revokedAt?: string }
const id = (c: string) => c.repeat(64);
const PEOPLE: Record<string, Member> = {
  olga: { personId: id("1"), name: "Olga", companyId: A, role: "owner" },
  otto: { personId: id("2"), name: "Otto", companyId: A, role: "owner" },
  ada: { personId: id("3"), name: "Ada", companyId: A, role: "admin" },
  mia: { personId: id("4"), name: "Mia", companyId: A, role: "member" },
  bob: { personId: id("5"), name: "Bob", companyId: B, role: "owner" },
  bea: { personId: id("6"), name: "Bea", companyId: B, role: "admin" },
  ben: { personId: id("7"), name: "Ben", companyId: B, role: "member" },
};

interface Answer { error: { code: string; message: string }; members: Array<{ developerId: string; name: string; role: string }>; [key: string]: unknown }
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
let tokens = 0;

function world() {
  let clock = START;
  const nowS = () => Math.floor(clock / 1000);
  const members = new Map<string, Member>(Object.values(PEOPLE).map((person) => [person.personId, { ...person }]));
  const byToken = new Map<string, { personId: string; stepUpAt?: number }>();
  const codeCalls: Array<{ method: string; path: string; body?: unknown }> = [];
  /** When set, Code answers role changes with this, whatever it holds. */
  let override: { status: number; body: unknown } | undefined;
  let listOverride: { status: number; body: unknown } | undefined;
  let pageSize = 100;
  let extraRows: unknown[] = [];
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const refuse = (code: string, message: string, status: number) => respond(status, { error: { code, message } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const auth = ((init?.headers as Record<string, string> | undefined)?.authorization ?? "").replace(/^Bearer /u, "");
    const token = byToken.get(auth);
    if (token === undefined) return respond(401, { error: { code: "AUTH_REQUIRED" } });
    const me = members.get(token.personId)!;
    if (url.pathname === "/v1/dev/access") {
      return respond(200, { developerId: me.personId, displayName: me.name, administrator: false, projects: [], notices: [], ...(me.revokedAt === undefined ? { companyId: me.companyId, companyRole: me.role } : {}) });
    }
    if (!url.pathname.startsWith(CODE_MEMBERS_PATH)) return respond(404, { error: { code: "NOT_FOUND" } });
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    codeCalls.push({ method, path: url.pathname + url.search, ...(body === undefined ? {} : { body }) });
    // Code's rules, in Code's order and words.
    if (me.revokedAt !== undefined) return refuse("AUTH_REQUIRED", "your AgentX sign-in has ended; run agentx login <url> again", 401);
    if (me.role !== "admin" && me.role !== "owner") return refuse("NOT_FOUND", "not found", 404);
    if (url.pathname === CODE_MEMBERS_PATH && method === "GET") {
      if (listOverride !== undefined) return respond(listOverride.status, listOverride.body);
      const all = [...members.values()].filter((member) => member.companyId === me.companyId);
      const start = Number(url.searchParams.get("cursor")?.slice(1) ?? "0");
      const page = [...all.slice(start, start + pageSize).map((member) => ({ entityType: "COMPANY_MEMBERSHIP", personId: member.personId, companyId: member.companyId, role: member.role, joinedAt: "2026-11-01T00:00:00.000Z", name: member.name, ...(member.revokedAt === undefined ? {} : { revokedAt: member.revokedAt }) })), ...extraRows];
      const more = start + pageSize < all.length;
      return respond(200, { members: page, more, ...(more ? { cursor: `c${String(start + pageSize)}` } : {}) });
    }
    const match = /^\/v1\/dev\/company\/members\/([^/]+)\/role$/u.exec(url.pathname);
    if (match === null || method !== "PUT") return refuse("NOT_FOUND", "not found", 404);
    const target = members.get(decodeURIComponent(match[1]!));
    if (target === undefined || target.companyId !== me.companyId) return refuse("NOT_FOUND", "member not found", 404);
    const role = (body as { role?: unknown } | undefined)?.role;
    if (role !== "member" && role !== "admin" && role !== "owner") return refuse("CONFIG_INVALID", "send the new role: member, admin or owner", 400);
    if (target.personId === me.personId && (me.role !== "owner" || role === "owner")) return refuse("FORBIDDEN", "you cannot change your own role or remove yourself here", 403);
    if ((target.role === "owner" || role === "owner") && me.role !== "owner") return refuse("FORBIDDEN", "only an owner can change or remove an owner", 403);
    if (override !== undefined) return respond(override.status, override.body);
    if (target.revokedAt !== undefined) return refuse("MEMBER_ALREADY_REMOVED", "restore this member before changing their role", 409);
    if (target.role === "owner" && role !== "owner" && ![...members.values()].some((m) => m.companyId === me.companyId && m.role === "owner" && m.revokedAt === undefined && m.personId !== target.personId)) {
      return refuse("LAST_OWNER", "a company must keep at least one active owner", 409);
    }
    target.role = role;
    return respond(200, { ok: true });
  }) as typeof fetch;
  const client = new CodeClient({ baseUrl: CODE, clientId: "rovara-cloud", clientSecret: "secret", redirectUri: `${ORIGIN}/callback`, scopes: "", fetch: fetchImpl });
  const sessions = new LocalSessionStore(undefined, { now: () => clock, environment: {} });
  const handler = createCloudHandler({ client, store: sessions, org: { orgId: "rovara", name: "Rovara", plan: "cloud" }, callbackPath: "/callback", secureCookies: false, work: new LocalWorkSessionStore(), origin: ORIGIN, now: () => new Date(clock), log: () => undefined });
  /** Signs a person in; `stepUpAge` seconds ago they stepped up with a passkey (undefined: no step-up). */
  const signIn = async (who: string, stepUpAge?: number) => {
    const person = PEOPLE[who]!;
    tokens += 1;
    const stepUpAt = stepUpAge === undefined ? undefined : nowS() - stepUpAge;
    const payload = { sub: person.personId, iat: nowS(), exp: nowS() + 3600, jti: String(tokens), ...(stepUpAt === undefined ? {} : { step_up_at: stepUpAt, step_up_amr: "passkey" }) };
    const token = `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}.c2ln`;
    byToken.set(token, { personId: person.personId, ...(stepUpAt === undefined ? {} : { stepUpAt }) });
    const cookie = `cookie-${String(tokens)}`;
    await sessions.create(cookie, { accessToken: token, access: { developerId: person.personId, displayName: person.name, administrator: false, projects: [], notices: [] }, csrf: `csrf-${cookie}`, signedInAt: new Date(clock).toISOString() });
    return { cookie };
  };
  const call = async (as: { cookie: string }, method: string, path: string, body?: unknown) => {
    const request: CloudRequest = {
      method, path: `/v1/web${path.split("?")[0]!}`, query: new URLSearchParams(path.split("?")[1] ?? ""),
      headers: { cookie: `rovara_cloud_session=${as.cookie}`, "x-rovara-csrf": `csrf-${as.cookie}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    const answer = await handler(request);
    return { status: answer!.status, body: JSON.parse(answer!.body) as Answer, raw: answer!.body };
  };
  const roleOf = (who: string) => members.get(PEOPLE[who]!.personId)!.role;
  const change = (as: { cookie: string }, who: string | { personId: string }, role: string, extra: Record<string, unknown> = {}) =>
    call(as, "PUT", `/org/members/${typeof who === "string" ? PEOPLE[who]!.personId : who.personId}/role`, { requestId: randomUUID(), role, ...extra });
  return {
    signIn, call, change, roleOf, codeCalls, members,
    putCalls: () => codeCalls.filter((entry) => entry.method === "PUT"),
    setOverride: (answer: { status: number; body: unknown } | undefined) => { override = answer; },
    setPageSize: (size: number) => { pageSize = size; },
    setListOverride: (answer: { status: number; body: unknown } | undefined) => { listOverride = answer; },
    setExtraRows: (rows: unknown[]) => { extraRows = rows; },
    advance: (ms: number) => { clock += ms; },
  };
}

const words = (answer: { status: number; body: unknown }) => ({ status: answer.status, body: answer.body });

describe("role change: Code's route as the person", () => {
  it("an admin makes a member an admin and back; Code gets only { role } on the person's path, and the app's reader reads the answer", async () => {
    const w = world();
    const ada = await w.signIn("ada", 30);
    const up = await w.change(ada, "mia", "admin", { expectedRole: "member" });
    expect(up.status).toBe(200);
    expect(OrgMemberRoleChangeResponseSchema.parse(up.body)).toEqual({ developerId: PEOPLE.mia!.personId, role: "admin" });
    expect(w.roleOf("mia")).toBe("admin");
    expect(w.putCalls()).toEqual([{ method: "PUT", path: `${CODE_MEMBERS_PATH}/${PEOPLE.mia!.personId}/role`, body: { role: "admin" } }]);
    const down = await w.change(ada, "mia", "member");
    expect(down.status).toBe(200);
    expect(w.roleOf("mia")).toBe("member");
  });

  it("an owner makes an owner and demotes another owner", async () => {
    const w = world();
    const olga = await w.signIn("olga", 30);
    expect((await w.change(olga, "ada", "owner", { expectedRole: "admin" })).status).toBe(200);
    expect(w.roleOf("ada")).toBe("owner");
    expect((await w.change(olga, "otto", "admin", { expectedRole: "owner" })).status).toBe(200);
    expect(w.roleOf("otto")).toBe("admin");
  });

  it("two companies: A's admin and A's owner can't change B's member; Code's 404 reaches the app as the one fixed sentence, the same as nobody", async () => {
    const w = world();
    for (const who of ["ada", "olga"]) {
      const as = await w.signIn(who, 30);
      const other = await w.change(as, "ben", "admin");
      const nobody = await w.change(as, { personId: id("e") }, "admin");
      expect(words(other)).toEqual(words({ status: 404, body: MEMBER_WORDS.notFound.body }));
      expect(words(nobody)).toEqual(words(other));
      expect(other.raw).not.toContain("member not found");
    }
    expect(w.roleOf("ben")).toBe("member");
    // Code was asked (Code decides company isolation), on the plain path, with no company named anywhere.
    expect(w.putCalls().length).toBe(4);
    for (const put of w.putCalls()) { expect(put.path).not.toContain("org_"); expect(JSON.stringify(put.body)).not.toContain("org_"); }
    // B's admin, the other way round.
    const bea = await w.signIn("bea", 30);
    expect(words(await w.change(bea, "mia", "admin"))).toEqual(words(MEMBER_WORDS.notFound));
    expect(w.roleOf("mia")).toBe("member");
  });

  it("a member can't change roles: refused before Code is asked", async () => {
    const w = world();
    const mia = await w.signIn("mia", 30);
    for (const role of ["admin", "member", "owner"]) expect(words(await w.change(mia, "ada", role))).toEqual(words(MEMBER_WORDS.notAdmin));
    expect(w.putCalls()).toEqual([]);
    expect(w.roleOf("ada")).toBe("admin");
  });

  it("the caller's role is Code's live answer: an admin demoted since sign-in is refused", async () => {
    const w = world();
    const ada = await w.signIn("ada", 30);
    w.members.get(PEOPLE.ada!.personId)!.role = "member";
    expect(words(await w.change(ada, "mia", "admin"))).toEqual(words(MEMBER_WORDS.notAdmin));
    expect(w.putCalls()).toEqual([]);
  });

  it("an admin can't make an owner or change an owner: refused before Code", async () => {
    const w = world();
    const ada = await w.signIn("ada");
    expect(words(await w.change(ada, "mia", "owner"))).toEqual(words(MEMBER_WORDS.ownerOnly));
    expect(words(await w.change(ada, "olga", "member", { expectedRole: "owner" }))).toEqual(words(MEMBER_WORDS.ownerOnly));
    expect(w.putCalls()).toEqual([]);
    // Without the screen's expectedRole Code still refuses an admin's change of an owner, in Cloud's words.
    const stepped = await w.signIn("ada", 30);
    expect(words(await w.change(stepped, "olga", "member"))).toEqual(words(MEMBER_WORDS.ownerOnly));
    expect(w.putCalls().length).toBe(1);
    expect(w.roleOf("olga")).toBe("owner");
  });

  it("an admin cannot change their own role, and an owner cannot promote themself or remove themself", async () => {
    const w = world();
    const as = await w.signIn("ada", 30);
    expect(words(await w.change(as, "ada", "member"))).toEqual(words(MEMBER_WORDS.self));
    const owner = await w.signIn("olga", 30);
    expect(words(await w.change(owner, "olga", "owner"))).toEqual(words(MEMBER_WORDS.self));
    expect(words(await w.call(owner, "POST", `/org/members/${PEOPLE.olga!.personId}/removal`, { requestId: randomUUID(), expectedRole: "owner" }))).toEqual(words({ status: 403, body: { error: { code: "FORBIDDEN", message: "You can't remove yourself. Ask another owner or admin." } } }));
    expect(w.putCalls()).toEqual([]);
    expect(w.roleOf("olga")).toBe("owner");
  });

  it("a live owner steps down through Code, which keeps the other live owner", async () => {
    const w = world(), owner = await w.signIn("olga", 30);
    const answer = await w.change(owner, "olga", "member", { expectedRole: "owner" });
    expect(answer.status).toBe(200);
    expect(w.roleOf("olga")).toBe("member");
    expect(w.roleOf("otto")).toBe("owner");
    expect(w.putCalls().at(-1)).toMatchObject({ path: `${CODE_MEMBERS_PATH}/${PEOPLE.olga!.personId}/role`, body: { role: "member" } });
  });

  it("a removed owner in this company and a live owner in another company are not witnesses", async () => {
    const w = world(), owner = await w.signIn("olga", 30);
    w.members.get(PEOPLE.otto!.personId)!.revokedAt = "2026-11-10T00:00:00.000Z";
    const answer = await w.change(owner, "olga", "admin", { expectedRole: "owner" });
    expect(words(answer)).toEqual(words({ status: 409, body: { error: { code: "LAST_OWNER", message: "You're the only owner; add another owner first" } } }));
    expect(w.roleOf("olga")).toBe("owner");
    expect(w.roleOf("bob")).toBe("owner");
  });

  it("no step-up (owner DEC 254zzz73): with none, an old one or a future one an admin changes a member of their own company; the wrong role and the wrong company still can't", async () => {
    for (const age of [undefined, 601, -120]) {
      const w = world();
      // Wrong role: a member with the same kind of sign-in is refused before Code is asked.
      expect(words(await w.change(await w.signIn("mia", age), "otto", "admin"))).toEqual(words(MEMBER_WORDS.notAdmin));
      expect(w.putCalls()).toEqual([]);
      // Wrong company: B's admin with the same kind of sign-in gets the one not-found sentence; A's member is unchanged.
      expect(words(await w.change(await w.signIn("bea", age), "mia", "admin"))).toEqual(words(MEMBER_WORDS.notFound));
      expect(w.roleOf("mia")).toBe("member");
      // The right role in the right company goes through.
      expect((await w.change(await w.signIn("ada", age), "mia", "admin")).status).toBe(200);
      expect(w.roleOf("mia")).toBe("admin");
    }
  });

  it("an unexpected 403 from Code (whatever its code) is the not-allowed sentence, never Code's words", async () => {
    const w = world();
    const ada = await w.signIn("ada");
    w.setOverride({ status: 403, body: { error: { code: "REAUTH_REQUIRED", message: `${SECRET} this role change needs a fresh sign-in check` } } });
    const answer = await w.change(ada, "mia", "admin");
    expect(words(answer)).toEqual(words(MEMBER_WORDS.notAdmin));
    expect(answer.raw).not.toContain(SECRET);
  });

  it("the last owner: Code refuses (inside its own transaction) and the app gets the one clear sentence, not Code's words", async () => {
    // Through this route the caller is always another active owner, so Code's last-owner refusal is reached by a race (two owners demoting each
    // other at once, or an owner removed meanwhile). Code answers it; Cloud only words it.
    const w = world();
    const olga = await w.signIn("olga", 30);
    w.setOverride({ status: 409, body: { error: { code: "LAST_OWNER", message: `a company must keep at least one active owner ${SECRET}` } } });
    const answer = await w.change(olga, "otto", "member", { expectedRole: "owner" });
    expect(words(answer)).toEqual(words({ status: 409, body: { error: { code: "LAST_OWNER", message: "You're the only owner; add another owner first" } } }));
    expect(answer.raw).not.toContain(SECRET);
    expect(w.roleOf("otto")).toBe("owner");
  });

  it("a removed person: Code's refusal reaches the app as a fixed sentence", async () => {
    const w = world();
    w.members.get(PEOPLE.mia!.personId)!.revokedAt = "2026-11-10T00:00:00.000Z";
    const olga = await w.signIn("olga", 30);
    expect(words(await w.change(olga, "mia", "admin"))).toEqual(words(MEMBER_WORDS.removed));
  });

  it("the body is checked strictly, and a person id that isn't one is the not-found sentence, with no Code call", async () => {
    const w = world();
    const olga = await w.signIn("olga", 30);
    const path = `/org/members/${PEOPLE.mia!.personId}/role`;
    for (const body of [undefined, [], "admin", { role: "admin" }, { requestId: "x", role: "admin" }, { requestId: randomUUID(), role: "auditor" }, { requestId: randomUUID(), role: "admin", companyId: B }, { requestId: randomUUID(), role: "admin", expectedRole: "boss" }]) {
      expect(words(await w.call(olga, "PUT", path, body))).toEqual(words(MEMBER_WORDS.badBody));
    }
    for (const bad of ["abc", "A".repeat(64), `${"a".repeat(63)}%2F`, "..%2F..%2Fpreapprovals"]) {
      const answer = await w.call(olga, "PUT", `/org/members/${bad}/role`, { requestId: randomUUID(), role: "admin" });
      expect(words(answer)).toEqual(words(MEMBER_WORDS.notFound));
      expect(answer.raw).not.toContain(bad);
    }
    expect(w.putCalls()).toEqual([]);
  });

  it("Code's other refusals become fixed sentences; nothing Code wrote or the request sent is echoed", async () => {
    const w = world();
    const olga = await w.signIn("olga", 30);
    const cases: Array<[{ status: number; body: unknown }, unknown]> = [
      [{ status: 403, body: { error: { code: "FORBIDDEN", message: `${SECRET} something new` } } }, MEMBER_WORDS.notAdmin],
      [{ status: 403, body: { error: { code: "FORBIDDEN", message: "you cannot change your own role or remove yourself here" } } }, MEMBER_WORDS.self],
      [{ status: 403, body: { error: { code: "FORBIDDEN", message: "only an owner can change or remove an owner" } } }, MEMBER_WORDS.ownerOnly],
      [{ status: 400, body: { error: { code: "CONFIG_INVALID", message: SECRET } } }, MEMBER_WORDS.badBody],
      // A caller demoted between Cloud's access check and Code's answer: Code's plain "not found" is the not-admin answer, not "not in your company".
      [{ status: 404, body: { error: { code: "NOT_FOUND", message: "not found" } } }, MEMBER_WORDS.notAdmin],
      [{ status: 409, body: { error: { code: "CONFLICT", message: SECRET } } }, MEMBER_WORDS.unavailable],
      [{ status: 500, body: SECRET }, MEMBER_WORDS.unavailable],
      [{ status: 502, body: { error: SECRET } }, MEMBER_WORDS.unavailable],
    ];
    for (const [code, expected] of cases) {
      w.setOverride(code);
      const answer = await w.change(olga, "mia", "admin");
      expect(words(answer)).toEqual(words(expected as { status: number; body: unknown }));
      expect(answer.raw).not.toContain(SECRET);
    }
  });

  it("someone with no company is refused with Code's one company answer, before any member call", async () => {
    const w = world();
    const mia = await w.signIn("mia", 30);
    w.members.get(PEOPLE.mia!.personId)!.revokedAt = "2026-11-17T00:00:00.000Z";
    const answer = await w.change(mia, "ada", "member");
    expect(answer.body.error.code).toBe("NO_COMPANY");
    expect(w.codeCalls).toEqual([]);
  });
});

describe("member list: Code's list as the person", () => {
  it("an admin sees their company's current people in the app's shape; removed people and other companies are left out", async () => {
    const w = world();
    w.members.get(PEOPLE.otto!.personId)!.revokedAt = "2026-11-10T00:00:00.000Z";
    const ada = await w.signIn("ada");
    const answer = await w.call(ada, "GET", "/org/members");
    expect(answer.status).toBe(200);
    const parsed = AppOrgMembersResponseSchema.parse(answer.body);
    expect(parsed.members.map((member) => [member.name, member.role]).sort()).toEqual([["Ada", "admin"], ["Mia", "member"], ["Olga", "owner"]]);
    expect(answer.raw).not.toContain(B);
    expect(answer.raw).not.toContain("Ben");
    expect(w.codeCalls).toEqual([{ method: "GET", path: `${CODE_MEMBERS_PATH}?limit=100` }]);
  });

  it("follows Code's pages, and refuses the whole list past the page bound", async () => {
    const w = world();
    w.setPageSize(1);
    const olga = await w.signIn("olga");
    const answer = await w.call(olga, "GET", "/org/members");
    expect(answer.body.members).toHaveLength(4);
    expect(w.codeCalls.map((entry) => entry.path)).toEqual([`${CODE_MEMBERS_PATH}?limit=100`, `${CODE_MEMBERS_PATH}?limit=100&cursor=c1`, `${CODE_MEMBERS_PATH}?limit=100&cursor=c2`, `${CODE_MEMBERS_PATH}?limit=100&cursor=c3`]);
    for (let n = 0; n < MEMBER_LIST_PAGES_MAX; n += 1) w.members.set(id(String.fromCharCode(97 + n)), { personId: id(String.fromCharCode(97 + n)), name: `P${String(n)}`, companyId: A, role: "member" });
    expect(words(await w.call(olga, "GET", "/org/members"))).toEqual(words(MEMBER_WORDS.listTooLong));
  });

  it("a row of another company, or one that doesn't read, refuses the whole list (never a part)", async () => {
    for (const row of [
      { entityType: "COMPANY_MEMBERSHIP", personId: id("9"), companyId: B, role: "member", joinedAt: "2026-11-01T00:00:00.000Z", name: "Leak" },
      { personId: "nope", companyId: A, role: "member" },
      { personId: id("9"), companyId: A, role: "superuser" },
      "row",
    ]) {
      const w = world();
      w.setExtraRows([row]);
      const ada = await w.signIn("ada");
      const answer = await w.call(ada, "GET", "/org/members");
      expect(words(answer)).toEqual(words(MEMBER_WORDS.listUnavailable));
      expect(answer.raw).not.toContain("Leak");
    }
  });

  it("Code's own refusals of the list become fixed answers, never Code's words", async () => {
    const w = world();
    const ada = await w.signIn("ada");
    for (const [code, expected] of [[{ status: 404, body: { error: { code: "NOT_FOUND", message: SECRET } } }, MEMBER_WORDS.listNotAdmin], [{ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: SECRET } } }, MEMBER_WORDS.listUnavailable], [{ status: 200, body: { members: "x", more: false } }, MEMBER_WORDS.listUnavailable]] as const) {
      w.setListOverride(code);
      const answer = await w.call(ada, "GET", "/org/members");
      expect(words(answer)).toEqual(words(expected));
      expect(answer.raw).not.toContain(SECRET);
    }
  });

  it("checks every page Code sends: size, cursor, a repeated cursor, a missing more; duplicates once; unsafe or long names shown as a fixed name", async () => {
    const row = (c: string, extra: Record<string, unknown> = {}) => ({ entityType: "COMPANY_MEMBERSHIP", personId: id(c), companyId: A, role: "member", joinedAt: "2026-11-01T00:00:00.000Z", name: `P${c}`, ...extra });
    const w = world();
    const ada = await w.signIn("ada");
    const bad = [
      { members: Array.from({ length: 101 }, () => row("9")), more: false },
      { members: [row("9")], more: true, cursor: "bad cursor!" },
      { members: [row("9")], more: true },
      { members: [row("9")] },
    ];
    for (const body of bad) {
      w.setListOverride({ status: 200, body });
      const before = w.codeCalls.length;
      expect(words(await w.call(ada, "GET", "/org/members")), JSON.stringify(body).slice(0, 80)).toEqual(words(MEMBER_WORDS.listUnavailable));
      // Refused on the first page: nothing that page carried is sent back to Code.
      expect(w.codeCalls.length - before).toBe(1);
    }
    // A cursor that repeats (Code loops) is refused, never followed forever.
    w.setListOverride({ status: 200, body: { members: [row("9")], more: true, cursor: "c1" } });
    expect(words(await w.call(ada, "GET", "/org/members"))).toEqual(words(MEMBER_WORDS.listUnavailable));
    w.setListOverride({ status: 200, body: { members: [row("9"), row("9"), row("8", { name: "Eve\u202Elive", email: "a\u202E@x.test" }), row("7", { name: "x".repeat(201), email: `${"e".repeat(330)}@x.test` })], more: false } });
    const answer = await w.call(ada, "GET", "/org/members");
    expect(answer.body.members).toEqual([
      { developerId: id("9"), name: "P9", role: "member", joinedAt: "2026-11-01T00:00:00.000Z" },
      { developerId: id("8"), name: "Unnamed person", role: "member", joinedAt: "2026-11-01T00:00:00.000Z" },
      { developerId: id("7"), name: "Unnamed person", role: "member", joinedAt: "2026-11-01T00:00:00.000Z" },
    ]);
  });

  it("the browser's query never reaches Code: Code's list call is always Cloud's own", async () => {
    const w = world();
    const ada = await w.signIn("ada");
    const request = await w.call(ada, "GET", `/org/members?companyId=${B}&cursor=c1&limit=1`);
    expect(request.status).toBe(200);
    expect(w.codeCalls).toEqual([{ method: "GET", path: `${CODE_MEMBERS_PATH}?limit=100` }]);
  });

  it("a member is refused before Code is asked; Code's own 404 for a demoted admin is the same answer", async () => {
    const w = world();
    const mia = await w.signIn("mia");
    expect(words(await w.call(mia, "GET", "/org/members"))).toEqual(words(MEMBER_WORDS.listNotAdmin));
    expect(w.codeCalls).toEqual([]);
  });
});
