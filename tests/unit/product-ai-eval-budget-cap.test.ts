// Removing the server comparison must let an over-cap write through and fail these tests.
// Exercise the signed HTTP handler, real company settings and real product-key transaction store.
import { describe, expect, it, vi } from "vitest";
import { A, B, ISS, world, write } from "./product-ai-world.js";

const ROOT = "/projects/web/product-ai";
const approval = (maxCostMicros: number) => ({ selection: "all-questions", inputsDigest: "d".repeat(64), maxCalls: 50, maxCostMicros });
const writes = [
  { path: `${ROOT}/eval-budget`, body: (amount: number) => ({ calls: 50, costMicros: amount }) },
  { path: `${ROOT}/eval-approval`, body: (amount: number) => ({ approval: approval(amount) }) },
];
const overCap = { status: 400, body: { error: { code: "CONFIG_INVALID", message: "The eval budget can't be more than the company's monthly AI budget." } } };

async function cap(w: ReturnType<typeof world>, company: string, amount: number | null) {
  await w.setCompanySettings(company, (s) => { s.budgets.companyMonthlyUsdMicros = amount; s.budgets.learningMonthlyUsdMicros = 0; });
}

async function unchanged(w: ReturnType<typeof world>, run: () => Promise<unknown>) {
  const rows = structuredClone([...w.table.rows]);
  const companyWrite = vi.spyOn(w.companies, "putSettings");
  const auditA = await w.audit.read(A, { max: 50 });
  const auditB = await w.audit.read(B, { max: 50 });
  const logs = [...w.logs];
  let commits = 0;
  const commit = w.table.transact.bind(w.table);
  const spy = vi.spyOn(w.table, "transact").mockImplementation(async (...args) => { commits += 1; return commit(...args); });
  try { await run(); } finally { spy.mockRestore(); }
  expect(commits).toBe(0);
  expect([...w.table.rows]).toEqual(rows);
  expect(companyWrite).not.toHaveBeenCalled();
  companyWrite.mockRestore();
  expect(await w.audit.read(A, { max: 50 })).toEqual(auditA);
  expect(await w.audit.read(B, { max: 50 })).toEqual(auditB);
  expect(w.logs).toEqual(logs);
}

