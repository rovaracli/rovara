// Slice 2, s2-emulator-run: the run contract of Rovara local AWS (the fork's README "Run contract") as the helper launcher starts it, and what the sandboxes are (and are not) given. Nothing starts Docker: a fake daemon records
// every argument list, and the env file seam records what was written. HIGH risk (secrets), so the tests are about where each of the three per-run values goes and where it does not.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ServiceCatalogSchema, type CatalogEntry } from "../../packages/contracts/src/service-catalog.js";
import { runNetworkAddresses, runNetworkBridge, runNetworkHelperIp, runNetworkLabelArgs, runNetworkName, type ServicesNetwork } from "../../packages/worker/src/run-network.js";
import {
  EMULATOR_CONTROL_PATHS, HelperStartError, controlRequestArgs, newLocalAwsCredentials, startHelpers, type HelperFiles, type HelperRequest,
} from "../../packages/worker/src/service-helpers.js";
import { ServiceEnvError, buildServiceEnvironment, createServiceRedactor, helperSecretValues, unbackedAwsServices, withServiceEnvFile } from "../../packages/worker/src/service-env.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const WS = "0123456789abcdef";
const NOW = 1_800_000_000_000;
const DIGEST = "a".repeat(64);
const REGISTRY = "registry.example.test/rovara";
const PROBE_IMAGE = `rovara/worker@sha256:${"b".repeat(64)}`;

const catalog = ServiceCatalogSchema.parse(JSON.parse(readFileSync(new URL("../../environments/service-catalog/catalog.json", import.meta.url), "utf8")) as unknown);
function emulatorEntry(): CatalogEntry {
  const copy = structuredClone(catalog.entries.find((entry) => entry.id === "local-aws@r1")!);
  copy.image.digest = DIGEST;
  return copy;
}
function makeNet(slot = 153): ServicesNetwork {
  const labels = { runId: RUN, workspace: WS, createdAt: NOW, expiresAt: NOW + 1_500_000 };
  return { name: runNetworkName(RUN), bridge: runNetworkBridge(RUN, slot), slot, ...runNetworkAddresses(slot), helperIp: (index: number) => runNetworkHelperIp(slot, index), labelArgs: () => runNetworkLabelArgs(labels), stop: () => Promise.resolve() };
}

function harness() {
  const calls: string[][] = [];
  const written: Array<{ name: string; content: string; mode: number }> = [];
  const present = new Map<string, string>();
  const containers = new Set<string>();
  const docker: DockerCli = {
    run(args) {
      calls.push([...args]);
      const ok = { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "image") return Promise.resolve({ exitCode: 0, stdout: "null\n", stderr: "" });
      if (args[0] === "run" && args.includes("--detach")) { containers.add(args[args.indexOf("--name") + 1]!); return Promise.resolve(ok); }
      if (args[0] === "inspect") return Promise.resolve({ exitCode: 0, stdout: "running\n", stderr: "" });
      return Promise.resolve(ok);
    },
  };
  const files: HelperFiles = {
    write(name, content, mode) { written.push({ name, content, mode }); present.set(name, content); return Promise.resolve(`/run/rovara-test/${name}`); },
    remove(name) { present.delete(name); return Promise.resolve(); },
  };
  const start = (helpers: HelperRequest[]) => startHelpers(docker, makeNet(), { registry: REGISTRY, edition: "public", probeImage: PROBE_IMAGE, maxMemMiB: 3_072, helpers, files, now: () => NOW, sleep: () => Promise.resolve() });
  return { calls, written, present, containers, start };
}
const emulator = (credentials: NonNullable<HelperRequest["credentials"]>, extra: Partial<HelperRequest> = {}): HelperRequest => ({ id: "aws", name: "aws", entry: emulatorEntry(), credentials, region: "us-east-1", ...extra });
const envFileOf = (h: ReturnType<typeof harness>): string => h.written.find((file) => file.name.endsWith(".env"))!.content;

