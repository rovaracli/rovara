// Slice 2, s2-emulator-run: the emulated plan through the orchestrator (test-services-run.ts): ONE Rovara local AWS helper for the plan's emulated entries (aws-s3, aws-sqs, aws-dynamodb), its run contract with fresh values in
// every phase, the project's declared resources created through the control API before the seed commands, the sandboxes' per-service endpoints, one usage row per entry, the ledger, fail-closed plan checks and the /ping feature.
// No Docker: the fake daemon of tests/support, wrapped to record the env files and answer the control calls.
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestServicesUsageRecordSchema, catalogPrepullList, type ProjectCommand, type ServiceCatalog, type TestServicesUsageRecord } from "@rovara-code/contracts";
import { TaskDependencyPlanSchema, type TaskDependencyPlan } from "@agentx/cloud-contracts";
import { withDetachedWorking } from "../../packages/worker/src/check-sandbox.js";
import { forgetWorkerStartSweeps } from "../../packages/worker/src/service-runner.js";
import { TaskSandbox } from "../../packages/worker/src/task-sandbox.js";
import {
  SEALED_ROUND_PORTS, TestServicesError, emulatorImagePrepulled, forgetEmulatorImageCache, notPulledRepositories, startTestServicesRun, testServicesAdvertisedFeatures,
  type SealedRoundPorts, type TestServicesConfig,
} from "../../packages/worker/src/test-services-run.js";
import type { CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { fakeServicesDocker } from "../support/fake-services-docker.js";

const DIGEST = "a".repeat(64);
const IMAGE = `registry.example.test/agentx/worker@sha256:${"b".repeat(64)}`;
const REGISTRY = "123456789012.dkr.ecr.us-west-2.amazonaws.com";
const OPERATION = "55555555-5555-4555-8555-555555555555";
const MIGRATE: ProjectCommand = { cwd: "app", executable: "npm", args: ["run", "migrate"], timeoutSeconds: 60 };
const TEMPLATE = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  OrdersTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: orders
      AttributeDefinitions:
        - { AttributeName: orderId, AttributeType: S }
      KeySchema:
        - { AttributeName: orderId, KeyType: HASH }
  ArchiveBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: orders-archive
  EventsQueue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: order-events
  AlertsTopic:
    Type: AWS::SNS::Topic
    Properties:
      TopicName: alerts
`;

const roots: string[] = [];
beforeEach(() => forgetWorkerStartSweeps());
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function temp(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

const catalog: ServiceCatalog = (() => {
  const copy = structuredClone(JSON.parse(readFileSync(new URL("../../environments/service-catalog/catalog.json", import.meta.url), "utf8")) as ServiceCatalog);
  for (const entry of copy.entries) if (entry.id === "local-aws@r1" || entry.id === "postgres@16") entry.image.digest = DIGEST;
  return copy;
})();

const AWS_IMAGE = `${REGISTRY}/rovara-catalog/staging/svc/local-aws@sha256:${DIGEST}`;
type Raw = Record<string, unknown>;
function emulated(service: string, over: Raw = {}, aws: Raw = {}): Raw {
  return {
    id: `aws-${service}`, name: service.toUpperCase(), kind: "object_store", family: `aws:${service}`, backing: "emulated", catalogId: "local-aws@r1", repository: "svc/local-aws", digest: DIGEST,
    config: {}, aliases: [], connect: [], seeds: [], reset: "fresh_per_round",
    aws: { services: [service], region: "us-east-1", ...aws }, ...over,
  };
}
const plan3 = (): Raw[] => [
  emulated("s3", { aliases: ["aws"], seeds: [{ command: MIGRATE }] }, { resources: { provider: "cloudformation", path: "app/template.yaml" } }),
  emulated("sqs"),
  emulated("dynamodb"),
];
const parse = (list: Raw[]): TaskDependencyPlan[] => list.map((item) => TaskDependencyPlanSchema.parse(item));
/** Plans the worker's OWN checks must refuse even where the broker's schema would not (or would): handed over as they are, unparsed. */
const raw = (list: Raw[]): TaskDependencyPlan[] => list as unknown as TaskDependencyPlan[];

interface Control { path: string; method: string; envFile: string | undefined; token: string | undefined; body: string | undefined; args: string[] }
interface Options { ledger?: string; seedExit?: number; ledgerExit?: number; seedAnswer?: (body: string) => string }

async function harness(options: Options = {}) {
  const fake = fakeServicesDocker();
  const root = await temp("rsv-aws-workspace-");
  await mkdir(join(root, "app"));
  await writeFile(join(root, "app", "template.yaml"), TEMPLATE);
  const runParent = await temp("rsv-aws-runs-");
  const controls: Control[] = [];
  const emulatorEnv: string[] = [];
  const order: string[] = [];
  const original = fake.docker.run.bind(fake.docker);
  fake.docker.run = (args, runOptions) => {
    const read = (flag: string): string | undefined => { const at = args.indexOf(flag); if (at < 0) return undefined; try { return readFileSync(args[at + 1]!, "utf8"); } catch { return undefined; } };
    if (args[0] === "run" && args.includes("--detach") && args.includes(AWS_IMAGE)) { emulatorEnv.push(read("--env-file") ?? ""); order.push("emulator"); }
    if (args[0] === "exec") order.push("exec");
    if (args[0] === "run" && args.includes("--rm") && (args.includes("--control") || args.includes("--post"))) {
      const envFile = read("--env-file");
      const mount = args.findIndex((arg) => arg === "-v");
      let body: string | undefined;
      if (mount >= 0) { try { body = readFileSync(args[mount + 1]!.split(":")[0]!, "utf8"); } catch { body = undefined; } }
      const path = args[args.indexOf("--path") + 1]!;
      controls.push({ path, method: args.includes("--control") ? args[args.indexOf("--control") + 1]! : "POST", envFile, token: /^ROVARA_CONTROL_TOKEN=(.+)$/mu.exec(envFile ?? "")?.[1], body, args: [...args] });
      order.push(path === "/_rovara/seed" ? "seed" : path === "/_rovara/reset" ? "reset" : "ledger");
      if (path === "/_rovara/reset") return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      if (path === "/_rovara/seed") {
        if ((options.seedExit ?? 0) !== 0) return Promise.resolve({ exitCode: options.seedExit!, stdout: "", stderr: "" });
        const document = JSON.parse(body ?? "{}") as { s3?: { buckets: Array<{ name: string }> }; dynamodb?: { tables: Array<{ request: { TableName: string } }> }; sqs?: { queues: Array<{ name: string }> } };
        const steps = [
          ...(document.s3?.buckets ?? []).map((bucket) => ({ service: "s3", action: "CreateBucket", name: bucket.name, ok: true })),
          ...(document.dynamodb?.tables ?? []).map((table) => ({ service: "dynamodb", action: "CreateTable", name: table.request.TableName, ok: true })),
          ...(document.sqs?.queues ?? []).map((queue) => ({ service: "sqs", action: "CreateQueue", name: queue.name, ok: true })),
        ];
        return Promise.resolve({ exitCode: 0, stdout: options.seedAnswer?.(body ?? "") ?? JSON.stringify({ ok: true, failed: 0, steps }), stderr: "" });
      }
      if ((options.ledgerExit ?? 0) !== 0) return Promise.resolve({ exitCode: options.ledgerExit!, stdout: "", stderr: "" });
      return Promise.resolve({ exitCode: 0, stdout: options.ledger ?? "{}", stderr: "" });
    }
    return original(args, runOptions);
  };
  const executed: ProjectCommand[] = [];
  const sealed: SealedRoundPorts = {
    withSealedCheckRound(setup, round) {
      return withDetachedWorking(setup.docker, setup.plan, async (start) => {
        await start();
        const runners: CheckRunners = {
          runProjectCommand(command) { executed.push(command); order.push("command"); return Promise.resolve({ exitCode: 0, timedOut: false, stdout: "ok", stderr: "" }); },
          runAgentCommand: () => Promise.resolve({ exitCode: 0, timedOut: false, output: "" }),
        };
        return round(runners);
      });
    },
    buildServiceUsageRecord: (input) => SEALED_ROUND_PORTS.buildServiceUsageRecord(input),
  };
  const config: TestServicesConfig = {
    docker: fake.docker, registry: REGISTRY, catalogEnv: "staging", edition: "public", probeImage: IMAGE, guardImage: IMAGE, maxMemMiB: 3072, runDirectoryParent: runParent,
    catalog: () => Promise.resolve(catalog), sealedRound: sealed, sleep: () => Promise.resolve(), log: () => undefined,
  };
  const sandbox = new TaskSandbox({ rootPath: root, taskId: OPERATION, docker: fake.docker, image: IMAGE, log: () => undefined });
  await sandbox.start();
  const start = (dependencies: readonly TaskDependencyPlan[], workingPhase = true) => startTestServicesRun(config, { dependencies, hasDevcontainer: false, operationId: OPERATION, rootPath: root, repositoryPaths: [join(root, "app")], sandbox, workingPhase });
  const base: CheckRunners = { runProjectCommand: () => Promise.reject(new Error("no")), runAgentCommand: () => Promise.reject(new Error("no")) };
  return { fake, root, runParent, controls, emulatorEnv, order, executed, config, sandbox, start, base };
}
const envValue = (file: string, name: string): string | undefined => new RegExp(`^${name}=(.*)$`, "mu").exec(file)?.[1];
const SECRET_NAMES = ["ROVARA_AWS_AUTH_PRESIGN_SECRET", "ROVARA_AWS_SERVICES_SQS_RECEIPT_HANDLE_SECRET", "ROVARA_AWS_CONTROL_TOKEN"] as const;
const secretsOf = (file: string): string[] => SECRET_NAMES.map((name) => envValue(file, name)!);
const nothingLeft = async (h: Awaited<ReturnType<typeof harness>>): Promise<void> => {
  expect(h.fake.left().networks).toEqual([]);
  expect(h.fake.left().containers.filter((name) => name.startsWith("rovara-svc-"))).toEqual([]);
  expect(await readdir(h.runParent)).toEqual([]);
};

describe("the working phase", () => {
  it("starts ONE emulator for the three entries, with the run contract; creates the declared resources BEFORE the seed commands, with the emulator's own token", async () => {
    const h = await harness();
    const run = await h.start(parse(plan3()));
    expect(h.emulatorEnv).toHaveLength(1);
    const file = h.emulatorEnv[0]!;
    expect(envValue(file, "ROVARA_AWS_BASE_URL")).toBe("http://aws:4566");
    expect(envValue(file, "QUARKUS_HTTP_HOST")).toMatch(/^172\.30\.\d+\.\d+$/u);
    expect(envValue(file, "ROVARA_AWS_DEFAULT_REGION")).toBe("us-east-1");
    expect(new Set(secretsOf(file)).size).toBe(3);
    // The seed call: the emulator's control token, a body with the three declared resources (the topic is left out), and it comes after the emulator and before the project's seed command.
    expect(h.controls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /_rovara/seed"]);
    expect(h.controls[0]!.token).toBe(envValue(file, "ROVARA_AWS_CONTROL_TOKEN"));
    expect(JSON.parse(h.controls[0]!.body!)).toEqual({
      region: "us-east-1", s3: { buckets: [{ name: "orders-archive" }] },
      dynamodb: { tables: [{ request: { TableName: "orders", KeySchema: [{ AttributeName: "orderId", KeyType: "HASH" }], AttributeDefinitions: [{ AttributeName: "orderId", AttributeType: "S" }], BillingMode: "PAY_PER_REQUEST" } }] },
      sqs: { queues: [{ name: "order-events" }] },
    });
    expect(h.order.indexOf("emulator")).toBeLessThan(h.order.indexOf("seed"));
    expect(h.order.indexOf("seed")).toBeLessThan(h.order.indexOf("exec"));
    await run.dispose();
    await h.sandbox.dispose();
    await nothingLeft(h);
  });
  it("the working sandbox's variables: S3, SQS and DynamoDB at the emulator's first alias, every other service and the global endpoint at the emulator too, the plan's region; none of the three values", async () => {
    const h = await harness();
    const run = await h.start(parse(plan3()));
    const secrets = secretsOf(h.emulatorEnv[0]!);
    const exec = h.fake.execs.find((entry) => entry.envFile?.includes("AWS_ENDPOINT_URL_S3=") === true)!;
    expect(exec.args).toContain(h.sandbox.name);
    const env = new Map(exec.envFile!.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    for (const name of ["S3", "SQS", "DYNAMODB"]) expect(env.get(`AWS_ENDPOINT_URL_${name}`)).toBe("http://aws:4566");
    // A service the plan does not name gets no variable of its own: a call to it reaches the emulator through the global endpoint, where its ledger counts it as outside the plan.
    for (const name of ["SNS", "STS", "LAMBDA", "KMS", "SSM", "SECRETS_MANAGER", "EVENTBRIDGE"]) expect(env.get(`AWS_ENDPOINT_URL_${name}`), name).toBeUndefined();
    expect(env.get("AWS_ENDPOINT_URL")).toBe("http://aws:4566");
    expect(env.get("AWS_REGION")).toBe("us-east-1");
    expect(env.get("AWS_DEFAULT_REGION")).toBe("us-east-1");
    expect(env.get("AWS_ACCESS_KEY_ID")).toBe("ROVARATESTKEY");
    for (const secret of secrets) expect(exec.envFile).not.toContain(secret);
    expect([...env.keys()].some((name) => /^ROVARA_AWS|CONTROL|RECEIPT|PRESIGN/u.test(name))).toBe(false);
    // No secret is in an argument of any docker call, and the token is in no exec's arguments.
    const all = h.fake.calls.flat().join(" ");
    for (const secret of secrets) expect(all).not.toContain(secret);
    await run.dispose();
    await h.sandbox.dispose();
  });
  it("the region comes from the plan: a plan in eu-west-2 tells the code eu-west-2 (and the emulator), while every endpoint is still overridden", async () => {
    const h = await harness();
    const run = await h.start(parse([emulated("s3", { aliases: ["aws"], seeds: [{ command: MIGRATE }] }, { region: "eu-west-2" })]));
    expect(envValue(h.emulatorEnv[0]!, "ROVARA_AWS_DEFAULT_REGION")).toBe("eu-west-2");
    const exec = h.fake.execs.find((entry) => entry.envFile?.includes("AWS_ENDPOINT_URL_S3=") === true)!;
    expect(envValue(exec.envFile!, "AWS_REGION")).toBe("eu-west-2");
    expect(envValue(exec.envFile!, "AWS_DEFAULT_REGION")).toBe("eu-west-2");
    expect(envValue(exec.envFile!, "AWS_ENDPOINT_URL_S3")).toBe("http://aws:4566");
    expect(envValue(exec.envFile!, "AWS_ENDPOINT_URL")).toBe("http://aws:4566");
    await run.dispose();
    await h.sandbox.dispose();
  });
  it("a plan whose first emulated entry names another alias uses it for the base URL and the sandboxes", async () => {
    const h = await harness();
    const run = await h.start(parse([emulated("s3", { aliases: ["cloud"], seeds: [{ command: MIGRATE }] }), emulated("sqs")]));
    expect(envValue(h.emulatorEnv[0]!, "ROVARA_AWS_BASE_URL")).toBe("http://cloud:4566");
    const exec = h.fake.execs.find((entry) => entry.envFile?.includes("AWS_ENDPOINT_URL_S3=") === true)!;
    expect(envValue(exec.envFile!, "AWS_ENDPOINT_URL_S3")).toBe("http://cloud:4566");
    await run.dispose();
    await h.sandbox.dispose();
  });
});

describe("sealed rounds: their own emulator, fresh values, resources again, one usage row per entry, the ledger", () => {
  const ledger = JSON.stringify({
    s3: { calls: 9, unsupported: 1, errors: 1, operations: { PutObject: { calls: 8, unsupported: 0, errors: 0 }, PutBucketReplication: { calls: 1, unsupported: 1, errors: 1 } } },
    sqs: { calls: 2, unsupported: 0, errors: 0, operations: { SendMessage: { calls: 2, unsupported: 0, errors: 0 } } },
  });
  const round = async (run: Awaited<ReturnType<Awaited<ReturnType<typeof harness>>["start"]>>, h: Awaited<ReturnType<typeof harness>>): Promise<void> => {
    const runners = run.checkRunners(h.base);
    const signal = new AbortController().signal;
    await runners.freshServices?.(signal);
    await runners.runProjectCommand({ cwd: "app", executable: "npm", args: ["test"], timeoutSeconds: 60 }, signal);
    await runners.endRound?.();
  };
  it("each round starts its own emulator with three NEW values (none shared with the working phase or another round), seeds it with its own token, and reports a row for each entry", async () => {
    const h = await harness({ ledger });
    const run = await h.start(parse(plan3()));
    await round(run, h);
    await round(run, h);
    expect(h.emulatorEnv).toHaveLength(3);
    const all = h.emulatorEnv.flatMap(secretsOf);
    expect(new Set(all).size).toBe(9);
    const seeds = h.controls.filter((call) => call.path === "/_rovara/seed");
    expect(seeds).toHaveLength(3);
    seeds.forEach((call, index) => expect(call.token).toBe(envValue(h.emulatorEnv[index]!, "ROVARA_AWS_CONTROL_TOKEN")));
    expect(new Set(seeds.map((call) => call.token)).size).toBe(3);
    // The ledger was read once per round, with that round's token.
    const ledgers = h.controls.filter((call) => call.path === "/_rovara/ledger/summary");
    expect(ledgers).toHaveLength(2);
    expect(ledgers.map((call) => call.token)).toEqual([envValue(h.emulatorEnv[1]!, "ROVARA_AWS_CONTROL_TOKEN"), envValue(h.emulatorEnv[2]!, "ROVARA_AWS_CONTROL_TOKEN")]);
    expect(ledgers.every((call) => call.method === "GET" && call.body === undefined)).toBe(true);
    const record = (await run.usageRecord())!;
    expect(TestServicesUsageRecordSchema.parse(record)).toEqual(record);
    expect(record.dependencies.map((entry) => entry.id)).toEqual(["aws-s3", "aws-sqs", "aws-dynamodb"]);
    expect(record.dependencies.every((entry) => entry.started && entry.healthy)).toBe(true);
    expect(record.aws?.ledger).toBe("read");
    expect(record.aws?.services.map((entry) => entry.service)).toEqual(["s3", "sqs"]);
    expect(record.aws?.unsupportedOperations).toEqual([{ service: "s3", operation: "PutBucketReplication", count: 2 }]);
    // Nothing of the run's values is in the record or in any docker argument.
    for (const secret of all) {
      expect(JSON.stringify(record)).not.toContain(secret);
      expect(h.fake.calls.flat().join(" ")).not.toContain(secret);
    }
    await run.dispose();
    await h.sandbox.dispose();
    await nothingLeft(h);
  });
  it("the sealed round's sandbox variables hold the per-service endpoints and not the round's token or secrets", async () => {
    const h = await harness({ ledger });
    const run = await h.start(parse(plan3()));
    await round(run, h);
    const roundSecrets = secretsOf(h.emulatorEnv[1]!);
    const envFiles = h.fake.calls.filter((call) => call[0] === "run" && call.includes("--env-file") && call.includes("--detach") === false).map((call) => { try { return readFileSync(call[call.indexOf("--env-file") + 1]!, "utf8"); } catch { return ""; } });
    for (const text of envFiles) for (const secret of roundSecrets) if (!text.startsWith("ROVARA_CONTROL_TOKEN=")) expect(text).not.toContain(secret);
    await run.dispose();
    await h.sandbox.dispose();
  });
  it("an emulator reset between checks puts the declared resources back (reset, then the seed call again, then the seed commands)", async () => {
    const h = await harness({ ledger });
    const plans = parse(plan3().map((item) => ({ ...item, reset: "between_checks" })));
    const run = await h.start(plans);
    const runners = run.checkRunners(h.base);
    const signal = new AbortController().signal;
    await runners.freshServices?.(signal);
    const before = h.controls.filter((call) => call.path === "/_rovara/seed").length;
    await runners.resetBetweenChecks?.(signal);
    expect(h.controls.filter((call) => call.path === "/_rovara/reset")).toHaveLength(1);
    expect(h.controls.filter((call) => call.path === "/_rovara/seed")).toHaveLength(before + 1);
    expect(h.controls.map((call) => call.path).lastIndexOf("/_rovara/reset")).toBeLessThan(h.controls.map((call) => call.path).lastIndexOf("/_rovara/seed"));
    await runners.endRound?.();
    await run.dispose();
    await h.sandbox.dispose();
  });
  it("a ledger that cannot be read is 'unreadable' in the record (never 'no calls'); the rest of the record is intact", async () => {
    const h = await harness({ ledgerExit: 1 });
    const run = await h.start(parse(plan3()));
    await round(run, h);
    const record = (await run.usageRecord())!;
    expect(record.aws).toEqual({ ledger: "unreadable", services: [], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0 });
    expect(record.dependencies.every((entry) => entry.healthy)).toBe(true);
    await run.dispose();
    await h.sandbox.dispose();
  });
});

describe("a round whose record is lost (review LOW)", () => {
  it("a round whose usage record cannot be built makes the WHOLE run's record unreadable, for the rest of the run, and the saved artifact says so", async () => {
    const h = await harness();
    let builds = 0;
    const sealedPorts = h.config.sealedRound!;
    h.config.sealedRound = { withSealedCheckRound: (setup, round) => sealedPorts.withSealedCheckRound(setup, round), buildServiceUsageRecord: (input) => { builds += 1; return builds === 2 ? Promise.reject(new Error("the record could not be built")) : sealedPorts.buildServiceUsageRecord(input); } };
    const saved: string[] = [];
    const run = await startTestServicesRun(h.config, { dependencies: parse(plan3()), hasDevcontainer: false, operationId: OPERATION, rootPath: h.root, repositoryPaths: [join(h.root, "app")], sandbox: h.sandbox, artifactSink: (artifact) => { saved.push(artifact.content); return Promise.resolve(); } });
    const runners = run.checkRunners(h.base);
    const signal = new AbortController().signal;
    const one = async (): Promise<void> => { await runners.freshServices?.(signal); await runners.endRound?.(); };
    await one();
    expect((await run.usageRecord())?.aws?.ledger).toBe("read");
    await one(); // the second record fails
    const lost = (await run.usageRecord())!;
    expect(lost.aws).toEqual({ ledger: "unreadable", services: [], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0 });
    expect(lost.dependencies.every((entry) => !entry.healthy && entry.failure !== undefined)).toBe(true);
    expect((JSON.parse(saved.at(-1)!) as TestServicesUsageRecord).aws?.ledger).toBe("unreadable");
    await one(); // a later good record does not bring a clean run back
    expect((await run.usageRecord())!.aws?.ledger).toBe("unreadable");
    expect((JSON.parse(saved.at(-1)!) as TestServicesUsageRecord).dependencies.every((entry) => !entry.healthy)).toBe(true);
    await run.dispose();
    await h.sandbox.dispose();
  });
  it("the emulator's env file switches off the services that are not planned", async () => {
    const h = await harness();
    const run = await h.start(parse(plan3()));
    const file = h.emulatorEnv[0]!;
    expect(file).toContain("ROVARA_AWS_SERVICES_SNS_ENABLED=false");
    expect(file).toContain("ROVARA_AWS_SERVICES_LAMBDA_ENABLED=false");
    for (const planned of ["S3", "SQS", "DYNAMODB"]) expect(file).not.toContain(`ROVARA_AWS_SERVICES_${planned}_ENABLED`);
    await run.dispose();
    await h.sandbox.dispose();
  });
  it("a pointer to app/notes.yaml fails the start with the fixed seed sentence and logs the fixed note, no name", async () => {
    const h = await harness();
    await writeFile(join(h.root, "app", "notes.yaml"), TEMPLATE);
    const events: Array<Record<string, unknown>> = [];
    h.config.log = (event) => events.push(event);
    const plans = plan3();
    plans[0] = emulated("s3", { aliases: ["aws"] }, { resources: { provider: "cloudformation", path: "app/notes.yaml" } });
    const error = await h.start(parse(plans)).then(() => undefined, (caught: unknown) => caught as TestServicesError);
    expect(error!.reason).toBe("seed_failed");
    expect(events.find((event) => event["event"] === "test-services.seed.refused")).toEqual({ event: "test-services.seed.refused", note: "The infrastructure file the plan names is not one that setup reads for resources" });
    expect(JSON.stringify(events)).not.toContain("orders-archive");
    expect(h.controls).toEqual([]);
    await h.sandbox.dispose();
    await nothingLeft(h);
  });
});

describe("fail closed", () => {
  it("a seed the emulator does not confirm ends the start with the fixed seed sentence, every entry marked, and nothing left behind", async () => {
    for (const options of [{ seedExit: 1 }, { seedAnswer: () => JSON.stringify({ ok: true, failed: 0, steps: [] }) }, { seedAnswer: () => "not json" }] as Options[]) {
      const h = await harness(options);
      const error = await h.start(parse(plan3())).then(() => undefined, (caught: unknown) => caught as TestServicesError);
      expect(error).toBeInstanceOf(TestServicesError);
      expect(error!.reason).toBe("seed_failed");
      expect(error!.message).toBe("A test service's seeds did not complete");
      expect([...error!.failures]).toEqual([["aws-s3", "seed_failed"], ["aws-sqs", "seed_failed"], ["aws-dynamodb", "seed_failed"]]);
      expect(JSON.stringify([error!.message, error!.stack])).not.toMatch(/orders|order-events|ROVARA/u);
      // The project's seed command never ran.
      expect(h.fake.execs).toHaveLength(0);
      await h.sandbox.dispose();
      await nothingLeft(h);
    }
  });
  it("a pointer to a file outside the repositories, a link out of them, a missing file or a file the detector reads nothing useful from fails the start; an unseedable resource does too", async () => {
    const bad = async (setup: (root: string) => Promise<string>): Promise<void> => {
      const h = await harness();
      const path = await setup(h.root);
      const plans = plan3();
      plans[0] = emulated("s3", { aliases: ["aws"] }, { resources: { provider: "cloudformation", path } });
      const error = await h.start(parse(plans)).then(() => undefined, (caught: unknown) => caught as TestServicesError);
      expect(error, path).toBeInstanceOf(TestServicesError);
      expect(error!.reason, path).toBe("seed_failed");
      expect(h.controls, path).toEqual([]);
      await h.sandbox.dispose();
      await nothingLeft(h);
    };
    await bad(async (root) => { await writeFile(join(root, "outside.yaml"), TEMPLATE); return "outside.yaml"; });
    await bad(async (root) => { await symlink(join(root, "outside.yaml"), join(root, "app", "link.yaml")).catch(() => undefined); await writeFile(join(root, "outside.yaml"), TEMPLATE); return "app/link.yaml"; });
    await bad(() => Promise.resolve("app/nothere.yaml"));
    await bad(async (root) => { await writeFile(join(root, "app", "template.txt"), TEMPLATE); return "app/template.txt"; });
    await bad(async (root) => { await writeFile(join(root, "app", "template.yaml"), TEMPLATE.replace("orders-archive", "Orders_Archive")); return "app/template.yaml"; });
    await bad(async (root) => { await writeFile(join(root, "app", "template.yaml"), TEMPLATE.replace("      KeySchema:\n        - { AttributeName: orderId, KeyType: HASH }\n", "")); return "app/template.yaml"; });
  });
  it("refuses, before anything is made, a plan whose emulated services the table does not know, or whose region is not a plain region", async () => {
    const cases: Array<[string, Raw[]]> = [
      ["a service the table does not know", [emulated("s3", { aliases: ["aws"] }, { services: ["s3", "nosuchservice"] })]],
      ["a family the table does not know", [emulated("nosuchservice", { aliases: ["aws"] })]],
      ["inherited name", [emulated("s3", { aliases: ["aws"] }, { services: ["s3", "constructor"] })]],
      ["region with a space", [emulated("s3", { aliases: ["aws"] }, { region: "us east 1" })]],
      ["upper-case region", [emulated("s3", { aliases: ["aws"] }, { region: "US-EAST-1" })]],
      ["region too long", [emulated("s3", { aliases: ["aws"] }, { region: `us-${"east-".repeat(8)}1` })]],
      ["region with a quote", [emulated("s3", { aliases: ["aws"] }, { region: "us-east-1'" })]],
      ["empty region", [emulated("s3", { aliases: ["aws"] }, { region: "" })]],
      ["region not an AWS shape", [emulated("s3", { aliases: ["aws"] }, { region: "mars" })]],
      ["two regions", [emulated("s3", { aliases: ["aws"] }), emulated("sqs", {}, { region: "us-west-2" })]],
      ["two images", [emulated("s3", { aliases: ["aws"] }), emulated("sqs", { digest: "c".repeat(64) })]],
      ["connect variables", [emulated("s3", { aliases: ["aws"], connect: [{ name: "BUCKET_URL", template: "http://{host}:{port}" }] })]],
      ["init files", [emulated("s3", { aliases: ["aws"], config: { initFiles: ["app/x.sql"] } })]],
      ["no aws block", [emulated("s3", { aliases: ["aws"], aws: undefined })]],
      ["a real-software entry posing as the emulator", [emulated("s3", { aliases: ["aws"], catalogId: "postgres@16", repository: "svc/postgres" })]],
    ];
    for (const [label, list] of cases) {
      const h = await harness();
      const error = await h.start(raw(list)).then(() => undefined, (caught: unknown) => caught as TestServicesError);
      expect(error, label).toBeInstanceOf(TestServicesError);
      expect(["mismatch", "pull_failed"], label).toContain(error!.reason);
      expect(h.fake.verbs("network").filter((call) => call[1] === "create"), label).toEqual([]);
      expect(h.fake.calls.filter((call) => call[0] === "run" && call.includes("--detach") && call.includes(AWS_IMAGE)), label).toEqual([]);
      expect(h.controls, label).toEqual([]);
      await h.sandbox.dispose();
      await nothingLeft(h);
    }
  });
  it("an image the worker image does not pin, or that is not on this host, is the fixed 'not available on this worker' sentence for every entry", async () => {
    const h = await harness();
    const unpinned = await h.start(raw(plan3().map((item) => ({ ...item, digest: "c".repeat(64) })))).then(() => undefined, (caught: unknown) => caught as TestServicesError);
    expect(unpinned!.message).toBe("Dependency image not available on this worker");
    expect([...unpinned!.failures.keys()]).toEqual(["aws-s3", "aws-sqs", "aws-dynamodb"]);
    await h.sandbox.dispose();
  });
});

describe("the /ping feature", () => {
  const env = { AGENTX_TEST_SERVICES_REGISTRY: REGISTRY, AGENTX_TEST_SERVICES_ENV: "staging", AGENTX_TEST_SERVICES_RUN_DIR: "/run/x", AGENTX_SANDBOX_IMAGE: IMAGE, AGENTX_WORKER_IMAGE: IMAGE } as NodeJS.ProcessEnv;
  /** A shipped catalog the contract accepts: pinned, with local-aws wholly pinned (digest, SBOM, scan) or not at all, and a pre-pull list as root would make it from it (or the one given). */
  const files = async (prepull: (shipped: ServiceCatalog) => object, pinned: boolean) => {
    const dir = await temp("rsv-ship-");
    const shipped = structuredClone(JSON.parse(readFileSync(new URL("../../environments/service-catalog/catalog.json", import.meta.url), "utf8")) as ServiceCatalog);
    shipped.pinned = true;
    // Slice 3: the fake server has its own feature (worker-test-services-fakes.test.ts); this test is about the AWS one.
    shipped.entries = shipped.entries.filter((entry) => entry.family !== "fake-server");
    for (const entry of shipped.entries) {
      if (entry.id === "postgres@16" || (entry.id === "local-aws@r1" && pinned)) {
        entry.image.digest = entry.id === "postgres@16" ? "d".repeat(64) : DIGEST;
        entry.sbomRef = "e".repeat(64);
        entry.scan = { scannedAt: "2026-11-03T00:00:00.000Z", criticalOpen: 0, highOpen: 0 };
      } else {
        // The shipped file pins local-aws since revision 2; this helper builds the "not pinned" case explicitly.
        delete entry.image.digest;
        delete entry.sbomRef;
        delete entry.scan;
      }
    }
    await writeFile(join(dir, "catalog.json"), JSON.stringify(shipped));
    await writeFile(join(dir, "prepull.json"), JSON.stringify(prepull(shipped)));
    return { catalog: join(dir, "catalog.json"), prepull: join(dir, "prepull.json") };
  };
  const listed = (shipped: ServiceCatalog) => catalogPrepullList(shipped);
  it("is advertised only with a test-services configuration AND a pinned local-aws image that root pre-pulls", async () => {
    expect(testServicesAdvertisedFeatures(env, await files(listed, true))).toEqual(["task.testServices.v1", "task.testServices.fileSeed.v1", "task.testServices.seedLock.v1", "task.testServices.aws.v1", "task.testServices.aws.allServices.v1", "task.testServices.companyImage.v1"]);
    // no configuration: nothing
    expect(testServicesAdvertisedFeatures({}, await files(listed, true))).toEqual([]);
    // not pinned in the shipped catalog, not in the pre-pull list, a different digest, an empty list: slice 1 only
    expect(testServicesAdvertisedFeatures(env, await files(listed, false))).toEqual(["task.testServices.v1", "task.testServices.fileSeed.v1", "task.testServices.seedLock.v1", "task.testServices.companyImage.v1"]);
    expect(testServicesAdvertisedFeatures(env, await files((shipped) => ({ ...listed(shipped), images: [] }), true))).toEqual(["task.testServices.v1", "task.testServices.fileSeed.v1", "task.testServices.seedLock.v1", "task.testServices.companyImage.v1"]);
    expect(testServicesAdvertisedFeatures(env, await files((shipped) => ({ ...listed(shipped), images: listed(shipped).images.map((image) => (image.id === "local-aws@r1" ? { ...image, digest: "c".repeat(64) } : image)) }), true))).toEqual(["task.testServices.v1", "task.testServices.fileSeed.v1", "task.testServices.seedLock.v1", "task.testServices.companyImage.v1"]);
    expect(testServicesAdvertisedFeatures(env, await files((shipped) => ({ ...listed(shipped), images: listed(shipped).images.filter((image) => image.id !== "local-aws@r1") }), true))).toEqual(["task.testServices.v1", "task.testServices.fileSeed.v1", "task.testServices.seedLock.v1", "task.testServices.companyImage.v1"]);
  });
  it("per image: root's note of a repository that did not pre-pull takes only that image out (local-aws gone: slice 1's feature stays; postgres gone: both stay); a malformed or too long note withholds everything (fail closed)", async () => {
    const shipped = await files(listed, true);
    expect(testServicesAdvertisedFeatures({ ...env, AGENTX_TEST_SERVICES_NOT_PULLED: "svc/local-aws" }, shipped)).toEqual(["task.testServices.v1", "task.testServices.fileSeed.v1", "task.testServices.seedLock.v1", "task.testServices.companyImage.v1"]);
    expect(testServicesAdvertisedFeatures({ ...env, AGENTX_TEST_SERVICES_NOT_PULLED: "svc/postgres,svc/mysql" }, shipped)).toEqual(["task.testServices.v1", "task.testServices.fileSeed.v1", "task.testServices.seedLock.v1", "task.testServices.aws.v1", "task.testServices.aws.allServices.v1", "task.testServices.companyImage.v1"]);
    expect(testServicesAdvertisedFeatures({ ...env, AGENTX_TEST_SERVICES_NOT_PULLED: "svc/postgres,svc/local-aws" }, shipped)).toEqual(["task.testServices.v1", "task.testServices.fileSeed.v1", "task.testServices.seedLock.v1", "task.testServices.companyImage.v1"]);
    // Fail closed: `all`, a malformed value and a list past 16 names withhold EVERY test-services feature (an empty value or none means nothing is missing).
    expect(testServicesAdvertisedFeatures({ ...env, AGENTX_TEST_SERVICES_NOT_PULLED: "" }, shipped)).toEqual(["task.testServices.v1", "task.testServices.fileSeed.v1", "task.testServices.seedLock.v1", "task.testServices.aws.v1", "task.testServices.aws.allServices.v1", "task.testServices.companyImage.v1"]);
    const tooMany = Array.from({ length: 17 }, (_, index) => `svc/image${String(index)}`).join(",");
    for (const bad of ["all", "svc/LOCAL-AWS", "local-aws", "svc/local-aws;", "svc/a,", tooMany]) {
      expect(testServicesAdvertisedFeatures({ ...env, AGENTX_TEST_SERVICES_NOT_PULLED: bad }, shipped), bad).toEqual([]);
      expect(notPulledRepositories({ AGENTX_TEST_SERVICES_NOT_PULLED: bad }), bad).toBe("all");
      expect(emulatorImagePrepulled(shipped, { AGENTX_TEST_SERVICES_NOT_PULLED: bad }), bad).toBe(false);
    }
    expect([...(notPulledRepositories({ AGENTX_TEST_SERVICES_NOT_PULLED: "svc/a,svc/b" }) as Set<string>)]).toEqual(["svc/a", "svc/b"]);
  });
  it("the withhold boot-stage2.sh writes when the IPv6 wall fails (AGENTX_TEST_SERVICES_NOT_PULLED=all, the last such line in worker.env) yields no task.testServices.* feature, with a complete configuration that otherwise offers both", async () => {
    const shipped = await files(listed, true);
    expect(testServicesAdvertisedFeatures(env, shipped)).toEqual(["task.testServices.v1", "task.testServices.fileSeed.v1", "task.testServices.seedLock.v1", "task.testServices.aws.v1", "task.testServices.aws.allServices.v1", "task.testServices.companyImage.v1"]);
    const withheld = testServicesAdvertisedFeatures({ ...env, AGENTX_TEST_SERVICES_NOT_PULLED: "all" }, shipped);
    expect(withheld).toEqual([]);
    expect(withheld.filter((feature) => feature.startsWith("task.testServices"))).toEqual([]);
    expect(emulatorImagePrepulled(shipped, { AGENTX_TEST_SERVICES_NOT_PULLED: "all" })).toBe(false);
  });
  it("reads the shipped files once, not on every /ping (the answer is cached for the life of the process)", async () => {
    const shipped = await files(listed, true);
    expect(emulatorImagePrepulled(shipped)).toBe(true);
    await rm(join(shipped.catalog, ".."), { recursive: true, force: true });
    expect(emulatorImagePrepulled(shipped)).toBe(true);
    expect(testServicesAdvertisedFeatures(env, shipped)).toEqual(["task.testServices.v1", "task.testServices.fileSeed.v1", "task.testServices.seedLock.v1", "task.testServices.aws.v1", "task.testServices.aws.allServices.v1", "task.testServices.companyImage.v1"]);
    forgetEmulatorImageCache();
    expect(emulatorImagePrepulled(shipped)).toBe(false);
  });
  it("any unreadable or invalid shipped file means not advertised", async () => {
    const dir = await temp("rsv-ship-");
    await writeFile(join(dir, "bad.json"), "{not json");
    expect(emulatorImagePrepulled({ catalog: join(dir, "missing.json"), prepull: join(dir, "missing.json") })).toBe(false);
    expect(emulatorImagePrepulled({ catalog: join(dir, "bad.json"), prepull: join(dir, "bad.json") })).toBe(false);
  });
});
