// Manual staging-only check. Never imported by tests; saves nothing and never retries.
// Run after building: ROVARA_LIVE_PRICE_CHECK=1 npx tsx scripts/model-gateway-prices-live-check.ts
import { fetchAWS, fetchLiteLLM, fetchTransport } from "../packages/model-gateway/src/price-sources.js";
if (process.env.ROVARA_LIVE_PRICE_CHECK !== "1") {
  console.error("Live price check refused: explicit opt-in required."); process.exitCode = 2;
} else {
  const now = Date.now(); const transport = fetchTransport(fetch);
  const results = await Promise.all([fetchLiteLLM(transport, { now }), fetchAWS(transport, { now })]);
  for (const [index, source] of ["litellm", "aws"].entries()) {
    const result = results[index]!;
    console.log(JSON.stringify(result.ok ? { source, count: result.entries.length, ageMs: Date.now() - now, skipped: result.report.skipped, ignoredLower: result.report.ignoredLower, anthropicSkipped: result.report.anthropicSkipped ?? {} } : { source, status: "refresh failed" }));
  }
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}
