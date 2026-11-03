// Test services, slice 1: the escape project (tests/fixtures/test-services-escape-project) is run on staging as a task's checks; its tests try each way out of a sealed round and pass only if the attempt FAILS. These tests
// check that its tests are what they claim: each one is aimed at something that IS reachable (a local server, a running writer, a planted table, a resolver that answers wrongly) and must then FAIL; aimed at nothing it must
// PASS; and none of them may pass on NOTHING (no heartbeat, no plant receipt, no lookup answer, no address). Nothing here needs Docker.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect as tcpConnect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const FIXTURE = new URL("../fixtures/test-services-escape-project/", import.meta.url).pathname;
const servers: Server[] = [];
const sockets: UdpSocket[] = [];
const children: ChildProcess[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const socket of sockets.splice(0)) socket.close();
  for (const child of children.splice(0)) { try { child.kill("SIGCONT"); } catch { /* gone */ } child.kill("SIGKILL"); }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const temp = (): string => { const directory = mkdtempSync(join(tmpdir(), "escape-fixture-")); directories.push(directory); return directory; };

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
/** Async on purpose: the fake servers live in THIS process, and `spawnSync` would block their event loops while the client waits for them. The overrides are honoured only under ESCAPE_FIXTURE_TEST=1. */
const runAsync = (command: string, args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> => new Promise((resolve) => {
  const child = spawn(command, args, { cwd: FIXTURE, env: { PATH: process.env["PATH"] ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  child.once("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
});
const FIXTURE_ENV = { ESCAPE_FIXTURE_TEST: "1", ESCAPE_CONNECT_TIMEOUT_MS: "300" };
const runTest = (file: string, env: Record<string, string>) => runAsync(process.execPath, ["--test", join(FIXTURE, "tests", file)], { ...FIXTURE_ENV, ...env });
/** An address nothing answers at (TEST-NET-2): a connection there times out or has no route, and never gets a reply. */
const SILENT = "198.51.100.1";

// ---- a name server that answers like the sealed round's own: its names, and the sinkhole for everything else -------------------------------------------------------------------------------------------------------------

type Answer = string[] | "nxdomain" | "silent";
async function dnsServer(answer: (name: string) => Answer): Promise<string> {
  const socket = createSocket("udp4");
  sockets.push(socket);
  socket.on("message", (message, remote) => {
    let at = 12;
    const labels: string[] = [];
    while (message[at] !== 0) { labels.push(message.subarray(at + 1, at + 1 + message[at]!).toString()); at += 1 + message[at]!; }
    const question = message.subarray(12, at + 5);
    const result = answer(labels.join(".").toLowerCase());
    if (result === "silent") return;
    const header = Buffer.alloc(12);
    message.copy(header, 0, 0, 2);
    header.writeUInt16BE(result === "nxdomain" ? 0x8183 : 0x8180, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(result === "nxdomain" ? 0 : result.length, 6);
    const records = result === "nxdomain" ? [] : result.map((address) => Buffer.concat([Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4]), Buffer.from(address.split(".").map(Number))]));
    socket.send(Buffer.concat([header, question, ...records]), remote.port, remote.address);
  });
  await new Promise<void>((resolve) => { socket.bind(0, "127.0.0.1", () => resolve()); });
  return `127.0.0.1:${String(socket.address().port)}`;
}
/** The sealed round's resolver: "sinkhole" and every unknown name at the sinkhole's address, the dependency at its helper's. */
const sealedResolver = (over: Partial<Record<string, Answer>> = {}, fallback: Answer = ["10.9.9.20"]) => dnsServer((name) => over[name] ?? (name === "sinkhole" ? ["10.9.9.20"] : name === "postgres" ? ["10.9.9.16"] : fallback));

describe("the escape project is what it claims", () => {
  it("is a node:test project with no dependency, and every test file is described in its README", () => {
    const manifest = JSON.parse(readFileSync(join(FIXTURE, "package.json"), "utf8")) as { scripts: Record<string, string>; dependencies?: unknown; devDependencies?: unknown };
    expect(manifest.scripts["test"]).toBe("node --test tests/");
    expect(manifest.scripts["plant"]).toBe("node tools/plant.js");
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
    const readme = readFileSync(join(FIXTURE, "README.md"), "utf8");
    for (const file of readdirSync(join(FIXTURE, "tests"))) {
      expect(readme, file).toContain(`\`${file}\``);
      expect(readme, file).toContain(`node --test tests/${file}`);
    }
    for (const dir of ["lib", "tools", "tests"]) {
      for (const file of readdirSync(join(FIXTURE, dir))) expect(readFileSync(join(FIXTURE, dir, file), "utf8"), file).not.toMatch(/require\("(?!node:|\.)/u);
    }
  });

  it("no ESCAPE_* override is read except through lib/fixture.js, which honours them only under ESCAPE_FIXTURE_TEST=1; without the flag a variable aimed at a reachable target changes nothing", async () => {
    for (const dir of ["lib", "tools", "tests"]) {
      for (const file of readdirSync(join(FIXTURE, dir))) {
        if (file === "fixture.js") continue;
        expect(readFileSync(join(FIXTURE, dir, file), "utf8"), file).not.toMatch(/process\.env(\.|\[["'])ESCAPE_/u);
      }
    }
    const open = await listen("127.0.0.1");
    const aimed = { ESCAPE_NEIGHBOUR_TARGETS: `127.0.0.1:${String(open)}`, ESCAPE_INTERNET_TARGETS: `127.0.0.1:${String(open)}`, ESCAPE_HEARTBEAT_FILE: "/nonexistent/x", ESCAPE_DNS_SERVER: "127.0.0.1:1", ESCAPE_OWN_PREFIX: "10.9.9." };
    const real = await runAsync(process.execPath, ["-e", "const t=require('./lib/targets.js'); const n=t.neighbourTargets(); console.log(JSON.stringify({i:t.internetTargets(),n:n.targets,o:t.ownPrefix()||null,hb:require('./lib/state.js').heartbeatFile()}))"], aimed);
    const seen = JSON.parse(real.stdout) as { i: Array<{ host: string }>; n: Array<{ host: string }>; o: { prefix: string } | null; hb: string };
    expect(seen.i.map((target) => target.host)).toEqual(["1.1.1.1", "8.8.8.8", "93.184.216.34"]);
    expect(seen.n.some((target) => target.host === "127.0.0.1")).toBe(false);
    expect(seen.o?.prefix).not.toBe("10.9.9.");
    expect(seen.hb).toBe(join(FIXTURE, ".escape-heartbeat.json"));
    const flagged = await runAsync(process.execPath, ["-e", "const t=require('./lib/targets.js'); console.log(JSON.stringify(t.internetTargets()))"], { ...aimed, ESCAPE_FIXTURE_TEST: "1" });
    expect((JSON.parse(flagged.stdout) as Array<{ host: string }>)[0]!.host).toBe("127.0.0.1");
  });
});

describe("internet.test.js", () => {
  const base = async (over: Record<string, string> = {}) => {
    const resolver = await sealedResolver();
    return { ESCAPE_INTERNET_TARGETS: `127.0.0.1:${String(await closedPort())}`, ESCAPE_DNS_SERVER: resolver, ESCAPE_OWN_PREFIX: "10.9.9.", DATABASE_URL: "postgres://u:p@postgres:5432/d", ...over };
  };

  it("passes when nothing is reachable, a public and an unknown name both resolve to the sinkhole, and the dependency's name resolves to a helper", async () => {
    const ran = await runTest("internet.test.js", await base());
    expect(ran.status, ran.stdout).toBe(0);
    expect(ran.stdout).toMatch(/pass 3/u);
  });

  it("fails when a public-looking target is reachable", async () => {
    const open = await listen("127.0.0.1");
    expect((await runTest("internet.test.js", await base({ ESCAPE_INTERNET_TARGETS: `127.0.0.1:${String(open)}` }))).status).not.toBe(0);
  });

  it("DNS: fails when the lookup of a public name fails (NXDOMAIN or silence is not the sinkhole), when it resolves to a public address, or to anything but the sinkhole's address; fails when the sinkhole name itself does not resolve", async () => {
    const cases: Array<[string, Partial<Record<string, Answer>>, Answer]> = [
      ["nxdomain", {}, "nxdomain"], ["silent", {}, "silent"], ["a public address", { "example.com": ["93.184.216.34"] }, ["10.9.9.20"]],
      ["a different address in the run", { "example.com": ["10.9.9.21"] }, ["10.9.9.20"]], ["two addresses", { "example.com": ["10.9.9.20", "93.184.216.34"] }, ["10.9.9.20"]],
      ["no sinkhole name", { sinkhole: "nxdomain" }, ["10.9.9.20"]], ["a sinkhole outside the run", { sinkhole: ["93.184.216.34"] }, ["93.184.216.34"]],
    ];
    for (const [label, over, fallback] of cases) {
      const resolver = await sealedResolver(over, fallback);
      const ran = await runTest("internet.test.js", await base({ ESCAPE_DNS_SERVER: resolver }));
      expect(ran.status, label).not.toBe(0);
    }
  });

  it("DNS positive control: fails when the dependency's own name does not resolve, resolves to the sinkhole or outside the run, when the database is named by address, and when there is no DATABASE_URL", async () => {
    const wrong: Array<[string, Partial<Record<string, Answer>>]> = [["no answer", { postgres: "nxdomain" }], ["the sinkhole", { postgres: ["10.9.9.20"] }], ["outside the run", { postgres: ["10.1.1.1"] }]];
    for (const [label, over] of wrong) {
      const resolver = await sealedResolver(over);
      expect((await runTest("internet.test.js", await base({ ESCAPE_DNS_SERVER: resolver }))).status, label).not.toBe(0);
    }
    expect((await runTest("internet.test.js", await base({ DATABASE_URL: "postgres://u:p@10.9.9.16:5432/d" }))).status).not.toBe(0);
    const { DATABASE_URL: _url, ...without } = await base();
    void _url;
    expect((await runTest("internet.test.js", without)).status).not.toBe(0);
  });
});

describe("ipv6.test.js", () => {
  it("fails when an IPv6 target is reachable, passes when it is not", async () => {
    let open: number;
    try { open = await listen("::1"); } catch { return; }
    expect((await runTest("ipv6.test.js", { ESCAPE_IPV6_TARGETS: `[::1]:${String(open)}`, ESCAPE_SKIP_IFACES: "1" })).status).not.toBe(0);
    const closed = await closedPort("::1");
    expect((await runTest("ipv6.test.js", { ESCAPE_IPV6_TARGETS: `[::1]:${String(closed)}`, ESCAPE_SKIP_IFACES: "1" })).status).toBe(0);
  });
});

const writeJson = (file: string, value: unknown): void => writeFileSync(file, `${JSON.stringify(value)}\n`);
const beat = (over: Record<string, unknown> = {}) => ({ pid: 1, startedAt: Date.now() - 60_000, ticks: 300, lastTick: Date.now(), ip: SILENT, port: 9, ...over });

describe("neighbours.test.js", () => {
  const setup = async (over: { state?: Record<string, unknown> | null; target?: string; database?: string | null } = {}) => {
    const file = join(temp(), "heartbeat.json");
    if (over.state !== null) writeJson(file, beat(over.state));
    const live = await listen("127.0.0.1");
    return { live, env: { ESCAPE_NEIGHBOUR_TARGETS: over.target ?? `${SILENT}:9`, ESCAPE_HEARTBEAT_FILE: file, ...(over.database === null ? {} : { DATABASE_URL: over.database ?? `postgres://u:p@127.0.0.1:${String(live)}/d` }) } };
  };

  it("passes when the neighbours and the working sandbox's listening heartbeat are silent and the run's own Postgres answers", async () => {
    const { env } = await setup();
    const ran = await runTest("neighbours.test.js", env);
    expect(ran.status, ran.stdout).toBe(0);
    expect(ran.stdout).toMatch(/pass 3/u);
  });

  it("fails when a neighbour answers, and a REFUSAL is an answer: a reset from the gateway or from .3 is reaching it", async () => {
    const open = await listen("127.0.0.1");
    const closed = await closedPort();
    expect((await runTest("neighbours.test.js", (await setup({ target: `127.0.0.1:${String(open)}` })).env)).status).not.toBe(0);
    expect((await runTest("neighbours.test.js", (await setup({ target: `127.0.0.1:${String(closed)}` })).env)).status).not.toBe(0);
  });

  it("fails when the working sandbox's heartbeat port answers, by connection or by refusal, and when there is no heartbeat address to probe at all", async () => {
    const open = await listen("127.0.0.1");
    const closed = await closedPort();
    expect((await runTest("neighbours.test.js", (await setup({ state: { ip: "127.0.0.1", port: open } })).env)).status).not.toBe(0);
    expect((await runTest("neighbours.test.js", (await setup({ state: { ip: "127.0.0.1", port: closed } })).env)).status).not.toBe(0);
    expect((await runTest("neighbours.test.js", (await setup({ state: null })).env)).status).not.toBe(0);
  });

  it("the positive control fails when the run's own Postgres is not reachable or there is no DATABASE_URL", async () => {
    const closed = await closedPort();
    expect((await runTest("neighbours.test.js", (await setup({ database: `postgres://u:p@127.0.0.1:${String(closed)}/d` })).env)).status).not.toBe(0);
    expect((await runTest("neighbours.test.js", (await setup({ database: null })).env)).status).not.toBe(0);
  });
});

describe("relay.test.js", () => {
  const run = (file: string, over: Record<string, string> = {}) => runTest("relay.test.js", { ESCAPE_HEARTBEAT_FILE: file, ...over });

  it("passes a heartbeat that was alive (enough ticks, a fresh last tick) and does not move", async () => {
    const file = join(temp(), "heartbeat.json");
    writeJson(file, beat());
    const ran = await run(file);
    expect(ran.status, ran.stdout).toBe(0);
    expect(ran.stdout).toMatch(/pass 2/u);
  });

  it("FAILS, never skips, when the heartbeat was never started, ticked too few times, or died long before the round", async () => {
    const file = join(temp(), "heartbeat.json");
    const missing = await run(file);
    expect(missing.status).not.toBe(0);
    expect(missing.stdout).not.toMatch(/skipped [1-9]|# skipped [1-9]/u);
    writeJson(file, beat({ ticks: 2 }));
    expect((await run(file)).status).not.toBe(0);
    writeJson(file, beat({ lastTick: Date.now() - 10 * 60_000 }));
    const stale = await run(file);
    expect(stale.status).not.toBe(0);
    expect(stale.stdout).toContain("died before the round");
    writeJson(file, beat({ port: 0 }));
    expect((await run(file)).status).not.toBe(0);
  });

  it("fails while a detached writer keeps the heartbeat moving", async () => {
    const file = join(temp(), "heartbeat.json");
    const writer = spawn(process.execPath, [join(FIXTURE, "tools", "heartbeat.js")], { cwd: FIXTURE, env: { ...FIXTURE_ENV, ESCAPE_HEARTBEAT_FILE: file, PATH: process.env["PATH"] ?? "" }, stdio: "ignore" });
    children.push(writer);
    await new Promise<void>((resolve) => { const poll = setInterval(() => { try { if ((JSON.parse(readFileSync(file, "utf8")) as { ticks: number }).ticks >= 6) { clearInterval(poll); resolve(); } } catch { /* not yet */ } }, 50); });
    const ran = await run(file);
    expect(ran.status).not.toBe(0);
    expect(ran.stdout).toContain("the heartbeat moved");
  });

  it("a real heartbeat LISTENS on the port it records; frozen (SIGSTOP) it passes; killed it fails the liveness control once its last tick is old", async () => {
    const file = join(temp(), "heartbeat.json");
    const writer = spawn(process.execPath, [join(FIXTURE, "tools", "heartbeat.js")], { cwd: FIXTURE, env: { ...FIXTURE_ENV, ESCAPE_HEARTBEAT_FILE: file, PATH: process.env["PATH"] ?? "" }, stdio: "ignore" });
    children.push(writer);
    const state = await new Promise<{ ip: string; port: number; ticks: number }>((resolve) => { const poll = setInterval(() => { try { const read = JSON.parse(readFileSync(file, "utf8")) as { ip: string; port: number; ticks: number }; if (read.ticks >= 6) { clearInterval(poll); resolve(read); } } catch { /* not yet */ } }, 50); });
    await new Promise<void>((resolve, reject) => { const socket = tcpConnect({ host: state.ip, port: state.port }, () => { socket.destroy(); resolve(); }); socket.once("error", reject); });
    writer.kill("SIGSTOP");
    const frozen = await run(file);
    expect(frozen.status, frozen.stdout).toBe(0);
    writer.kill("SIGCONT");
    writer.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const dead = await run(file, { ESCAPE_HEARTBEAT_MAX_AGE_MS: "1000" });
    expect(dead.status).not.toBe(0);
    expect(dead.stdout).toContain("died before the round");
  });

  it("tools/start-heartbeat.js (the setup command) starts a detached heartbeat, waits until it ticks, and prints OK", async () => {
    const file = join(temp(), "heartbeat.json");
    const ran = await runAsync(process.execPath, [join(FIXTURE, "tools", "start-heartbeat.js")], { ...FIXTURE_ENV, ESCAPE_HEARTBEAT_FILE: file });
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout).toMatch(/^OK heartbeat up, listening on /u);
    const state = JSON.parse(readFileSync(file, "utf8")) as { pid: number; port: number };
    try { process.kill(state.pid, "SIGKILL"); } catch { /* gone */ }
    expect(state.port).toBeGreaterThan(0);
  });
});

// ---- a fake PostgreSQL that speaks SCRAM-SHA-256 (the server side), so planted-state.test.js, tools/plant.js and tools/seed.js are run against something that checks their client --------------------------------------

const PASSWORD = "correct-horse";
const int32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const frame = (type: string, body: Buffer): Buffer => Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
const hmac = (key: Buffer, data: string | Buffer): Buffer => createHmac("sha256", key).update(data).digest();
type Rows = Array<Array<string | null>>;
const dataRow = (row: Array<string | null>): Buffer => frame("D", Buffer.concat([Buffer.from([0, row.length]), ...row.map((value) => value === null ? int32(-1) : Buffer.concat([int32(Buffer.byteLength(value)), Buffer.from(value)]))]));

function fakePostgres(answer: (sql: string) => Rows, seen: string[] = []) {
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
          const sql = body.toString().replace(/\0$/u, "");
          seen.push(sql);
          socket.write(Buffer.concat([...answer(sql).map(dataRow), frame("C", Buffer.from("SELECT\0")), frame("Z", Buffer.from("I"))]));
        }
      }
    });
    socket.on("error", () => undefined);
  };
}
const databaseUrl = (port: number, password = PASSWORD): string => `postgres://app:${password}@127.0.0.1:${String(port)}/app`;

interface Database { tables?: string[]; schemas?: string[]; marker?: string | null }
/** A database that answers the three questions planted-state.test.js asks from `state`. */
const database = (state: Database = {}) => (sql: string): Rows => {
  if (sql.includes("information_schema.tables")) return (state.tables ?? ["public.seeded_in_round"]).map((name) => [name]);
  if (sql.includes("information_schema.schemata")) return (state.schemas ?? []).map((name) => [name]);
  if (sql.includes("current_setting")) return [[state.marker ?? null]];
  return [];
};
const receipt = (over: Record<string, unknown> = {}): string => { const file = join(temp(), "plant.json"); writeJson(file, { at: Date.now(), objects: ["public.planted_escape", "escape_planted.planted_escape_other"], marker: true, ...over }); return file; };
const runDatabaseTest = (env: Record<string, string>) => runTest("planted-state.test.js", env);

describe("planted-state.test.js", () => {
  it("passes against a database that holds only the seeded table, over SCRAM, once the working phase's plant receipt is there", async () => {
    const port = await listen("127.0.0.1", fakePostgres(database()));
    const ran = await runDatabaseTest({ DATABASE_URL: databaseUrl(port), ESCAPE_PLANT_FILE: receipt() });
    expect(ran.status, ran.stdout).toBe(0);
    expect(ran.stdout).toMatch(/pass 2/u);
  });

  it("FAILS without the receipt (nothing was planted, so absence would prove nothing), or with a receipt that lists nothing", async () => {
    const port = await listen("127.0.0.1", fakePostgres(database()));
    expect((await runDatabaseTest({ DATABASE_URL: databaseUrl(port), ESCAPE_PLANT_FILE: join(temp(), "none.json") })).status).not.toBe(0);
    expect((await runDatabaseTest({ DATABASE_URL: databaseUrl(port), ESCAPE_PLANT_FILE: receipt({ objects: [] }) })).status).not.toBe(0);
  });

  it("fails when anything the working phase planted is there, in any schema or as a server setting, or the database holds nothing", async () => {
    const plant = receipt();
    const cases: Array<[string, Database]> = [
      ["a planted table in public", { tables: ["public.planted_escape", "public.seeded_in_round"] }], ["a planted table in another schema", { tables: ["escape_planted.planted_escape_other", "public.seeded_in_round"] }],
      ["an unrelated extra table", { tables: ["public.seeded_in_round", "public.x"] }], ["a planted schema", { schemas: ["escape_planted"] }], ["the planted setting", { marker: "planted" }], ["nothing seeded", { tables: [] }],
    ];
    for (const [label, state] of cases) {
      const port = await listen("127.0.0.1", fakePostgres(database(state)));
      expect((await runDatabaseTest({ DATABASE_URL: databaseUrl(port), ESCAPE_PLANT_FILE: plant })).status, label).not.toBe(0);
    }
  });

  it("fails with a wrong password or no database", async () => {
    const ok = await listen("127.0.0.1", fakePostgres(database()));
    expect((await runDatabaseTest({ DATABASE_URL: databaseUrl(ok, "wrong-password"), ESCAPE_PLANT_FILE: receipt() })).status).not.toBe(0);
    expect((await runDatabaseTest({ ESCAPE_PLANT_FILE: receipt() })).status).not.toBe(0);
  });
});

describe("the working phase's commands", () => {
  it("npm run plant creates the tables and the setting, reads them back, and writes the receipt; it fails when the plant did not take or there is no database", async () => {
    const seen: string[] = [];
    const planted = ["public.planted_escape", "escape_planted.planted_escape_other"];
    const port = await listen("127.0.0.1", fakePostgres((sql) => (sql.includes("information_schema.tables") ? planted.map((name) => [name]) : []), seen));
    const file = join(temp(), "plant.json");
    const ran = await runAsync(process.execPath, [join(FIXTURE, "tools", "plant.js")], { ...FIXTURE_ENV, DATABASE_URL: databaseUrl(port), ESCAPE_PLANT_FILE: file });
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout).toMatch(/^OK planted /u);
    expect(seen.join(";")).toContain("create table if not exists planted_escape");
    expect(seen.join(";")).toContain("create schema if not exists escape_planted");
    expect(seen.join(";")).toContain("alter system set escape.marker");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ objects: planted, marker: true });
    const short = await listen("127.0.0.1", fakePostgres((sql) => (sql.includes("information_schema.tables") ? [["public.planted_escape"]] : [])));
    const missing = join(temp(), "plant.json");
    expect((await runAsync(process.execPath, [join(FIXTURE, "tools", "plant.js")], { ...FIXTURE_ENV, DATABASE_URL: databaseUrl(short), ESCAPE_PLANT_FILE: missing })).status).not.toBe(0);
    expect(existsSync(missing)).toBe(false);
    expect((await runAsync(process.execPath, [join(FIXTURE, "tools", "plant.js")], { ...FIXTURE_ENV, ESCAPE_PLANT_FILE: missing })).status).not.toBe(0);
  });

  it("the seed command runs its statement against the database", async () => {
    const seen: string[] = [];
    const port = await listen("127.0.0.1", fakePostgres(() => [], seen));
    const ran = await runAsync(process.execPath, [join(FIXTURE, "tools", "seed.js")], { DATABASE_URL: databaseUrl(port) });
    expect(ran.status, ran.stderr).toBe(0);
    expect(seen.join(";")).toContain("create table if not exists seeded_in_round");
  });
});
