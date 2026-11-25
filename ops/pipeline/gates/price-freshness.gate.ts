// Gate (L6): the gateway's price snapshot is fresh (BETA-CLOUD-PLAN 3.6): a successful price fetch inside the last 48 hours. When it is not, the gate runs the
// price-fetch task once with the schedule's own settings (never in a dry run: there it reports `skipped` with what a real run would do) (the new image's fetch is part of what the proof proves) and checks again; if the task cannot run, fails,
// or still leaves nothing fresh, the gate refuses with the reason.
import { errorText } from "../lib/context.ts";
import { PRICE_MAX_AGE_MS, locatePriceFetch, newestFetch, runPriceFetchOnce } from "../lib/price-fetch.ts";
import type { Gate } from "../types.ts";

const hours = (ms: number): string => `${Math.round(ms / 360_000) / 10} h`;

export const gate: Gate = {
  name: "price-freshness",
  phases: ["proof"],
  async run(input) {
    const { ports } = input;
    const now = ports.clock.now().getTime();
    const resources = await locatePriceFetch(ports, input.config, input.env, input.region, input.manifest.exec8);
    const last = await newestFetch(ports, resources.logGroup, now - PRICE_MAX_AGE_MS);
    if (last !== null) {
      input.log(`last successful price fetch ${hours(now - last)} ago`);
      return { result: "pass", data: { lastFetchedAt: new Date(last).toISOString(), ageHours: Math.round((now - last) / 360_000) / 10 } };
    }
    const stale = `prices are stale: no successful price fetch in the last ${PRICE_MAX_AGE_MS / 3_600_000} h`;
    // A dry run never starts the task: a non-pass status that says what a real run would do (never a silent pass).
    if (input.dryRun === true) return { result: "skipped", skippedReason: `stale: a real run would run the price-fetch task once and refuse if the prices are still stale (${stale})` };
    input.log("no successful price fetch in the last 48 h: running the price-fetch task once");
    try {
      // One token per gate invocation (execution + step + start time): a CLI retry of the call reuses it, a deliberate re-run of the proof does not.
      await runPriceFetchOnce(ports, resources, `rovara-price-${input.manifest.exec8}-proof-${now}`, input.log);
    } catch (error) {
      return { result: "fail", failures: [`${stale}, and the one-off price fetch did not succeed: ${errorText(error)}. Check the price-fetch alarm and the task's log group, fix the cause, run the fetch, then re-run the proof.`] };
    }
    // The task logs `price_fetched` just before it exits 0; log delivery can lag a little.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const fresh = await newestFetch(ports, resources.logGroup, now);
      if (fresh !== null) return { result: "pass", notes: ["prices were stale; a one-off price fetch refreshed them"], data: { lastFetchedAt: new Date(fresh).toISOString(), refreshed: true } };
      await ports.clock.sleep(15_000);
    }
    return { result: "fail", failures: [`${stale}; the one-off price fetch exited 0 but no price_fetched event followed it in the log. Look at the task's log group before deploying on these prices.`] };
  },
};
