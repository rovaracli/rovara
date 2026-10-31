// Service mocks (E8, owner decision Q9): new mock answers for the cases a change introduces. Two ways to make one, both explicit and both listed in the evidence:
//   from the schema: the request must satisfy the base set's request schema and the base set must have a response schema; the answer is a deterministic synthetic one, stored as a real entry (so a later run
//                    serves exactly the same bytes and the evidence can name it);
//   from pre-prod:   recorded exactly as the base recorder does (inputs scanned before anything is sent, no 5xx recorded, answers scanned again).
// A request the base set already answers is never added (the pinned recording wins). Everything is bounded by `SERVICE_MOCK_ADDITIONS_MAX`.
import {
  SERVICE_MOCK_ADDITIONS_MAX,
  ServiceMockAdditionSetSchema,
  serviceMockFixtureSetDigest,
  type DataGuardReport,
  type ServiceMockAdditionSet,
  type ServiceMockFixtureSet,
  type TestEnvProdDeny,
} from "@agentx/contracts";
import { createSyntheticGenerator, guardInputs } from "../data-guard.js";
import { hashOfRequest } from "./fixture-set.js";
import { recordFixtureSet, type RecordInput, type RecordedResponse } from "./recorder.js";
import { schemaAccepts, synthesizeFromSchema } from "./schema.js";

export type AdditionFailure = "no_inputs" | "too_many" | "no_response_schema" | "request_not_in_schema" | "not_json" | "already_recorded" | "recording_failed";
export type AdditionOutcome =
  | { ok: true; set: ServiceMockAdditionSet }
  | { ok: false; reason: AdditionFailure; at?: number }
  | { ok: false; reason: "data_guard"; report: DataGuardReport };

const empty = (base: ServiceMockFixtureSet, now: Date): ServiceMockAdditionSet => ({ schemaVersion: 1, service: base.service.name, baseFixtureDigest: serviceMockFixtureSetDigest(base), createdAt: now.toISOString(), additions: [] });

/** New answers made from the base set's schemas, for requests the change introduces. Refuses the whole batch on the first request it cannot answer, and says which one (its index). */
export function additionsFromSchema(base: ServiceMockFixtureSet, requests: readonly RecordInput[], deny: TestEnvProdDeny, now: Date): AdditionOutcome {
  if (requests.length === 0) return { ok: false, reason: "no_inputs" };
  if (requests.length > SERVICE_MOCK_ADDITIONS_MAX) return { ok: false, reason: "too_many" };
  if (base.responseSchema === null) return { ok: false, reason: "no_response_schema" };
  const guard = guardInputs(requests.map((request, index) => ({ source: "fixture" as const, path: `requests[${String(index)}]`, text: `${request.pathAndQuery}\n${request.body}` })), deny);
  if (!guard.ok) return { ok: false, reason: "data_guard", report: guard };
  const taken = new Set(base.entries.map((entry) => entry.requestHash));
  const additions: ServiceMockAdditionSet["additions"] = [];
  for (const [index, request] of requests.entries()) {
    const requestHash = hashOfRequest(base, request);
    if (taken.has(requestHash)) return { ok: false, reason: "already_recorded", at: index };
    taken.add(requestHash);
    let parsed: unknown;
    try { parsed = JSON.parse(request.body) as unknown; } catch { return { ok: false, reason: "not_json", at: index }; }
    if (base.requestSchema !== null && !schemaAccepts(base.requestSchema, parsed)) return { ok: false, reason: "request_not_in_schema", at: index };
    const body = JSON.stringify(synthesizeFromSchema(base.responseSchema, createSyntheticGenerator(parseInt(requestHash.slice(0, 7), 16))));
    additions.push({ origin: "schema", entry: { requestHash, request: { contentType: request.contentType, body: request.body }, response: { status: 200, contentType: "application/json", body, latencyMs: 0 } } });
  }
  const set = ServiceMockAdditionSetSchema.safeParse({ ...empty(base, now), additions });
  return set.success ? { ok: true, set: set.data } : { ok: false, reason: "recording_failed" };
}

/** New answers recorded from pre-prod for requests the change introduces: the base recorder's rules apply, and an input the base set already answers is refused. */
export async function additionsFromPreprod(
  base: ServiceMockFixtureSet,
  requests: readonly RecordInput[],
  context: { deny: TestEnvProdDeny; now(): Date; send(request: RecordInput, signal: AbortSignal): Promise<RecordedResponse> },
): Promise<AdditionOutcome> {
  if (requests.length > SERVICE_MOCK_ADDITIONS_MAX) return { ok: false, reason: "too_many" };
  const taken = new Set(base.entries.map((entry) => entry.requestHash));
  const clash = requests.findIndex((request) => taken.has(hashOfRequest(base, request)));
  if (clash >= 0) return { ok: false, reason: "already_recorded", at: clash };
  const outcome = await recordFixtureSet({ service: base.service, revision: base.revision, inputs: requests, deny: context.deny, now: () => context.now(), send: (request, signal) => context.send(request, signal) });
  if (!outcome.ok) return outcome.reason === "data_guard" ? { ok: false, reason: "data_guard", report: outcome.report } : { ok: false, reason: outcome.reason === "no_inputs" ? "no_inputs" : "recording_failed" };
  const set = ServiceMockAdditionSetSchema.safeParse({ ...empty(base, context.now()), additions: outcome.set.entries.map((entry) => ({ origin: "preprod" as const, entry })) });
  return set.success ? { ok: true, set: set.data } : { ok: false, reason: "recording_failed" };
}
