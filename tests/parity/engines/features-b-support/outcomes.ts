// Feature outcomes of the features-b drivers, in one vocabulary on both engines (`feature:<area>:<what>`).
//
// The harness's facets have no slot for a feature's own outcome (a token start's answer, the model a step ran on), so the drivers put these words in the
// AUDIT facet's extra list with the `feature:` prefix. Shared change asked of the parent: a `features` facet (Observation.features, FACETS) to carry
// them instead. Until the audit facet is observed on both engines, these words are written but not compared.
export const outcome = (area: string, what: string): string => `feature:${area}:${what}`;

/** An HTTP status in the outcome words: only its class matters (both paths answer a refused token with 403; a created task is 200 or 201). */
export function statusClass(status: number): string {
  if (status === 200 || status === 201) return "ok";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status >= 400 && status < 500) return `refused_${String(status)}`;
  return `error_${String(status)}`;
}

/** With PARITY_FEATURES_LOG set, each engine's words are appended there as one JSON line (the suite hides a passing test's console). */
export async function logWords(engine: string, scenario: string, words: readonly string[]): Promise<void> {
  const file = process.env.PARITY_FEATURES_LOG;
  if (file === undefined || file === "") return;
  const { appendFile } = await import("node:fs/promises");
  await appendFile(file, `${JSON.stringify({ engine, scenario, words })}\n`);
}
