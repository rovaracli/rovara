// UX-4b: the writer of a project's learning mode (`learning-mode-write.ts`), through the record route: who may set it, the company lock, the condition on what was read, the request item that makes
// a repeat answer the same (and a late repeat change nothing), the audit item, and the readers (`mode.ts`) seeing the new value.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { learningModeKey, type OrgId } from "@rovara-code/contracts";
import { handleRecordRoute } from "../../../packages/broker/src/team-record/routes.js";
import type { SourceWriteContext } from "../../../packages/broker/src/team-record/source-write.js";
import { capturingAuditDeps } from "../../support/audit-capture.js";
import { ORG_A, ORG_B, caller, setLock, setMode, world, type World } from "../../support/team-record-core.js";

const MAINT = "c".repeat(64), CONTRIB = "d".repeat(64), ADMIN = "b".repeat(64);
type Who = { id: string; orgRole: "owner" | "admin" | "member" | "auditor"; projectRole: "maintainer" | "contributor" | "viewer" | undefined };
const WHO = {
  maint: { id: MAINT, orgRole: "member", projectRole: "maintainer" },
  admin: { id: ADMIN, orgRole: "admin", projectRole: "maintainer" },
  contrib: { id: CONTRIB, orgRole: "member", projectRole: "contributor" },
  auditor: { id: "f".repeat(64), orgRole: "auditor", projectRole: "viewer" },
  stranger: { id: "9".repeat(64), orgRole: "member", projectRole: undefined },
} as const satisfies Record<string, Who>;

function harness() {
  const w = world();
  const audit = capturingAuditDeps({ db: w.db, now: () => w.clock.ms });
  return { w, audit };
}
type H = ReturnType<typeof harness>;
const deps = (w: World) => ({ table: w.table, modes: w.deps.modes, now: () => w.clock.ms });
const PATH = "/v1/app/projects/web/record/learning-mode";
const ctx = (h: H, who: Who, body: unknown, over: Partial<SourceWriteContext> = {}): SourceWriteContext => ({ orgRole: who.orgRole, browserSession: true, body: () => body, audit: h.audit.deps, ...over });

async function get(h: H, who: Who, org: OrgId = ORG_A) {
  return await handleRecordRoute(deps(h.w), { method: "GET", path: PATH, query: {}, caller: caller({ orgId: org, developerId: who.id, projectRole: who.projectRole }), write: ctx(h, who, undefined) }) as { status: number; body: Record<string, unknown> };
}
async function post(h: H, who: Who, body: unknown, over: Partial<SourceWriteContext> = {}, org: OrgId = ORG_A) {
  return await handleRecordRoute(deps(h.w), { method: "POST", path: PATH, query: {}, caller: caller({ orgId: org, developerId: who.id, projectRole: who.projectRole }), write: ctx(h, who, body, over) }) as { status: number; body: Record<string, unknown> };
}
const set = (mode: string, expectedMode: string, requestId = randomUUID()) => ({ requestId, mode, expectedMode });
const stored = (h: H, org: OrgId = ORG_A) => h.w.db.get(learningModeKey(org, "web"));

describe("reading the learning mode", () => {
  it("answers the default with no stored value, and whether the reader may change it", async () => {
    const h = harness();
    expect(await get(h, WHO.maint)).toEqual({ status: 200, body: { mode: "suggest", effective: "suggest", canChange: true } });
    expect(await get(h, WHO.contrib)).toEqual({ status: 200, body: { mode: "suggest", effective: "suggest", canChange: false } });
    expect((await get(h, WHO.stranger)).body.code).toBe("PROJECT_NOT_FOUND");
  });

  it("shows the company lock and what runs (the stricter of the two)", async () => {
    const h = harness();
    setLock(h.w, ORG_A, "collect");
    expect((await get(h, WHO.maint)).body).toEqual({ mode: "suggest", lock: "collect", effective: "collect", canChange: true });
  });
});

