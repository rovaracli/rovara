// Service mocks (design proof-test-env, section 4.6): the shapes of a recorded fixture set, the schema inferred from it, what a mock does with a request it has no recording for, and what a
// mock reports back so the evidence names every mocked service honestly. The mock server itself is the verifier's (`verifier/src/service-mocks/*`); this module is what it, the recorder, the
// broker and the evidence all read the same way. Nothing here imports a Node module.
//
// What it guarantees:
//   - a fixture is addressed by the hash of its canonical request, so the same request always finds the same recording and a re-ordered JSON body is the same request;
//   - every list, body and schema is bounded (a recorded body is at most 64 KiB, a set holds at most 500 entries, a schema at most 32 levels deep and 2,048 nodes);
//   - an unmatched request is `fail` unless the maintainer chose `schema_synth`, and either way it is counted (`ServiceMockUsageSchema`), so "mock answered 3 unrecorded requests" is always true;
//   - a fixture that holds personal data or names production is refused by the data guard before it is stored (that check is the verifier's; its report shape is in test-environment.ts).
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { TEST_ENV_SERVICE_KINDS, TEST_ENV_UNMATCHED } from "./test-environment.js";
import { sha256Hex } from "./web-hash.js";

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
function line(max: number, min = 1) {
  return z.string().min(min).max(max).regex(NO_HIDDEN, "one plain line");
}
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const SERVICE_MOCK_ENTRIES_MAX = 500;
export const SERVICE_MOCK_BODY_MAX_BYTES = 65_536;
export const SERVICE_MOCK_FAULTS_MAX = 20;
export const SERVICE_MOCK_SCHEMA_MAX_DEPTH = 32;
export const SERVICE_MOCK_SCHEMA_MAX_NODES = 2_048;
export const SERVICE_MOCK_LATENCY_MAX_MS = 30_000;

/** What an unmatched request is answered with when the mode is `fail`: a 500 and these words, so the case fails as "mock had no recording". */
export const SERVICE_MOCK_UNMATCHED_STATUS = 500;
export const SERVICE_MOCK_NO_RECORDING_MESSAGE = "mock had no recording";

/** A JSON schema as the recorder infers it: the small subset the OpenAPI fixtures already use (`E2EFixtureSchema`), bounded in depth and size. */
export interface ServiceMockJsonSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, ServiceMockJsonSchema> | undefined;
  required?: string[] | undefined;
  items?: ServiceMockJsonSchema | undefined;
  enum?: Array<string | number | boolean> | undefined;
  format?: "date" | "date-time" | "email" | "uuid" | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  minItems?: number | undefined;
  maxItems?: number | undefined;
  additionalProperties?: false | undefined;
}

const JsonSchemaNodeSchema: z.ZodType<ServiceMockJsonSchema> = z.lazy(() =>
  z
    .object({
      type: z.enum(["object", "array", "string", "number", "integer", "boolean", "null"]),
      properties: z.record(z.string().max(128), JsonSchemaNodeSchema).optional(),
      required: z.array(z.string().max(128)).max(256).optional(),
      items: JsonSchemaNodeSchema.optional(),
      enum: z.array(z.union([z.string().max(256), z.number(), z.boolean()])).max(64).optional(),
      format: z.enum(["date", "date-time", "email", "uuid"]).optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      minLength: z.number().int().min(0).optional(),
      maxLength: z.number().int().min(0).optional(),
      minItems: z.number().int().min(0).optional(),
      maxItems: z.number().int().min(0).optional(),
      additionalProperties: z.literal(false).optional(),
    })
    .strict(),
);

function schemaBudget(schema: ServiceMockJsonSchema, depth: number, counter: { nodes: number }): boolean {
  counter.nodes += 1;
  if (depth > SERVICE_MOCK_SCHEMA_MAX_DEPTH || counter.nodes > SERVICE_MOCK_SCHEMA_MAX_NODES) return false;
  for (const child of [...Object.values(schema.properties ?? {}), ...(schema.items === undefined ? [] : [schema.items])]) {
    if (!schemaBudget(child, depth + 1, counter)) return false;
  }
  return true;
}

export const ServiceMockJsonSchemaSchema: z.ZodType<ServiceMockJsonSchema> = JsonSchemaNodeSchema.refine((schema) => schemaBudget(schema, 1, { nodes: 0 }), "a schema is at most 32 levels deep and 2,048 nodes");

const BodySchema = z.string().max(SERVICE_MOCK_BODY_MAX_BYTES).refine((text) => new TextEncoder().encode(text).length <= SERVICE_MOCK_BODY_MAX_BYTES, "a recorded body is at most 64 KiB");

/** A fault a scenario may ask for by name: a timeout, a 5xx or a throttle. Without one, a claim like "a timeout falls back" is shown as not tested. */
export const SERVICE_MOCK_FAULT_KINDS = ["timeout", "http_5xx", "throttle"] as const;
export const ServiceMockFaultSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
    kind: z.enum(SERVICE_MOCK_FAULT_KINDS),
    /** The status a `http_5xx` or `throttle` fault answers with. */
    status: z.number().int().min(400).max(599).optional(),
    delayMs: z.number().int().min(0).max(SERVICE_MOCK_LATENCY_MAX_MS),
  })
  .strict()
  .refine((fault) => (fault.kind === "timeout") === (fault.status === undefined), { message: "a timeout has no status and the other faults have one", path: ["status"] });
