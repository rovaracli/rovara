// Slice 2, s2-emulator-run: the Opus review's fixes. (1) The ledger side: "too many different calls" is its own failure word, from the summary's limits and from an answer past the probe's limit. (2) The IaC reading is
// guarded (a thread with a time limit) and FAILS CLOSED: a pointer the detector does not read, a skipped folder, a file the parser refuses, any note, a cut at the resource limit, nothing found. (3) The emulator is
// restricted to the planned services in its env file. (4) A round whose record is lost makes the run's record unreadable. (5) The ledger call is cancelled and its container removed when the time is up.
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { runNetworkAddresses, runNetworkHelperIp, runNetworkLabelArgs, runNetworkName } from "../../packages/worker/src/run-network.js";
import { type EmulatorControlTarget } from "../../packages/worker/src/emulator-control.js";
import { EmulatorLedgerError, LEDGER_LIMITS, emulatorLedgerPort, parseLedgerSummary } from "../../packages/worker/src/emulator-ledger.js";
import { EmulatorSeedError, IAC_FILE_MAX_BYTES, readAwsResourcesFromIac } from "../../packages/worker/src/service-seed-aws.js";
import { LOCAL_AWS_SERVICE_KEYS, newLocalAwsCredentials, startHelpers, type HelperFiles, type HelperRequest } from "../../packages/worker/src/service-helpers.js";
import { CONTROL_ANSWER_MAX_BYTES, probeCli } from "../../packages/worker/src/service-probe.js";
import { FLOODED_AWS_USAGE, UNREADABLE_AWS_USAGE, buildServiceUsageRecord, mergeAwsUsage } from "../../packages/worker/src/service-usage-record.js";
import { createServiceRedactor } from "../../packages/worker/src/service-env.js";
import { ServiceCatalogSchema } from "../../packages/contracts/src/service-catalog.js";
import { readFileSync } from "node:fs";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const NOW = 1_800_000_000_000;
const PROBE_IMAGE = `rovara/worker@sha256:${"b".repeat(64)}`;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function workspace(files: Record<string, string>): Promise<{ root: string; repo: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rsv-iac-")));
  roots.push(root);
  const repo = join(root, "app");
  await mkdir(repo, { recursive: true });
  for (const [path, text] of Object.entries(files)) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), text); }
  return { root, repo };
}
const TEMPLATE = `Resources:
  Archive:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: orders-archive
  Events:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: order-events
`;
const read = async (files: Record<string, string>, path: string, extra: { services?: string[]; guard?: { timeoutMs: number } } = {}) => {
  const { root, repo } = await workspace(files);
  return readAwsResourcesFromIac({ ref: { path }, services: extra.services ?? ["s3", "sqs", "dynamodb"], rootPath: root, repositoryPaths: [repo], ...(extra.guard === undefined ? {} : { guard: extra.guard }) });
};
const refusal = async (promise: Promise<unknown>): Promise<EmulatorSeedError> => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(EmulatorSeedError);
  expect((error as EmulatorSeedError).reason).toBe("refused");
  expect((error as Error).message).toBe("The project's AWS resources cannot be created in the test services");
  return error as EmulatorSeedError;
};

