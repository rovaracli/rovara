// DEC 240: "AI for your agents" (agent-ai-routes.ts). Company admins only (reads too), a fresh step-up on every write, audited, the
// three choices with "your own Bedrock" refused as coming soon, and two companies never meet. The gateway reads what these save
// (tests/contract/model-gateway-agent-ai-choice.test.ts).
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { A, B, world, write } from "./product-ai-world.js";

const PATH = "/org/agent-ai";
const choose = (expectedVersion: number, source: string) => ({ expectedVersion, source });

describe("AI for your agents", () => {
  it("an admin sees the three choices, saves Rovara's AI, then their own Anthropic key; each change is audited", async () => {
    const w = world({ company: true });
    const ada = await w.signIn("ada", 30);
    const empty = await w.call(ada, "GET", PATH);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ source: null, version: 0, canChange: true, anthropicKeyConnected: false, choices: [{ source: "rovara", available: true }, { source: "anthropic_key", available: true }, { source: "bedrock_byo", available: false }] });
    const one = await w.call(ada, "PUT", PATH, choose(0, "rovara"));
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ source: "rovara", version: 1 });
    expect(await w.companies.agentAi(A)).toMatchObject({ source: "rovara", version: 1, updatedBy: "d".repeat(64) });
    // The Anthropic key's state is shown beside the choice (connected on the Learning AI key page).
    await w.call(ada, "PUT", "/org/learning-ai/key", write(0, { provider: "anthropic", key: ["sk", "ant", randomBytes(16).toString("hex")].join("-") }));
    const two = await w.call(ada, "PUT", PATH, choose(1, "anthropic_key"));
    expect(two.body).toMatchObject({ source: "anthropic_key", version: 2, anthropicKeyConnected: true });
    const records = (await w.audit.read(A, { max: 50 })).rows.filter((r) => r.action === "agent_ai.source.changed").map((r) => r.subject);
    expect(records.sort()).toEqual(["agent_ai:anthropic_key", "agent_ai:rovara"]);
  });

  it("one company's choice never touches another's (two companies)", async () => {
    const w = world({ company: true });
    const ada = await w.signIn("ada", 30); const bea = await w.signIn("bea", 30);
    expect((await w.call(ada, "PUT", PATH, choose(0, "rovara"))).status).toBe(200);
    const b = await w.call(bea, "GET", PATH);
    expect(b.body).toMatchObject({ source: null, version: 0 });
    expect((await w.call(bea, "PUT", PATH, choose(0, "anthropic_key"))).status).toBe(200);
    expect(await w.companies.agentAi(A)).toMatchObject({ source: "rovara", version: 1 });
    expect(await w.companies.agentAi(B)).toMatchObject({ source: "anthropic_key", version: 1 });
    expect((await w.audit.read(B, { max: 50 })).rows.filter((r) => r.action === "agent_ai.source.changed").map((r) => r.subject)).toEqual(["agent_ai:anthropic_key"]);
  });

  it("refuses anyone but a company admin (reads too), and a write without a fresh step-up or the CSRF token", async () => {
    const w = world({ company: true });
    for (const who of ["pam", "cal"]) {
      const cookie = await w.signIn(who, 30);
      expect((await w.call(cookie, "GET", PATH)).status).toBe(403);
      expect((await w.call(cookie, "PUT", PATH, choose(0, "rovara"))).status).toBe(403);
    }
    for (const age of [undefined, 3600]) {
      const ada = await w.signIn("ada", age);
      expect((await w.call(ada, "PUT", PATH, choose(0, "rovara"))).body.error?.code).toBe("STEP_UP_REQUIRED");
    }
    const ada = await w.signIn("ada", 30);
    expect((await w.call(ada, "PUT", PATH, choose(0, "rovara"), "wrong")).status).toBe(403);
    expect(await w.companies.agentAi(A)).toBeUndefined();
  });

  it("your own Bedrock is coming soon; anything else is refused in fixed words; a stale version conflicts", async () => {
    const w = world({ company: true });
    const ada = await w.signIn("ada", 30);
    const soon = await w.call(ada, "PUT", PATH, choose(0, "bedrock_byo"));
    expect(soon.status).toBe(400);
    expect(soon.body.error?.message).toBe("Your own Bedrock is coming soon. Choose Rovara's AI or your own Anthropic key for now.");
    for (const body of [choose(0, "openai"), choose(0, "<b>x"), { source: "rovara" }, { expectedVersion: -1, source: "rovara" }, { ...choose(0, "rovara"), more: 1 }, null]) {
      const r = await w.call(ada, "PUT", PATH, body);
      expect(r.status).toBe(400);
      expect(r.raw).not.toContain("<b>");
    }
    expect(await w.companies.agentAi(A)).toBeUndefined();
    expect((await w.call(ada, "PUT", PATH, choose(0, "rovara"))).status).toBe(200);
    const stale = await w.call(ada, "PUT", PATH, choose(0, "anthropic_key"));
    expect(stale.status).toBe(409);
    expect(await w.companies.agentAi(A)).toMatchObject({ source: "rovara", version: 1 });
  });

  it("is not on a Cloud without company data", async () => {
    const w = world();
    const ada = await w.signIn("ada", 30);
    expect((await w.call(ada, "GET", PATH)).status).toBe(501);
  });
});
