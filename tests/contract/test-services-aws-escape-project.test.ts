// Test services, slice 2: the AWS overlay of the escape project (tests/fixtures/test-services-escape-project/aws) is run on staging as a task's checks. These tests check that its tests are what they claim, against a fake
// Rovara local AWS (a plain HTTP server that answers the way the fork does: a health path, control paths refused without the token, S3 / SQS / DynamoDB for the declared resources, a refusal for anything else): the right
// answers PASS, and each wrong one FAILS (a control path that answers, a 404 instead of a refusal, a missing resource, nothing listening, no endpoint). Nothing here needs Docker.
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const FIXTURE = new URL("../fixtures/test-services-escape-project/", import.meta.url).pathname;
const servers: Server[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** The slice-1 project with the overlay copied over it, as an operator sets up the staging project (and the variant, when asked). */
function project(variant = false): string {
  const directory = mkdtempSync(join(tmpdir(), "aws-escape-"));
  directories.push(directory);
  cpSync(FIXTURE, directory, { recursive: true });
  cpSync(join(FIXTURE, "aws"), directory, { recursive: true });
  if (variant) cpSync(join(FIXTURE, "aws", "variants", "out-of-plan"), directory, { recursive: true });
  rmSync(join(directory, "variants"), { recursive: true, force: true });
  return directory;
}

interface Behaviour {
  /** What a control path answers (default 403 for any control call). */
  control?: (method: string, path: string, headers: IncomingMessage["headers"]) => { status: number; body?: string };
  health?: number;
  /** Resources that exist; the default is the template's three. */
  bucket?: boolean; queue?: boolean; table?: boolean;
  sns?: number;
}
function fakeEmulator(behaviour: Behaviour = {}): Promise<string> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = request.url ?? "/";
      const reply = (status: number, text = ""): void => { response.statusCode = status; response.end(text); };
      if (url === "/_rovara/health") return reply(behaviour.health ?? 200, "ok");
      if (url.startsWith("/_rovara/")) { const answer = behaviour.control?.(request.method ?? "GET", url, request.headers) ?? { status: 403, body: "forbidden" }; return reply(answer.status, answer.body ?? ""); }
      const auth = String(request.headers["authorization"] ?? "");
      if (url.startsWith("/orders-archive/")) {
        if (behaviour.bucket === false) return reply(404, "NoSuchBucket");
        if (request.method === "PUT") { (server as unknown as { stored: string }).stored = body; return reply(200); }
        return reply(200, (server as unknown as { stored?: string }).stored ?? "");
      }
      if (auth.includes("/sqs/")) return behaviour.queue === false ? reply(400, "QueueDoesNotExist") : reply(200, "<GetQueueUrlResponse>http://aws:4566/000000000000/order-events</GetQueueUrlResponse>");
      if (auth.includes("/dynamodb/")) return behaviour.table === false ? reply(400, '{"__type":"ResourceNotFoundException"}') : reply(200, JSON.stringify({ Table: { TableName: "orders", KeySchema: [{ AttributeName: "orderId", KeyType: "HASH" }] } }));
      if (auth.includes("/sns/")) return reply(behaviour.sns ?? 400, "service disabled");
      return reply(404);
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
}
/** A port nothing listens on. */
async function closedEndpoint(): Promise<string> {
  const url = await fakeEmulator();
  const server = servers.pop()!;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return url;
}

