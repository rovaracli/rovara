// S3-9 review H1c / M1: the CoreTierChecks function's handler answers only the tier pass's event, with the function's own time left as the pass's cap; a host that cannot be built throws (the Errors alarm), never a quiet skip.
import { describe, expect, it, vi } from "vitest";
import { createCoreTierChecksHandler, coreTierChecksHostFrom } from "../../packages/broker/src/aws/broker/core-tier-checks.js";

describe("the tier pass's function", () => {
  it("runs the tier pass with Lambda's time left, builds its root once, and refuses every other event without building anything", async () => {
    const handleScheduledJob = vi.fn(async () => ({ job: "tier-checks", companies: [] }));
    const build = vi.fn(() => ({ handleScheduledJob }));
    const logs: Array<Record<string, unknown>> = [];
    const handler = createCoreTierChecksHandler(build, (entry) => { logs.push(entry); });
    for (const event of [{ source: "agentx.core-job", job: "merge-tracking" }, { source: "agentx.core-job", job: "dispatch-sweep" }, { source: "aws.events" }, { requestContext: {} }]) {
      expect(await handler(event), JSON.stringify(event)).toEqual({ skipped: "not_this_host" });
    }
    expect(build).not.toHaveBeenCalled();
    expect(logs).toContainEqual(expect.objectContaining({ event: "core_tier_checks.refused" }));
    const event = { source: "agentx.core-job", job: "tier-checks" };
    await handler(event, { getRemainingTimeInMillis: () => 899_000 });
    await handler(event, { getRemainingTimeInMillis: () => 600_000 });
    expect(build).toHaveBeenCalledTimes(1);
    expect(handleScheduledJob.mock.calls).toEqual([[event, { remainingMs: 899_000 }], [event, { remainingMs: 600_000 }]]);
  });

  it("no Cloud root (the install gives no core inputs): throws, so the function's errors show", async () => {
    const handler = createCoreTierChecksHandler(() => undefined, () => undefined);
    await expect(handler({ source: "agentx.core-job", job: "tier-checks" })).rejects.toThrow(/no Cloud root/u);
    expect(coreTierChecksHostFrom({} as never)).toBeUndefined();
  });
});
