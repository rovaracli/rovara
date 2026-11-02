// Setup and test health KF-1: `/v1/app/projects/{name}/known-failing` through the whole broker. A project maintainer reads the marks and removes one (Undo) from a live browser session; a token, a member without the maintainer
// role and a project the caller cannot see are refused; the route and the project page's `knownFailing` count exist only while vx is on; every removal is audited.
import { afterEach, describe, expect, it } from "vitest";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { NAME, errorOf, setupWizardBench, type Bench } from "../support/setup-wizard-testenv.js";
import { knownFailingKey, readKnownFailingRow, type KnownFailingMark } from "../../packages/broker/src/test-env/known-failing.js";

afterEach(() => { delete process.env.VERIFY_RESULTS_ENABLED; });
const PATH = `/v1/app/projects/${NAME}/known-failing`;
const on = () => { process.env.VERIFY_RESULTS_ENABLED = "1"; };
const AT = "2026-11-01T10:00:00.000Z";
const mark = (name: string, over: Partial<KnownFailingMark> = {}): KnownFailingMark => ({ name, checkId: "unit", markedBy: MAYA.developerId, markedAt: AT, epoch: 2, ...over });
async function bench(marks: KnownFailingMark[] = [mark("tests/a.py::one"), mark("tests/b.py::two", { checkId: "lint", markedBy: OMAR.developerId, epoch: 3 })], options: { maya?: "admin" | "member" } = {}) {
  const audit = capturingAuditDeps();
  const t = await setupWizardBench({ audit });
  if (options.maya !== undefined) await t.person(MAYA, options.maya);
  t.db.set({ ...knownFailingKey(TEST_ORG, NAME), entityType: "TEST_ENV_KNOWN_FAILING", orgId: TEST_ORG, project: NAME, marks, version: 4, updatedAt: AT });
  return { t, audit };
}
const refOf = (m: KnownFailingMark) => ({ name: m.name, checkId: m.checkId, markedBy: m.markedBy, markedAt: m.markedAt, epoch: m.epoch });
const body = (m: KnownFailingMark, over: Record<string, unknown> = {}) => ({ action: "undo", requestId: "request-0001", ...refOf(m), ...over });
const names = async (t: Bench) => (await readKnownFailingRow({ documentClient: t.db, tableName: "state" }, TEST_ORG, NAME))!.marks.map((m) => m.name);

describe("behind vx", () => {
  it("is not found while vx is off, for any value but exactly 1, and nothing is removed", async () => {
    const { t } = await bench();
    for (const value of [undefined, "0", "true", " 1"]) {
      if (value === undefined) delete process.env.VERIFY_RESULTS_ENABLED; else process.env.VERIFY_RESULTS_ENABLED = value;
      expect((await t.web(OMAR, "GET", PATH)).status, String(value)).toBe(404);
      expect((await t.web(OMAR, "POST", PATH, body(mark("tests/a.py::one")))).status, String(value)).toBe(404);
    }
    expect(await names(t)).toEqual(["tests/a.py::one", "tests/b.py::two"]);
  });

  it("the project page tells a maintainer how many marks there are only while vx is on", async () => {
    const { t } = await bench();
    const overview = `/v1/app/projects/${NAME}/overview`;
    const off = await t.web(OMAR, "GET", overview);
    expect(off.status).toBe(200);
    expect(off.body).not.toHaveProperty("knownFailing");
    on();
    expect((await t.web(OMAR, "GET", overview)).body).toMatchObject({ knownFailing: { count: 2 } });
    // Only a maintainer is told: a contributor sees the page without the count.
    await t.person(MAYA, "member", "contributor");
    const contributor = await t.web(MAYA, "GET", overview);
    expect(contributor.status).toBe(200);
    expect(contributor.body).not.toHaveProperty("knownFailing");
  });
});

describe("reading", () => {
  it("lists every mark with who and when, and whether the reader made it", async () => {
    const { t } = await bench();
    on();
    const reply = await t.web(OMAR, "GET", PATH);
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ max: 500, marks: [
      { name: "tests/a.py::one", checkId: "unit", markedBy: MAYA.developerId, markedAt: AT, epoch: 2, markedByYou: false },
      { name: "tests/b.py::two", checkId: "lint", markedBy: OMAR.developerId, epoch: 3, markedByYou: true },
    ] });
  });

  it("a company member with no role in the project learns nothing about it", async () => {
    const { t } = await bench(undefined, { maya: "member" });
    on();
    const member = await t.web(MAYA, "GET", PATH);
    expect([403, 404]).toContain(member.status);
    expect(JSON.stringify(member.body)).not.toContain("tests/a.py");
  });
});