export type ServiceMockFault = z.infer<typeof ServiceMockFaultSchema>;

export const ServiceMockEntrySchema = z
  .object({
    /** `serviceMockRequestHash` of the request. */
    requestHash: Sha256Schema,
    request: z.object({ contentType: line(100), body: BodySchema }).strict(),
    response: z.object({ status: z.number().int().min(100).max(599), contentType: line(100), body: BodySchema, latencyMs: z.number().int().min(0).max(SERVICE_MOCK_LATENCY_MAX_MS) }).strict(),
  })
  .strict();
export type ServiceMockEntry = z.infer<typeof ServiceMockEntrySchema>;

/** One recorded fixture set: what a maintainer approves (by digest) and the mock serves. */
export const ServiceMockFixtureSetSchema = z
  .object({
    schemaVersion: z.literal(1),
    service: z.object({ name: line(80), kind: z.enum(TEST_ENV_SERVICE_KINDS), target: line(253) }).strict(),
    revision: z.number().int().min(1),
    recordedAt: z.string().datetime(),
    /** Recorded from the project's synthetic inputs only; the data guard has scanned the entries. */
    syntheticOnly: z.literal(true),
    requestSchema: ServiceMockJsonSchemaSchema.nullable(),
    responseSchema: ServiceMockJsonSchemaSchema.nullable(),
    entries: z.array(ServiceMockEntrySchema).max(SERVICE_MOCK_ENTRIES_MAX),
    faults: z.array(ServiceMockFaultSchema).max(SERVICE_MOCK_FAULTS_MAX),
  })
  .strict()
  .superRefine((set, context) => {
    if (new Set(set.entries.map((entry) => entry.requestHash)).size !== set.entries.length) context.addIssue({ code: "custom", path: ["entries"], message: "a request has one recording" });
    if (new Set(set.faults.map((fault) => fault.name)).size !== set.faults.length) context.addIssue({ code: "custom", path: ["faults"], message: "fault names are unique" });
  });
export type ServiceMockFixtureSet = z.infer<typeof ServiceMockFixtureSetSchema>;

/** The digest a fixture set is pinned by in the approved environment (`mock.fixtureSetRef`). */
export function serviceMockFixtureSetDigest(set: ServiceMockFixtureSet): string {
  return sha256Hex(canonicalJson(ServiceMockFixtureSetSchema.parse(set)));
}

export const ServiceMockUnmatchedSchema = z.enum(TEST_ENV_UNMATCHED);

/**
 * What a mock server reports for a round, per service. The broker puts it in the evidence ("mock answered 3 unrecorded requests") and a service with unrecorded answers is never shown as
 * plainly "mocked": a `fail` mock that was asked something unrecorded has failed the case that asked.
 */
export const ServiceMockUsageSchema = z
  .object({
    service: line(80),
    matched: z.number().int().min(0).max(10_000_000),
    unmatchedFailed: z.number().int().min(0).max(10_000_000),
    synthesized: z.number().int().min(0).max(10_000_000),
    faultsInjected: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u), count: z.number().int().min(1).max(10_000_000) }).strict()).max(SERVICE_MOCK_FAULTS_MAX),
  })
  .strict();
export type ServiceMockUsage = z.infer<typeof ServiceMockUsageSchema>;

/**
 * The key a request is looked up by. A JSON body is canonicalised first (keys in a fixed order, so `{"a":1,"b":2}` and `{"b":2,"a":1}` are one request); any other body is hashed as written. The service, target,
 * method and content type are part of the key, so the same bytes sent to another endpoint find nothing.
 */
export function serviceMockRequestHash(input: { service: (typeof TEST_ENV_SERVICE_KINDS)[number]; target: string; method: string; contentType: string; body: string }): string {
  const type = input.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  let body = input.body;
  if (type === "application/json" || type.endsWith("+json")) {
    try {
      body = canonicalJson(JSON.parse(input.body) as unknown);
    } catch {
      // Not valid JSON: it is hashed as written, so it can only match a recording of the same bytes.
    }
  }
  return sha256Hex(canonicalJson({ service: input.service, target: input.target, method: input.method.toUpperCase(), contentType: type, body }));
}

/**
 * The environment variable an AWS SDK reads to send one service's calls to another address (`AWS_ENDPOINT_URL_<SERVICE>`): the service's id uppercased, spaces as underscores. The SageMaker Runtime
 * mock is reached through `AWS_ENDPOINT_URL_SAGEMAKER_RUNTIME`, so the customer's code needs no change (unless it passes `endpoint_url` itself, which takes precedence).
 */
export function awsEndpointUrlVariable(serviceId: string): string {
  if (!/^[A-Za-z][A-Za-z0-9 ]{0,63}$/u.test(serviceId)) throw new RangeError("a service id is letters, digits and spaces");
  return `AWS_ENDPOINT_URL_${serviceId.toUpperCase().replace(/ /gu, "_")}`;
}
