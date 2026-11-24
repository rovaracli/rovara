// Meta repo lane B, task B1: the setup agent's proposal contract and the reader that turns a model's answer into one (the worker and the broker both run it).
import { describe, expect, it } from "vitest";
import { SetupApplyBodySchema, SetupDraftResponseSchema, SetupDraftSchema } from "../../packages/contracts/src/index.js";

describe("the proposal contract", () => {

  it("still parses a version 1 draft exactly as the earlier code stored it, and the page's answer no longer carries one", () => {
    const stored = { basedOnRevision: 1, setupCommands: ["npm ci"], testCommands: ["npm test"], allowedDomains: [], secretsNeeded: [], flaggedCommands: [], notes: "" };
    expect(SetupDraftSchema.safeParse(stored).success).toBe(true);
    expect(SetupDraftResponseSchema.safeParse({ status: "ready", basedOnRevision: 1, draft: stored }).success).toBe(false);
  });

  it("takes exactly the items it names, each once, in a body", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(SetupApplyBodySchema.safeParse({ requestId: id, expectedRevision: 1, items: [{ id: "setup-web" }] }).success).toBe(true);
    expect(SetupApplyBodySchema.safeParse({ requestId: id, expectedRevision: 1, items: [] }).success).toBe(false);
    expect(SetupApplyBodySchema.safeParse({ requestId: id, expectedRevision: 1, items: [{ id: "setup-web" }, { id: "setup-web" }] }).success).toBe(false);
    expect(SetupApplyBodySchema.safeParse({ requestId: id, expectedRevision: 1, items: [{ id: "setup-web", include: true }] }).success).toBe(false);
    expect(SetupApplyBodySchema.safeParse({ requestId: id, expectedRevision: 1, items: [{ id: "Setup Web" }] }).success).toBe(false);
  });
});
