// Who and which company (company-caller.ts, DEC 253z): the company and the company role come only from Code's access check; a Code that names
// none (or one that doesn't read) is refused with fixed words, never a fallback; a company admin is a company owner or admin, never Code's
// install administrator. Cloud's own sessions carry the company and read as missing to anyone in another company (companyScopedWork).
import { describe, expect, it } from "vitest";
import { COMPANY_NAME_FALLBACK, NOT_IN_COMPANY, companyNameOf, companyOf, isCompanyAdmin } from "../../packages/cloud-server/src/company-caller.js";
import { LocalWorkSessionStore, SessionCompanyMissing, StoreConflict, companyScopedWork, type WorkSession } from "../../packages/cloud-server/src/work-sessions.js";
import type { CodeAccess } from "../../packages/cloud-server/src/code-client.js";
import type { BedrockBackend } from "../../packages/cloud-server/src/bedrock-byo-routes.js";
import { A, B, world } from "./product-ai-world.js";

const base: CodeAccess = { developerId: "a".repeat(64), displayName: "Ada", administrator: false, projects: [], notices: [] };

describe("companyOf: the company Code's access answer names", () => {
  it("reads the company, the role and a readable name", () => {
    expect(companyOf({ ...base, companyId: A, companyRole: "owner", companyName: "  Acme  " })).toEqual({ companyId: A, companyRole: "owner", companyName: "Acme" });
    for (const role of ["owner", "admin", "member"]) expect(companyOf({ ...base, companyId: A, companyRole: role })).toEqual({ companyId: A, companyRole: role });
  });

  it("is undefined (refused) when the company or the role is missing or doesn't read: never a guessed role", () => {
    const bad: Array<Record<string, unknown>> = [
      {}, { companyId: A }, { companyRole: "owner" }, { companyId: A, companyRole: "auditor" }, { companyId: A, companyRole: "OWNER" }, { companyId: A, companyRole: "" },
      { companyId: A, companyRole: ["owner"] }, { companyId: "acme", companyRole: "owner" }, { companyId: `${A} `, companyRole: "owner" }, { companyId: "org_AAAAAAAAAAAAAAAAAAAA", companyRole: "owner" },
      { companyId: 7, companyRole: "owner" }, { companyId: null, companyRole: "owner" },
    ];
    for (const extra of bad) expect({ extra, read: companyOf({ ...base, ...extra }) }).toEqual({ extra, read: undefined });
    expect(companyOf(undefined)).toBeUndefined();
  });

  it("drops a name that doesn't read (empty, control or format characters, over 200 characters), and shows the fallback", () => {
    for (const name of ["", "   ", "a\u0000b", "a‮b", "x".repeat(201), 42]) {
      const read = companyOf({ ...base, companyId: A, companyRole: "member", companyName: name } as CodeAccess)!;
      expect(read).toEqual({ companyId: A, companyRole: "member" });
      expect(companyNameOf(read)).toBe(COMPANY_NAME_FALLBACK);
    }
    expect(companyNameOf(companyOf({ ...base, companyId: A, companyRole: "member", companyName: "x".repeat(200) })!)).toBe("x".repeat(200));
  });

  it("a company admin is owner or admin only", () => {
    expect([isCompanyAdmin("owner"), isCompanyAdmin("admin"), isCompanyAdmin("member"), isCompanyAdmin(undefined)]).toEqual([true, true, false, false]);
  });
});

const session = (sessionId: string, companyId?: string): WorkSession => ({
  sessionId, taskId: "6f9d0c1e-2b3a-4c5d-8e7f-001122334455", project: "web", startedBy: { developerId: "a".repeat(64), name: "Ada" }, owner: { developerId: "a".repeat(64), name: "Ada" },
  createdAt: "2026-11-16T00:00:00.000Z", revision: 1, ...(companyId === undefined ? {} : { companyId }),
});

