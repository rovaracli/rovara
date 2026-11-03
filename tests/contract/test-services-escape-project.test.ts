// Test services, slice 1: the escape project (tests/fixtures/test-services-escape-project) is run on staging as a task's checks; its tests try each way out of a sealed round and pass only if the attempt FAILS. These tests
// check that its tests are what they claim: each one is aimed at something that IS reachable (a local server, a running writer, a planted table) and must then FAIL, and aimed at nothing it must PASS. Nothing here needs Docker.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const FIXTURE = new URL("../fixtures/test-services-escape-project/", import.meta.url).pathname;
const servers: Server[] = [];
const children: ChildProcess[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const listen = (host: string, handler?: (socket: Socket) => void): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer(handler ?? ((socket) => { socket.end(); }));
  servers.push(server);
  server.once("error", reject);
  server.listen(0, host, () => resolve((server.address() as { port: number }).port));
});
/** A port nothing listens on: bind, read the number, close. */
const closedPort = async (host = "127.0.0.1"): Promise<number> => {
  const port = await listen(host);
  await new Promise<void>((resolve) => { servers.pop()!.close(() => resolve()); });
  return port;
};
const runTest = (file: string, env: Record<string, string>) => spawnSync(process.execPath, ["--test", join(FIXTURE, "tests", file)], { cwd: FIXTURE, encoding: "utf8", timeout: 60_000, env: { PATH: process.env["PATH"] ?? "", ...env } });