describe("fresh values per run (newLocalAwsCredentials)", () => {
  it("makes three different values of 48 hex characters (16 is the emulator's floor)", () => {
    const credentials = newLocalAwsCredentials();
    const values = [credentials.password, credentials.controlToken, credentials.sqsReceiptSecret];
    expect(new Set(values).size).toBe(3);
    for (const value of values) expect(value).toMatch(/^[0-9a-f]{48}$/u);
  });
  it("never repeats a value across many runs and rounds", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 300; index += 1) {
      const credentials = newLocalAwsCredentials();
      for (const value of [credentials.password, credentials.controlToken, credentials.sqsReceiptSecret]) { expect(seen.has(value)).toBe(false); seen.add(value); }
    }
    expect(seen.size).toBe(900);
  });
  it("refuses a random source that repeats itself, or gives something too short: a repeated secret is never used", () => {
    expect(() => newLocalAwsCredentials(() => Buffer.alloc(24, 7))).toThrow(RangeError);
    expect(() => newLocalAwsCredentials(() => Buffer.alloc(4, 7))).toThrow(RangeError);
    let step = 0;
    expect(() => newLocalAwsCredentials(() => Buffer.alloc(24, step++ % 2))).toThrow(RangeError);
  });
});

describe("the emulator's env file (the run contract)", () => {
  it("sets the run address, the base URL on the FIRST alias and the entry's port, and the three secrets; QUARKUS_HTTP_HOST is the container's own address, never a wildcard", async () => {
    const h = harness();
    const credentials = newLocalAwsCredentials();
    await h.start([emulator(credentials, { aliases: ["s3-local", "aws"] })]);
    const lines = envFileOf(h).trimEnd().split("\n");
    const get = (name: string): string | undefined => lines.find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1);
    expect(get("QUARKUS_HTTP_HOST")).toBe(runNetworkHelperIp(153, 0));
    expect(get("QUARKUS_HTTP_HOST")).not.toMatch(/^0\.0\.0\.0$|^::|^127\./u);
    expect(get("ROVARA_AWS_BASE_URL")).toBe("http://s3-local:4566");
    expect(get("ROVARA_AWS_AUTH_PRESIGN_SECRET")).toBe(credentials.password);
    expect(get("ROVARA_AWS_SERVICES_SQS_RECEIPT_HANDLE_SECRET")).toBe(credentials.sqsReceiptSecret);
    expect(get("ROVARA_AWS_CONTROL_TOKEN")).toBe(credentials.controlToken);
    // The control paths are never opened by a switch, and nothing else is in the file.
    expect(envFileOf(h)).not.toContain("DEV_OPEN_CONTROL");
    expect(lines.map((line) => line.split("=")[0]).sort()).toEqual(["QUARKUS_HTTP_HOST", "ROVARA_AWS_AUTH_PRESIGN_SECRET", "ROVARA_AWS_BASE_URL", "ROVARA_AWS_CONTROL_TOKEN", "ROVARA_AWS_DEFAULT_REGION", "ROVARA_AWS_HOSTNAME", "ROVARA_AWS_SERVICES_SQS_RECEIPT_HANDLE_SECRET"]);
  });
  it("the file is mode 0600, goes to docker only as --env-file, and is removed once the emulator is healthy", async () => {
    const h = harness();
    await h.start([emulator(newLocalAwsCredentials())]);
    const file = h.written.find((entry) => entry.name.endsWith(".env"))!;
    expect(file.mode).toBe(0o600);
    const run = h.calls.find((call) => call.includes("--detach"))!;
    expect(run[run.indexOf("--env-file") + 1]).toBe(`/run/rovara-test/${file.name}`);
    expect(h.present.size).toBe(0);
  });
  it("no secret is in any docker argument, including the probe's", async () => {
    const h = harness();
    const credentials = newLocalAwsCredentials();
    await h.start([emulator(credentials)]);
    const all = h.calls.flat().join(" ");
    for (const value of helperSecretValues([{ credentials }])) expect(all).not.toContain(value);
    expect(h.calls.length).toBeGreaterThan(2);
  });
  it("the three values must all differ: a token equal to a signing secret (either one), or the two secrets equal, is refused before anything starts or is written", async () => {
    const good = newLocalAwsCredentials();
    const cases: Array<[string, NonNullable<HelperRequest["credentials"]>]> = [
      ["control = presign", { ...good, controlToken: good.password }],
      ["control = receipt", { ...good, controlToken: good.sqsReceiptSecret }],
      ["presign = receipt", { ...good, sqsReceiptSecret: good.password }],
      ["all equal", { password: good.password, controlToken: good.password, sqsReceiptSecret: good.password }],
    ];
    for (const [label, credentials] of cases) {
      const h = harness();
      await expect(h.start([emulator(credentials)]), label).rejects.toBeInstanceOf(HelperStartError);
      expect(h.containers.size, label).toBe(0);
      expect(h.written.length, label).toBe(0);
    }
  });
  it("each value must be present, plain (letters and digits) and 16 to 64 characters: the emulator's own floor is enforced here, so it never has to refuse a value", async () => {
    const good = newLocalAwsCredentials();
    const bad = [undefined, "", "short", "a".repeat(15), "a".repeat(65), `${"b".repeat(20)}\nROVARA_AWS_DEV_OPEN_CONTROL=1`, "has space in it 1234", "pw-with-dash-0123456789", "ünicode0123456789012"];
    for (const field of ["password", "controlToken", "sqsReceiptSecret"] as const) {
      for (const value of bad) {
        const h = harness();
        const credentials = { ...good, ...(value === undefined ? {} : { [field]: value }) };
        if (value === undefined) delete (credentials as Record<string, unknown>)[field];
        await expect(h.start([emulator(credentials)]), `${field}=${String(value)}`).rejects.toBeInstanceOf(HelperStartError);
        expect(h.containers.size).toBe(0);
        expect(h.written.length).toBe(0);
      }
    }
  });
  it("a refusal says one fixed sentence and never repeats a secret", async () => {
    const good = newLocalAwsCredentials();
    const h = harness();
    const error = await h.start([emulator({ ...good, controlToken: good.password })]).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(HelperStartError);
    expect(JSON.stringify([(error as Error).message, (error as Error).stack])).not.toContain(good.password);
    expect((error as Error).message).toBe("aws cannot be started here");
  });
  it("a start that fails after the file was written removes it and the container, and no secret is left in any call", async () => {
    const credentials = newLocalAwsCredentials();
    const written: string[] = [];
    const present = new Set<string>();
    const calls: string[][] = [];
    const docker: DockerCli = { run(args) { calls.push([...args]); return Promise.resolve(args.includes("--detach") ? { exitCode: 125, stdout: "", stderr: `Unable to find image ${credentials.controlToken}` } : { exitCode: 0, stdout: "null\n", stderr: "" }); } };
    const files: HelperFiles = { write(name, content) { written.push(content); present.add(name); return Promise.resolve(`/run/x/${name}`); }, remove(name) { present.delete(name); return Promise.resolve(); } };
    const error = await startHelpers(docker, makeNet(), { registry: REGISTRY, edition: "public", probeImage: PROBE_IMAGE, maxMemMiB: 3_072, helpers: [emulator(credentials)], files, now: () => NOW, sleep: () => Promise.resolve() }).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(HelperStartError);
    expect((error as Error).message).not.toContain(credentials.controlToken);
    expect(present.size).toBe(0);
    expect(calls.flat().join(" ")).not.toContain(credentials.controlToken);
  });
});

