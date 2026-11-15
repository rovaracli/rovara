import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, expect, it } from "vitest";
import { InMemoryMeter, runMeterConformance } from "../../packages/model-gateway/src/meter.js";
it("runs the reusable meter adapter conformance suite", async () => { expect((await runMeterConformance((clock) => new InMemoryMeter(clock))).length).toBeGreaterThanOrEqual(6); });

it("conformance includes the company marker and its independent hold lifetime", async () => {
  const results = await runMeterConformance((clock) => new InMemoryMeter(clock));
  expect(results).toContain("one overrun in flight"); expect(results).toContain("marker expiry keeps hold");
});
it("conformance includes estimated atomic settlement and delta correction", async () => {
  const results = await runMeterConformance((clock) => new InMemoryMeter(clock));
  expect(results).toContain("atomic estimated ledger"); expect(results).toContain("idempotent correction"); expect(results).toContain("correction frees budget");
});
