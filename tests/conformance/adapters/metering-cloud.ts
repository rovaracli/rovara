// Convergence lane A5: Cloud's Metering adapter under Code's metering conformance suite.
import { MemoryDocumentStore } from "@rovara-code/broker/ports";
import type { MeterEntry } from "@rovara-code/contracts";
import { createCloudMetering } from "../../../packages/broker/src/cloud-adapters/money/index.js";
import { defineCloudAdapter } from "../registry.js";
import { MONEY_COMPANY, MONEY_PRICES } from "./money-world.js";

export const cloudMetering = defineCloudAdapter({
  port: "metering",
  name: "Cloud meter rows",
  harness: {
    create: async () => createCloudMetering({ store: new MemoryDocumentStore(), prices: MONEY_PRICES }),
    known: { provider: "bedrock", modelId: "model-a", tokens: { input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0 } },
    unknown: { provider: "other", modelId: "model-z", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
    entry: (usage): MeterEntry => ({ companyId: MONEY_COMPANY, entryId: "e1", at: "2026-11-09T10:00:00.000Z", usage, taskId: "t1" }),
  },
});
