// DEC 238 slice 2 in Cloud: a project's tests call Bedrock on the project's OWN role, or on the company's it links to. The project's
// admin (or a company admin) connects, links, removes and gets the setup command; the gateway tests the role for THIS company; two
// companies never meet; changes need a fresh step-up and are audited.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BedrockBackend } from "../../packages/cloud-server/src/index.js";
import { bedrockModelPresets, bedrockSetupCommand, type BedrockConnection } from "../../packages/model-gateway/src/bedrock-byo.js";
import { ROVARA_AI_US_MODELS } from "../../packages/model-gateway/src/agent-ai.js";
import { A, B, world, write } from "./product-ai-world.js";

const BROKER = "arn:aws:iam::944937319445:role/RovaraBedrockBroker-staging";
const TEMPLATE = "https://raw.githubusercontent.com/PrepLabsAI/Rovara/0123456789abcdef0123456789abcdef01234567/docs/bedrock/rovara-bedrock-role.json";
const ROLE = (cid: string, n = "") => `arn:aws:iam::${cid === A ? "111111111111" : "222222222222"}:role/RovaraBedrockInvoke-${cid}${n}`;
const SONNET = "us.anthropic.claude-sonnet-5-5";
const NOVA = "us.amazon.nova-pro-v1:0";
const TITAN = "amazon.titan-embed-text-v2:0";
const FORM = (cid: string, over: Record<string, unknown> = {}) => ({ roleArn: ROLE(cid), region: "us-west-2", models: { "claude-sonnet-5-5": SONNET }, allowGlobal: false, ...over });
const extOf = (cid: string) => `rvb-${createHmac("sha256", "ext").update(cid).digest("hex").slice(0, 40)}`;
const PROJECT = "/projects/web/product-ai";

function kit(probe: (cid: string, c: BedrockConnection) => { result: "ok" | "too_open" | "refused" | "unavailable"; models?: Record<string, "ready" | "not_enabled"> } = (_cid, c) => ({ result: "ok", models: Object.fromEntries([...Object.values(c.models), ...(c.productModels ?? [])].map((id) => [id, "ready" as const])) })) {
  const probes: Array<{ cid: string; roleArn: string; productModels?: readonly string[] }> = [];
  const backend: BedrockBackend = {
    async setup(cid) { return { externalId: extOf(cid), brokerRoleArn: BROKER, templateUrl: TEMPLATE }; },
    command: (made, cid, choice) => bedrockSetupCommand({ ...made, cid, ...choice }),
    presets: (region) => bedrockModelPresets(region, ROVARA_AI_US_MODELS),
  };
  const check = async (cid: string, c: BedrockConnection) => { probes.push({ cid, roleArn: c.roleArn, ...(c.productModels === undefined ? {} : { productModels: c.productModels }) }); return probe(cid, c); };
  return { backend, check, probes };
}
const bedrockWorld = (probe?: Parameters<typeof kit>[0]) => { const k = kit(probe); return { k, w: world({ company: true, bedrock: k.backend, bedrockCheck: k.check }) }; };