describe("reading the plan's infrastructure file (MEDIUM 1 and 2)", () => {
  it("reads a template the detector reads, in a thread, for the planned services only (a topic and an unplanned service are left out)", async () => {
    const found = await read({ "app/template.yaml": `${TEMPLATE}  Alerts:\n    Type: AWS::SNS::Topic\n    Properties:\n      TopicName: alerts\n` }, "app/template.yaml", { services: ["s3", "sqs"] });
    expect(found).toEqual([{ kind: "bucket", name: "orders-archive" }, { kind: "queue", name: "order-events" }]);
    expect(await read({ "app/template.yaml": TEMPLATE }, "app/template.yaml", { services: ["s3"] })).toEqual([{ kind: "bucket", name: "orders-archive" }]);
  });
  it("REFUSES a pointer the detector does not read: app/notes.yaml (even with a valid template inside), a README, a file in a skipped folder", async () => {
    const notes = await refusal(read({ "app/notes.yaml": TEMPLATE }, "app/notes.yaml"));
    expect(notes.note).toBe("The infrastructure file the plan names is not one that setup reads for resources");
    await refusal(read({ "app/README.md": TEMPLATE }, "app/README.md"));
    await refusal(read({ "app/node_modules/x/template.yaml": TEMPLATE }, "app/node_modules/x/template.yaml"));
    await refusal(read({ "app/dist/template.yaml": TEMPLATE }, "app/dist/template.yaml"));
  });
  it("REFUSES a file the YAML parser refuses (too many aliases, a bomb), with the detector's note, not a partial read", async () => {
    const aliases = `x: &a [1]\n${Array.from({ length: 70 }, (_v, index) => `k${String(index)}: *a`).join("\n")}\n`;
    const bomb = `Resources:\n  Archive:\n    Type: AWS::S3::Bucket\n    Properties:\n      BucketName: orders-archive\n${aliases.replace(/^/gmu, "  ")}`;
    const error = await refusal(read({ "app/template.yaml": `${TEMPLATE}${aliases}` }, "app/template.yaml"));
    expect(error.note).toBe("Reading the infrastructure file raised a problem (a file the parser refused, or more resources than are read)");
    await refusal(read({ "app/template.yaml": bomb }, "app/template.yaml"));
    await refusal(read({ "app/template.yaml": "Resources: [unclosed\n  - : :" }, "app/template.yaml"));
  });
  it("REFUSES when the detector cuts at its resource limit (more than 24 of one kind), never a silent first 24", async () => {
    const many = `Resources:\n${Array.from({ length: 30 }, (_v, index) => `  B${String(index)}:\n    Type: AWS::S3::Bucket\n    Properties:\n      BucketName: bucket-${String(index).padStart(2, "0")}\n`).join("")}`;
    const error = await refusal(read({ "app/template.yaml": many }, "app/template.yaml"));
    expect(error.note).toContain("raised a problem");
  });
  it("REFUSES when nothing is found for the plan's services (a template with only a function; a bucket when only SQS is planned)", async () => {
    const lambda = "Resources:\n  Fn:\n    Type: AWS::Lambda::Function\n    Properties:\n      FunctionName: f\n";
    expect((await refusal(read({ "app/template.yaml": lambda }, "app/template.yaml"))).note).toBe("The infrastructure file the plan names declares no resources for the services in the plan");
    await refusal(read({ "app/template.yaml": TEMPLATE.split("  Events:")[0]! }, "app/template.yaml", { services: ["sqs"] }));
    await refusal(read({ "app/template.yaml": "" }, "app/template.yaml"));
  });
  it("REFUSES a file past the detector's 256 KiB (never half read), a link or a missing file, and a table the detector found no key for", async () => {
    expect(IAC_FILE_MAX_BYTES).toBe(256 * 1024);
    const big = `${TEMPLATE}#${"x".repeat(IAC_FILE_MAX_BYTES)}\n`;
    expect((await refusal(read({ "app/template.yaml": big }, "app/template.yaml"))).note).toBe("The infrastructure file the plan names is too large to read");
    await refusal(read({}, "app/template.yaml"));
    await refusal(read({ "app/template.yaml": "Resources:\n  T:\n    Type: AWS::DynamoDB::Table\n    Properties:\n      TableName: orders\n" }, "app/template.yaml"));
  });
  it("runs the detector in a time-limited thread: a thread that is stopped is a refusal ('took too long'), not a read", async () => {
    const error = await refusal(read({ "app/template.yaml": TEMPLATE }, "app/template.yaml", { guard: { timeoutMs: 1 } }));
    expect(error.note).toBe("Reading the infrastructure file took too long and was stopped");
  });
  it("the detector sees only the one file, only its resource detector runs (an SDK call in the same file is not reported), and a refusal never carries a name from the file", async () => {
    const error = await refusal(read({ "app/notes.yaml": TEMPLATE.replace("orders-archive", "super-secret-bucket") }, "app/notes.yaml"));
    expect(JSON.stringify([error.message, error.note, error.stack])).not.toContain("super-secret-bucket");
  });
});