describe("Undo", () => {
  it("removes the named mark from a browser session, answers the list afterwards and audits it as the maintainer", async () => {
    const { t, audit } = await bench();
    on();
    const reply = await t.web(OMAR, "POST", PATH, body(mark("tests/a.py::one")));
    expect(reply).toMatchObject({ status: 200, body: { status: "done", max: 500, marks: [{ name: "tests/b.py::two" }] } });
    expect(await names(t)).toEqual(["tests/b.py::two"]);
    const events = audit.recordedBy("project.known_failing_removed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { kind: "member", id: OMAR.developerId }, facts: { removal: "undo", testCount: 1, markEpoch: 2, rowVersionAfter: 5, totalAfter: 1 } });
    expect(JSON.stringify(events[0])).not.toContain("tests/a.py");
  });

  it("is refused from a token (the CLI, Slack), and writes nothing", async () => {
    const { t, audit } = await bench();
    on();
    const token = await t.dev(OMAR, "POST", PATH, body(mark("tests/a.py::one")));
    expect(token.status).toBe(403);
    expect(JSON.stringify(token.body)).toContain("Use a live browser session");
    expect(await names(t)).toEqual(["tests/a.py::one", "tests/b.py::two"]);
    expect(audit.recordedBy("project.known_failing_removed")).toEqual([]);
  });

  it("a mark changed or already removed answers CHANGE_STALE and removes nothing", async () => {
    const { t, audit } = await bench();
    on();
    for (const over of [{ epoch: 9 }, { markedBy: OMAR.developerId }, { checkId: "lint" }, { name: "tests/zzz.py::none" }, { markedAt: "2026-11-01T11:00:00.000Z" }]) {
      const reply = await t.web(OMAR, "POST", PATH, body(mark("tests/a.py::one"), over));
      expect(reply.status, JSON.stringify(over)).toBe(409);
      expect(errorOf(reply).code).toBe("CHANGE_STALE");
    }
    expect((await t.web(OMAR, "POST", PATH, body(mark("tests/a.py::one")))).status).toBe(200);
    expect((await t.web(OMAR, "POST", PATH, body(mark("tests/a.py::one"), { requestId: "request-0002" }))).status).toBe(409);
    expect(audit.recordedBy("project.known_failing_removed")).toHaveLength(1);
  });

  it("refuses a body with a missing or extra field, naming only the field", async () => {
    const { t } = await bench();
    on();
    for (const bad of [{ ...body(mark("tests/a.py::one")), extra: 1 }, { ...body(mark("tests/a.py::one")), epoch: 0 }, { action: "remove", ...refOf(mark("tests/a.py::one")), requestId: "request-0001" }, { ...body(mark("tests/a.py::one")), requestId: "x" }]) {
      const reply = await t.web(OMAR, "POST", PATH, bad);
      expect(reply.status, JSON.stringify(bad)).toBe(400);
      expect(JSON.stringify(reply.body)).not.toContain("tests/a.py");
    }
    expect(await names(t)).toEqual(["tests/a.py::one", "tests/b.py::two"]);
  });

  it("a project maintainer who is not a company admin may undo; a viewer or contributor, and a member with no role in the project, may not", async () => {
    const { t, audit } = await bench();
    await t.person(MAYA, "member", "maintainer");
    on();
    expect((await t.web(MAYA, "GET", PATH)).status).toBe(200);
    for (const grant of ["viewer", "contributor"] as const) {
      await t.person(MAYA, "member", grant);
      const denied = await t.web(MAYA, "POST", PATH, body(mark("tests/a.py::one"), { requestId: "request-0003" }));
      expect(denied.status, grant).toBe(403);
      expect((await t.web(MAYA, "GET", PATH)).status, grant).toBe(403);
    }
    expect(await names(t)).toEqual(["tests/a.py::one", "tests/b.py::two"]);
    await t.person(MAYA, "member", "maintainer");
    expect((await t.web(MAYA, "POST", PATH, body(mark("tests/a.py::one")))).status).toBe(200);
    expect(audit.recordedBy("project.known_failing_removed")[0]).toMatchObject({ actor: { id: MAYA.developerId } });
  });
});
