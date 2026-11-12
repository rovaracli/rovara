// Convergence lane A5: what the money adapters' conformance harnesses share. Each harness builds its adapter over a fresh in-memory copy of Code's document store
// (no AWS), with one company, a member and a project whose month budget is $10.
import { MemoryDocumentStore } from "@rovara-code/broker/ports";
import type { AdmissionRequest, PriceTable } from "@rovara-code/contracts";
import { createCloudAdmission, type AdmissionLevel, type CloudAdmission } from "../../../packages/broker/src/cloud-adapters/money/index.js";

export const MONEY_COMPANY = "org_a5moneyconformance00";
export const MONEY_PRICES: PriceTable = { currency: "USD", models: { "bedrock/model-a": { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 } } };

/** The org's $10 a month and the member's budget with no limit. */
export const MONEY_LEVELS: readonly AdmissionLevel[] = [{ scope: "ORG", kind: "org", limitUsd: 10 }, { scope: "MEMBER#dev-1", kind: "member", limitUsd: undefined }];

export function moneyAdmission(store = new MemoryDocumentStore()): CloudAdmission {
  return createCloudAdmission({
    store,
    levels: async () => MONEY_LEVELS,
    actions: { "task.start": { kind: "room", minimumUsd: 0.5 }, "model.call": { kind: "hold", unknownCostUsd: 2 } },
  });
}

/** A model call estimated at $1: fits the $10 month. */
export const admissibleCall: AdmissionRequest = { companyId: MONEY_COMPANY, idempotencyKey: "k", action: "model.call", projectName: "web", estimate: { cost: { micros: 1_000_000, currency: "USD" } } };
/** A model call estimated at $11: more than the whole month. */
export const refusedCall: AdmissionRequest = { ...admissibleCall, idempotencyKey: "r", estimate: { cost: { micros: 11_000_000, currency: "USD" } } };