describe("distinct values per run and per round", () => {
  it("two emulators of one task (the working phase's and a sealed round's, or two rounds) get disjoint secrets, each in its own file", async () => {
    const seen: Array<{ name: string; secrets: string[] }> = [];
    for (let round = 0; round < 3; round += 1) {
      const h = harness();
      const credentials = newLocalAwsCredentials();
      await h.start([emulator(credentials)]);
      const content = envFileOf(h);
      for (const value of helperSecretValues([{ credentials }])) expect(content).toContain(value);
      seen.push({ name: `r${String(round)}`, secrets: helperSecretValues([{ credentials }]) });
    }
    const all = seen.flatMap((entry) => entry.secrets);
    expect(all).toHaveLength(9);
    expect(new Set(all).size).toBe(9);
  });
  it("a round's secrets are not in another round's redactor spellings by accident: each set is registered with its own redactor and only its own is rewritten", () => {
    const a = newLocalAwsCredentials();
    const b = newLocalAwsCredentials();
    const redactA = createServiceRedactor(helperSecretValues([{ credentials: a }]));
    for (const value of [a.password, a.controlToken, a.sqsReceiptSecret]) expect(redactA.text(`x ${value} y`)).toBe("x <redacted> y");
    for (const value of [b.password, b.controlToken, b.sqsReceiptSecret]) expect(redactA.text(`x ${value} y`)).toBe(`x ${value} y`);
  });
});

describe("helperSecretValues and the redactor cover all three", () => {
  it("lists the presign secret, the control token and the SQS receipt secret", () => {
    const c = newLocalAwsCredentials();
    expect(helperSecretValues([{ credentials: c }])).toEqual([c.password, c.controlToken, c.sqsReceiptSecret]);
  });
  it("the redactor removes each of them, in the usual spellings, from text an error or a log would carry", () => {
    const c = newLocalAwsCredentials();
    const redactor = createServiceRedactor(helperSecretValues([{ credentials: c }]));
    for (const value of [c.password, c.controlToken, c.sqsReceiptSecret]) {
      for (const text of [value, value.toUpperCase(), `Bearer ${value}`, `http://aws:4566/?token=${value}`]) expect(redactor.text(text), text).not.toContain(value.slice(0, 20));
      expect(redactor.contains(Buffer.from(`prefix ${value} suffix`))).toBe(true);
    }
  });
});

