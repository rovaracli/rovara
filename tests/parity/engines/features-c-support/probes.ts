// Features-C lane: route probes. Most of areas 27-34 are surfaces a person reads or acts on (a panel, a check, a list), not task transitions. A probe asks
// the same route on both engines, as the task's owner, and records a normalized outcome word: `<feature> <METHOD> <path> -> <status> <what>`, where <what>
// is the error code or the answer's top-level keys (sorted). Words go to the `features` list of the engine's `extra` (the shared facet that reads it is the
// shared change this lane asks for; see known-differences/features-c.ts).

/** The routes each feature is probed on (identical paths on both sides, so a missing route on one side shows as a 404 there). */
export const FEATURE_PROBES: Readonly<Record<string, readonly { method: "GET" | "POST"; path: string; body?: unknown }[]>> = {
  "saved-env": [{ method: "GET", path: "/v1/app/projects/payments/environment-image" }],
  "test-services": [{ method: "GET", path: "/v1/app/projects/payments/test-environment" }],
  "setup-agent": [{ method: "GET", path: "/v1/app/projects/payments/setup-agent" }],
  playbook: [{ method: "GET", path: "/v1/app/projects/payments/playbook" }],
  // The company list (Cloud) and one diagnosis by id (both hosted and laptop routes read one); the id is unknown, so the answer is the refusal.
  diagnosis: [{ method: "GET", path: "/v1/app/diagnoses" }, { method: "GET", path: "/v1/app/diagnoses/dgn_00000000000000000000" }],
  // Cloud serves the company's connections at /v1/app/connections, the core at /v1/dev/connections: both paths are asked on both sides.
  connections: [{ method: "GET", path: "/v1/app/connections" }, { method: "GET", path: "/v1/dev/connections" }],
};

/** The outcome word of one answer: the error code, else the answer's top-level keys. */
export function outcomeWord(feature: string, probe: { method: string; path: string }, status: number, body: unknown): string {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const error = record.error as { code?: unknown } | undefined;
  // `requestId` is Cloud's answer envelope (every Cloud route adds it), not the feature's answer: left out of the keys.
  const what = error !== undefined && typeof error === "object" ? `error:${String(error.code)}` : `keys:${Object.keys(record).filter((key) => key !== "requestId").sort().join(",")}`;
  return `${feature} ${probe.method} ${probe.path} -> ${String(status)} ${what}`;
}

/** The `features` list on an engine's `extra` (added here, read by the shared facet once it exists). */
export function featureWords(extra: object): string[] {
  const holder = extra as { features?: string[] };
  holder.features ??= [];
  return holder.features;
}

export const parse = (text: string): unknown => {
  try { return JSON.parse(text) as unknown; } catch { return { error: { code: "NOT_JSON" } }; }
};

/** Records a word, and prints it with PARITY_DEBUG=1 (the shared `features` facet does not exist yet, so this is how the lane reads its outcomes). */
export function note(extra: object, engine: string, word: string): void {
  featureWords(extra).push(word);
  if (process.env.PARITY_DEBUG === "1") console.log(JSON.stringify({ parity: "features-c", engine, word }));
}
