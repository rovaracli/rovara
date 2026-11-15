// The company audit list (plan v3.2 7.5): Cloud's own records and Code's engine records read as one list, newest first across both, paged with a stable cursor,
// filtered by time, person, action and project, for one company only. The merge is tested on stand-ins for Code that behave as Code's audit read does: rows
// in key order (not time order), newest first only within a page, a bounded scan per call, and `next` while there may be more.
import { describe, expect, it } from "vitest";
import {
  COMPANY_AUDIT, CompanyAuditQueryRefused, LocalCloudAuditStore, listCompanyAudit, parseCompanyAuditQuery, recordCloudAction,
  type CloudAuditRecord, type CloudAuditStore, type CompanyAuditEntry, type EngineAuditPageQuery, type EngineAuditSource, type EngineRecord, type EnginePageResult,
} from "../../packages/cloud-server/src/index.js";
import type { CompanyAuditPage } from "../../packages/contracts/src/code-contract-v0.js";

const ACME = "org_aaaaaaaaaaaaaaaaaaaa";
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb";
const ADA = "a".repeat(64);
const GRACE = "f".repeat(64);
const BASE = Date.UTC(2026, 10, 14, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = () => new Date(BASE + 10 * 86_400_000);

let counter = 0;
const cloudRow = (companyId: string, atMs: number, over: Partial<CloudAuditRecord> = {}): CloudAuditRecord => ({
  id: `aud_${String(counter++).padStart(20, "0")}`, companyId, at: iso(atMs), actor: { developerId: ADA, name: "Ada", type: "person" },
  action: "company.rules.changed", subject: "", outcome: "ok", ...over,
});
const engineRow = (atMs: number, over: Partial<EngineRecord> = {}): EngineRecord => ({
  eventId: `ev_${String(counter++).padStart(8, "0")}`, at: iso(atMs), actor: { developerId: ADA, name: "Ada", type: "person" }, action: "task.approved", subject: "task:t1", outcome: "ok", via: "web", ...over,
});
const matchesAction = (action: string, wanted: string | undefined) => wanted === undefined || (wanted.endsWith(".*") ? action.startsWith(wanted.slice(0, -1)) : action === wanted);

/** Code's audit read, as the PR describes it: key order, `scan` rows read per call, newest first within the page only, `next` while rows remain. */
class FakeEngine implements EngineAuditSource {
  readonly calls: EngineAuditPageQuery[] = [];
  constructor(readonly rows: EngineRecord[], private readonly scan = 3) {}
  async page(query: EngineAuditPageQuery): Promise<EnginePageResult> {
    this.calls.push(query);
    // Engine lines carry no project: Code answers a project filter from the rows' details, and these have none.
    if (query.project !== undefined) return { kind: "page", records: [] };
    const ordered = [...this.rows].sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const read = ordered.slice(start, start + this.scan).filter((row) => {
      const at = Date.parse(row.at);
      return (query.from === undefined || at >= Date.parse(query.from)) && (query.to === undefined || at <= Date.parse(query.to))
        && (query.person === undefined || row.actor.developerId === query.person) && matchesAction(row.action, query.action);
    }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return { kind: "page", records: read.slice(0, query.limit), ...(start + this.scan < ordered.length ? { next: String(start + this.scan) } : {}) };
  }
}
const engineWith = (result: EnginePageResult | ((query: EngineAuditPageQuery) => EnginePageResult)): EngineAuditSource & { calls: EngineAuditPageQuery[] } => {
  const calls: EngineAuditPageQuery[] = [];
  return { calls, page: async (query) => { calls.push(query); return typeof result === "function" ? result(query) : result; } };
};

const q = (params: Record<string, string> = {}) => parseCompanyAuditQuery(new URLSearchParams(params));
const idOf = (entry: CompanyAuditEntry) => entry.id;
const expectedOrder = (cloud: CloudAuditRecord[], engine: EngineRecord[]) =>
  [...cloud.map((row) => ({ id: `cloud:${row.id}`, atMs: Date.parse(row.at) })), ...engine.map((row) => ({ id: `engine:${row.eventId}`, atMs: Date.parse(row.at) }))]
    .sort((a, b) => (a.atMs === b.atMs ? (a.id < b.id ? 1 : -1) : b.atMs - a.atMs)).map((entry) => entry.id);

async function seeded(cloud: CloudAuditRecord[]): Promise<LocalCloudAuditStore> {
  const store = new LocalCloudAuditStore();
  for (const row of cloud) await store.append(row);
  return store;
}
async function allPages(deps: { store: CloudAuditStore; engine: EngineAuditSource }, company: string, params: Record<string, string> = {}, maxPages = 60): Promise<CompanyAuditPage[]> {
  const pages: CompanyAuditPage[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < maxPages; n += 1) {
    const page = await listCompanyAudit({ ...deps, now: NOW }, company, q({ ...params, ...(cursor === undefined ? {} : { cursor }) }));
    pages.push(page);
    if (page.next === undefined) return pages;
    cursor = page.next;
  }
  throw new Error("the list did not end");
}

describe("the merged order", () => {
  it("lists Cloud and engine records together, newest first, ties by id with engine lines before Cloud's", async () => {
    const cloud = [cloudRow(ACME, BASE + 1000), cloudRow(ACME, BASE + 3000), cloudRow(ACME, BASE + 5000)];
    const engine = [engineRow(BASE + 2000), engineRow(BASE + 3000), engineRow(BASE + 6000)];
    const page = await listCompanyAudit({ store: await seeded(cloud), engine: new FakeEngine(engine, 2), now: NOW }, ACME, q());
    expect(page.records.map(idOf)).toEqual(expectedOrder(cloud, engine));
    expect(page.records.map((entry) => entry.source)).toEqual(["engine", "cloud", "engine", "cloud", "engine", "cloud"]);
    expect(page.next).toBeUndefined();
    expect(page.engine).toEqual({ state: "connected" });
  });

  it("orders engine lines by time although Code answers each page newest first only within the page", async () => {
    const times = [9, 1, 8, 2, 7, 3, 6, 4, 5].map((n) => BASE + n * 1000);
    const engine = times.map((at) => engineRow(at));
    // Key order is creation order: the times above are in no order.
    const page = await listCompanyAudit({ store: await seeded([]), engine: new FakeEngine(engine, 2), now: NOW }, ACME, q());
    expect(page.records.map((entry) => Date.parse(entry.at))).toEqual([...times].sort((a, b) => b - a));
  });

  it("shows each line as the list's shape: Cloud's with its project and detail, the engine's with its event id, kind and caller", async () => {
    const cloud = cloudRow(ACME, BASE, { via: "policy-hook", project: "payments", detail: "over_estimate_limit", action: "hook.start.answered", outcome: "refused", subject: "task:t9", actor: { developerId: "policy-hook", name: "Policy hook", type: "system" } });
    const engine = engineRow(BASE + 1, { eventId: "ev_x", actor: { developerId: GRACE, name: "Grace", type: "agent" }, via: "slack", outcome: "refused", action: "task.rejected" });
    const page = await listCompanyAudit({ store: await seeded([cloud]), engine: new FakeEngine([engine]), now: NOW }, ACME, q());
    expect(page.records).toEqual([
      { id: "engine:ev_x", source: "engine", at: iso(BASE + 1), actor: { developerId: GRACE, name: "Grace", type: "agent" }, via: "slack", action: "task.rejected", subject: "task:t1", outcome: "refused" },
      { id: `cloud:${cloud.id}`, source: "cloud", at: iso(BASE), actor: { developerId: "policy-hook", name: "Policy hook", type: "system" }, via: "policy-hook", action: "hook.start.answered", subject: "task:t9", project: "payments", outcome: "refused", detail: "over_estimate_limit" },
    ] satisfies CompanyAuditEntry[]);
  });
});

describe("paging across both sources", () => {
  const cloud = Array.from({ length: 9 }, (_, n) => cloudRow(ACME, BASE + (n * 2 + 1) * 1000));
  const engine = Array.from({ length: 10 }, (_, n) => engineRow(BASE + (n * 2 + (n % 3 === 0 ? 1 : 0)) * 1000));

  it.each([1, 3, 4, 7, 19, 50])("returns every record once, in order, with a limit of %i", async (limit) => {
    const pages = await allPages({ store: await seeded(cloud), engine: new FakeEngine(engine, 4) }, ACME, { limit: String(limit) });
    const ids = pages.flatMap((page) => page.records.map(idOf));
    expect(ids).toEqual(expectedOrder(cloud, engine));
    expect(new Set(ids).size).toBe(ids.length);
    for (const page of pages.slice(0, -1)) expect(page.records.length).toBeLessThanOrEqual(limit);
    expect(pages.at(-1)!.next).toBeUndefined();
  });

  it("ends without a cursor when the last page holds exactly the rest, and does not give an empty page after a full one", async () => {
    const pages = await allPages({ store: await seeded(cloud), engine: new FakeEngine(engine) }, ACME, { limit: String(cloud.length + engine.length) });
    expect(pages).toHaveLength(1);
    expect(pages[0]!.next).toBeUndefined();
  });

  it("keeps a page's cursor good when newer records arrive meanwhile: the next page is where the first one ended", async () => {
    const store = await seeded(cloud);
    const engineSource = new FakeEngine(engine);
    const expected = expectedOrder(cloud, engine);
    const first = await listCompanyAudit({ store, engine: engineSource, now: NOW }, ACME, q({ limit: "5" }));
    await store.append(cloudRow(ACME, BASE + 500_000));
    engineSource.rows.push(engineRow(BASE + 600_000));
    const second = await listCompanyAudit({ store, engine: engineSource, now: NOW }, ACME, q({ limit: "5", cursor: first.next! }));
    expect(first.records.map(idOf)).toEqual(expected.slice(0, 5));
    expect(second.records.map(idOf)).toEqual(expected.slice(5, 10));
  });

  it("goes on among records of one instant in both sources without skipping or repeating one", async () => {
    const sameCloud = [cloudRow(ACME, BASE), cloudRow(ACME, BASE), cloudRow(ACME, BASE)];
    const sameEngine = [engineRow(BASE), engineRow(BASE), engineRow(BASE)];
    const pages = await allPages({ store: await seeded(sameCloud), engine: new FakeEngine(sameEngine, 2) }, ACME, { limit: "1" });
    expect(pages.flatMap((page) => page.records.map(idOf))).toEqual(expectedOrder(sameCloud, sameEngine));
  });

  it("asks the engine only for what is older than the cursor", async () => {
    const engineSource = new FakeEngine(engine);
    const first = await listCompanyAudit({ store: await seeded(cloud), engine: engineSource, now: NOW }, ACME, q({ limit: "5" }));
    engineSource.calls.length = 0;
    await listCompanyAudit({ store: await seeded(cloud), engine: engineSource, now: NOW }, ACME, q({ limit: "5", cursor: first.next! }));
    const cursorAt = Date.parse(first.records.at(-1)!.at);
    expect(engineSource.calls.length).toBeGreaterThan(0);
    for (const call of engineSource.calls) expect(Date.parse(call.to!)).toBe(cursorAt);
  });

  it("answers an empty list with no records and no cursor", async () => {
    const page = await listCompanyAudit({ store: await seeded([]), engine: new FakeEngine([]), now: NOW }, ACME, q());
    expect(page).toEqual({ records: [], engine: { state: "connected" } });
  });
});

describe("filters", () => {
  const cloud = [
    cloudRow(ACME, BASE + 1000, { action: "company.rules.changed", actor: { developerId: ADA, name: "Ada", type: "person" } }),
    cloudRow(ACME, BASE + 2000, { action: "company.budget.changed", actor: { developerId: GRACE, name: "Grace", type: "person" }, project: "payments" }),
    cloudRow(ACME, BASE + 3000, { action: "hook.start.answered", project: "payments", actor: { developerId: GRACE, name: "Grace", type: "person" } }),
    cloudRow(ACME, BASE + 4000, { action: "hook.decide.answered", project: "web", actor: { developerId: ADA, name: "Ada", type: "person" } }),
  ];
  const engine = [
    engineRow(BASE + 1500, { action: "task.approved", actor: { developerId: ADA, name: "Ada", type: "person" } }),
    engineRow(BASE + 2500, { action: "task.rejected", actor: { developerId: GRACE, name: "Grace", type: "person" } }),
    engineRow(BASE + 3500, { action: "member.removed", actor: { developerId: ADA, name: "Ada", type: "person" } }),
  ];
  const run = async (params: Record<string, string>) => {
    const engineSource = new FakeEngine(engine, 2);
    const page = await listCompanyAudit({ store: await seeded(cloud), engine: engineSource, now: NOW }, ACME, q(params));
    return { ids: page.records.map(idOf), engineSource, page };
  };
  const cloudId = (n: number) => `cloud:${cloud[n]!.id}`;
  const engineId = (n: number) => `engine:${engine[n]!.eventId}`;

  it("by time, both ends inclusive, and passes the range on to the engine", async () => {
    const { ids, engineSource } = await run({ from: iso(BASE + 2000), to: iso(BASE + 3500) });
    expect(ids).toEqual([engineId(2), cloudId(2), engineId(1), cloudId(1)]);
    for (const call of engineSource.calls) expect([call.from, call.to]).toEqual([iso(BASE + 2000), iso(BASE + 3500)]);
  });

  it("by person, in both sources", async () => {
    const { ids, engineSource } = await run({ person: GRACE });
    expect(ids).toEqual([cloudId(2), engineId(1), cloudId(1)]);
    for (const call of engineSource.calls) expect(call.person).toBe(GRACE);
    const byAction = await run({ action: "task.*" });
    for (const call of byAction.engineSource.calls) expect(call.action).toBe("task.*");
  });

  it("by action, exact or a family", async () => {
    expect((await run({ action: "task.approved" })).ids).toEqual([engineId(0)]);
    expect((await run({ action: "task.*" })).ids).toEqual([engineId(1), engineId(0)]);
    expect((await run({ action: "hook.*" })).ids).toEqual([cloudId(3), cloudId(2)]);
    expect((await run({ action: "company.rules.changed" })).ids).toEqual([cloudId(0)]);
    expect((await run({ action: "task" })).ids).toEqual([]);
    expect((await run({ action: "hook.start" })).ids).toEqual([]);
  });

  it("by project: Cloud's records of that project, and the engine is asked for the project too", async () => {
    const { ids, engineSource } = await run({ project: "payments" });
    expect(ids).toEqual([cloudId(2), cloudId(1)]);
    // The engine's lines do not carry the project; Code applies the filter, and a line it sends back is shown.
    for (const call of engineSource.calls) expect(call.project).toBe("payments");
  });

  it("shows the engine lines Code sends for a project (Code applied the filter)", async () => {
    const engineSource = engineWith({ kind: "page", records: [engineRow(BASE + 9000, { eventId: "ev_p" })] });
    const page = await listCompanyAudit({ store: await seeded(cloud), engine: engineSource, now: NOW }, ACME, q({ project: "payments" }));
    expect(page.records.map(idOf)[0]).toBe("engine:ev_p");
  });

  it("drops an engine line outside the time range, the person or the action asked for, whatever Code sends", async () => {
    const rogue = [
      engineRow(BASE + 100, { eventId: "ev_early" }), engineRow(BASE + 100_000, { eventId: "ev_late" }), engineRow(BASE + 5000, { eventId: "ev_other_person", actor: { developerId: GRACE, name: "G", type: "person" } }),
      engineRow(BASE + 5000, { eventId: "ev_other_action", action: "task.rejected" }), engineRow(BASE + 5000, { eventId: "ev_fits" }),
    ];
    const engineSource = engineWith({ kind: "page", records: rogue });
    const page = await listCompanyAudit({ store: await seeded([]), engine: engineSource, now: NOW }, ACME, q({ from: iso(BASE + 1000), to: iso(BASE + 10_000), person: ADA, action: "task.approved" }));
    expect(page.records.map(idOf)).toEqual(["engine:ev_fits"]);
  });
});

describe("one company only", () => {
  it("never reads another company's Cloud records", async () => {
    const mine = cloudRow(ACME, BASE), theirs = cloudRow(OTHER, BASE + 1000);
    const page = await listCompanyAudit({ store: await seeded([mine, theirs]), engine: new FakeEngine([]), now: NOW }, ACME, q());
    expect(page.records.map(idOf)).toEqual([`cloud:${mine.id}`]);
    expect((await listCompanyAudit({ store: await seeded([mine, theirs]), engine: new FakeEngine([]), now: NOW }, OTHER, q())).records.map(idOf)).toEqual([`cloud:${theirs.id}`]);
  });

  it("checks each row again against the company, so a store that answers another company's row does not show it", async () => {
    const mine = cloudRow(ACME, BASE), theirs = cloudRow(OTHER, BASE + 1000);
    const leaky: CloudAuditStore = { append: async () => "added", read: async () => ({ rows: [theirs, mine], more: false }) };
    const page = await listCompanyAudit({ store: leaky, engine: new FakeEngine([]), now: NOW }, ACME, q());
    expect(page.records.map(idOf)).toEqual([`cloud:${mine.id}`]);
  });

  it("refuses a company that is not a valid id before reading anything", async () => {
    let reads = 0;
    const counting: CloudAuditStore = { append: async () => "added", read: async () => { reads += 1; return { rows: [], more: false }; } };
    const engineSource = new FakeEngine([]);
    await expect(listCompanyAudit({ store: counting, engine: engineSource, now: NOW }, "org#1", q())).rejects.toThrow();
    expect(reads).toBe(0);
    expect(engineSource.calls).toHaveLength(0);
  });

  it("refuses a cursor made for another company, for other filters, or not made by this list", async () => {
    const cloud = [cloudRow(ACME, BASE + 1000), cloudRow(ACME, BASE + 2000), cloudRow(ACME, BASE + 3000)];
    const deps = { store: await seeded(cloud), engine: new FakeEngine([]), now: NOW };
    const first = await listCompanyAudit(deps, ACME, q({ limit: "1", person: ADA }));
    expect(first.next).toBeDefined();
    await expect(listCompanyAudit(deps, OTHER, q({ limit: "1", person: ADA, cursor: first.next! }))).rejects.toBeInstanceOf(CompanyAuditQueryRefused);
    await expect(listCompanyAudit(deps, ACME, q({ limit: "1", person: GRACE, cursor: first.next! }))).rejects.toBeInstanceOf(CompanyAuditQueryRefused);
    await expect(listCompanyAudit(deps, ACME, q({ limit: "1", cursor: first.next! }))).rejects.toBeInstanceOf(CompanyAuditQueryRefused);
    await expect(listCompanyAudit(deps, ACME, q({ limit: "1", person: ADA, from: iso(BASE), cursor: first.next! }))).rejects.toBeInstanceOf(CompanyAuditQueryRefused);
    for (const forged of ["garbage", "e30", Buffer.from(JSON.stringify({ v: 1, t: 1, k: "cloud:x", d: "x" })).toString("base64url"), Buffer.from(JSON.stringify({ v: 2, t: BASE, k: "cloud:x", d: "x" })).toString("base64url")]) {
      await expect(listCompanyAudit(deps, ACME, q({ cursor: forged })), forged).rejects.toBeInstanceOf(CompanyAuditQueryRefused);
    }
    // The same filters, in another order of writing, are the same filters.
    const again = await listCompanyAudit(deps, ACME, q({ person: ADA, limit: "1", cursor: first.next! }));
    expect(again.records).toHaveLength(1);
  });

  const tamper = (cursor: string, change: (body: Record<string, unknown>) => void) => {
    const body = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    change(body);
    return Buffer.from(JSON.stringify(body)).toString("base64url");
  };

  it("refuses a cursor whose own parts are wrong even when it carries the right company and filters", async () => {
    const cloud = [cloudRow(ACME, BASE + 1000), cloudRow(ACME, BASE + 2000)];
    const deps = { store: await seeded(cloud), engine: new FakeEngine([]), now: NOW };
    const first = await listCompanyAudit(deps, ACME, q({ limit: "1" }));
    const good = first.next!;
    const changes: Array<[string, (body: Record<string, unknown>) => void]> = [
      ["version", (body) => { body["v"] = 2; }], ["extra key", (body) => { body["x"] = 1; }], ["time too early", (body) => { body["t"] = 5; }], ["time not whole", (body) => { body["t"] = BASE + 0.5; }],
      ["time as text", (body) => { body["t"] = String(BASE); }], ["key without a source", (body) => { body["k"] = "bogus"; }], ["key of another source", (body) => { body["k"] = "other:x"; }],
      ["key too long", (body) => { body["k"] = `cloud:${"x".repeat(500)}`; }], ["key with a space", (body) => { body["k"] = "cloud:a b"; }], ["key not text", (body) => { body["k"] = 7; }],
    ];
    for (const [name, change] of changes) await expect(listCompanyAudit(deps, ACME, q({ limit: "1", cursor: tamper(good, change) })), name).rejects.toBeInstanceOf(CompanyAuditQueryRefused);
    await expect(listCompanyAudit(deps, ACME, q({ limit: "1", cursor: `${good}==` })), "padding").rejects.toBeInstanceOf(CompanyAuditQueryRefused);
    await expect(listCompanyAudit(deps, ACME, q({ limit: "1", cursor: good }))).resolves.toBeDefined();
  });

  it.each([
    ["person", { person: ADA }, { person: GRACE }],
    ["project", { project: "payments" }, { project: "web" }],
    ["action", { action: "company.*" }, { action: "company.rules.*" }],
    ["from", { from: iso(BASE) }, { from: iso(BASE + 1) }],
    ["to", { to: iso(BASE + 9000) }, { to: iso(BASE + 9001) }],
  ])("binds a cursor to the %s filter", async (_name, made, changed) => {
    const cloud = [1, 2, 3].map((n) => cloudRow(ACME, BASE + n * 1000, { project: "payments" }));
    const deps = { store: await seeded(cloud), engine: new FakeEngine([]), now: NOW };
    const first = await listCompanyAudit(deps, ACME, q({ ...made, limit: "1" }));
    expect(first.next).toBeDefined();
    await expect(listCompanyAudit(deps, ACME, q({ ...changed, limit: "1", cursor: first.next! }))).rejects.toBeInstanceOf(CompanyAuditQueryRefused);
    await expect(listCompanyAudit(deps, ACME, q({ ...made, limit: "1", cursor: first.next! }))).resolves.toBeDefined();
  });

  it("keeps the range's start when going on from a cursor", async () => {
    const cloud = [cloudRow(ACME, BASE + 1000), cloudRow(ACME, BASE + 2000), cloudRow(ACME, BASE + 3000)];
    const deps = { store: await seeded(cloud), engine: new FakeEngine([]), now: NOW };
    const first = await listCompanyAudit(deps, ACME, q({ limit: "1", from: iso(BASE + 2000) }));
    const second = await listCompanyAudit(deps, ACME, q({ limit: "5", from: iso(BASE + 2000), cursor: first.next! }));
    expect(second.records.map(idOf)).toEqual([`cloud:${cloud[1]!.id}`]);
  });
});

describe("the engine's status", () => {
  const cloud = [cloudRow(ACME, BASE + 1000)];
  const run = async (engine: EngineAuditSource) => listCompanyAudit({ store: await seeded(cloud), engine, now: NOW }, ACME, q());

  it("says the engine is not connected yet when Code does not serve the read, and still lists Cloud's records", async () => {
    const page = await run(engineWith({ kind: "not_served" }));
    expect(page.records.map(idOf)).toEqual([`cloud:${cloud[0]!.id}`]);
    expect(page.engine).toEqual({ state: "not_connected", message: "Engine records are not connected yet. This list shows Cloud's own records only." });
  });

  it("says the engine did not answer, and lists Cloud's records", async () => {
    const page = await run(engineWith({ kind: "unavailable" }));
    expect(page.records).toHaveLength(1);
    expect(page.engine).toEqual({ state: "unavailable", message: "Engine records could not be read just now. This list shows Cloud's own records only." });
  });

  it("drops the engine lines read so far when Code stops answering in the middle", async () => {
    let call = 0;
    const page = await run(engineWith(() => (call++ === 0 ? { kind: "page", records: [engineRow(BASE + 5000)], next: "1" } : { kind: "unavailable" })));
    expect(page.records.map((entry) => entry.source)).toEqual(["cloud"]);
    expect(page.engine.state).toBe("unavailable");
  });

  it("treats Code ceasing to serve the route mid-way as not answering, never as not connected", async () => {
    let call = 0;
    const page = await run(engineWith(() => (call++ === 0 ? { kind: "page", records: [], next: "1" } : { kind: "not_served" })));
    expect(page.engine.state).toBe("unavailable");
  });

  it("reads at most the budget of engine pages, shows what it read and says the engine's lines may be incomplete", async () => {
    const engineSource = engineWith((query) => ({ kind: "page", records: [engineRow(BASE + 9000 + Number(query.cursor ?? 0))], next: String(Number(query.cursor ?? 0) + 1) }));
    const page = await run(engineSource);
    expect(engineSource.calls).toHaveLength(COMPANY_AUDIT.ENGINE_CALLS_MAX);
    expect(page.records.filter((entry) => entry.source === "engine")).toHaveLength(COMPANY_AUDIT.ENGINE_CALLS_MAX);
    expect(page.engine.state).toBe("incomplete");
    expect(page.engine.message).toMatch(/not all/u);
  });

  it("shows a line Code sends twice (a page boundary, a retry) once", async () => {
    const same = engineRow(BASE + 1000, { eventId: "ev_same" });
    let call = 0;
    const page = await listCompanyAudit({ store: await seeded([]), engine: engineWith(() => (call++ === 0 ? { kind: "page", records: [same], next: "1" } : { kind: "page", records: [same] })), now: NOW }, ACME, q());
    expect(page.records.map(idOf)).toEqual(["engine:ev_same"]);
  });

  it("does not loop on a Code that answers the same cursor again", async () => {
    const engineSource = engineWith({ kind: "page", records: [engineRow(BASE + 7000)], next: "same" });
    const page = await run(engineSource);
    expect(engineSource.calls.length).toBeLessThanOrEqual(2);
    expect(page.engine.state).toBe("unavailable");
    expect(page.records.filter((entry) => entry.source === "engine")).toEqual([]);
  });

  it("asks Code for pages of up to 200 and follows its cursor until it ends, and says connected", async () => {
    const engineSource = new FakeEngine(Array.from({ length: 7 }, (_, n) => engineRow(BASE + n)), 3);
    const page = await listCompanyAudit({ store: await seeded([]), engine: engineSource, now: NOW }, ACME, q({ limit: "200" }));
    expect(engineSource.calls.map((call) => call.cursor)).toEqual([undefined, "3", "6"]);
    expect(engineSource.calls.every((call) => call.limit === 200)).toBe(true);
    expect(COMPANY_AUDIT.ENGINE_PAGE).toBe(200);
    expect(page.records).toHaveLength(7);
    expect(page.engine).toEqual({ state: "connected" });
  });
});

describe("Cloud's records when many rows do not match", () => {
  it("goes on across short pages with a cursor, keeps the order and never shows an engine line before Cloud's older rows have been looked through", async () => {
    // 2,100 newer rows of Grace, then Ada's rows: a filter for Ada has to look through more rows than one call reads.
    const grace = Array.from({ length: COMPANY_AUDIT.CLOUD_SCAN_MAX + 100 }, (_, n) => cloudRow(ACME, BASE + 1_000_000 + n * 10, { actor: { developerId: GRACE, name: "Grace", type: "person" } }));
    const ada = [1, 2, 3].map((n) => cloudRow(ACME, BASE + n * 1000));
    const adaEngine = engineRow(BASE + 2500);
    const store = await seeded([...grace, ...ada]);
    const pages = await allPages({ store, engine: new FakeEngine([adaEngine]) }, ACME, { person: ADA, limit: "50" });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]!.records).toEqual([]);
    expect(pages[0]!.next).toBeDefined();
    const ids = pages.flatMap((page) => page.records.map(idOf));
    expect(ids).toEqual(expectedOrder(ada, [adaEngine]));
  });

  it("does not show an engine line newer than a Cloud row it has not yet looked past, in the wrong place", async () => {
    // The engine line is newer than Ada's rows but older than all of Grace's; page one must not carry it ahead of rows still to come.
    const grace = Array.from({ length: COMPANY_AUDIT.CLOUD_SCAN_MAX + 5 }, (_, n) => cloudRow(ACME, BASE + 1_000_000 + n * 10, { actor: { developerId: GRACE, name: "Grace", type: "person" } }));
    const adaNewer = cloudRow(ACME, BASE + 900_000);
    const adaEngine = engineRow(BASE + 500_000);
    const pages = await allPages({ store: await seeded([...grace, adaNewer]), engine: new FakeEngine([adaEngine]) }, ACME, { person: ADA });
    expect(pages.flatMap((page) => page.records.map(idOf))).toEqual([`cloud:${adaNewer.id}`, `engine:${adaEngine.eventId}`]);
  });
});

