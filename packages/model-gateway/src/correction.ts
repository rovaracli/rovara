import { record, whole } from "./model-gateway-token.js";
import { CORRECTION_RUN_MAX, CORRECTION_RUN_MS } from "./price-constants.js";
import { usageCost } from "./estimate.js";
import { validCaps, type CapsSource } from "./caps.js";
import { validPrice, type PriceOrigin, type PriceSource } from "./price.js";
import type { Meter } from "./meter.js";
export interface CorrectionReport { corrected: number; already: number; skipped: number; expired: number; more: boolean }
export interface CorrectionLog { event: "price_corrected" | "price_expired" | "price_correction_busy"; deltaMicros?: number }
export async function runCorrections(options: { meter: Meter; prices: PriceSource; caps: CapsSource; now: number; runId: string; log?: (line: CorrectionLog) => void; clock?: () => number }): Promise<CorrectionReport> {
  const report: CorrectionReport = { corrected: 0, already: 0, skipped: 0, expired: 0, more: false };
  const clock = options.clock ?? performance.now.bind(performance); const deadline = clock() + CORRECTION_RUN_MS;
  let visited = 0;
  let rejectDeadline!: (reason: Error) => void;
  const expired = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  void expired.catch(() => undefined);
  const timer = setTimeout(() => rejectDeadline(new Error("correction deadline")), CORRECTION_RUN_MS);
  const wait = async <T>(operation: T | Promise<T>): Promise<T> => Promise.race([Promise.resolve(operation), expired]);
  const log = (line: CorrectionLog) => { try { options.log?.(line); } catch { /* No effect on the transaction. */ } };
  try {
    const keys = await wait(options.meter.pendingKeys(CORRECTION_RUN_MAX + 1));
    for (const key of keys) {
      if (clock() >= deadline || visited >= CORRECTION_RUN_MAX) { report.more = true; break; }
      const price = await wait(options.prices.priceFor(key.provider, key.model));
      if (!validPrice(price)) { report.skipped++; continue; }
      const rawOrigin = record(record(price)?.origin);
      if (rawOrigin === undefined || !["litellm", "aws", "override"].includes(String(rawOrigin.source)) || !whole(rawOrigin.fetchedAt)) { report.skipped++; continue; }
      const priceSource: PriceOrigin = { source: rawOrigin.source as PriceOrigin["source"], fetchedAt: rawOrigin.fetchedAt };
      const pending = await wait(options.meter.pendingFor(key, CORRECTION_RUN_MAX - visited + 1));
      for (const call of pending) {
        if (clock() >= deadline || visited >= CORRECTION_RUN_MAX) { report.more = true; break; }
        visited++;
        const caps = await wait(options.caps.capsFor(call));
        if (!validCaps(caps)) { report.skipped++; report.more = true; continue; }
        if (clock() >= deadline) { report.more = true; break; }
        const realMicros = Math.max(1, usageCost(call.usage, price));
        const result = await options.meter.correct({ callKey: call.callKey, realMicros, caps, priceSource, now: options.now, runId: options.runId });
        if (result.status === "corrected") { report.corrected++; log({ event: "price_corrected", deltaMicros: result.deltaMicros }); }
        else if (result.status === "already") report.already++;
        else if (result.status === "expired") { report.expired++; log({ event: "price_expired" }); }
        else { report.skipped++; report.more = true; if (result.status === "busy") log({ event: "price_correction_busy" }); }
      }
    }
    if (keys.length > CORRECTION_RUN_MAX) report.more = true;
  } catch { report.more = true; }
  finally { clearTimeout(timer); }
  return report;
}