const run = (directory: string, file: string, env: Record<string, string>): Promise<{ status: number | null; output: string }> => new Promise((resolve) => {
  const child = spawn(process.execPath, ["--test", join(directory, "tests", file)], { cwd: directory, env: { PATH: process.env["PATH"] ?? "", ESCAPE_CONNECT_TIMEOUT_MS: "800", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  child.once("close", (status) => { clearTimeout(timer); resolve({ status, output }); });
});
const at = (url: string): Record<string, string> => ({ AWS_ENDPOINT_URL_S3: url, AWS_ENDPOINT_URL_SQS: url, AWS_ENDPOINT_URL_DYNAMODB: url, AWS_ENDPOINT_URL_SNS: url });

describe("the overlay", () => {
  it("is plain node with no dependency, adds nothing to the slice-1 tests directory, and every overlay test file is described in the README with its check command", () => {
    const readme = readFileSync(join(FIXTURE, "README.md"), "utf8");
    for (const file of readdirSync(join(FIXTURE, "aws", "tests"))) {
      expect(readme, file).toContain(`\`${file}\``);
      expect(readme, file).toContain(`node --test tests/${file}`);
    }
    expect(readme).toContain("aws-out-of-plan.test.js");
    for (const dir of ["aws/lib", "aws/tests", "aws/variants/out-of-plan/tests"]) {
      for (const file of readdirSync(join(FIXTURE, dir))) expect(readFileSync(join(FIXTURE, dir, file), "utf8"), file).not.toMatch(/require\("(?!node:|\.)/u);
    }
    expect(readdirSync(join(FIXTURE, "tests")).filter((file) => file.startsWith("aws"))).toEqual([]);
  });
  it("the endpoint override is read only through lib/fixture.js, which honours it only under ESCAPE_FIXTURE_TEST=1", async () => {
    const source = readFileSync(join(FIXTURE, "aws", "lib", "aws-http.js"), "utf8");
    expect(source.match(/process\.env\.ESCAPE_|process\.env\["ESCAPE_/gu)).toBeNull();
    const url = await fakeEmulator();
    // An override variable, without the fixture flag, and no endpoint from the run: nothing to attack, so the test FAILS.
    const answer = await run(project(), "aws-positive.test.js", { ESCAPE_AWS_ENDPOINT: url });
    expect(answer.status).not.toBe(0);
    expect(answer.output).toMatch(/no AWS_ENDPOINT_URL_S3/u);
  });
});

describe("aws-positive.test.js", () => {
  it("passes when the declared bucket, queue and table are there", async () => {
    const result = await run(project(), "aws-positive.test.js", at(await fakeEmulator()));
    expect(result.status, result.output).toBe(0);
  });
  it("fails when a declared resource is missing (the worker did not seed the template), when nothing listens, and when the run gave no endpoint", async () => {
    for (const missing of [{ bucket: false }, { queue: false }, { table: false }] as Behaviour[]) {
      const result = await run(project(), "aws-positive.test.js", at(await fakeEmulator(missing)));
      expect(result.status, JSON.stringify(missing)).not.toBe(0);
    }
    expect((await run(project(), "aws-positive.test.js", at(await closedEndpoint()))).status).not.toBe(0);
    expect((await run(project(), "aws-positive.test.js", {})).status).not.toBe(0);
  });
});

describe("aws-control.test.js", () => {
  it("passes when every control path is refused with 403 (and with 401), with no token and with a made-up one", async () => {
    expect((await run(project(), "aws-control.test.js", at(await fakeEmulator()))).status).toBe(0);
    expect((await run(project(), "aws-control.test.js", at(await fakeEmulator({ control: () => ({ status: 401 }) })))).status).toBe(0);
  });
  it("FAILS when a control path answers (2xx), when it only says 404 (not a refusal), when only one of the calls is let through, or when the refusal leaks the ledger", async () => {
    const cases: Behaviour[] = [
      { control: () => ({ status: 200, body: "{}" }) },
      { control: () => ({ status: 404 }) },
      { control: (method, path) => (method === "POST" && path === "/_rovara/reset" ? { status: 204 } : { status: 403 }) },
      { control: (_method, path, headers) => (path === "/_rovara/ledger/summary" && headers["x-rovara-control-token"] !== undefined ? { status: 200, body: "{}" } : { status: 403 }) },
      { control: () => ({ status: 403, body: '{"s3":{"calls":3,"operations":{}}}' }) },
    ];
    for (const behaviour of cases) {
      const result = await run(project(), "aws-control.test.js", at(await fakeEmulator(behaviour)));
      expect(result.status, result.output).not.toBe(0);
    }
  });
  it("FAILS when the emulator is not up (health), when nothing listens, and when the run gave no endpoint: a refusal of nothing proves nothing", async () => {
    expect((await run(project(), "aws-control.test.js", at(await fakeEmulator({ health: 503 })))).status).not.toBe(0);
    expect((await run(project(), "aws-control.test.js", at(await closedEndpoint()))).status).not.toBe(0);
    expect((await run(project(), "aws-control.test.js", {})).status).not.toBe(0);
  });
});

describe("the out-of-plan variant", () => {
  it("passes when the emulator refuses an SNS call, and fails when it accepts it or nothing answers", async () => {
    expect((await run(project(true), "aws-out-of-plan.test.js", at(await fakeEmulator()))).status).toBe(0);
    expect((await run(project(true), "aws-out-of-plan.test.js", at(await fakeEmulator({ sns: 200 })))).status).not.toBe(0);
    expect((await run(project(true), "aws-out-of-plan.test.js", at(await closedEndpoint()))).status).not.toBe(0);
    expect((await run(project(true), "aws-out-of-plan.test.js", {})).status).not.toBe(0);
  });
  it("is not in the clean project", () => {
    expect(readdirSync(join(project(), "tests"))).not.toContain("aws-out-of-plan.test.js");
  });
});
