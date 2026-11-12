// Convergence lane A5: the one conversion between Code's ports and Cloud's money rows. Code's `Cost` is a whole number of millionths of a currency unit;
// Cloud's spend rows (`SPEND_COUNTER` `committedUsd`/`spentUsd`, `MODEL_KEY` `capUsd`, budgets and top-ups) are US dollars cleaned to six decimals
// (`spend/top-ups.ts#cleanUsd`). Six decimals of a dollar is exactly one millionth, so the two are the same precision and convert without rounding loss.
import type { Cost } from "@rovara-code/contracts";
import { cleanUsd } from "../../spend/top-ups.js";

/** Cloud's only currency. A cost in another currency is never converted (there is no rate to trust) and never read as zero. */
export const CLOUD_CURRENCY = "USD";

/** Whether this is a cost Cloud can count: US dollars, a whole, non-negative, exactly representable number of millionths. */
export function isCountableCost(cost: Cost | undefined): cost is Cost {
  return cost !== undefined && cost.currency === CLOUD_CURRENCY && Number.isSafeInteger(cost.micros) && cost.micros >= 0;
}

/** Millionths of a dollar as Cloud's dollar figure (exact: `cleanUsd` keeps six decimals). */
export const microsToUsd = (micros: number): number => cleanUsd(micros / 1_000_000);

/** A Cloud dollar figure as whole millionths. The figure is cleaned first, so float dust (0.1 + 0.2) is the millionth it stands for. */
export const usdToMicros = (usd: number): number => Math.round(cleanUsd(usd) * 1_000_000);

/** A Cloud dollar figure as a port `Cost`. */
export const usdCost = (usd: number): Cost => ({ micros: usdToMicros(usd), currency: CLOUD_CURRENCY });