describe("what the sandboxes are given (TS15): per-service endpoints, the emulator (which refuses and counts) for the rest, and none of the three values", () => {
  const sinkholeUrl = "http://sinkhole";
  const build = (sandbox: "working" | "check", c = newLocalAwsCredentials()) => ({
    c,
    environment: buildServiceEnvironment({
      sandbox, sinkholeUrl, dependencies: [], neverValues: helperSecretValues([{ credentials: c }]),
      aws: { alias: "aws", port: 4566, region: "us-east-1", emulatedServices: ["s3", "sqs", "dynamodb"], unbackedServices: unbackedAwsServices(["s3", "sqs", "dynamodb"]) },
    }),
  });
  for (const sandbox of ["working", "check"] as const) {
    it(`the ${sandbox} sandbox: S3, SQS and DynamoDB point at the emulator, every other AWS service and the global endpoint at the emulator too`, () => {
      const { environment } = build(sandbox);
      const map = new Map(environment.entries);
      expect(map.get("AWS_ENDPOINT_URL_S3")).toBe("http://aws:4566");
      expect(map.get("AWS_ENDPOINT_URL_SQS")).toBe("http://aws:4566");
      expect(map.get("AWS_ENDPOINT_URL_DYNAMODB")).toBe("http://aws:4566");
      const others = [...map].filter(([name]) => name.startsWith("AWS_ENDPOINT_URL_") && !["S3", "SQS", "DYNAMODB"].includes(name.slice("AWS_ENDPOINT_URL_".length)));
      expect(others.length).toBeGreaterThanOrEqual(10);
      for (const [name, value] of others) expect(value, name).toBe("http://aws:4566");
      // The global endpoint is the emulator in both sandboxes: a call to a service nobody named is refused by the emulator and written to its ledger (a sinkhole host is never looked up, so nothing would count it).
      expect(map.get("AWS_ENDPOINT_URL")).toBe("http://aws:4566");
      expect(JSON.stringify([...map])).not.toContain("sinkhole");
    });
    it(`the ${sandbox} sandbox's variables hold none of the three values and no ROVARA_* name`, () => {
      const { c, environment } = build(sandbox);
      const text = JSON.stringify(environment.entries);
      for (const value of [c.password, c.controlToken, c.sqsReceiptSecret]) expect(text).not.toContain(value);
      expect(environment.entries.some(([name]) => /^ROVARA_|CONTROL|TOKEN|RECEIPT|PRESIGN/iu.test(name))).toBe(false);
      expect(environment.secretValues.some((value) => [c.password, c.controlToken, c.sqsReceiptSecret].includes(value))).toBe(false);
    });
  }
  it("a variable that would carry any of the three values is refused (the builder fails closed instead of handing the sandbox the token)", () => {
    const c = newLocalAwsCredentials();
    for (const leaked of [c.controlToken, c.password, c.sqsReceiptSecret]) {
      expect(() => buildServiceEnvironment({
        sandbox: "check", sinkholeUrl, neverValues: helperSecretValues([{ credentials: c }]),
        dependencies: [{ id: "db", host: "db", port: 5432, credentials: { user: "rovara", password: leaked, database: "app" }, connect: { env: [{ name: "DATABASE_URL", template: "postgres://{user}:{password}@{host}:{port}/{db}" }], hostAliases: ["db"] } }],
      })).toThrow(ServiceEnvError);
    }
  });
  it("unbackedAwsServices is every known AWS service but the emulated ones, and refuses a service the table does not know", () => {
    const unbacked = unbackedAwsServices(["s3", "sqs", "dynamodb"]);
    expect(unbacked).not.toContain("s3");
    expect(unbacked).not.toContain("sqs");
    expect(unbacked).not.toContain("dynamodb");
    expect(unbacked).toContain("sns");
    expect(unbacked).toContain("lambda");
    expect(() => unbackedAwsServices(["s3", "not-a-service"])).toThrow(ServiceEnvError);
  });
  it("the env file a sandbox command gets holds only these variables: written 0600, passed as --env-file, and removed", async () => {
    const { c, environment } = build("check");
    const files = { written: [] as Array<{ name: string; content: string; mode: number }>, present: new Set<string>() };
    const seam: HelperFiles = { write(name, content, mode) { files.written.push({ name, content, mode }); files.present.add(name); return Promise.resolve(`/run/x/${name}`); }, remove(name) { files.present.delete(name); return Promise.resolve(); } };
    const args = await withServiceEnvFile(seam, "chk-1", environment, (envFileArgs) => Promise.resolve(envFileArgs));
    expect(args).toEqual(["--env-file", "/run/x/chk-1.env"]);
    expect(files.written[0]!.mode).toBe(0o600);
    for (const value of [c.password, c.controlToken, c.sqsReceiptSecret]) expect(files.written[0]!.content).not.toContain(value);
    expect(files.present.size).toBe(0);
  });
});

