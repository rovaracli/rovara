import { openRouterPolicy, type OpenRouterTariff } from "./openrouter-policy.js";
import type { RunPrice, TaskClaims } from "./model-gateway-token.js";
import type { ResolvedPrice } from "./price.js";
import { completePrice } from "./price-tiers.js";
import type { ChargeSource } from "./charge-producer.js";

/** The admitted account and effective tariff must fit the signed authorization. */
export function runPriceAllows(claims: TaskClaims, provider: string, model: string, source: ChargeSource | undefined, price: ResolvedPrice, now: number, tariffs?: readonly OpenRouterTariff[]): boolean {
  const grant: RunPrice | undefined = claims.runPrice;
  if (grant === undefined) return true; // Existing laptop and ordinary task tokens.
  if (grant.companyId !== claims.cid || claims.mdl.length !== 1 || grant.model !== claims.mdl[0] || grant.expiresAt <= now ||
      grant.provider !== provider || source?.source.provider !== provider || grant.catalogModel !== model || source === undefined || grant.sourceId !== source.source.id ||
      grant.connectionRevision !== source.source.connectionRevision || (provider === "openrouter" && openRouterPolicy(model, now, tariffs)?.hash !== grant.snapshotHash) || price.operatorReview ||
      (price.estimated && !price.knownTokenPrice) || price.priceVersion !== grant.snapshotVersion) return false;
  const completed = completePrice(price);
  return [completed, ...(completed.longContext ?? []).map((tier) => ({ ...completed, ...tier }))].every((r) =>
    r.inputMicrosPerMTok / 1_000_000 <= grant.inputUsdPerMillion && r.outputMicrosPerMTok / 1_000_000 <= grant.outputUsdPerMillion &&
    r.cacheReadMicrosPerMTok! / 1_000_000 <= grant.cacheReadUsdPerMillion &&
    Math.max(r.cacheWrite5mMicrosPerMTok!, r.cacheWrite1hMicrosPerMTok!) / 1_000_000 <= grant.cacheWriteUsdPerMillion);
}
