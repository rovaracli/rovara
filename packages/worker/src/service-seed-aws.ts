// Seeding Rovara local AWS from the project's own infrastructure code (test services, slice 2, TS22; design test-services.md 3.2 D7 and 5.4). The D7 detector found the tables (with their key schema), buckets and queues the
// project declares; the plan carries them as `awsResources` (contracts/src/test-services-aws-resources.ts, names and attribute types only). Once the emulator is healthy, in every phase that starts one (the working phase and EACH
// sealed round, which has its own emulator), this module turns them into the emulator's seed document and sends it to `POST /_rovara/seed` with the run's control token (emulator-control.ts). The project's own seed commands
// run afterwards, as they do for Postgres.
//
// The seed document is the fork's (`SeedService`): `{ region, s3: { buckets: [{ name }] }, dynamodb: { tables: [{ request: <CreateTable> }] }, sqs: { queues: [{ name, attributes }] } }`. Every request is built here from fixed
// words and from names that passed the contract's strict forms again; nothing else of the repository is sent.
//
// Rules this module keeps, each with a test (tests/unit/worker-service-seed-aws.test.ts):
//   - FAIL CLOSED. A resource that does not have its strict form, a duplicate, a region that is not one, a table without its key, an emulator that answers anything but a complete success: the seed fails with ONE fixed sentence
//     (`EmulatorSeedError`) and the run does not continue. The emulator applies a document step by step and reports each, so the answer is checked step by step too: every resource must be there, and there is nothing else.
//   - No secret and no repository string in an error, a log or an argument. The control token is `emulator-control.ts`'s business; the document is a file of the run's directory, not an argument.
//   - A run with no resources sends nothing.
import { TaskAwsResourcesSchema, type TaskAwsResource } from "@agentx/contracts";
import { EmulatorControlError, emulatorControlCall, type EmulatorControlTarget } from "./emulator-control.js";

export type EmulatorSeedFailure = "refused" | "failed" | "stopped";
const SENTENCES: Record<EmulatorSeedFailure, string> = {
  refused: "The project's AWS resources cannot be created in the test services",
  failed: "The test services' AWS resources were not created",
  stopped: "The test services' AWS resources were stopped",
};

/** The one error of the seeding. `message` is a fixed sentence: no resource name, no emulator text. */
export class EmulatorSeedError extends Error {
  constructor(readonly reason: EmulatorSeedFailure) {
    super(SENTENCES[reason]);
    this.name = "EmulatorSeedError";
  }
}

const REGION = /^[a-z]{2}(?:-[a-z]+)+-[0-9]{1,2}$/u;

interface DynamoKey { AttributeName: string; KeyType: "HASH" | "RANGE" }
interface DynamoAttribute { AttributeName: string; AttributeType: "S" | "N" | "B" }
export interface AwsSeedDocument {
  region: string;
  s3?: { buckets: Array<{ name: string }> };
  dynamodb?: { tables: Array<{ request: { TableName: string; KeySchema: DynamoKey[]; AttributeDefinitions: DynamoAttribute[]; BillingMode: "PAY_PER_REQUEST" } }> };
  sqs?: { queues: Array<{ name: string; attributes?: { FifoQueue: "true" } }> };
}

/**
 * The seed document for the resources. Pure. Refuses (`EmulatorSeedError("refused")`) a resource list the contract does not accept, and a region that is not one. A table is on-demand (no capacity to guess), its key schema is
 * the declared one and its attribute definitions are exactly its key attributes; a queue named `*.fifo` is a FIFO queue; a bucket is just created in the region.
 */
