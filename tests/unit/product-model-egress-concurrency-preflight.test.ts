// TE-F1e fix round 1 (89's staging read): the install refuses, before any write, a product model egress reservation the account's Lambda concurrency cannot take with Lambda's unreserved floor of 100 left.
import { describe, expect, it } from "vitest";
import { PRODUCT_MODEL_CONCURRENCY_REFUSAL, productModelConcurrencyPreflight, readLambdaConcurrency } from "../../packages/cli/src/deploy/product-model-concurrency-preflight.js";

describe("product model egress concurrency preflight", () => {
  it("allows staging's shape (quota 1000, 12 reserved elsewhere: 988 unreserved, 968 after 20)", () => {
    expect(productModelConcurrencyPreflight({ unreserved: 988, reservation: 20, alreadyReservedByFunction: 0 })).toEqual({ ok: true });
  });

  it("refuses with the fixed reason when unreserved minus the reservation is under 100, as on a new account of quota 10", () => {
    for (const unreserved of [10, 100, 119]) expect(productModelConcurrencyPreflight({ unreserved, reservation: 20, alreadyReservedByFunction: 0 })).toEqual({ ok: false, reason: PRODUCT_MODEL_CONCURRENCY_REFUSAL });
    expect(productModelConcurrencyPreflight({ unreserved: 120, reservation: 20, alreadyReservedByFunction: 0 })).toEqual({ ok: true });
    expect(PRODUCT_MODEL_CONCURRENCY_REFUSAL).not.toMatch(/\d{12}/u);
  });

  it("counts the function's own current reservation as already taken (an upgrade does not need it twice)", () => {
    expect(productModelConcurrencyPreflight({ unreserved: 100, reservation: 20, alreadyReservedByFunction: 20 })).toEqual({ ok: true });
    expect(productModelConcurrencyPreflight({ unreserved: 100, reservation: 30, alreadyReservedByFunction: 20 })).toEqual({ ok: false, reason: PRODUCT_MODEL_CONCURRENCY_REFUSAL });
  });

  it("refuses a value it cannot read as a whole number (fails closed)", () => {
    for (const unreserved of [Number.NaN, -1, 1.5]) expect(productModelConcurrencyPreflight({ unreserved, reservation: 20, alreadyReservedByFunction: 0 }).ok).toBe(false);
  });

  it("reads GetAccountSettings' UnreservedConcurrentExecutions and the function's own reservation (absent function: 0)", async () => {
    const sent: string[] = [];
    const lambda = {
      send: async (command: { constructor: { name: string } }) => {
        sent.push(command.constructor.name);
        if (command.constructor.name === "GetAccountSettingsCommand") return { AccountLimit: { UnreservedConcurrentExecutions: 988 } };
        throw Object.assign(new Error("Function not found"), { name: "ResourceNotFoundException" });
      },
    };
    expect(await readLambdaConcurrency(lambda as never, "agentx-staging-product-model-egress")).toEqual({ unreserved: 988, alreadyReservedByFunction: 0 });
    expect(sent).toEqual(["GetAccountSettingsCommand", "GetFunctionConcurrencyCommand"]);
  });
});

describe("the preflight's reservation", () => {
  it("is the template's default for ProductModelEgressReservedConcurrency", async () => {
    const { PRODUCT_MODEL_EGRESS_DEFAULT_RESERVED_CONCURRENCY } = await import("../../packages/cli/src/deploy/product-model-concurrency-preflight.js");
    const { PRODUCT_MODEL_EGRESS_RESERVED_CONCURRENCY } = await import("../../infra/lib/product-model-egress.js");
    expect(PRODUCT_MODEL_EGRESS_DEFAULT_RESERVED_CONCURRENCY).toBe(PRODUCT_MODEL_EGRESS_RESERVED_CONCURRENCY);
  });
});