describe("setting the learning mode", () => {
  it("turns learning off and on again, each change audited, and the mode reader sees it", async () => {
    const h = harness();
    expect(await post(h, WHO.maint, set("off", "suggest"))).toEqual({ status: 200, body: { mode: "off", effective: "off", canChange: true } });
    expect(stored(h)).toMatchObject({ mode: "off", updatedBy: MAINT });
    expect(await h.w.deps.modes.effectiveMode(ORG_A, "web")).toBe("off");
    expect((await post(h, WHO.maint, set("on", "off"))).body).toMatchObject({ mode: "on" });
    expect(await h.w.deps.modes.effectiveMode(ORG_A, "web")).toBe("on");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = h.audit.recorded().filter((event) => event.action === "lesson.mode_changed");
    expect(events.map((event) => event.facts)).toEqual([{ fromMode: "suggest", toMode: "off", locked: false }, { fromMode: "off", toMode: "on", locked: false }]);
    expect(events[0]!.actor).toEqual({ kind: "member", id: MAINT });
  });

  it("refuses a value looser than the company lock, and stores nothing", async () => {
    const h = harness();
    setLock(h.w, ORG_A, "collect");
    expect((await post(h, WHO.maint, set("on", "suggest"))).body.code).toBe("LEARNING_LOCKED");
    expect(stored(h)).toBeUndefined();
    // Stricter than the lock is fine.
    expect((await post(h, WHO.maint, set("off", "suggest"))).body).toEqual({ mode: "off", lock: "collect", effective: "off", canChange: true });
  });

  it("loses cleanly to another writer: a stale expected value changes nothing", async () => {
    const h = harness();
    setMode(h.w, ORG_A, "web", "collect");
    expect((await post(h, WHO.maint, set("on", "suggest"))).body.code).toBe("CHANGE_STALE");
    expect(stored(h)).toMatchObject({ mode: "collect" });
  });

  it("answers a repeat the same, refuses the same id with a different body, and a late repeat after the opposite change changes nothing", async () => {
    const h = harness();
    const first = set("off", "suggest");
    const answer = await post(h, WHO.maint, first);
    expect(await post(h, WHO.maint, first)).toEqual(answer);
    expect((await post(h, WHO.maint, { ...first, mode: "collect" })).body.code).toBe("CONFIG_INVALID");
    expect((await post(h, WHO.maint, set("suggest", "off"))).status).toBe(200);
    expect(await post(h, WHO.maint, first)).toEqual(answer);
    expect(stored(h)).toMatchObject({ mode: "suggest" });
  });

  it("is for the project's maintainers and company admins, on a live browser session", async () => {
    const h = harness();
    expect((await post(h, WHO.contrib, set("off", "suggest"))).body.code).toBe("FORBIDDEN");
    expect((await post(h, WHO.auditor, set("off", "suggest"))).body.code).toBe("FORBIDDEN");
    expect((await post(h, WHO.stranger, set("off", "suggest"))).body.code).toBe("PROJECT_NOT_FOUND");
    expect((await post(h, WHO.maint, set("off", "suggest"), { browserSession: false })).body.code).toBe("FORBIDDEN");
    expect((await post(h, WHO.admin, set("off", "suggest"))).status).toBe(200);
    expect(stored(h)).toMatchObject({ mode: "off", updatedBy: ADMIN });
  });

  it("keys on the caller's own company: another company's project of the same name is untouched", async () => {
    const h = harness();
    expect((await post(h, WHO.maint, set("off", "suggest"), {}, ORG_B)).status).toBe(200);
    expect(stored(h)).toBeUndefined();
    expect(stored(h, ORG_B)).toMatchObject({ mode: "off" });
  });

  it("refuses a body it does not know, without echoing it", async () => {
    const h = harness();
    const reply = await post(h, WHO.maint, { requestId: randomUUID(), mode: "loud", expectedMode: "suggest" });
    expect(reply).toEqual({ status: 400, body: { code: "CONFIG_INVALID", message: "The request is not valid." } });
  });

  it("refuses to loosen learning when the audit ledger is missing, but may make it stricter", async () => {
    const h = harness();
    setMode(h.w, ORG_A, "web", "off");
    const noAudit = { audit: undefined } as unknown as Partial<SourceWriteContext>;
    expect((await post(h, WHO.maint, set("on", "off"), noAudit)).body.code).toBe("AUDIT_UNAVAILABLE");
    expect(stored(h)).toMatchObject({ mode: "off" });
  });

  it("review fix 6: a stored value that does not read (it reads as Off) can be reset from the page, conditional on that exact value", async () => {
    const h = harness();
    setMode(h.w, ORG_A, "web", "loud");
    expect((await get(h, WHO.maint)).body).toMatchObject({ mode: "off", effective: "off" });
    expect((await post(h, WHO.maint, set("suggest", "off"))).body).toMatchObject({ mode: "suggest" });
    expect(stored(h)).toMatchObject({ mode: "suggest" });
  });
});