export function buildAwsSeedDocument(region: string, resources: readonly TaskAwsResource[]): AwsSeedDocument {
  const parsed = TaskAwsResourcesSchema.safeParse(resources);
  if (!REGION.test(region) || !parsed.success) throw new EmulatorSeedError("refused");
  const document: AwsSeedDocument = { region };
  const buckets = parsed.data.flatMap((resource) => (resource.kind === "bucket" ? [{ name: resource.name }] : []));
  const tables = parsed.data.flatMap((resource) => {
    if (resource.kind !== "table") return [];
    const { partitionKey, sortKey } = resource.keySchema;
    const keys: DynamoKey[] = [{ AttributeName: partitionKey.name, KeyType: "HASH" }, ...(sortKey === undefined ? [] : [{ AttributeName: sortKey.name, KeyType: "RANGE" as const }])];
    const definitions: DynamoAttribute[] = [{ AttributeName: partitionKey.name, AttributeType: partitionKey.type }, ...(sortKey === undefined ? [] : [{ AttributeName: sortKey.name, AttributeType: sortKey.type }])];
    return [{ request: { TableName: resource.name, KeySchema: keys, AttributeDefinitions: definitions, BillingMode: "PAY_PER_REQUEST" as const } }];
  });
  const queues = parsed.data.flatMap((resource) => (resource.kind === "queue" ? [resource.name.endsWith(".fifo") ? { name: resource.name, attributes: { FifoQueue: "true" as const } } : { name: resource.name }] : []));
  if (buckets.length > 0) document.s3 = { buckets };
  if (tables.length > 0) document.dynamodb = { tables };
  if (queues.length > 0) document.sqs = { queues };
  return document;
}

const STEP_OF_KIND = { bucket: ["s3", "CreateBucket"], table: ["dynamodb", "CreateTable"], queue: ["sqs", "CreateQueue"] } as const;

/**
 * Checks the emulator's report of the document (`{ ok, failed, steps: [{ service, action, name, ok }] }`) against the resources sent: it must say `ok` with no failure, every step must be `ok`, and each resource must have
 * exactly its step. Anything else (a missing step, an extra one, a step that failed, a shape that is not the report) fails the seed.
 */
export function seedReportCovers(report: unknown, resources: readonly TaskAwsResource[]): boolean {
  if (typeof report !== "object" || report === null) return false;
  const { ok, failed, steps } = report as { ok?: unknown; failed?: unknown; steps?: unknown };
  if (ok !== true || failed !== 0 || !Array.isArray(steps) || steps.length !== resources.length) return false;
  const reported = new Set<string>();
  for (const step of steps as unknown[]) {
    if (typeof step !== "object" || step === null) return false;
    const { service, action, name, ok: stepOk } = step as { service?: unknown; action?: unknown; name?: unknown; ok?: unknown };
    if (stepOk !== true || typeof service !== "string" || typeof action !== "string" || typeof name !== "string") return false;
    reported.add(`${service}\0${action}\0${name}`);
  }
  return resources.every((resource) => reported.has(`${STEP_OF_KIND[resource.kind][0]}\0${STEP_OF_KIND[resource.kind][1]}\0${resource.name}`));
}

export interface SeedEmulatorInput {
  /** The emulator and the means to talk to it (its control token is in here and nowhere else). */
  target: EmulatorControlTarget;
  region: string;
  /** The plan's `awsResources`. */
  resources: readonly TaskAwsResource[];
}

/**
 * Creates the resources in the running emulator. Call it once per emulator, after it is healthy and before the project's own seed commands. Resolves when every resource is there; throws `EmulatorSeedError` (a fixed
 * sentence) otherwise. A run with no resources makes no call.
 */
export async function seedEmulator(input: SeedEmulatorInput): Promise<void> {
  if (input.resources.length === 0) return;
  const document = buildAwsSeedDocument(input.region, input.resources);
  let answer: string;
  try {
    answer = await emulatorControlCall(input.target, { path: "seed", method: "POST", body: JSON.stringify(document), print: true });
  } catch (error) {
    throw new EmulatorSeedError(error instanceof EmulatorControlError ? error.reason : "failed");
  }
  let report: unknown;
  try { report = JSON.parse(answer); } catch { throw new EmulatorSeedError("failed"); }
  if (!seedReportCovers(report, input.resources)) throw new EmulatorSeedError("failed");
}
