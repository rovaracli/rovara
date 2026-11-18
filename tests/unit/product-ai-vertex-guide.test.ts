// L4-T4 (setup review G4): what Cloud gives the Vertex guide. Each Vertex refusal carries a fixed `reason` code beside its sentence (no new route,
// no new status), the read carries Rovara's AWS account and role name (from the one optional backend value) with THIS company's id, and the guide's
// condition is the gateway's own (vertexSetupSteps).
import { describe, expect, it } from "vitest";
import type { ProbeResult } from "../../packages/model-gateway/src/product-vertex-token.js";
import { vertexSetupSteps } from "../../packages/model-gateway/src/product-vertex-credential.js";
import { vertexGuide } from "../../packages/ui/src/screens/admin/product-ai/vertex-guide.js";
import { A, B, world, write } from "./product-ai-world.js";

const ROLE = "arn:aws:iam::111122223333:role/rovara-cloud-staging-gateway-VertexFederationRole-ABC";
const VERTEX = "/projects/web/product-ai/vertex", READ = "/projects/web/product-ai";
const FORM = { projectId: "acme-evals", location: "us-central1", audience: "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/rovara/providers/rovara-aws", serviceAccount: null as string | null };
const check = (result: ProbeResult) => async () => result;

describe("Vertex refusal reason codes", () => {
  it.each([["too_open", "vertex_too_open", 400], ["refused", "vertex_refused", 400], ["unavailable", "vertex_unavailable", 503]] as const)("the gateway's %s answers reason %s (status %i, same words as before)", async (result, reason, status) => {
    const w = world({ vertexCheck: check(result) });
    const r = await w.call(await w.signIn("pam", 30), "PUT", VERTEX, write(0, FORM));
    expect(r.status).toBe(status);
    expect(r.body.error).toMatchObject({ reason });
    expect(Object.keys(r.body.error!).sort()).toEqual(["code", "message", "reason"]);
    expect(r.body.error!.code).toBe(status === 503 ? "RUNTIME_UNAVAILABLE" : "CONFIG_INVALID");
  });
  it("a form that is not valid answers vertex_invalid, and the gateway is never called", async () => {
    let calls = 0;
    const w = world({ vertexCheck: async () => { calls += 1; return "ok"; } });
    const r = await w.call(await w.signIn("pam", 30), "PUT", VERTEX, write(0, { ...FORM, location: "us" }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: "CONFIG_INVALID", reason: "vertex_invalid" });
    expect(calls).toBe(0);
  });
  it("other refusals carry no reason: a bad key, a stale revision, not an admin", async () => {
    const w = world({ vertexCheck: check("ok") });
    const pam = await w.signIn("pam", 30);
    expect((await w.call(pam, "PUT", VERTEX, write(7, FORM))).body.error).toEqual({ code: "CONFLICT", message: "Product AI settings changed. Refresh and try again." });
    expect((await w.call(await w.signIn("cal", 30), "PUT", VERTEX, write(0, FORM))).body.error).not.toHaveProperty("reason");
    const key = await w.call(pam, "PUT", "/projects/web/product-ai/eval-budget", write(0, { calls: 0, costMicros: 1 }));
    expect(key.body.error).not.toHaveProperty("reason");
  });
});

describe("what the read gives the guide", () => {
  it("Rovara's AWS account, the role's name (not its path or suffix rules) and THIS company's id; another company gets its own", async () => {
    const w = world({ vertexFederationRoleArn: ROLE });
    const pam = (await w.call(await w.signIn("pam"), "GET", READ)).body as unknown as { vertexSetup: unknown };
    expect(pam.vertexSetup).toEqual({ awsAccountId: "111122223333", roleName: "rovara-cloud-staging-gateway-VertexFederationRole-ABC", companyId: A });
    const bob = (await w.call(await w.signIn("bob"), "GET", READ)).body as unknown as { vertexSetup: unknown };
    expect(bob.vertexSetup).toEqual({ awsAccountId: "111122223333", roleName: "rovara-cloud-staging-gateway-VertexFederationRole-ABC", companyId: B });
    expect(JSON.stringify(pam)).not.toContain(B);
  });
  it("a role with a path keeps only its name, as the assumed-role ARN does", async () => {
    const w = world({ vertexFederationRoleArn: "arn:aws:iam::111122223333:role/service/rovara/Fed" });
    expect(((await w.call(await w.signIn("pam"), "GET", READ)).body as unknown as { vertexSetup: { roleName: string } }).vertexSetup.roleName).toBe("Fed");
  });
  it("not configured, or not a role ARN: null, never a half-filled value", async () => {
    for (const arn of [undefined, "", "arn:aws:iam::1:role/x", "arn:aws:s3:::bucket", "arn:aws:iam::111122223333:user/x", "arn:aws:iam::111122223333:role/a b", `${ROLE}'; rm -rf /`]) {
      const w = world(arn === undefined ? {} : { vertexFederationRoleArn: arn });
      expect(((await w.call(await w.signIn("pam"), "GET", READ)).body as unknown as { vertexSetup: unknown }).vertexSetup).toBeNull();
    }
  });
  it("the guide's condition is the gateway's own, with this company's session ARN and no other", () => {
    const setup = { awsAccountId: "111122223333", roleName: "RovaraProductAiFederation", companyId: A };
    const guide = vertexGuide({ projectId: "acme-evals", setup });
    expect(guide.condition).toBe(vertexSetupSteps({ awsAccountId: setup.awsAccountId, roleName: setup.roleName, cid: A }).condition);
    expect(guide.sessionArn).toBe(vertexSetupSteps({ awsAccountId: setup.awsAccountId, roleName: setup.roleName, cid: A }).sessionArn);
    expect(JSON.stringify(guide)).not.toContain(B);
  });
});
