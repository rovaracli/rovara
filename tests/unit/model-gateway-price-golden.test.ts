import { beforeAll, expect, it } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
import { UnknownPriceSource, resolvePrice } from "../../packages/model-gateway/src/price.js";
import { estimateCall } from "../../packages/model-gateway/src/estimate.js";
import { InMemoryPriceSnapshotStore } from "../../packages/model-gateway/src/price-snapshot.js";
import { SnapshotPriceSource } from "../../packages/model-gateway/src/price-index.js";
import { call, setup, scope, requestBody, answer } from "./model-gateway-fixture.js";
beforeAll(denyNetwork);
it("empty snapshot and UnknownPriceSource preserve flat R3a holds byte for byte", async () => {
  const prices = new SnapshotPriceSource(new InMemoryPriceSnapshotStore()); await prices.reload();
  for (const source of [UnknownPriceSource, prices]) {
    const price = await resolvePrice(source, "anthropic", requestBody.model!);
    expect(JSON.stringify(price)).toBe('{"inputMicrosPerMTok":100000000,"outputMicrosPerMTok":100000000,"estimated":true}');
    for (const [bytes, max, golden] of [[106, 10, 11600], [1024, 128000, 12902400], [4194304, 128000, 432230400]]) expect(estimateCall(bytes!, max!, price)).toBe(golden);
    const f = setup({ prices: source }); let hold = 0;
    f.deps.transport = async () => { hold = (await f.meter.read(scope))[0]!.reservedMicros; return { status: 200, body: answer() }; };
    expect((await call(f.deps)).status).toBe(200); expect(hold).toBe(11600); expect((await f.meter.read(scope))[0]?.spentMicros).toBe(1400);
  }
});