describe("the escape project is what it claims", () => {
  it("is a node:test project with no dependency, and every test file is described in its README", () => {
    const manifest = JSON.parse(readFileSync(join(FIXTURE, "package.json"), "utf8")) as { scripts: Record<string, string>; dependencies?: unknown; devDependencies?: unknown };
    expect(manifest.scripts["test"]).toBe("node --test tests/");
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
    const readme = readFileSync(join(FIXTURE, "README.md"), "utf8");
    for (const file of readdirSync(join(FIXTURE, "tests"))) expect(readme, file).toContain(`\`${file}\``);
    for (const dir of ["lib", "tools", "tests"]) {
      for (const file of readdirSync(join(FIXTURE, dir))) expect(readFileSync(join(FIXTURE, dir, file), "utf8"), file).not.toMatch(/require\("(?!node:|\.)/u);
    }
  });

  it("internet: fails when a public-looking target is reachable, passes when nothing answers; a public name must not resolve publicly", async () => {
    const open = await listen("127.0.0.1");
    expect(runTest("internet.test.js", { ESCAPE_INTERNET_TARGETS: `127.0.0.1:${String(open)}`, ESCAPE_SKIP_DNS: "1" }).status).not.toBe(0);
    const closed = await closedPort();
    expect(runTest("internet.test.js", { ESCAPE_INTERNET_TARGETS: `127.0.0.1:${String(closed)}`, ESCAPE_SKIP_DNS: "1" }).status).toBe(0);
    // A name that is a public address literal "resolves" publicly: the DNS test fails; a name that resolves to loopback passes.
    expect(runTest("internet.test.js", { ESCAPE_INTERNET_TARGETS: `127.0.0.1:${String(closed)}`, ESCAPE_PUBLIC_NAME: "8.8.8.8" }).status).not.toBe(0);
    expect(runTest("internet.test.js", { ESCAPE_INTERNET_TARGETS: `127.0.0.1:${String(closed)}`, ESCAPE_PUBLIC_NAME: "localhost" }).status).toBe(0);
  });

  it("ipv6: fails when an IPv6 target is reachable, passes when it is not", async () => {
    let open: number;
    try { open = await listen("::1"); } catch { return; }
    expect(runTest("ipv6.test.js", { ESCAPE_IPV6_TARGETS: `[::1]:${String(open)}`, ESCAPE_SKIP_IFACES: "1" }).status).not.toBe(0);
    const closed = await closedPort("::1");
    expect(runTest("ipv6.test.js", { ESCAPE_IPV6_TARGETS: `[::1]:${String(closed)}`, ESCAPE_SKIP_IFACES: "1" }).status).toBe(0);
  });

  it("neighbours: fails when the working sandbox's address answers; its positive control fails when the run's own Postgres is not reachable", async () => {
    const open = await listen("127.0.0.1");
    const closed = await closedPort();
    const database = `postgres://u:p@127.0.0.1:${String(open)}/d`;
    expect(runTest("neighbours.test.js", { ESCAPE_NEIGHBOUR_TARGETS: `127.0.0.1:${String(closed)}`, DATABASE_URL: database }).status).toBe(0);
    expect(runTest("neighbours.test.js", { ESCAPE_NEIGHBOUR_TARGETS: `127.0.0.1:${String(open)}`, DATABASE_URL: database }).status).not.toBe(0);
    expect(runTest("neighbours.test.js", { ESCAPE_NEIGHBOUR_TARGETS: `127.0.0.1:${String(closed)}`, DATABASE_URL: `postgres://u:p@127.0.0.1:${String(closed)}/d` }).status).not.toBe(0);
    expect(runTest("neighbours.test.js", { ESCAPE_NEIGHBOUR_TARGETS: `127.0.0.1:${String(closed)}` }).status).not.toBe(0);
  });

  it("relay: fails while a detached writer keeps the heartbeat moving, passes when it is frozen, skips without one and fails if one is required", () => {
    const directory = mkdtempSync(join(tmpdir(), "escape-heartbeat-"));
    directories.push(directory);
    const file = join(directory, "heartbeat");
    expect(runTest("relay.test.js", { ESCAPE_HEARTBEAT_FILE: file }).status).toBe(0);
    expect(runTest("relay.test.js", { ESCAPE_HEARTBEAT_FILE: file, ESCAPE_REQUIRE_HEARTBEAT: "1" }).status).not.toBe(0);
    writeFileSync(file, "7\n");
    expect(runTest("relay.test.js", { ESCAPE_HEARTBEAT_FILE: file }).status).toBe(0);
    const writer = spawn(process.execPath, [join(FIXTURE, "tools", "heartbeat.js")], { env: { ESCAPE_HEARTBEAT_FILE: file, PATH: process.env["PATH"] ?? "" }, stdio: "ignore" });
    children.push(writer);
    return new Promise<void>((resolve) => { setTimeout(() => { expect(runTest("relay.test.js", { ESCAPE_HEARTBEAT_FILE: file }).status).not.toBe(0); resolve(); }, 600); });
  });
});

// ---- a fake PostgreSQL that speaks SCRAM-SHA-256 (the server side), so planted-state.test.js and tools/seed.js are run against something that checks their client ---------------------------------------------------

const PASSWORD = "correct-horse";
const int32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const frame = (type: string, body: Buffer): Buffer => Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
const hmac = (key: Buffer, data: string | Buffer): Buffer => createHmac("sha256", key).update(data).digest();

function fakePostgres(tables: string[], seen: string[] = []) {
  return (socket: Socket): void => {
    let buffer = Buffer.alloc(0);
    let started = false;
    let clientFirstBare = "";
    let serverFirst = "";
    const salt = randomBytes(16);
    const salted = pbkdf2Sync(PASSWORD, salt, 4096, 32, "sha256");
    const storedKey = createHash("sha256").update(hmac(salted, "Client Key")).digest();
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!started) {
          if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
          buffer = buffer.subarray(buffer.readInt32BE(0));
          started = true;
          socket.write(frame("R", Buffer.concat([int32(10), Buffer.from("SCRAM-SHA-256\0\0")])));
          continue;
        }
        if (buffer.length < 5 || buffer.length < buffer.readInt32BE(1) + 1) return;
        const type = String.fromCharCode(buffer[0]!);
        const body = buffer.subarray(5, buffer.readInt32BE(1) + 1);
        buffer = buffer.subarray(buffer.readInt32BE(1) + 1);
        if (type === "p" && clientFirstBare === "") {
          const at = body.indexOf(0);
          const first = body.subarray(at + 1 + 4).toString();
          clientFirstBare = first.slice(first.indexOf("n=,"));
          const clientNonce = /r=(.+)$/u.exec(clientFirstBare)![1]!;
          serverFirst = `r=${clientNonce}${randomBytes(12).toString("base64")},s=${salt.toString("base64")},i=4096`;
          socket.write(frame("R", Buffer.concat([int32(11), Buffer.from(serverFirst)])));
        } else if (type === "p") {
          const text = body.toString();
          const withoutProof = text.slice(0, text.lastIndexOf(",p="));
          const proof = Buffer.from(text.slice(text.lastIndexOf(",p=") + 3), "base64");
          const authMessage = `${clientFirstBare},${serverFirst},${withoutProof}`;
          const clientKey = Buffer.from(proof.map((byte, index) => byte ^ hmac(storedKey, authMessage)[index]!));
          if (!createHash("sha256").update(clientKey).digest().equals(storedKey)) { socket.write(frame("E", Buffer.from("SFATAL\0Mpassword authentication failed\0\0"))); socket.end(); return; }
          const signature = hmac(hmac(salted, "Server Key"), authMessage).toString("base64");
          socket.write(Buffer.concat([frame("R", Buffer.concat([int32(12), Buffer.from(`v=${signature}`)])), frame("R", int32(0)), frame("Z", Buffer.from("I"))]));
        } else if (type === "Q") {
          seen.push(body.toString().replace(/\0$/u, ""));
          const rows = tables.map((name) => frame("D", Buffer.concat([Buffer.from([0, 1]), int32(Buffer.byteLength(name)), Buffer.from(name)])));
          socket.write(Buffer.concat([...rows, frame("C", Buffer.from("SELECT\0")), frame("Z", Buffer.from("I"))]));
        }
      }
    });
    socket.on("error", () => undefined);
  };
}
const databaseUrl = (port: number, password = PASSWORD): string => `postgres://app:${password}@127.0.0.1:${String(port)}/app`;