describe("Cloud's scan, chunk by chunk", () => {
  const grace = (atMs: number) => cloudRow(ACME, atMs, { actor: { developerId: GRACE, name: "Grace", type: "person" } });

  it("keeps the row its scan stopped on when that row is a match, so it is neither lost nor repeated", async () => {
    // The 2,000th row looked at is Ada's: the scan cap stops right on it, with no other match yet.
    const filler = Array.from({ length: COMPANY_AUDIT.CLOUD_SCAN_MAX - 1 }, (_, n) => grace(BASE + 1_000_000 + n * 10));
    const onTheCap = cloudRow(ACME, BASE + 500_000);
    const older = [1, 2, 3].map((n) => cloudRow(ACME, BASE + n * 1000));
    const pages = await allPages({ store: await seeded([...filler, onTheCap, ...older]), engine: new FakeEngine([]) }, ACME, { person: ADA, limit: "50" });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((page) => page.records.map(idOf))).toEqual(expectedOrder([onTheCap, ...older], []));
  });

  it("goes on to the next chunk of rows when the first one holds fewer matches than a page", async () => {
    const filler = Array.from({ length: 299 }, (_, n) => grace(BASE + 1_000_000 + n * 10));
    const adaNewest = cloudRow(ACME, BASE + 900_000);
    const adaOlder = Array.from({ length: 10 }, (_, n) => cloudRow(ACME, BASE + n * 1000));
    const pages = await allPages({ store: await seeded([...filler, adaNewest, ...adaOlder]), engine: new FakeEngine([]) }, ACME, { person: ADA, limit: "5" });
    expect(pages.flatMap((page) => page.records.map(idOf))).toEqual(expectedOrder([adaNewest, ...adaOlder], []));
  });

  it("stops reading once it has a page and one more, rather than reading every chunk", async () => {
    const rows = Array.from({ length: 1_000 }, (_, n) => cloudRow(ACME, BASE + n * 10));
    const inner = await seeded(rows);
    let reads = 0;
    const counting: CloudAuditStore = { append: (row) => inner.append(row), read: (company, range) => { reads += 1; return inner.read(company, range); } };
    const page = await listCompanyAudit({ store: counting, engine: new FakeEngine([]), now: NOW }, ACME, q({ limit: "5" }));
    expect(page.records).toHaveLength(5);
    expect(reads).toBe(1);
  });

  it("asks the store only for the range and position it needs, and in chunks of 300", async () => {
    const asked: Array<Record<string, unknown>> = [];
    const spy: CloudAuditStore = { append: async () => "added", read: async (_company, range) => { asked.push({ ...range }); return { rows: [], more: false }; } };
    await listCompanyAudit({ store: spy, engine: new FakeEngine([]), now: NOW }, ACME, q({ from: iso(BASE), to: iso(BASE + 5000), limit: "10" }));
    expect(asked).toEqual([{ fromMs: BASE, toMs: BASE + 5000, max: 300 }]);
  });

  it("does not repeat a row an old page had when the store hands back rows it was told to skip", async () => {
    const rows = [1, 2, 3, 4].map((n) => cloudRow(ACME, BASE + n * 1000));
    const inner = await seeded(rows);
    // A store that ignores the position it is given: the list itself keeps to the cursor.
    const forgetful: CloudAuditStore = { append: (row) => inner.append(row), read: (company, range) => inner.read(company, { ...range, olderThan: undefined as never }) };
    const first = await listCompanyAudit({ store: forgetful, engine: new FakeEngine([]), now: NOW }, ACME, q({ limit: "2" }));
    const second = await listCompanyAudit({ store: forgetful, engine: new FakeEngine([]), now: NOW }, ACME, q({ limit: "2", cursor: first.next! }));
    expect([...first.records, ...second.records].map(idOf)).toEqual(expectedOrder(rows, []));
  });
});