describe("Cloud: a project's own Bedrock role", () => {
  it("the project's admin gets the command, connects a role with product models, and sees each model's state; audited", async () => {
    const { k, w } = bedrockWorld((_cid, c) => ({ result: "ok", models: { [Object.values(c.models)[0]!]: "ready", ...(c.productModels === undefined ? {} : { [c.productModels[0]!]: "not_enabled" }) } }));
    const pam = await w.signIn("pam", 30);
    const command = await w.call(pam, "POST", `${PROJECT}/bedrock/setup`, { region: "us-west-2", models: { "claude-sonnet-5-5": SONNET }, allowGlobal: false, productModels: [NOVA, TITAN] });
    expect(command.status).toBe(200);
    expect(command.body.command).toContain(`ExternalId=${extOf(A)}`);
    expect(command.body.command).toContain("inference-profile/us.amazon.nova-pro-v1:0");
    // Its own stack: never the company's (a deploy of the same stack name would rewrite the company role's policy).
    expect(command.body.stackName).toBe("rovara-bedrock-org-aaaaaaaaaaaaaaaaaaaa-web");
    expect((await w.call(await w.signIn("ada", 30), "POST", "/org/bedrock/setup", { region: "us-west-2", models: { "claude-sonnet-5-5": SONNET }, allowGlobal: false })).body.stackName).toBe("rovara-bedrock-org-aaaaaaaaaaaaaaaaaaaa");
    const saved = await w.call(pam, "PUT", `${PROJECT}/bedrock`, write(0, FORM(A, { productModels: [NOVA, TITAN] })));
    expect(saved.status).toBe(200);
    expect(k.probes).toEqual([{ cid: A, roleArn: ROLE(A), productModels: [NOVA, TITAN].sort() }]);
    expect(saved.body.bedrock).toMatchObject({ connected: true, linked: false, roleArn: ROLE(A), region: "us-west-2", models: [{ name: "claude-sonnet-5-5", id: SONNET, state: "ready" }] });
    expect((saved.body.bedrock as { productModels: unknown[] }).productModels).toEqual([{ id: TITAN, state: "not_enabled" }, { id: NOVA, state: "unavailable" }]);
    expect((await w.call(pam, "GET", PROJECT)).body.bedrock).toMatchObject({ roleArn: ROLE(A) });
    // A change is a rotate; removing it leaves the recovery window the store keeps.
    const rotated = await w.call(pam, "PUT", `${PROJECT}/bedrock`, write(1, FORM(A, { region: "us-east-2" })));
    expect(rotated.body.error, JSON.stringify(rotated.body)).toBeUndefined();
    expect(rotated.body.bedrock).toMatchObject({ region: "us-east-2" });
    const removed = await w.call(pam, "DELETE", `${PROJECT}/bedrock`, write(2));
    expect(removed.body.bedrock).toEqual({ connected: false });
    expect(removed.body.bedrockRemovedUntil).toBeGreaterThan(0);
    expect((await w.audit.read(A, { max: 50 })).rows.map((r) => r.action).sort()).toEqual(["product_ai.bedrock.connected", "product_ai.bedrock.removed", "product_ai.bedrock.rotated"]);
  });

  it("a project may link to the company's connected Bedrock (never a copy); without one it is refused; removing the link frees the project to connect its own", async () => {
    const { w } = bedrockWorld();
    const pam = await w.signIn("pam", 30); const ada = await w.signIn("ada", 30);
    const early = await w.call(pam, "PUT", `${PROJECT}/bedrock/link`, write(0));
    expect(early.status).toBe(404); expect(early.body.error?.message).toBe("No Bedrock connection is saved for this company.");
    expect((await w.call(ada, "PUT", "/org/bedrock", write(0, FORM(A)))).status).toBe(200);
    const linked = await w.call(pam, "PUT", `${PROJECT}/bedrock/link`, write(0));
    expect(linked.status).toBe(200);
    expect(linked.body.bedrock).toMatchObject({ connected: true, linked: true, linkedTo: "src_bedrock" });
    expect(JSON.stringify(linked.body)).not.toContain(ROLE(A));
    // One source per provider: its own role needs the link removed first.
    expect((await w.call(pam, "PUT", `${PROJECT}/bedrock`, write(1, FORM(A, { roleArn: ROLE(A, "2") })))).status).toBe(400);
    expect((await w.call(pam, "DELETE", `${PROJECT}/bedrock`, write(1))).body.bedrock).toEqual({ connected: false });
    expect((await w.call(pam, "PUT", `${PROJECT}/bedrock`, write(2, FORM(A, { roleArn: ROLE(A, "2") })))).status).toBe(200);
    expect((await w.audit.read(A, { max: 50 })).rows.map((r) => r.action)).toEqual(expect.arrayContaining(["product_ai.bedrock.linked", "product_ai.bedrock.removed", "product_ai.bedrock.connected"]));
  });

  it("two companies: B can't take A's role (own or linked), B's project sees nothing of A's, each company's external id is its own", async () => {
    const { k, w } = bedrockWorld();
    const pam = await w.signIn("pam", 30); const bob = await w.signIn("bob", 30);
    expect((await w.call(pam, "PUT", `${PROJECT}/bedrock`, write(0, FORM(A)))).status).toBe(200);
    const taken = await w.call(bob, "PUT", `${PROJECT}/bedrock`, write(0, FORM(B, { roleArn: ROLE(A) })));
    expect(taken.status).toBe(409);
    expect(taken.body.error?.message).toBe("This AWS role is already connected to another Rovara company. Create a role for this company with the setup command.");
    expect(k.probes.map((p) => p.cid)).toEqual([A]);
    expect((await w.call(bob, "GET", PROJECT)).body.bedrock).toEqual({ connected: false });
    expect((await w.call(bob, "PUT", `${PROJECT}/bedrock/link`, write(0))).status).toBe(404);
    expect((await w.call(bob, "POST", `${PROJECT}/bedrock/setup`, { region: "us-west-2", models: { "claude-sonnet-5-5": SONNET }, allowGlobal: false })).body.command).toContain(`ExternalId=${extOf(B)}`);
  });

  it("the gateway's test decides: too open, refused and unavailable save nothing, each in its own words", async () => {
    for (const [result, status, words] of [["too_open", 400, "would also trust another Rovara company"], ["refused", 400, "AWS refused Rovara"], ["unavailable", 503, "Nothing was saved"]] as const) {
      const { w } = bedrockWorld(() => ({ result }));
      const pam = await w.signIn("pam", 30);
      const r = await w.call(pam, "PUT", `${PROJECT}/bedrock`, write(0, FORM(A)));
      expect(r.status, result).toBe(status); expect(r.body.error?.message).toContain(words);
      expect((await w.call(pam, "GET", PROJECT)).body.bedrock).toEqual({ connected: false });
    }
  });

  it("only the project's admin or a company admin; changes need a fresh step-up; bad input is refused; off without the backend", async () => {
    const { w } = bedrockWorld();
    const cal = await w.signIn("cal", 30);
    for (const [method, path, body] of [["PUT", `${PROJECT}/bedrock`, write(0, FORM(A))], ["PUT", `${PROJECT}/bedrock/link`, write(0)], ["DELETE", `${PROJECT}/bedrock`, write(0)]] as const) {
      expect((await w.call(cal, method, path, body)).status, `${method} ${path}`).toBe(403);
    }
    expect((await w.call(await w.signIn("pam", 3600), "PUT", `${PROJECT}/bedrock`, write(0, FORM(A)))).body.error?.code).toBe("STEP_UP_REQUIRED");
    const pam = await w.signIn("pam", 30);
    for (const body of [
      write(0, FORM(A, { roleArn: "arn:aws:iam::111111111111:role/Admin" })), write(0, FORM(A, { region: "us-gov-west-1" })), write(0, FORM(A, { productModels: [] })), write(0, FORM(A, { productModels: ["arn:aws:bedrock:us-west-2:1:provisioned-model/x"] })),
      write(0, FORM(A, { productModels: [NOVA, NOVA] })), write(0, FORM(A, { productModels: "x" })), write(0, { ...FORM(A), extra: 1 }), { ...FORM(A) },
    ]) expect((await w.call(pam, "PUT", `${PROJECT}/bedrock`, body)).status).toBe(400);
    expect((await w.call(pam, "POST", `${PROJECT}/bedrock/setup`, { region: "us-west-2", models: { "claude-x": SONNET }, allowGlobal: false, productModels: ["eu.amazon.nova-pro-v1:0"] })).status).toBe(400);
    const off = world({ company: true });
    expect((await off.call(await off.signIn("pam", 30), "PUT", `${PROJECT}/bedrock`, write(0, FORM(A)))).status).toBe(501);
  });
});