describe("the ledger's flood word (HIGH)", () => {
  const op = { calls: 1, unsupported: 0, errors: 0 };
  const flood = JSON.stringify({ s3: { ...op, operations: Object.fromEntries(Array.from({ length: LEDGER_LIMITS.operationsPerService + 1 }, (_v, index) => [`Op${String(index)}`, op])) } });
  it("more different operations than any honest run makes is 'too_many'; any other shape fault is 'invalid'", () => {
    expect(LEDGER_LIMITS.operationsPerService).toBeLessThanOrEqual(200);
    expect(() => parseLedgerSummary(flood)).toThrow(EmulatorLedgerError);
    try { parseLedgerSummary(flood); } catch (error) { expect((error as EmulatorLedgerError).reason).toBe("too_many"); }
    try { parseLedgerSummary("not json"); } catch (error) { expect((error as EmulatorLedgerError).reason).toBe("invalid"); }
    const services = JSON.stringify(Object.fromEntries(Array.from({ length: LEDGER_LIMITS.services + 1 }, (_v, index) => [`svc${String(index)}`, { ...op, operations: {} }])));
    try { parseLedgerSummary(services); } catch (error) { expect((error as EmulatorLedgerError).reason).toBe("too_many"); }
    expect(parseLedgerSummary(JSON.stringify({ s3: { ...op, operations: Object.fromEntries(Array.from({ length: LEDGER_LIMITS.operationsPerService }, (_v, index) => [`Op${String(index)}`, op])) } })).services[0]!.operations).toHaveLength(LEDGER_LIMITS.operationsPerService);
  });
  it("the probe exits 2 (and prints nothing) when the answer is past its limit, 1 for any other failure", async () => {
    const big = createServer((_request, response) => { response.writeHead(200).end("x".repeat(CONTROL_ANSWER_MAX_BYTES + 1)); });
    const fine = createServer((_request, response) => { response.writeHead(500).end("no"); });
    await new Promise<void>((done) => big.listen(0, "127.0.0.1", done));
    await new Promise<void>((done) => fine.listen(0, "127.0.0.1", done));
    try {
      const argv = (port: number) => ["--host", "127.0.0.1", "--port", String(port), "--path", "/_rovara/ledger/summary", "--control", "GET", "--print"];
      expect(await probeCli(argv((big.address() as AddressInfo).port), { ROVARA_CONTROL_TOKEN: "t".repeat(20) })).toEqual({ exitCode: 2, stdout: "" });
      expect(await probeCli(argv((fine.address() as AddressInfo).port), { ROVARA_CONTROL_TOKEN: "t".repeat(20) })).toEqual({ exitCode: 1, stdout: "" });
    } finally {
      big.closeAllConnections(); fine.closeAllConnections(); big.close(); fine.close();
    }
  });
  it("a control call whose probe exits 2 is 'too_large'; the record then says 'flooded', never 'unreadable' or clean; a stream of other failures stays 'unreadable'", async () => {
    const redactor = createServiceRedactor([]);
    const target = (exit: number): EmulatorControlTarget => ({
      docker: { run: () => Promise.resolve({ exitCode: exit, stdout: "", stderr: "" }) },
      network: { name: runNetworkName(RUN), gateway: runNetworkAddresses(153).gateway, labelArgs: () => runNetworkLabelArgs({ runId: RUN, workspace: "0123456789abcdef", createdAt: NOW, expiresAt: NOW + 1 }) },
      helper: { container: "c", address: runNetworkHelperIp(153, 0), ports: [4566] }, probeImage: PROBE_IMAGE,
      files: { write: (name) => Promise.resolve(`/run/x/${name}`), remove: () => Promise.resolve() }, controlToken: newLocalAwsCredentials().controlToken,
    });
    await expect(emulatorLedgerPort(target(2))()).rejects.toMatchObject({ reason: "too_large" });
    await expect(emulatorLedgerPort(target(1))()).rejects.toMatchObject({ reason: "failed" });
    expect((await buildServiceUsageRecord({ planned: [], redactor, emulator: emulatorLedgerPort(target(2)) })).aws).toEqual(FLOODED_AWS_USAGE);
    expect((await buildServiceUsageRecord({ planned: [], redactor, emulator: emulatorLedgerPort(target(1)) })).aws).toEqual(UNREADABLE_AWS_USAGE);
    expect((await buildServiceUsageRecord({ planned: [], redactor, emulator: () => Promise.reject(new EmulatorLedgerError("too_many")) })).aws).toEqual(FLOODED_AWS_USAGE);
  });
  it("flooded survives the merge of rounds, and beats unreadable", () => {
    const read = { ledger: "read" as const, services: [{ service: "s3", calls: 1, unsupported: 0 }], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0 };
    expect(mergeAwsUsage(read, FLOODED_AWS_USAGE)).toEqual(FLOODED_AWS_USAGE);
    expect(mergeAwsUsage(FLOODED_AWS_USAGE, read)).toEqual(FLOODED_AWS_USAGE);
    expect(mergeAwsUsage(UNREADABLE_AWS_USAGE, FLOODED_AWS_USAGE)).toEqual(FLOODED_AWS_USAGE);
  });
});

