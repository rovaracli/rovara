// TE-F1e item 7, the broker send (its own commit): a CHECKS round's plan is minted at delivery, only for a worker that lists task.productModels.v1 and only with the company's gate on; anything else leaves the
// invocation as it is today, byte for byte (golden), and never refuses the delivery.
import { generateKeyPairSync, sign as cryptoSign, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AGENTX_PROTOCOL_VERSION } from "@rovara-code/contracts";
import { PRODUCT_MODELS_FEATURE, WorkerInvocationSchema, type WorkerInvocation } from "@agentx/cloud-contracts";
import { withProductModelPlan } from "../../packages/broker/src/aws/ec2-delivery.js";
import { verifyModelEgressCapability } from "../../packages/broker/src/product-ai/capability.js";
import { createProductModelPlanner } from "../../packages/broker/src/product-ai/plan.js";

const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const NOW = Date.UTC(2026, 10, 14, 12);
const ARN = "arn:aws:lambda:us-west-2:111122223333:function:agentx-staging-product-model-egress";
const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as never;
const invocation = (payload: Record<string, unknown> = {}): WorkerInvocation => WorkerInvocationSchema.parse({
  protocolVersion: AGENTX_PROTOCOL_VERSION, operationId: randomUUID(), workspaceId: randomUUID(), fence: 2, projectRevision: 1, callbackCapability: "c".repeat(48),
  kind: "task", payload: { conversationId: randomUUID(), prompt: "check it", ...payload },
});
const planner = (gateOn = true) => createProductModelPlanner({
  sign: async (message) => cryptoSign("sha256", message, { key: pair.privateKey, dsaEncoding: "der" }), functionArn: ARN, gate: async () => gateOn, orgOf: async () => ORG, now: () => NOW,
});
const pings = () => {
  const urls: string[] = [];
  return { urls, features: async (url: string) => { urls.push(url); return [PRODUCT_MODELS_FEATURE, "task.workflowMode"]; } };
};

describe("the product model plan at delivery", () => {
  it("mints, for a CHECKS round to a worker that lists the feature, a capability for exactly this operation, verifiable with the public key", async () => {
    const task = invocation({ workflowMode: "CHECKS" });
    const ping = pings();
    const sent = await withProductModelPlan(task, "http://10.0.0.1:8080/ping", ping.features, planner());
    expect(sent.kind === "task" && sent.payload.productModels?.functionArn).toBe(ARN);
    const claims = verifyModelEgressCapability(sent.kind === "task" ? sent.payload.productModels?.capability : undefined, pair.publicKey, Math.floor(NOW / 1000));
    expect(claims).toMatchObject({ purpose: "task", workspaceId: task.workspaceId, operationId: task.operationId, fence: 2 });
    expect(WorkerInvocationSchema.parse(sent)).toEqual(sent);
    expect(ping.urls).toEqual(["http://10.0.0.1:8080/ping"]);
  });

  it("leaves the invocation byte-identical with no planner, another mode, a worker without the feature, a failing ping or planner, or the gate off", async () => {
    for (const [label, task, features, plan] of [
      ["no planner", invocation({ workflowMode: "CHECKS" }), pings().features, undefined],
      ["not CHECKS", invocation({ workflowMode: "IMPLEMENT" }), pings().features, planner()],
      ["no mode", invocation(), pings().features, planner()],
      ["worker lacks the feature", invocation({ workflowMode: "CHECKS" }), async () => ["task.workflowMode"], planner()],
      ["ping fails", invocation({ workflowMode: "CHECKS" }), async () => { throw new Error("down"); }, planner()],
      ["gate off", invocation({ workflowMode: "CHECKS" }), pings().features, planner(false)],
      ["planner throws", invocation({ workflowMode: "CHECKS" }), pings().features, async () => { throw new Error("kms"); }],
    ] as const) {
      const sent = await withProductModelPlan(task, "http://10.0.0.1:8080/ping", features, plan);
      expect(JSON.stringify(sent), label).toBe(JSON.stringify(task));
    }
  });

  it("does not ping the worker again unless a plan could be sent, and never forwards a plan stored on a queued invocation", async () => {
    const ping = pings();
    await withProductModelPlan(invocation({ workflowMode: "IMPLEMENT" }), "u", ping.features, planner());
    await withProductModelPlan(invocation({ workflowMode: "CHECKS" }), "u", ping.features, undefined);
    expect(ping.urls).toHaveLength(0);
    const stored = invocation({ workflowMode: "CHECKS", productModels: { capability: "pme-v1.stale.sig", functionArn: ARN } });
    const sent = await withProductModelPlan(stored, "u", ping.features, undefined);
    expect(sent.kind === "task" && sent.payload.productModels).toBe(undefined);
  });
});