describe("companyScopedWork: one company's view of Cloud's sessions", () => {
  it("stamps a new session with the company, and reads it only within that company", async () => {
    const store = new LocalWorkSessionStore();
    let company: string | undefined = A;
    const view = companyScopedWork(store, () => company);
    await view.put(session("ses_a0000000000000000000"), "req-a");
    expect((await store.get("ses_a0000000000000000000"))?.companyId).toBe(A);
    expect((await view.get("ses_a0000000000000000000"))?.sessionId).toBe("ses_a0000000000000000000");
    expect((await view.byRequest("req-a"))?.sessionId).toBe("ses_a0000000000000000000");
    expect((await view.startedBy("a".repeat(64))).map((each) => each.sessionId)).toEqual(["ses_a0000000000000000000"]);
    for (const other of [B, undefined]) {
      company = other;
      expect(await view.get("ses_a0000000000000000000")).toBeUndefined();
      expect(await view.byRequest("req-a")).toBeUndefined();
      expect(await view.startedBy("a".repeat(64))).toEqual([]);
    }
  });

  it("never writes another company's session, and never restamps one", async () => {
    const store = new LocalWorkSessionStore();
    await store.put(session("ses_b0000000000000000000", B));
    const read = (await store.get("ses_b0000000000000000000"))!;
    await expect(companyScopedWork(store, () => A).put({ ...read, revision: 2 })).rejects.toBeInstanceOf(StoreConflict);
    expect((await store.get("ses_b0000000000000000000"))!.revision).toBe(1);
    // A change made within the company keeps its company.
    await companyScopedWork(store, () => B).put({ ...read, revision: 2 });
    expect(await store.get("ses_b0000000000000000000")).toMatchObject({ companyId: B, revision: 2 });
  });

  it("keeps showing a session written before sessions carried a company, and leaves it unstamped", async () => {
    const store = new LocalWorkSessionStore();
    await store.put(session("ses_c0000000000000000000"));
    const view = companyScopedWork(store, () => B);
    const read = (await view.get("ses_c0000000000000000000"))!;
    expect(read.sessionId).toBe("ses_c0000000000000000000");
    await view.put({ ...read, revision: 2 });
    expect((await store.get("ses_c0000000000000000000"))!.companyId).toBeUndefined();
    // With no company, a new session is never written (it could not be kept to one company).
    await expect(companyScopedWork(store, () => undefined).put(session("ses_d0000000000000000000"))).rejects.toBeInstanceOf(SessionCompanyMissing);
    expect(await store.get("ses_d0000000000000000000")).toBeUndefined();
  });
});

const NO_BEDROCK_CALL: BedrockBackend = {
  setup: async () => { throw new Error("not reached"); },
  command: () => { throw new Error("not reached"); },
  presets: () => { throw new Error("not reached"); },
};

describe("the company's AI settings: company admin by company role, company by Code's answer", () => {
  const routes = [["agent AI", "/org/agent-ai"], ["learning AI", "/org/learning-ai"], ["own Bedrock", "/org/bedrock"]] as const;

  it("refuses Code's install administrator who is a plain member of the company", async () => {
    const w = world({ company: true, bedrock: NO_BEDROCK_CALL });
    const ian = await w.signIn("ian", 10);
    for (const [what, path] of routes) expect({ what, status: (await w.call(ian, "GET", path)).status }).toEqual({ what, status: 403 });
    // A project the install administrator can't see as a company admin is not found; it isn't theirs to administer.
    expect((await w.call(ian, "GET", "/projects/web/product-ai")).status).toBe(404);
  });

  it("lets the company's owner in, though not Code's install administrator", async () => {
    const w = world({ company: true, bedrock: NO_BEDROCK_CALL });
    const oz = await w.signIn("oz", 10);
    for (const [what, path] of routes.slice(0, 2)) expect({ what, status: (await w.call(oz, "GET", path)).status }).toEqual({ what, status: 200 });
    expect((await w.call(oz, "GET", "/projects/web/product-ai")).status).toBe(200);
  });

  it("refuses a project member change for a person Code names no company for, rather than make it without withdrawing their approvals", async () => {
    const w = world({ company: true });
    const nob = await w.signIn("nob", 10);
    expect((await w.call(nob, "PUT", `/projects/web/members/${"c".repeat(64)}`, {})).body).toEqual(NOT_IN_COMPANY.body);
    expect((await w.call(nob, "DELETE", `/projects/web/members/${"c".repeat(64)}`)).body).toEqual(NOT_IN_COMPANY.body);
    expect(w.codeCalls).toEqual([]);
  });

  it("refuses a person Code names no company for, with the fixed words, on every one of them", async () => {
    const w = world({ company: true, bedrock: NO_BEDROCK_CALL });
    const nob = await w.signIn("nob", 10);
    for (const [what, path] of [...routes, ["product AI", "/projects/web/product-ai"]] as const) {
      const answer = await w.call(nob, "GET", path);
      expect({ what, status: answer.status, body: answer.body }).toEqual({ what, status: 403, body: NOT_IN_COMPANY.body });
    }
  });
});