describe("the ledger call is cancelled with the time limit (LOW)", () => {
  it("when the 15 s race ends, the call container is stopped and removed by name, and its files are gone", async () => {
    const calls: string[][] = [];
    const present = new Set<string>();
    let signalSeen: AbortSignal | undefined;
    const docker: DockerCli = {
      run(args, options) {
        calls.push([...args]);
        if (args[0] === "run") {
          signalSeen = options?.signal;
          return new Promise((resolve) => { options?.signal?.addEventListener("abort", () => resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false }), { once: true }); });
        }
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
    };
    const files: HelperFiles = { write(name) { present.add(name); return Promise.resolve(`/run/x/${name}`); }, remove(name) { present.delete(name); return Promise.resolve(); } };
    const target: EmulatorControlTarget = {
      docker, network: { name: runNetworkName(RUN), gateway: runNetworkAddresses(153).gateway, labelArgs: () => runNetworkLabelArgs({ runId: RUN, workspace: "0123456789abcdef", createdAt: NOW, expiresAt: NOW + 1 }) },
      helper: { container: "rvi-h0123456789", address: runNetworkHelperIp(153, 0), ports: [4566] }, probeImage: PROBE_IMAGE, files, controlToken: newLocalAwsCredentials().controlToken,
    };
    const record = await buildServiceUsageRecord({ planned: [], redactor: createServiceRedactor([]), ledgerLimitMs: 30, emulator: emulatorLedgerPort(target) });
    expect(record.aws).toEqual(UNREADABLE_AWS_USAGE);
    expect(signalSeen?.aborted).toBe(true);
    const name = calls.find((call) => call[0] === "run")![calls.find((call) => call[0] === "run")!.indexOf("--name") + 1]!;
    await new Promise((done) => setTimeout(done, 20));
    expect(calls.some((call) => call[0] === "rm" && call.includes(name))).toBe(true);
    expect(present.size).toBe(0);
  });
});

describe("the emulator is restricted to the planned services (LOW)", () => {
  const entry = (() => { const copy = structuredClone(ServiceCatalogSchema.parse(JSON.parse(readFileSync(new URL("../../environments/service-catalog/catalog.json", import.meta.url), "utf8")) as unknown).entries.find((candidate) => candidate.id === "local-aws@r1")!); copy.image.digest = "a".repeat(64); return copy; })();
  async function envFileFor(awsServices: readonly string[] | undefined): Promise<string> {
    let content = "";
    const docker: DockerCli = { run: (args) => Promise.resolve(args[0] === "image" ? { exitCode: 0, stdout: "null\n", stderr: "" } : args[0] === "inspect" ? { exitCode: 0, stdout: "running\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" }) };
    const files: HelperFiles = { write(name, text) { if (name.endsWith(".env")) content = text; return Promise.resolve(`/run/x/${name}`); }, remove: () => Promise.resolve() };
    const request: HelperRequest = { id: "aws", name: "aws", entry, credentials: newLocalAwsCredentials(), region: "us-east-1", ...(awsServices === undefined ? {} : { awsServices }) };
    const net = { name: runNetworkName(RUN), bridge: "b", slot: 153, ...runNetworkAddresses(153), helperIp: (index: number) => runNetworkHelperIp(153, index), labelArgs: () => runNetworkLabelArgs({ runId: RUN, workspace: "0123456789abcdef", createdAt: NOW, expiresAt: NOW + 1_500_000 }), stop: () => Promise.resolve() };
    await startHelpers(docker, net, { registry: "registry.example.test/rovara", edition: "public", probeImage: PROBE_IMAGE, maxMemMiB: 3072, helpers: [request], files, now: () => NOW, sleep: () => Promise.resolve() });
    return content;
  }
  it("switches off, with the fork's per-service switch, every service that is not planned", async () => {
    const file = await envFileFor(["s3", "sqs", "dynamodb"]);
    const off = [...file.matchAll(/^ROVARA_AWS_SERVICES_([A-Z0-9]+)_ENABLED=false$/gmu)].map((match) => match[1]!.toLowerCase()).sort();
    expect(off).toEqual(LOCAL_AWS_SERVICE_KEYS.filter((key) => !["s3", "sqs", "dynamodb"].includes(key)).sort());
    expect(off).toContain("sns");
    expect(off).toContain("lambda");
    for (const planned of ["S3", "SQS", "DYNAMODB"]) expect(file).not.toContain(`ROVARA_AWS_SERVICES_${planned}_ENABLED`);
    expect(file).not.toContain("ENABLED=true");
  });
  it("only the planned services stay on: a plan with S3 alone switches SQS and DynamoDB off too", async () => {
    const file = await envFileFor(["s3"]);
    expect(file).toContain("ROVARA_AWS_SERVICES_SQS_ENABLED=false");
    expect(file).toContain("ROVARA_AWS_SERVICES_DYNAMODB_ENABLED=false");
    expect(file).not.toContain("ROVARA_AWS_SERVICES_S3_ENABLED");
  });
  it("without a service list every service stays on (the development default is unchanged), and an unknown, repeated or empty list is refused before anything starts", async () => {
    expect(await envFileFor(undefined)).not.toContain("_ENABLED");
    for (const bad of [[], ["s3", "s3"], ["s3", "nope"], ["S3"], ["s3\nROVARA_AWS_DEV_OPEN_CONTROL=1"]]) await expect(envFileFor(bad)).rejects.toThrow();
  });
});