describe("the control call's arguments (the token and the body are never arguments)", () => {
  const net = makeNet();
  const base = { probeImage: PROBE_IMAGE, address: runNetworkHelperIp(153, 0), port: 4566, name: "rsv-call-1", envFile: "/run/rovara-test/call.env" };
  it("the three control paths are the only ones, and any other path, a GET with a body, or a relative file is refused", () => {
    expect(Object.values(EMULATOR_CONTROL_PATHS)).toEqual(["/_rovara/reset", "/_rovara/seed", "/_rovara/ledger/summary"]);
    for (const path of ["/_rovara/tick/all", "/_rovara/ledger", "/_rovara/health", "/", "/_rovara/seed/", "/_rovara/../x", "/_rovara/seed?x=1", "/_rovara/lambda/function-code/x"]) {
      expect(() => controlRequestArgs(net, { ...base, path, method: "POST" }), path).toThrow(RangeError);
    }
    expect(() => controlRequestArgs(net, { ...base, path: "/_rovara/ledger/summary", method: "GET", bodyFile: "/run/rovara-test/b.json" })).toThrow(RangeError);
    expect(() => controlRequestArgs(net, { ...base, path: "/_rovara/seed", method: "POST", bodyFile: "relative/b.json" })).toThrow(RangeError);
    expect(() => controlRequestArgs(net, { ...base, path: "/_rovara/seed", method: "POST", bodyFile: "/run/../etc/passwd" })).toThrow(RangeError);
    expect(() => controlRequestArgs(net, { ...base, path: "/_rovara/seed", method: "DELETE" as "GET" })).toThrow(RangeError);
    expect(() => controlRequestArgs(net, { ...base, path: "/_rovara/seed", method: "POST", timeoutMs: 5 })).toThrow(RangeError);
  });
  it("is a hardened container on the run network: no capability, read-only root, labels, --env-file for the token, a read-only mount for the body, the probe program last", () => {
    const args = controlRequestArgs(net, { ...base, path: "/_rovara/seed", method: "POST", bodyFile: "/run/rovara-test/b.json", print: true, timeoutMs: 8000 });
    expect(args.slice(0, 3)).toEqual(["run", "--rm", "--name"]);
    expect(args).toContain("--read-only");
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args[args.indexOf("--network") + 1]).toBe(net.name);
    for (const label of net.labelArgs()) expect(args).toContain(label);
    expect(args[args.indexOf("--env-file") + 1]).toBe(base.envFile);
    expect(args[args.indexOf("-v") + 1]).toBe("/run/rovara-test/b.json:/rovara/body.json:ro");
    const program = args.slice(args.indexOf(PROBE_IMAGE) + 1);
    expect(program).toEqual(["/opt/agentx/packages/worker/dist/service-probe.js", "--host", base.address, "--port", "4566", "--path", "/_rovara/seed", "--control", "POST", "--timeout-ms", "8000", "--body-file", "/rovara/body.json", "--print"]);
    expect(args.join(" ")).not.toMatch(/ROVARA_CONTROL_TOKEN|--token/u);
  });
  it("a GET prints and carries no mount", () => {
    const args = controlRequestArgs(net, { ...base, path: "/_rovara/ledger/summary", method: "GET", print: true });
    expect(args).not.toContain("-v");
    expect(args.slice(args.indexOf(PROBE_IMAGE) + 1)).toContain("--print");
  });
  it("an address outside the run's /24 or a port that is not one is refused", () => {
    expect(() => controlRequestArgs(net, { ...base, address: "10.0.0.5", path: "/_rovara/seed", method: "POST" })).toThrow(RangeError);
    expect(() => controlRequestArgs(net, { ...base, port: 0, path: "/_rovara/seed", method: "POST" })).toThrow(RangeError);
  });
});
