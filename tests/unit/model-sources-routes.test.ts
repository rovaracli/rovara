// DEC 254zzz84(4): the company's AI source order (model-sources-routes.ts). Any member reads it; only a company owner or admin changes it (no step-up,
// DEC 254zzz73); the order is the AGENT_AI row's first choice and fallback, guarded by its version; two companies never meet. The gateway reads what these
// save (model-gateway-source-order.test.ts).
import { describe, expect, it } from "vitest";
import { A, B, PEOPLE, world } from "./product-ai-world.js";

const READ = "/org/model-sources";
const WRITE = "/org/model-sources-order";
const RID = "11111111-1111-4111-8111-111111111111";
const change = (who: string, expectedRevision: number, order: unknown, company = PEOPLE[who]!.companyId) => ({ requestId: RID, expectedOrgId: company, expectedDeveloperId: PEOPLE[who]!.developerId, expectedRevision, order });

describe("model sources: the company's AI source order", () => {
  it("an admin saves 'own key first, then Rovara's AI'; members read it; the change is audited", async () => {
    const w = world({ company: true });
    const ada = await w.signIn("ada", 3600);
    const empty = await w.call(ada, "GET", READ);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({
      orgId: A, developerId: PEOPLE["ada"]!.developerId, revision: 0, canChange: true, order: [],
      sources: [
        { source: "rovara", available: true, connected: true, inOrder: false },
        { source: "anthropic_key", available: true, connected: false, inOrder: false },
        { source: "bedrock_byo", available: false, connected: null, inOrder: false },
      ],
    });
    const saved = await w.call(ada, "PUT", WRITE, change("ada", 0, ["anthropic_key", "rovara"]));
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ order: ["anthropic_key", "rovara"], revision: 1 });
    expect(await w.companies.agentAi(A)).toMatchObject({ source: "anthropic_key", fallback: ["rovara"], version: 1, updatedBy: PEOPLE["ada"]!.developerId });
    const rows = (await w.audit.read(A, { max: 50 })).rows.filter((r) => r.action === "agent_ai.source.changed");
    expect(rows.map((r) => [r.subject, r.detail])).toEqual([["agent_ai:anthropic_key", "order:anthropic_key,rovara"]]);
    for (const who of ["pam", "cal"]) {
      const member = await w.signIn(who, 3600);
      const read = await w.call(member, "GET", READ);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ canChange: false, order: ["anthropic_key", "rovara"], revision: 1 });
    }
  });

  it("a single source saves no fallback (the row is exactly as before)", async () => {
    const w = world({ company: true });
    const ada = await w.signIn("ada", 3600);
    expect((await w.call(ada, "PUT", WRITE, change("ada", 0, ["rovara"]))).status).toBe(200);
    const row = await w.companies.agentAi(A);
    expect(row).toMatchObject({ source: "rovara", version: 1 });
    expect(row).not.toHaveProperty("fallback");
  });

  it("a member (or an install administrator who is a plain member) can't change it; nothing is written", async () => {
    const w = world({ company: true });
    for (const who of ["pam", "cal", "ian"]) {
      const cookie = await w.signIn(who, 30);
      const r = await w.call(cookie, "PUT", WRITE, change(who, 0, ["rovara"]));
      expect(r.status).toBe(403);
      expect(r.body.error?.message).toBe("Only a company owner or admin can change the order of the company's AI sources.");
    }
    expect(await w.companies.agentAi(A)).toBeUndefined();
    // An owner may.
    const oz = await w.signIn("oz", 3600);
    expect((await w.call(oz, "PUT", WRITE, change("oz", 0, ["rovara"]))).status).toBe(200);
  });

  it("no step-up is asked (an old sign-in still changes it)", async () => {
    const w = world({ company: true });
    const ada = await w.signIn("ada", undefined);
    expect((await w.call(ada, "PUT", WRITE, change("ada", 0, ["rovara"]))).status).toBe(200);
  });

  it("refuses unknown, repeated, empty, too long or malformed orders and bodies, in fixed words that echo nothing", async () => {
    const w = world({ company: true });
    const ada = await w.signIn("ada", 3600);
    const bad: unknown[] = [
      change("ada", 0, ["<b>x"]), change("ada", 0, ["rovara", "rovara"]), change("ada", 0, []), change("ada", 0, "rovara"), change("ada", 0, ["personal-chatgpt"]),
      change("ada", 0, ["rovara", "anthropic_key", "bedrock_byo", "openai_key", "openrouter_key", "custom_endpoint", "rovara"]),
      { ...change("ada", 0, ["rovara"]), more: 1 }, { ...change("ada", 0, ["rovara"]), requestId: "x" }, { ...change("ada", -1, ["rovara"]) }, null,
    ];
    for (const body of bad) {
      const r = await w.call(ada, "PUT", WRITE, body);
      expect(r.status).toBe(400);
      expect(r.raw).not.toContain("<b>");
    }
    expect(await w.companies.agentAi(A)).toBeUndefined();
  });

  it("a source the company can't use now is refused (own Bedrock not connected; a kind not switched on)", async () => {
    const w = world({ company: true });
    const ada = await w.signIn("ada", 3600);
    for (const order of [["rovara", "bedrock_byo"], ["openai_key"]]) {
      const r = await w.call(ada, "PUT", WRITE, change("ada", 0, order));
      expect(r.status).toBe(400);
      expect(r.body.error?.message).toBe("Every AI source in the order must be one your company can use now. Connect it first, then add it.");
    }
    expect(await w.companies.agentAi(A)).toBeUndefined();
  });

  it("a stale revision, or a page drawn for another company or person, changes nothing", async () => {
    const w = world({ company: true });
    const ada = await w.signIn("ada", 3600);
    expect((await w.call(ada, "PUT", WRITE, change("ada", 0, ["rovara"]))).status).toBe(200);
    const stale = await w.call(ada, "PUT", WRITE, change("ada", 0, ["anthropic_key", "rovara"]));
    expect(stale.status).toBe(409);
    expect(stale.body.error?.code).toBe("CHANGE_STALE");
    expect((await w.call(ada, "PUT", WRITE, change("ada", 1, ["anthropic_key"], B))).status).toBe(409);
    expect((await w.call(ada, "PUT", WRITE, { ...change("ada", 1, ["anthropic_key"]), expectedDeveloperId: PEOPLE["pam"]!.developerId })).status).toBe(409);
    expect(await w.companies.agentAi(A)).toMatchObject({ source: "rovara", version: 1 });
  });

  it("two companies: one company's order never touches another's, and each reads only its own", async () => {
    const w = world({ company: true });
    const ada = await w.signIn("ada", 3600); const bea = await w.signIn("bea", 3600);
    expect((await w.call(ada, "PUT", WRITE, change("ada", 0, ["anthropic_key", "rovara"]))).status).toBe(200);
    const b = await w.call(bea, "GET", READ);
    expect(b.body).toMatchObject({ orgId: B, revision: 0, order: [] });
    expect((await w.call(bea, "PUT", WRITE, change("bea", 0, ["rovara"]))).status).toBe(200);
    expect(await w.companies.agentAi(A)).toMatchObject({ source: "anthropic_key", fallback: ["rovara"], version: 1 });
    expect(await w.companies.agentAi(B)).toMatchObject({ source: "rovara", version: 1 });
    expect((await w.audit.read(B, { max: 50 })).rows.map((r) => r.detail)).toEqual(["order:rovara"]);
  });

  it("choosing a new first source on 'AI for your agents' keeps the rest of the order, minus the new first source", async () => {
    const w = world({ company: true });
    const ada = await w.signIn("ada", 30);
    expect((await w.call(ada, "PUT", WRITE, change("ada", 0, ["anthropic_key", "rovara"]))).status).toBe(200);
    expect((await w.call(ada, "PUT", "/org/agent-ai", { expectedVersion: 1, source: "rovara" })).status).toBe(200);
    const row = await w.companies.agentAi(A);
    expect(row).toMatchObject({ source: "rovara", version: 2 });
    expect(row).not.toHaveProperty("fallback");
    expect((await w.call(ada, "PUT", WRITE, change("ada", 2, ["rovara", "anthropic_key"]))).status).toBe(200);
    expect(await w.companies.agentAi(A)).toMatchObject({ source: "rovara", fallback: ["anthropic_key"], version: 3 });
    expect((await w.call(ada, "PUT", "/org/agent-ai", { expectedVersion: 3, source: "anthropic_key" })).status).toBe(200);
    // The old first choice is not a fallback (only the sources after it are kept).
    const last = await w.companies.agentAi(A);
    expect(last).toMatchObject({ source: "anthropic_key", version: 4 });
    expect(last).not.toHaveProperty("fallback");
  });

  it("is not on a Cloud without company data", async () => {
    const w = world();
    const ada = await w.signIn("ada", 30);
    expect((await w.call(ada, "GET", READ)).status).toBe(501);
  });
});