/** Async on purpose: the fake database lives in THIS process, and `spawnSync` would block its event loop while the client waits for it. */
const runAsync = (command: string, args: string[], env: Record<string, string>): Promise<{ status: number | null; stderr: string }> => new Promise((resolve) => {
  const child = spawn(command, args, { cwd: FIXTURE, env: { PATH: process.env["PATH"] ?? "", ...env }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.once("close", (status) => resolve({ status, stderr }));
});
const runDatabaseTest = (env: Record<string, string>) => runAsync(process.execPath, ["--test", join(FIXTURE, "tests", "planted-state.test.js")], env);

describe("the escape project's database test", () => {
  it("passes against a database that holds only the seeded table, over SCRAM", async () => {
    const port = await listen("127.0.0.1", fakePostgres(["seeded_in_round"]));
    expect((await runDatabaseTest({ DATABASE_URL: databaseUrl(port) })).status).toBe(0);
  });
  it("fails when a table a working phase planted is there, or the database holds nothing, or the password is wrong, or there is no database", async () => {
    const planted = await listen("127.0.0.1", fakePostgres(["planted_by_working_phase", "seeded_in_round"]));
    expect((await runDatabaseTest({ DATABASE_URL: databaseUrl(planted) })).status).not.toBe(0);
    const empty = await listen("127.0.0.1", fakePostgres([]));
    expect((await runDatabaseTest({ DATABASE_URL: databaseUrl(empty) })).status).not.toBe(0);
    const ok = await listen("127.0.0.1", fakePostgres(["seeded_in_round"]));
    expect((await runDatabaseTest({ DATABASE_URL: databaseUrl(ok, "wrong-password") })).status).not.toBe(0);
    expect((await runDatabaseTest({})).status).not.toBe(0);
  });
  it("the seed command runs its statement against the database", async () => {
    const seen: string[] = [];
    const port = await listen("127.0.0.1", fakePostgres([], seen));
    const ran = await runAsync(process.execPath, [join(FIXTURE, "tools", "seed.js")], { DATABASE_URL: databaseUrl(port) });
    expect(ran.status, ran.stderr).toBe(0);
    expect(seen.join(";")).toContain("create table if not exists seeded_in_round");
  });
});