describe("the query", () => {
  it("takes the filters, a limit of 1 to 200 (50 when none) and a cursor", () => {
    expect(q()).toMatchObject({ limit: COMPANY_AUDIT.PAGE_DEFAULT });
    expect(COMPANY_AUDIT.PAGE_DEFAULT).toBe(50);
    expect(COMPANY_AUDIT.PAGE_MAX).toBe(200);
    expect(q({ limit: "1" }).limit).toBe(1);
    expect(q({ limit: "200" }).limit).toBe(200);
    expect(q({ from: "2026-11-14T12:00:00Z", to: "2026-11-14T13:00:00.500Z", person: ADA, project: "payments", action: "task.*" })).toMatchObject({ person: ADA, project: "payments", action: "task.*" });
  });

  it.each([
    ["limit 0", { limit: "0" }], ["limit 201", { limit: "201" }], ["limit text", { limit: "ten" }], ["limit decimal", { limit: "1.5" }], ["limit negative", { limit: "-1" }],
    ["from not a time", { from: "yesterday" }], ["to without Z", { to: "2026-11-14T12:00:00" }], ["to impossible", { to: "2026-13-45T12:00:00Z" }],
    ["unknown parameter", { orgId: ACME }], ["company parameter", { company: ACME }], ["empty value", { person: "" }],
    ["action upper case", { action: "Task.Approved" }], ["action too long", { action: `a${"b".repeat(130)}` }], ["action wildcard in the middle", { action: "task.*.x" }],
    ["project not a name", { project: "Not A Project" }], ["person with a slash", { person: "a/b" }], ["person too long", { person: "p".repeat(129) }],
    ["range backwards", { from: "2026-11-14T13:00:00Z", to: "2026-11-14T12:00:00Z" }], ["cursor too long", { cursor: "c".repeat(1025) }], ["cursor empty", { cursor: "" }],
  ])("refuses %s", (_name, params) => {
    expect(() => q(params as Record<string, string>)).toThrow(CompanyAuditQueryRefused);
  });

  it("refuses a parameter given twice", () => {
    expect(() => parseCompanyAuditQuery(new URLSearchParams("person=a&person=b"))).toThrow(CompanyAuditQueryRefused);
  });

  it("refuses words that echo nothing back", () => {
    try {
      q({ person: "<script>" });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe("the audit query is not valid");
    }
  });
});

describe("recording and then listing", () => {
  it("lists what recordCloudAction wrote for the company", async () => {
    const store = new LocalCloudAuditStore();
    await recordCloudAction(store, { companyId: ACME, actor: { developerId: ADA, name: "Ada" }, action: "company.invite.created", subject: "invite:inv_1", via: "web" }, () => new Date(BASE));
    const page = await listCompanyAudit({ store, engine: new FakeEngine([]), now: NOW }, ACME, q());
    expect(page.records).toMatchObject([{ source: "cloud", action: "company.invite.created", subject: "invite:inv_1", via: "web", actor: { name: "Ada" } }]);
  });
});