describe.each(writes)("company monthly cap at $path", ({ path, body }) => {
  it("refuses one micro above the cap, including replay, before any writes", async () => {
    const w = world({ company: true });
    await cap(w, A, 4_000_000);
    const pam = await w.signIn("pam");
    const request = write(0, body(4_000_001));
    await unchanged(w, async () => {
      expect(await w.call(pam, "PUT", path, request)).toMatchObject(overCap);
      expect(await w.call(pam, "PUT", path, request)).toMatchObject(overCap);
    });
  });

  it.each([4_000_000, 3_999_999])("allows %i micros and the caller's own approval, with the documented inputs", async (amount) => {
    const w = world({ company: true });
    await cap(w, A, 4_000_000);
    const pam = await w.signIn("pam");
    const result = await w.call(pam, "PUT", path, write(0, body(amount)));
    expect(result.status).toBe(200);
    expect(result.body.revision).toBe(1);
    const view = await w.store.view(ISS, A, "web");
    if (path.endsWith("eval-budget")) expect(view.evalBudget).toEqual({ calls: 50, costMicros: amount });
    else {
      expect(view.evalApproval).toMatchObject({ maxCostMicros: amount, approver: { personId: "a".repeat(64) } });
      expect(result.body).toMatchObject({ evalApproval: { approvedByYou: true } });
    }
    expect((await w.audit.read(A, { max: 50 })).rows).toHaveLength(1);
  });

  it("refuses a company admin above the cap too, with no role bypass (review test, lead 4 Opus)", async () => {
    const w = world({ company: true });
    await cap(w, A, 4_000_000);
    const ada = await w.signIn("ada");
    await unchanged(w, async () => { expect(await w.call(ada, "PUT", path, write(0, body(4_000_001)))).toMatchObject(overCap); });
    expect((await w.call(ada, "PUT", path, write(0, body(4_000_000)))).status).toBe(200);
  });

  it("a zero company cap refuses positive eval spend without writes", async () => {
    const w = world({ company: true });
    await cap(w, A, 0);
    const pam = await w.signIn("pam");
    await unchanged(w, async () => { expect(await w.call(pam, "PUT", path, write(0, body(1)))).toMatchObject(overCap); });
  });

  it.each(["missing", "null"])("preserves pre-cap configuration with %s monthly budget (runtime still needs a cap)", async (kind) => {
    const w = world({ company: true });
    if (kind === "null") await cap(w, A, null);
    expect((await w.call(await w.signIn("pam"), "PUT", path, write(0, body(4_000_000)))).status).toBe(200);
  });

  it("uses only the caller's company cap, even for the same project name", async () => {
    const w = world({ company: true });
    await cap(w, A, 1_000_000);
    await cap(w, B, 9_000_000);
    const pam = await w.signIn("pam"), bob = await w.signIn("bob");
    await unchanged(w, async () => {
      const refused = await w.call(pam, "PUT", path, write(0, body(2_000_000)));
      expect(refused).toMatchObject(overCap);
      expect(refused.raw).not.toContain(B);
      expect(refused.raw).not.toContain("9,000,000");
    });
    expect((await w.call(bob, "PUT", path, write(0, body(2_000_000)))).status).toBe(200);
    expect((await w.store.view(ISS, A, "web")).revision).toBe(0);
    expect((await w.store.view(ISS, B, "web")).revision).toBe(1);
  });

  it("checks role before reading the budget, with no cap leak or writes", async () => {
    const w = world({ company: true });
    const read = vi.spyOn(w.companies, "settings");
    await unchanged(w, async () => {
      const result = await w.call(await w.signIn("cal"), "PUT", path, write(0, body(2_000_000)));
      expect(result.status).toBe(403);
    });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["unreadable", "other company", "failed read", "backend absent"])("fails closed with %s settings, with no writes or lower-layer text", async (kind) => {
    const w = world({ company: kind !== "backend absent" });
    if (kind === "unreadable") vi.spyOn(w.companies, "settings").mockResolvedValue({ companyId: A, version: 1, settings: { secret: "private-store-text" } });
    if (kind === "other company") {
      await cap(w, B, 9_000_000);
      vi.spyOn(w.companies, "settings").mockResolvedValue(await w.companies.settings(B));
    }
    if (kind === "failed read") vi.spyOn(w.companies, "settings").mockRejectedValue(new Error("private-store-text"));
    await unchanged(w, async () => {
      const result = await w.call(await w.signIn("pam"), "PUT", path, write(0, body(1)));
      expect(result.status).toBe(503);
      expect(result.body.error?.code).toBe("RUNTIME_UNAVAILABLE");
      expect(result.raw).not.toContain("private-store-text");
      expect(result.raw).not.toContain(B);
    });
  });

  it("rereads a lowered monthly cap and leaves the prior project record intact on refusal", async () => {
    const w = world({ company: true });
    await cap(w, A, 4_000_000);
    const pam = await w.signIn("pam");
    expect((await w.call(pam, "PUT", path, write(0, body(4_000_000)))).status).toBe(200);
    const current = (await w.companies.settings(A))!;
    const settings = structuredClone(current.settings) as { budgets: { companyMonthlyUsdMicros: number } };
    settings.budgets.companyMonthlyUsdMicros = 1_000_000;
    expect((await w.call(await w.signIn("ada"), "PUT", "/org/settings", { expectedVersion: current.version, settings })).status).toBe(200);
    await unchanged(w, async () => { expect(await w.call(pam, "PUT", path, write(1, body(4_000_000)))).toMatchObject(overCap); });
    expect((await w.store.view(ISS, A, "web")).revision).toBe(1);
  });
});

it("withdraws a prior approval even after the cap becomes zero and its settings cannot be read", async () => {
  const w = world({ company: true });
  await cap(w, A, 4_000_000);
  const pam = await w.signIn("pam");
  expect((await w.call(pam, "PUT", `${ROOT}/eval-approval`, write(0, { approval: approval(4_000_000) }))).status).toBe(200);
  await cap(w, A, 0);
  vi.spyOn(w.companies, "settings").mockRejectedValue(new Error("private-store-text"));
  const result = await w.call(pam, "PUT", `${ROOT}/eval-approval`, write(1, { approval: null }));
  expect(result.status).toBe(200);
  expect((await w.store.view(ISS, A, "web")).evalApproval).toBeUndefined();
});
