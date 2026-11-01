// Live interaction F2: the money path of a Public light diagnosis. Rovara pays for its own support, and only for its own AI: a turn routed to Rovara's AI gets a key that can call that route alone and
// spend a fixed small amount, counted against none of the customer's budgets (it does not even need the trial or machine-time admission, so a customer whose budget is spent can still be helped).
// A turn that routes anywhere else (the company's own source), a turn nobody asked Rovara to pay for, and every Enterprise turn are admitted and paid like any chat turn of the project.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DIAGNOSIS_LIGHT_BUDGET_USD, type OrgId } from "../../packages/contracts/src/index.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const routes = vi.hoisted(() => ({ sourceId: "rovara" }));
const admit = vi.hoisted(() => vi.fn(async (...args: unknown[]) => { void args; return { maxBudgetUsd: 1.5 }; }));
const minted = vi.hoisted(() => vi.fn(async (...args: unknown[]) => { void args; return { key: "fake-proxy-key", expiresAt: 4_000_000_000_000 }; }));
vi.mock("../../packages/broker/src/model-sources/routing.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  effectiveSources: async () => ({ stored: {}, order: ["rovara"] }),
  servingRoutes: async () => [{ alias: "the-model-alias", sourceId: routes.sourceId }],
  routeOnWire: () => undefined,
}));
vi.mock("../../packages/broker/src/aws/broker/scope-helpers.js", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), routingOf: () => ({}) }));
vi.mock("../../packages/broker/src/spend/admission.js", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), admitWork: admit }));
vi.mock("../../packages/broker/src/org/budget.js", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), mintKeyHealing: minted }));

import { mintChatTurnKey } from "../../packages/broker/src/aws/broker/model-access.js";
import type { AwsBrokerDependencies } from "../../packages/broker/src/aws/broker/definitions.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const dependencies = {
  documentClient: new FakeDynamoDb(), tableName: "state", agents: {}, cloud: true,
  modelAccess: { access: {}, proxyUrl: "https://proxy.example.invalid" },
} as unknown as AwsBrokerDependencies;

beforeEach(() => { admit.mockClear(); minted.mockClear(); routes.sourceId = "rovara"; });

describe("a Rovara-paid turn", () => {
  it("is let through unmetered on a fixed small key for Rovara's own AI, with no customer to bill and no admission", async () => {
    admit.mockRejectedValueOnce(new Error("the customer's budget is spent"));
    const key = await mintChatTurnKey(dependencies, ORG, "web", undefined, { turnId: "Ev1234567890" }, { rovaraPays: true });
    expect(key).toMatchObject({ apiKey: "fake-proxy-key", baseUrl: "https://proxy.example.invalid" });
    expect(admit).not.toHaveBeenCalled();
    expect(minted).toHaveBeenCalledTimes(1);
    const input = minted.mock.calls[0]![1] as Record<string, unknown>;
    expect(input).toMatchObject({ orgId: ORG, purpose: "turn", refId: "Ev1234567890", maxBudgetUsd: DIAGNOSIS_LIGHT_BUDGET_USD, models: ["the-model-alias"] });
    expect(input).not.toHaveProperty("developerId");
    expect(input).not.toHaveProperty("tags");
    expect(input["maxBudgetUsd"]).toBeLessThanOrEqual(0.5);
  });

  it("is paid like any chat turn when the route is not Rovara's own AI (the company's own source)", async () => {
    routes.sourceId = "company-bedrock";
    await mintChatTurnKey(dependencies, ORG, "web", undefined, { turnId: "Ev1234567890" }, { rovaraPays: true }).catch(() => undefined);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit.mock.calls[0]![1]).toMatchObject({ orgId: ORG, project: "web", payer: { kind: "project", project: "web" }, path: "CHAT" });
  });

  it("is never unmetered unless the caller asked for it: the ordinary turn is admitted against the project's budget first", async () => {
    await mintChatTurnKey(dependencies, ORG, "web", undefined, { turnId: "Ev1234567890" }).catch(() => undefined);
    expect(admit).toHaveBeenCalledTimes(1);
    const input = minted.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    if (input !== undefined) expect(input["maxBudgetUsd"]).not.toBe(DIAGNOSIS_LIGHT_BUDGET_USD);
  });
});
