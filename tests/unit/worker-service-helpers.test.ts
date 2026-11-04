// TS14: the helper launcher (test-services.md 4.0.6, 4.1.4; deferred check TS-RN-3). Nothing starts Docker: a fake daemon records every argument list and answers the few commands the launcher uses (run, exec, inspect, rm), so the
// hardening profile, the labels, the alias rule, the start order and the health words are checked against the arguments that would reach `docker`, not against the code that builds them.
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { CatalogEntrySchema, ServiceCatalogSchema, type CatalogEntry } from "../../packages/contracts/src/service-catalog.js";
import { runNetworkAddresses, runNetworkBridge, runNetworkHelperIp, runNetworkLabelArgs, runNetworkName, type ServicesNetwork } from "../../packages/worker/src/run-network.js";
import {
  HELPER_ALIAS_PATTERN, HelperStartError, helperContainerName, startHelpers, sweepServicesNetworksAtWorkerStart,
  type HelperFiles, type HelperRequest, type StartHelpersInput,
} from "../../packages/worker/src/service-helpers.js";
import { probeService } from "../../packages/worker/src/service-probe.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const WS = "0123456789abcdef";
const NOW = 1_800_000_000_000;
const SLOT = 153;
const DIGEST = "a".repeat(64);
const REGISTRY = "registry.example.test/rovara";
const PROBE_IMAGE = `rovara/worker@sha256:${"b".repeat(64)}`;
const SECRET = ["pw", "Zk3Lm9Qx7TbW", "Hd5Pr2Yc"].join("");

const catalogFile = JSON.parse(readFileSync(new URL("../../environments/service-catalog/catalog.json", import.meta.url), "utf8")) as unknown;
const catalog = ServiceCatalogSchema.parse(catalogFile);
/** A catalog entry as the pinned catalog will carry it (digest set). */
function pinned(id: string, change: (entry: CatalogEntry) => void = () => undefined): CatalogEntry {
  const found = catalog.entries.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no entry ${id}`);
  const copy = structuredClone(found);
  copy.image.digest = DIGEST;
  change(copy);
  return copy;
}

function makeNet(slot = SLOT): ServicesNetwork {
  const labels = { runId: RUN, workspace: WS, createdAt: NOW, expiresAt: NOW + 1_500_000 };
  return { name: runNetworkName(RUN), bridge: runNetworkBridge(RUN, slot), slot, ...runNetworkAddresses(slot), helperIp: (index: number) => runNetworkHelperIp(slot, index), labelArgs: () => runNetworkLabelArgs(labels), stop: () => Promise.resolve() };
}

interface FakeContainer { name: string; args: string[]; status: "running" | "exited" }
interface FakeOptions {
  /** Container names (by dependency id) whose `docker run` fails. */
  failRun?: (args: string[]) => boolean;
  /** Answers a health command or probe: the number of calls so far for this container, 0-based. */
  healthy?: (container: string, attempt: number) => boolean;
  /** Containers that exit right after they start. */
  exits?: (name: string) => boolean;
  /** The output of an exec. */
  execOutput?: string;
  /** The `.Config.Volumes` of every image: paths the image declares as volumes. Default none. */
  volumes?: string[] | "broken" | "unreadable" | "emptyarray" | "array";
  /** The volumes of one image (by its reference), for a run of several images. */
  volumesFor?: (image: string) => string[];
  /** A probe container that never answers: the docker call times out. */
  probeTimesOut?: boolean;
}
function fakeDocker(options: FakeOptions = {}) {
  const calls: string[][] = [];
  const containers = new Map<string, FakeContainer>();
  const attempts = new Map<string, number>();
  const order: string[] = [];
  const timeouts: Array<{ args: string[]; timeoutMs: number | undefined }> = [];
  const docker: DockerCli = {
    run(args, runOptions) {
      calls.push([...args]);
      timeouts.push({ args: [...args], timeoutMs: runOptions?.timeoutMs });
      const ok = { exitCode: 0, stdout: "", stderr: "" };
      const fail = { exitCode: 1, stdout: "", stderr: "boom" };
      if (args[0] === "run" && args.includes("--detach")) {
        if (options.failRun?.([...args])) return Promise.resolve({ exitCode: 125, stdout: "", stderr: "Unable to find image" });
        const name = args[args.indexOf("--name") + 1]!;
        containers.set(name, { name, args: [...args], status: options.exits?.(name) === true ? "exited" : "running" });
        order.push(name);
        return Promise.resolve(ok);
      }
      if (args[0] === "image" && args[1] === "inspect") {
        if (options.volumes === "unreadable") return Promise.resolve(fail);
        if (options.volumes === "broken") return Promise.resolve({ exitCode: 0, stdout: "not json", stderr: "" });
        if (options.volumes === "emptyarray") return Promise.resolve({ exitCode: 0, stdout: "[]\n", stderr: "" });
        if (options.volumes === "array") return Promise.resolve({ exitCode: 0, stdout: '["/srv/extra"]\n', stderr: "" });
        if (options.volumesFor !== undefined) return Promise.resolve({ exitCode: 0, stdout: `${JSON.stringify(Object.fromEntries(options.volumesFor(args.at(-1)!).map((path) => [path, {}])))}\n`, stderr: "" });
        return Promise.resolve({ exitCode: 0, stdout: options.volumes === undefined ? "null\n" : `${JSON.stringify(Object.fromEntries(options.volumes.map((path) => [path, {}])))}\n`, stderr: "" });
      }
      if (args[0] === "run" && args.includes("--rm")) {
        if (options.probeTimesOut === true) return Promise.resolve({ exitCode: null, stdout: "", stderr: "", timedOut: true });
        // A probe container: asks the same question about the helper whose address it was given.
        const host = args[args.indexOf("--host") + 1]!;
        const target = [...containers.values()].find((container) => container.args.includes(host));
        const key = target?.name ?? host;
        const attempt = attempts.get(key) ?? 0;
        attempts.set(key, attempt + 1);
        return Promise.resolve(options.healthy?.(key, attempt) === false ? fail : ok);
      }
      if (args[0] === "exec") {
        const key = args[1]!;
        const attempt = attempts.get(key) ?? 0;
        attempts.set(key, attempt + 1);
        return Promise.resolve(options.healthy?.(key, attempt) === false ? { exitCode: 1, stdout: "", stderr: "" } : { exitCode: 0, stdout: options.execOutput ?? "", stderr: "" });
      }
      if (args[0] === "inspect") {
        const container = containers.get(args.at(-1)!);
        return Promise.resolve(container === undefined ? fail : { exitCode: 0, stdout: `${container.status}\n`, stderr: "" });
      }
      if (args[0] === "rm") {
        for (const target of args.slice(1).filter((arg) => !arg.startsWith("-"))) containers.delete(target);
        return Promise.resolve(ok);
      }
      if (args[0] === "ps" || args[0] === "network") return Promise.resolve(ok);
      return Promise.resolve(fail);
    },
  };
  const started = () => calls.filter((call) => call[0] === "run" && call.includes("--detach"));
  return { docker, calls, containers, started, order, timeouts };
}

function fakeFiles() {
  const files = new Map<string, { content: string; mode: number }>();
  const removed: string[] = [];
  const helper: HelperFiles = {
    write(name, content, mode) { files.set(name, { content, mode }); return Promise.resolve(`/run/rovara-test/${name}`); },
    remove(name) { removed.push(name); files.delete(name); return Promise.resolve(); },
  };
  return { helper, files, removed };
}

function fakeClock() {
  let at = NOW;
  return { now: () => at, sleep: (ms: number) => { at += ms; return Promise.resolve(); }, advance: (ms: number) => { at += ms; } };
}

const CONTROL = ["ct", "Vb4Nq8Wz2Kd7", "Ms6Jf3Xa"].join("");
const RECEIPT = ["rc", "Gn7Tp5Ue9Lq1", "Bw8Zh4Kd"].join("");
const CREDENTIALS = { user: "rovara", password: SECRET, database: "app" };
function request(id: string, entryId: string, extra: Partial<HelperRequest> = {}): HelperRequest {
  const entry = pinned(entryId);
  const needsCredentials = ["postgres", "mysql", "redis", "rabbitmq"].includes(entry.family);
  return { id, name: id, entry, ...(needsCredentials ? { credentials: CREDENTIALS } : {}), ...extra };
}

function setup(options: FakeOptions = {}, extra: Partial<StartHelpersInput> = {}) {
  const daemon = fakeDocker(options);
  const files = fakeFiles();
  const clock = fakeClock();
  const input = (helpers: HelperRequest[]): StartHelpersInput => ({
    registry: REGISTRY, edition: "public", probeImage: PROBE_IMAGE, maxMemMiB: 3_072, helpers, files: files.helper, now: clock.now, sleep: clock.sleep, ...extra,
  });
  return { ...daemon, files, clock, input, run: (helpers: HelperRequest[]) => startHelpers(daemon.docker, makeNet(), input(helpers)) };
}

const LABELS = runNetworkLabelArgs({ runId: RUN, workspace: WS, createdAt: NOW, expiresAt: NOW + 1_500_000 });
const flag = (args: readonly string[], name: string): string[] => args.flatMap((arg, index) => (args[index - 1] === name ? [arg] : []));

describe("the alias rule (TS-RN-3 rule 2)", () => {
  it("accepts plain DNS-like names of 2 to 32 characters", () => {
    for (const alias of ["db", "postgres", "aws", "fake-payments", "a1", "cache-2", `a${"b".repeat(30)}c`]) expect(HELPER_ALIAS_PATTERN.test(alias), alias).toBe(true);
  });
  it("refuses anything that could be read as a docker option, a path, an address or a second argument", () => {
    const hostile = ["", "a", "A", "Postgres", "-db", "db-", "1db", "db_1", "db.local", "db local", "db\nx", "db;rm", "db --privileged", "--privileged", "db=1", "db:80", "../db", "db/x", "dbé", "db\u0000", `a${"b".repeat(31)}c`, "127.0.0.1", " db"];
    for (const alias of hostile) expect(HELPER_ALIAS_PATTERN.test(alias), JSON.stringify(alias)).toBe(false);
  });
  it("is checked before any container starts: a bad or reserved alias starts nothing", async () => {
    for (const aliases of [["db --privileged"], ["Db"], ["dns"], ["localhost"], ["sinkhole"], ["test-account-proxy"], ["app"], ["gateway"]]) {
      const t = setup();
      await expect(t.run([request("postgres", "postgres@16", { aliases })]), JSON.stringify(aliases)).rejects.toBeInstanceOf(HelperStartError);
      expect(t.started(), JSON.stringify(aliases)).toHaveLength(0);
    }
  });
  it("checks the aliases of the catalog's defaults too, and an alias used twice in one run", async () => {
    const t = setup();
    await expect(t.run([request("one", "postgres@16", { aliases: ["db"] }), request("two", "valkey@8", { aliases: ["db"] })])).rejects.toBeInstanceOf(HelperStartError);
    expect(t.started()).toHaveLength(0);
    const forged = pinned("valkey@8");
    forged.connect.defaultAliases = ["x --privileged"];
    const t2 = setup();
    await expect(t2.run([{ id: "cache", name: "cache", entry: forged, credentials: CREDENTIALS }])).rejects.toBeInstanceOf(HelperStartError);
    expect(t2.started()).toHaveLength(0);
  });
  it("gives the entry's default alias when the request names none", async () => {
    const t = setup();
    await t.run([request("postgres", "postgres@16")]);
    expect(flag(t.started()[0]!, "--network-alias")).toEqual(["postgres"]);
  });
});

describe("the arguments of a helper (snapshot)", () => {
  it("postgres@16: the whole hardening profile, labels, address and fixed arguments, and nothing else", async () => {
    const t = setup();
    await t.run([request("postgres", "postgres@16")]);
    const name = helperContainerName(makeNet(), "postgres");
    expect(t.started()).toEqual([[
      "run", "--detach", "--name", name, "--pull=never", "--init",
      ...LABELS,
      "--network", runNetworkName(RUN), "--ip", "172.30.153.16", "--network-alias", "postgres",
      "--user", "999:999", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
      "--memory", "512m", "--memory-swap", "512m", "--cpus", "1", "--pids-limit", "256",
      "--log-driver", "local", "--log-opt", "max-size=1m", "--log-opt", "max-file=1",
      "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=256m,uid=999,gid=999",
      "--tmpfs", "/run/postgresql:rw,nosuid,nodev,noexec,size=8m,uid=999,gid=999",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=32m,uid=999,gid=999",
      "--env-file", `/run/rovara-test/${name}.env`,
      `${REGISTRY}/svc/postgres@sha256:${DIGEST}`,
      "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off",
    ]]);
  });
  it("the second helper gets the next address; the image is the registry, the catalog repository and the digest, never a tag", async () => {
    const t = setup();
    await t.run([request("postgres", "postgres@16"), request("cache", "valkey@8")]);
    expect(flag(t.started()[1]!, "--ip")).toEqual(["172.30.153.17"]);
    expect(t.started()[1]!).toContain(`${REGISTRY}/svc/valkey@sha256:${DIGEST}`);
    for (const call of t.started()) expect(call.some((arg) => /^[^@]*:[A-Za-z0-9._-]+$/u.test(arg) && arg.includes("/svc/")), "a tag").toBe(false);
  });
  it("redis: the password goes into a read-only config file named first, never into an argument", async () => {
    const t = setup();
    await t.run([request("cache", "valkey@8")]);
    const call = t.started()[0]!;
    const name = helperContainerName(makeNet(), "cache");
    expect(flag(call, "-v")).toEqual([`/run/rovara-test/${name}.conf:/etc/rovara/redis.conf:ro`]);
    expect(call.slice(call.indexOf(`${REGISTRY}/svc/valkey@sha256:${DIGEST}`) + 1)).toEqual(["/etc/rovara/redis.conf", "--save", "", "--appendonly", "no"]);
    expect(call.join(" ")).not.toContain(SECRET);
    expect(t.files.removed).toContain(`${name}.conf`);
  });
  it("the emulator: bound to its own run address, a presign secret of the run's own, the region, all through the env file", async () => {
    const t = setup();
    const seen: string[] = [];
    const write = t.files.helper.write.bind(t.files.helper);
    t.files.helper.write = (name, content, mode) => { seen.push(content); return write(name, content, mode); };
    await t.run([request("aws", "local-aws@r1", { credentials: { user: "rovara", password: SECRET, controlToken: CONTROL, sqsReceiptSecret: RECEIPT }, region: "us-west-2" })]);
    expect(seen).toEqual([`QUARKUS_HTTP_HOST=172.30.153.16\nROVARA_AWS_BASE_URL=http://aws:4566\nROVARA_AWS_AUTH_PRESIGN_SECRET=${SECRET}\nROVARA_AWS_SERVICES_SQS_RECEIPT_HANDLE_SECRET=${RECEIPT}\nROVARA_AWS_CONTROL_TOKEN=${CONTROL}\nROVARA_AWS_DEFAULT_REGION=us-west-2\nROVARA_AWS_HOSTNAME=aws\n`]);
    expect(flag(t.started()[0]!, "--memory")).toEqual(["384m"]);
    expect(flag(t.started()[0]!, "--network-alias")).toEqual(["aws"]);
    expect(t.calls.map((call) => call.join(" ")).join("\n")).not.toContain(SECRET);
    expect(t.calls.map((call) => call.join(" ")).join("\n")).not.toContain(CONTROL);
    expect(t.calls.map((call) => call.join(" ")).join("\n")).not.toContain(RECEIPT);
  });
});

describe("every catalog entry is started under the profile (4.1.4)", () => {
  // The helpers (the DNS helper, the proxy) are started by their own code; the fake server runs from the worker's own image and has its own tests (worker-fake-helper-launch.test.ts).
  const entries = catalog.entries.filter((entry) => entry.backing !== "helper" && entry.workerImage !== true);
  for (const entry of entries) {
    it(`${entry.id}`, async () => {
      const t = setup();
      await t.run([request("dep", entry.id, entry.backing === "emulated" ? { credentials: { user: "rovara", password: SECRET, controlToken: CONTROL, sqsReceiptSecret: RECEIPT }, region: "us-east-1" } : {})]);
      const call = t.started()[0]!;
      for (const forbidden of ["--privileged", "--cap-add", "--publish", "-p", "-P", "--publish-all", "--net", "--pid", "--ipc", "--uts", "--device", "--volumes-from", "--userns", "--add-host", "--entrypoint", "--env", "-e", "--dns", "--link", "--cgroupns", "--security-opt=seccomp=unconfined"]) {
        expect(call, forbidden).not.toContain(forbidden);
      }
      expect(flag(call, "--security-opt")).not.toContain("seccomp=unconfined");
      expect(call.join(" ")).not.toContain("docker.sock");
      expect(flag(call, "--cap-drop")).toEqual(["ALL"]);
      expect(flag(call, "--security-opt")).toEqual(["no-new-privileges"]);
      expect(flag(call, "--network")).toEqual([runNetworkName(RUN)]);
      expect(flag(call, "--pull")).toEqual([]);
      expect(call).toContain("--pull=never");
      expect(call).toContain("--init");
      expect(flag(call, "--user")).toEqual([entry.run.user]);
      expect(Number(flag(call, "--user")[0]!.split(":")[0])).toBeGreaterThan(0);
      expect(flag(call, "--memory")).toEqual([`${String(entry.resources.memMiB)}m`]);
      expect(flag(call, "--memory-swap")).toEqual(flag(call, "--memory"));
      expect(flag(call, "--pids-limit")).toEqual([String(entry.resources.pids)]);
      expect(flag(call, "--cpus")).toEqual([String(entry.resources.cpus)]);
      expect(call.includes("--read-only")).toBe(entry.run.readOnlyRoot);
      expect(flag(call, "--ip")[0]).toMatch(/^172\.30\.153\.(?:1[6-9]|[2-3]\d|4[0-7])$/u);
      for (const label of LABELS.filter((arg) => arg !== "--label")) expect(call, label).toContain(label);
      // Host mounts: read-only files of the run's own directory only.
      for (const mount of flag(call, "-v")) expect(mount, mount).toMatch(/^\/run\/rovara-test\/[A-Za-z0-9._-]+:\/[A-Za-z0-9._/-]+:ro$/u);
      expect(flag(call, "--tmpfs")).toHaveLength(entry.run.tmpfs.length);
      // Everything after the image is the entry's fixed arguments (and the config file of a password-protected cache).
      const afterImage = call.slice(call.findIndex((arg) => arg.includes("@sha256:")) + 1);
      expect(afterImage.length).toBeGreaterThanOrEqual(0);
      expect(call.filter((arg) => arg.includes("@sha256:"))).toHaveLength(1);
    });
  }
});

describe("what the repository can and cannot reach", () => {
  it("a forged entry that the catalog schema refuses is never started (root user, a free-form argument, a private port range)", async () => {
    const forgeries: Array<(entry: CatalogEntry) => void> = [
      (entry) => { entry.run.user = "0:0"; },
      (entry) => { (entry.run.extraArgs as string[]).push("--privileged"); },
      (entry) => { (entry.run as unknown as { capAdd: string[] }).capAdd = ["SYS_ADMIN"]; },
      (entry) => { entry.image.repository = "svc/postgres --privileged"; },
      (entry) => { entry.resources.memMiB = 1_000_000; },
    ];
    for (const [index, forge] of forgeries.entries()) {
      const t = setup();
      const entry = pinned("postgres@16", forge);
      expect(CatalogEntrySchema.safeParse(entry).success, `forgery ${String(index)} should be invalid`).toBe(false);
      await expect(t.run([{ id: "postgres", name: "postgres", entry, credentials: CREDENTIALS }]), `forgery ${String(index)}`).rejects.toBeInstanceOf(HelperStartError);
      expect(t.calls, `forgery ${String(index)}`).toHaveLength(0);
    }
  });
  it("hostile ids, registries, image references and regions never reach a docker argument", async () => {
    for (const change of [{ id: "db --privileged" }, { id: "Db" }, { id: "x".repeat(41) }, { id: "" }, { region: "us-east-1 --privileged" }]) {
      const t = setup();
      await expect(t.run([{ ...request("postgres", "postgres@16"), ...change }]), JSON.stringify(change)).rejects.toBeInstanceOf(HelperStartError);
      expect(t.calls, JSON.stringify(change)).toHaveLength(0);
    }
    for (const registry of ["", "registry.example.test/rovara --privileged", "REGISTRY", "reg istry", "registry.example.test/", "-v", "registry.example.test:70000", "registry.example.test/ro@sha256", "a".repeat(200)]) {
      const t = setup({}, { registry });
      await expect(t.run([request("postgres", "postgres@16")]), registry).rejects.toBeInstanceOf(HelperStartError);
      expect(t.calls, registry).toHaveLength(0);
    }
    for (const probeImage of ["rovara/worker:test", "rovara/worker:latest", "rovara/worker", "rovara/worker@sha256:abc", `rovara/worker@sha256:${"b".repeat(8)}`, `rovara/worker@sha256:${"b".repeat(63)}`, `sha256:${"b".repeat(40)}`, `rovara/worker@sha256:${"b".repeat(64)} --privileged`, "sha256:abc", `-v@sha256:${"b".repeat(64)}`]) {
      const bad = setup({}, { probeImage });
      await expect(bad.run([request("a", "valkey@8")]), probeImage).rejects.toBeInstanceOf(HelperStartError);
      expect(bad.calls, probeImage).toHaveLength(0);
    }
    for (const probeImage of [`rovara/worker@sha256:${"b".repeat(64)}`, `sha256:${"c".repeat(64)}`]) {
      const good = setup({}, { probeImage });
      await expect(good.run([request("a", "valkey@8")]), probeImage).resolves.toBeDefined();
    }
    const t = setup({}, { probeImage: "rovara/worker --privileged" });
    await expect(t.run([request("a", "valkey@8"), request("b", "local-aws@r1", { credentials: { user: "rovara", password: SECRET, controlToken: CONTROL, sqsReceiptSecret: RECEIPT }, region: "us-east-1" })])).rejects.toBeInstanceOf(HelperStartError);
    expect(t.calls).toHaveLength(0);
  });
  it("a hostile user, database or password cannot break out of the env file or be an option", async () => {
    for (const credentials of [
      { user: "rovara\nPOSTGRES_PASSWORD=x", password: SECRET, database: "app" },
      { user: "rovara", password: SECRET, database: "app\nX=1" },
      { user: "rovara", password: `${SECRET}\nX=1`, database: "app" },
      { user: "rovara", password: "short", database: "app" },
      { user: "-c fsync=off", password: SECRET, database: "app" },
      { user: "rovara", password: SECRET, database: "app db" },
      { user: "rovara", password: SECRET, database: "" },
      { user: "Rovara", password: SECRET, database: "app" },
    ]) {
      const t = setup();
      await expect(t.run([{ ...request("postgres", "postgres@16"), credentials }]), JSON.stringify(credentials)).rejects.toBeInstanceOf(HelperStartError);
      expect(t.started(), JSON.stringify(credentials)).toHaveLength(0);
      expect(t.files.files.size).toBe(0);
    }
  });
  it("a family with no credential rule is refused rather than started with whatever the image does", async () => {
    const t = setup();
    const entry = pinned("postgres@16", (copy) => { copy.family = "oddball"; copy.run.extraArgs = []; });
    await expect(t.run([{ id: "odd", name: "odd", entry, credentials: CREDENTIALS }])).rejects.toBeInstanceOf(HelperStartError);
    expect(t.started()).toHaveLength(0);
  });
  it("a helper entry (proxy, DNS helper) is not started as a dependency", async () => {
    const t = setup();
    await expect(t.run([{ id: "dns", name: "dns", entry: pinned("dns-helper@r1") }])).rejects.toBeInstanceOf(HelperStartError);
    expect(t.started()).toHaveLength(0);
  });
  it("the password is in the env file and nowhere in any docker argument; the env file is removed once docker has read it", async () => {
    const t = setup();
    let seen = "";
    const write = t.files.helper.write.bind(t.files.helper);
    t.files.helper.write = (name, content, mode) => { if (name.endsWith(".env")) seen = `${content}|${String(mode)}`; return write(name, content, mode); };
    await t.run([request("postgres", "postgres@16")]);
    expect(seen).toBe(`POSTGRES_USER=rovara\nPOSTGRES_PASSWORD=${SECRET}\nPOSTGRES_DB=app\n|${String(0o600)}`);
    for (const call of t.calls) expect(call.join(" ")).not.toContain(SECRET);
    expect(t.files.removed).toContain(`${helperContainerName(makeNet(), "postgres")}.env`);
    expect(t.files.files.size).toBe(0);
  });
  it("the env file is removed when the start fails too", async () => {
    const t = setup({ failRun: () => true });
    await expect(t.run([request("postgres", "postgres@16")])).rejects.toBeInstanceOf(HelperStartError);
    expect(t.files.files.size).toBe(0);
    expect(t.files.removed.length).toBeGreaterThan(0);
  });
  it("mysql and rabbitmq take their per-run user and password through the env file", async () => {
    const t = setup();
    const seen: string[] = [];
    const write = t.files.helper.write.bind(t.files.helper);
    t.files.helper.write = (name, content, mode) => { seen.push(content); return write(name, content, mode); };
    await t.run([request("db", "mysql@8"), request("queue", "rabbitmq@3")]);
    expect(seen).toContain(`MYSQL_RANDOM_ROOT_PASSWORD=yes\nMYSQL_USER=rovara\nMYSQL_PASSWORD=${SECRET}\nMYSQL_DATABASE=app\n`);
    expect(seen).toContain(`RABBITMQ_DEFAULT_USER=rovara\nRABBITMQ_DEFAULT_PASS=${SECRET}\n`);
  });
  it("files for a helper (init SQL, fixtures) are mounted read-only from the run's own directory; a hostile name or target is refused", async () => {
    const t = setup();
    await t.run([request("postgres", "postgres@16", { files: [{ name: "init.sql", content: "select 1;", to: "/docker-entrypoint-initdb.d/init.sql" }] })]);
    expect(flag(t.started()[0]!, "-v")).toEqual([`/run/rovara-test/${helperContainerName(makeNet(), "postgres")}.init.sql:/docker-entrypoint-initdb.d/init.sql:ro`]);
    for (const file of [
      { name: "../x", content: "", to: "/a/b" }, { name: "a b", content: "", to: "/a/b" }, { name: "init.sql", content: "", to: "/a/../b" }, { name: "init.sql", content: "", to: "/a:rw" },
      { name: "init.sql", content: "", to: "relative" }, { name: "init.sql", content: "", to: "/proc/x" }, { name: "init.sql", content: "", to: "/var/run/docker.sock" }, { name: "init.sql", content: "", to: "/run/x" }, { name: "init.sql", content: "", to: "/data/docker.sock" }, { name: "env", content: "", to: "/a/b" }, { name: "conf", content: "", to: "/a/b" }, { name: "init.sql", content: "x".repeat(1_048_577), to: "/a/b" },
    ]) {
      const bad = setup();
      await expect(bad.run([request("postgres", "postgres@16", { files: [file] })]), JSON.stringify(file).slice(0, 80)).rejects.toBeInstanceOf(HelperStartError);
      expect(bad.started()).toHaveLength(0);
    }
  });
});

describe("small rules", () => {
  it("at most four aliases per helper", async () => {
    const t = setup();
    await expect(t.run([request("postgres", "postgres@16", { aliases: ["db-a", "db-b", "db-c", "db-d", "db-e"] })])).rejects.toBeInstanceOf(HelperStartError);
    expect(t.calls).toHaveLength(0);
    const ok = setup();
    await ok.run([request("postgres", "postgres@16", { aliases: ["db-a", "db-b", "db-c", "db-d"] })]);
    expect(flag(ok.started()[0]!, "--network-alias")).toEqual(["db-a", "db-b", "db-c", "db-d"]);
  });
  it("a port below 1024 gets the one namespaced sysctl that lets a non-root user bind it; a high port gets none", async () => {
    const low = setup();
    const entry = pinned("valkey@8", (copy) => { copy.run.ports = [80]; copy.health = { kind: "tcp", port: 80, startTimeoutS: 15 }; });
    await low.run([{ ...request("cache", "valkey@8"), entry }]);
    expect(flag(low.started()[0]!, "--sysctl")).toEqual(["net.ipv4.ip_unprivileged_port_start=80"]);
    const high = setup();
    await high.run([request("postgres", "postgres@16")]);
    expect(flag(high.started()[0]!, "--sysctl")).toEqual([]);
  });
  it("a stop signal that is already set starts nothing that stays", async () => {
    const controller = new AbortController();
    controller.abort();
    const t = setup({}, { signal: controller.signal });
    const error = await t.run([request("postgres", "postgres@16")]).then(() => undefined, (failure: unknown) => failure);
    expect((error as HelperStartError).reason).toBe("stopped");
    expect(t.containers.size).toBe(0);
  });
});

describe("review fixes (TS14 review M1-M3, L1-L3)", () => {
  it("M1: a probe that never answers is removed by name when its call times out, and the start fails with the health words", async () => {
    const t = setup({ probeTimesOut: true });
    const error = await t.run([request("aws", "local-aws@r1", { credentials: { user: "rovara", password: SECRET, controlToken: CONTROL, sqsReceiptSecret: RECEIPT }, region: "us-east-1" })]).then(() => undefined, (failure: unknown) => failure);
    expect((error as HelperStartError).reason).toBe("health_timeout");
    const probes = t.calls.filter((call) => call[0] === "run" && call.includes("--rm"));
    expect(probes.length).toBeGreaterThan(1);
    const names = probes.map((call) => flag(call, "--name")[0]!);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(t.calls.some((call) => call[0] === "rm" && call.includes("--force") && call.includes("--volumes") && call.includes(name)), name).toBe(true);
  });
  it("M2: every removal of a helper takes its anonymous volumes with it", async () => {
    const t = setup({ healthy: () => false });
    await t.run([request("postgres", "postgres@16")]).catch(() => undefined);
    const removals = t.calls.filter((call) => call[0] === "rm");
    expect(removals.length).toBeGreaterThan(0);
    for (const call of removals) expect(call, call.join(" ")).toContain("--volumes");
  });
  it("M2: an image that declares a volume no tmpfs covers is refused before anything starts; covered ones, and null, pass", async () => {
    const bad = setup({ volumes: ["/var/lib/postgresql/data", "/srv/extra"] });
    const error = await bad.run([request("postgres", "postgres@16")]).then(() => undefined, (failure: unknown) => failure);
    expect((error as HelperStartError).reason).toBe("refused");
    expect(bad.started()).toHaveLength(0);
    for (const volumes of ["broken", "unreadable", "emptyarray", "array"] as const) {
      const t = setup({ volumes });
      await expect(t.run([request("postgres", "postgres@16")]), volumes).rejects.toBeInstanceOf(HelperStartError);
      expect(t.started(), volumes).toHaveLength(0);
    }
    const nested = setup({ volumes: ["/var/lib/postgresql/data", "/tmp"] });
    await expect(nested.run([request("postgres", "postgres@16")])).resolves.toBeDefined();
    // L4: a folder under a tmpfs destination is a different mount point (its own anonymous volume): only the exact destination counts.
    const below = setup({ volumes: ["/var/lib/postgresql/data", "/var/lib/postgresql/data/sub"] });
    await expect(below.run([request("postgres", "postgres@16")])).rejects.toBeInstanceOf(HelperStartError);
    expect(below.started()).toHaveLength(0);
    // A path that only shares a prefix is not covered.
    const sibling = setup({ volumes: ["/var/lib/postgresql/data2"] });
    await expect(sibling.run([request("postgres", "postgres@16")])).rejects.toBeInstanceOf(HelperStartError);
    // Every distinct image is checked, not just the first: the second image's uncovered volume refuses the run, and nothing started.
    const second = setup({ volumesFor: (image) => (image.includes("/redis") ? ["/data", "/srv/extra"] : []) });
    const cache = request("cache", "redis@7");
    await expect(second.run([request("postgres", "postgres@16"), cache])).rejects.toBeInstanceOf(HelperStartError);
    expect(second.started()).toHaveLength(0);
    expect(second.calls.filter((call) => call[0] === "image" && call[1] === "inspect")).toHaveLength(2);
    const inspected = nested.calls.find((call) => call[0] === "image" && call[1] === "inspect")!;
    expect(inspected).toEqual(["image", "inspect", "--format", "{{json .Config.Volumes}}", `${REGISTRY}/svc/postgres@sha256:${DIGEST}`]);
  });
  it("M3: the emulator is told its own hostname: the first alias, aws by default", async () => {
    const seen: string[] = [];
    for (const aliases of [undefined, ["my-aws", "other-aws"], [] as string[]]) {
      const t = setup();
      const write = t.files.helper.write.bind(t.files.helper);
      t.files.helper.write = (name, content, mode) => { seen.push(content); return write(name, content, mode); };
      await t.run([request("aws", "local-aws@r1", { credentials: { user: "rovara", password: SECRET, controlToken: CONTROL, sqsReceiptSecret: RECEIPT }, region: "us-east-1", ...(aliases === undefined ? {} : { aliases }) })]);
    }
    expect(seen[0]).toContain("ROVARA_AWS_HOSTNAME=aws\n");
    expect(seen[1]).toContain("ROVARA_AWS_HOSTNAME=my-aws\n");
    // No alias at all: the fallback is still a name the other containers can use, never `localhost`.
    expect(seen[2]).toContain("ROVARA_AWS_HOSTNAME=aws\n");
  });
  it("L1: no docker call of the wait is given more time than the deadline has left, and the wait ends at the deadline", async () => {
    const entry = pinned("valkey@8", (copy) => { copy.health = { kind: "command", check: "redis_ping", startTimeoutS: 2 }; });
    const t = setup({ healthy: () => false });
    await t.run([{ id: "cache", name: "cache", entry, credentials: CREDENTIALS }]).catch(() => undefined);
    const waits = t.timeouts.filter((item) => item.args[0] === "exec" || item.args[0] === "inspect");
    expect(waits.length).toBeGreaterThan(2);
    for (const wait of waits) { expect(wait.timeoutMs).toBeGreaterThan(0); expect(wait.timeoutMs).toBeLessThanOrEqual(2_000); }
    expect(Math.min(...waits.map((wait) => wait.timeoutMs!))).toBeLessThanOrEqual(500);
    expect(t.clock.now() - NOW).toBeLessThanOrEqual(2_000);
  });
  it("L1: a probe container's call, and every sleep, are held to what is left of the deadline too (calls take time)", async () => {
    const entry = pinned("local-aws@r1", (copy) => { copy.health = { kind: "tcp", port: 4566, startTimeoutS: 2 }; });
    const clock = fakeClock();
    const sleeps: number[] = [];
    const t = setup({ healthy: () => false }, { now: () => clock.now(), sleep: (ms) => { sleeps.push(ms); return clock.sleep(ms); } });
    const original = t.docker.run.bind(t.docker);
    // Every health call takes 300 ms of the fake clock, so the time left is rarely a multiple of the poll.
    t.docker.run = (args, runOptions) => { if (args[0] === "inspect" || (args[0] === "run" && args.includes("--rm"))) clock.advance(300); return original(args, runOptions); };
    await t.run([{ id: "aws", name: "aws", entry, credentials: { user: "rovara", password: SECRET, controlToken: CONTROL, sqsReceiptSecret: RECEIPT }, region: "us-east-1" }]).catch(() => undefined);
    const probes = t.timeouts.filter((item) => item.args[0] === "run" && item.args.includes("--rm"));
    expect(probes.length).toBeGreaterThan(1);
    for (const probe of probes) { expect(probe.timeoutMs).toBeGreaterThan(0); expect(probe.timeoutMs).toBeLessThanOrEqual(2_000); }
    expect(Math.min(...probes.map((probe) => probe.timeoutMs!))).toBeLessThan(2_000);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(500);
    // The wait ends within one call of the deadline: no sleep carried it past.
    expect(clock.now() - NOW).toBeLessThanOrEqual(2_000 + 300);
  });
  it("L1: the deadline is checked before an attempt, so a clock already past it makes no health call", async () => {
    const clock = fakeClock();
    const jumpAfterStart = setup({}, { now: () => clock.now(), sleep: clock.sleep });
    // The first `docker run` takes the clock past the helper's whole limit.
    const original = jumpAfterStart.docker.run.bind(jumpAfterStart.docker);
    jumpAfterStart.docker.run = (args, runOptions) => { if (args[0] === "run" && args.includes("--detach")) clock.advance(60_000); return original(args, runOptions); };
    const error = await startHelpers(jumpAfterStart.docker, makeNet(), { ...jumpAfterStart.input([request("postgres", "postgres@16")]), now: () => clock.now(), sleep: clock.sleep }).then(() => undefined, (failure: unknown) => failure);
    expect((error as HelperStartError).reason).toBe("health_timeout");
    expect(jumpAfterStart.calls.filter((call) => call[0] === "exec")).toHaveLength(0);
  });
});

describe("review fixes 2 (H1, M1)", () => {
  const aws = (credentials: NonNullable<HelperRequest["credentials"]>): HelperRequest => request("aws", "local-aws@r1", { credentials, region: "us-east-1" });
  it("H1: the emulator's env file holds a control token of its own; it is in no argument, and in no other helper's file", async () => {
    const t = setup();
    const seen = new Map<string, string>();
    const write = t.files.helper.write.bind(t.files.helper);
    t.files.helper.write = (name, content, mode) => { seen.set(name, content); return write(name, content, mode); };
    await t.run([aws({ user: "rovara", password: SECRET, controlToken: CONTROL, sqsReceiptSecret: RECEIPT }), request("postgres", "postgres@16")]);
    const awsFile = [...seen.entries()].find(([name]) => name.endsWith(".env") && seen.get(name)!.includes("ROVARA_AWS_CONTROL_TOKEN"));
    expect(awsFile?.[1]).toContain(`ROVARA_AWS_CONTROL_TOKEN=${CONTROL}\n`);
    expect(awsFile?.[1]).toContain(`ROVARA_AWS_AUTH_PRESIGN_SECRET=${SECRET}\n`);
    expect([...seen.values()].filter((content) => content.includes(CONTROL))).toHaveLength(1);
    expect(t.calls.flat().join(" ")).not.toContain(CONTROL);
    expect(t.files.files.size).toBe(0);
  });
  it("H1: the emulator will not start without a control token, with one equal to the presign secret, or with one that is not plain", async () => {
    for (const controlToken of [undefined, SECRET, "short", `${CONTROL}\nX=1`, "has space 1234", "a".repeat(65), ""]) {
      const t = setup();
      await expect(t.run([aws({ user: "rovara", password: SECRET, ...(controlToken === undefined ? {} : { controlToken }) })]), String(controlToken)).rejects.toBeInstanceOf(HelperStartError);
      expect(t.started(), String(controlToken)).toHaveLength(0);
      expect(t.files.files.size).toBe(0);
    }
  });
  it("H1: another family ignores a control token it was given (it is in no env file of a database)", async () => {
    const t = setup();
    const seen: string[] = [];
    const write = t.files.helper.write.bind(t.files.helper);
    t.files.helper.write = (name, content, mode) => { seen.push(content); return write(name, content, mode); };
    await t.run([request("postgres", "postgres@16", { credentials: { ...CREDENTIALS, controlToken: CONTROL } })]);
    expect(seen.join("\n")).not.toContain(CONTROL);
  });
  it("M1: a restart-kind helper's bind-mounted files stay until stop(); its env file goes at once; a reset-by-template helper's files go when it is healthy", async () => {
    const t = setup();
    const file = { name: "seed.sql", content: "select 1;", to: "/etc/rovara/seed.sql" };
    const started = await t.run([request("db", "mysql@8", { files: [file] }), request("pg", "postgres@16", { files: [{ ...file, to: "/docker-entrypoint-initdb.d/seed.sql" }] })]);
    const mysql = helperContainerName(makeNet(), "db");
    const postgres = helperContainerName(makeNet(), "pg");
    expect([...t.files.files.keys()].sort()).toEqual([`${mysql}.seed.sql`]);
    expect(t.files.removed).toContain(`${mysql}.env`);
    expect(t.files.removed).toContain(`${postgres}.seed.sql`);
    expect(t.files.removed).not.toContain(`${mysql}.seed.sql`);
    await started.stop();
    expect(t.files.files.size).toBe(0);
    expect(t.files.removed).toContain(`${mysql}.seed.sql`);
    await started.stop();
  });
  it("M1: a restart-kind helper's config file (a cache that reads one) is kept until stop() too", async () => {
    const t = setup();
    const entry = pinned("valkey@8", (copy) => { copy.reset = { kind: "restart" }; });
    const started = await t.run([{ id: "cache", name: "cache", entry, credentials: CREDENTIALS }]);
    const name = helperContainerName(makeNet(), "cache");
    expect([...t.files.files.keys()]).toEqual([`${name}.conf`]);
    await started.stop();
    expect(t.files.files.size).toBe(0);
  });
  it("M1: a restart-kind helper whose start fails loses its files too", async () => {
    const t = setup({ healthy: () => false });
    await t.run([request("db", "mysql@8", { files: [{ name: "seed.sql", content: "x", to: "/etc/rovara/seed.sql" }] })]).catch(() => undefined);
    expect(t.files.files.size).toBe(0);
  });
});

describe("the labels (TS-RN-3 rule 1)", () => {
  it("every container the launcher starts, helpers and probes, carries all four labels with this run's values", async () => {
    const t = setup();
    await t.run([request("postgres", "postgres@16"), request("aws", "local-aws@r1", { credentials: { user: "rovara", password: SECRET, controlToken: CONTROL, sqsReceiptSecret: RECEIPT }, region: "us-east-1" })]);
    const containerCalls = t.calls.filter((call) => call[0] === "run");
    expect(containerCalls.length).toBeGreaterThanOrEqual(3); // two helpers and at least one probe (the emulator's health is over HTTP)
    for (const call of containerCalls) {
      const labels = flag(call, "--label");
      expect(labels, call.join(" ")).toEqual(flag(LABELS, "--label"));
    }
  });
});

describe("start order and health (4.0.6)", () => {
  it("starts a dependency's helpers first and waits for their health before the next level", async () => {
    const t = setup();
    await t.run([request("app-db", "postgres@16", { dependsOn: ["seed-cache"] }), request("seed-cache", "valkey@8")]);
    expect(t.order).toEqual([helperContainerName(makeNet(), "seed-cache"), helperContainerName(makeNet(), "app-db")]);
    const firstExec = t.calls.findIndex((call) => call[0] === "exec");
    const secondRun = t.calls.findIndex((call) => call[0] === "run" && call.includes(helperContainerName(makeNet(), "app-db")));
    expect(firstExec).toBeGreaterThan(-1);
    expect(firstExec).toBeLessThan(secondRun);
  });
  it("addresses follow the request order, not the start order", async () => {
    const t = setup();
    await t.run([request("app-db", "postgres@16", { dependsOn: ["seed-cache"] }), request("seed-cache", "valkey@8")]);
    const byName = new Map(t.started().map((call) => [call[call.indexOf("--name") + 1]!, flag(call, "--ip")[0]!]));
    expect(byName.get(helperContainerName(makeNet(), "app-db"))).toBe("172.30.153.16");
    expect(byName.get(helperContainerName(makeNet(), "seed-cache"))).toBe("172.30.153.17");
  });
  it("refuses a cycle, a missing dependency, a repeated id and a self-dependency before starting anything", async () => {
    for (const helpers of [
      [request("a-one", "postgres@16", { dependsOn: ["b-two"] }), request("b-two", "valkey@8", { dependsOn: ["a-one"] })],
      [request("a-one", "postgres@16", { dependsOn: ["nobody"] })],
      [request("a-one", "postgres@16"), request("a-one", "valkey@8")],
      [request("a-one", "postgres@16", { dependsOn: ["a-one"] })],
    ]) {
      const t = setup();
      await expect(t.run(helpers)).rejects.toBeInstanceOf(HelperStartError);
      expect(t.calls).toHaveLength(0);
    }
  });
  it("a command health check runs the fixed command inside the helper", async () => {
    const t = setup();
    await t.run([request("postgres", "postgres@16"), request("db", "mysql@8"), request("queue", "rabbitmq@3"), request("cache", "valkey@8")]);
    const execs = t.calls.filter((call) => call[0] === "exec").map((call) => call.slice(2));
    expect(execs).toContainEqual(["pg_isready", "-h", "127.0.0.1", "-p", "5432"]);
    expect(execs).toContainEqual(["mysqladmin", "ping", "-h", "127.0.0.1", "--silent"]);
    expect(execs).toContainEqual(["rabbitmq-diagnostics", "-q", "ping"]);
    expect(execs).toContainEqual(["valkey-cli", "ping"]);
  });
  it("an http health check is a hardened probe container on the run network, asking the helper's own address", async () => {
    const t = setup();
    await t.run([request("aws", "local-aws@r1", { credentials: { user: "rovara", password: SECRET, controlToken: CONTROL, sqsReceiptSecret: RECEIPT }, region: "us-east-1" })]);
    const probe = t.calls.find((call) => call[0] === "run" && call.includes("--rm"))!;
    expect(probe).toBeDefined();
    expect(flag(probe, "--network")).toEqual([runNetworkName(RUN)]);
    expect(flag(probe, "--cap-drop")).toEqual(["ALL"]);
    expect(flag(probe, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(probe).toContain("--read-only");
    expect(flag(probe, "--user")).toEqual(["1000:1000"]);
    expect(probe.at(-1)).not.toContain("--privileged");
    expect(probe.slice(probe.indexOf(PROBE_IMAGE))).toEqual([PROBE_IMAGE, "/opt/agentx/packages/worker/dist/service-probe.js", "--host", "172.30.153.16", "--port", "4566", "--path", "/_rovara/health"]);
    expect(probe).toContain("--entrypoint");
    expect(flag(probe, "--name")[0]).toMatch(/^rovara-svc-[0-9a-f]{12}-p[0-9a-f]{10}$/u);
    expect(flag(probe, "--stop-timeout")).toEqual(["1"]);
  });
  it("a tcp health check is a probe without a path", async () => {
    const t = setup();
    const entry = pinned("valkey@8", (copy) => { copy.health = { kind: "tcp", port: copy.run.ports[0]!, startTimeoutS: 15 }; });
    await t.run([{ ...request("cache", "valkey@8"), entry }]);
    const probe = t.calls.find((call) => call[0] === "run" && call.includes("--rm"))!;
    expect(probe.slice(probe.indexOf(PROBE_IMAGE))).toEqual([PROBE_IMAGE, "/opt/agentx/packages/worker/dist/service-probe.js", "--host", "172.30.153.16", "--port", String(entry.run.ports[0])]);
  });
  it("waits until the helper answers, polling, and returns the started helpers", async () => {
    const t = setup({ healthy: (_name, attempt) => attempt >= 3 });
    const started = await t.run([request("postgres", "postgres@16")]);
    expect(t.calls.filter((call) => call[0] === "exec")).toHaveLength(4);
    expect(started.helpers).toEqual([{ id: "postgres", container: helperContainerName(makeNet(), "postgres"), address: "172.30.153.16", aliases: ["postgres"], ports: [5432] }]);
  });
  it("fixed words when health never arrives, and everything started is removed", async () => {
    const t = setup({ healthy: () => false });
    const error = await t.run([request("cache", "valkey@8")]).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(HelperStartError);
    expect((error as HelperStartError).reason).toBe("health_timeout");
    expect((error as HelperStartError).message).toBe("cache did not start (health check timed out after 15 s)");
    expect((error as HelperStartError).dependencyId).toBe("cache");
    expect(t.containers.size).toBe(0);
  });
  it("the entry's own limit applies: postgres says 30 s", async () => {
    const t = setup({ healthy: () => false });
    const error = await t.run([request("postgres", "postgres@16")]).then(() => undefined, (failure: unknown) => failure);
    expect((error as HelperStartError).message).toBe("postgres did not start (health check timed out after 30 s)");
    expect(t.clock.now() - NOW).toBeGreaterThanOrEqual(30_000);
    expect(t.clock.now() - NOW).toBeLessThan(31_000);
  });
  it("a run-wide limit of 120 s caps a later helper", async () => {
    const longWait = (entryId: string) => pinned(entryId, (entry) => { entry.health = { kind: "command", check: "pg_isready", startTimeoutS: 120 }; });
    const slowName = helperContainerName(makeNet(), "slow");
    // The first helper answers on its 201st poll, 100 s in (a poll every 0.5 s), leaving 20 s of the run's 120 s.
    const t = setup({ healthy: (name, attempt) => (name === slowName ? attempt >= 200 : false) });
    const error = await t.run([
      { id: "slow", name: "slow", entry: longWait("postgres@16"), credentials: CREDENTIALS },
      { id: "late", name: "late", entry: longWait("postgres@15"), credentials: CREDENTIALS, aliases: ["late-db"], dependsOn: ["slow"] },
    ]).then(() => undefined, (failure: unknown) => failure);
    expect((error as HelperStartError).reason).toBe("health_timeout");
    expect((error as HelperStartError).message).toBe("late did not start (health check timed out after 20 s)");
    expect(t.clock.now() - NOW).toBeLessThan(121_000);
    expect(t.containers.size).toBe(0);
  });
  it("a helper that stops while starting says so, without waiting out the timeout", async () => {
    const t = setup({ exits: () => true });
    const error = await t.run([request("postgres", "postgres@16")]).then(() => undefined, (failure: unknown) => failure);
    expect((error as HelperStartError).reason).toBe("exited");
    expect((error as HelperStartError).message).toBe("postgres stopped while starting");
    expect(t.clock.now() - NOW).toBeLessThan(5_000);
    expect(t.containers.size).toBe(0);
  });
  it("a failed docker run says the helper could not be started, never docker's own words", async () => {
    const t = setup({ failRun: () => true });
    const error = await t.run([request("postgres", "postgres@16")]).then(() => undefined, (failure: unknown) => failure);
    expect((error as HelperStartError).reason).toBe("start_failed");
    expect((error as HelperStartError).message).toBe("postgres could not be started");
    expect((error as HelperStartError).message).not.toContain("Unable to find image");
  });
  it("a hostile display name cannot add words, lines or markup to the message", async () => {
    const t = setup({ failRun: () => true });
    const error = await t.run([{ ...request("postgres", "postgres@16"), name: "Pay\nBLOCKED: <script>alert(1)</script> `x` $(id)" }]).then(() => undefined, (failure: unknown) => failure);
    expect((error as HelperStartError).message).toBe("Pay?BLOCKED? ?script?alert?1???script? ?x? ??id? could not be started");
    const long = setup({ failRun: () => true });
    const cut = await long.run([{ ...request("postgres", "postgres@16"), name: "n".repeat(500) }]).then(() => undefined, (failure: unknown) => failure);
    expect((cut as HelperStartError).message).toBe(`${"n".repeat(80)} could not be started`);
  });
  it("a stop signal ends the wait and removes what was started", async () => {
    const controller = new AbortController();
    const t = setup({ healthy: () => { controller.abort(); return false; } }, { signal: controller.signal });
    const error = await t.run([request("postgres", "postgres@16")]).then(() => undefined, (failure: unknown) => failure);
    expect((error as HelperStartError).reason).toBe("stopped");
    expect(t.containers.size).toBe(0);
  });
});

describe("the run's limits", () => {
  it("refuses more than 12 helpers, and more memory than the run may use, before any docker call", async () => {
    const many = Array.from({ length: 13 }, (_unused, index) => request(`cache-${String(index)}`, "valkey@8", { aliases: [`cache-${String(index)}`] }));
    const t = setup();
    await expect(t.run(many)).rejects.toBeInstanceOf(HelperStartError);
    expect(t.calls).toHaveLength(0);
    const heavy = setup({}, { maxMemMiB: 1_023 });
    const error = await heavy.run([request("postgres", "postgres@16"), request("db", "mysql@8")]).then(() => undefined, (failure: unknown) => failure);
    expect((error as HelperStartError).reason).toBe("over_limit");
    expect((error as HelperStartError).message).toBe("The test services need 1280 MiB; this run may use 1023 MiB");
    expect(heavy.calls).toHaveLength(0);
  });
  it("12 helpers fit when the memory does", async () => {
    const t = setup();
    const twelve = Array.from({ length: 12 }, (_unused, index) => request(`cache-${String(index)}`, "valkey@8", { aliases: [`cache-${String(index)}`] }));
    const started = await t.run(twelve);
    expect(started.helpers).toHaveLength(12);
  });
  it("refuses an entry that is not pinned, retired, or not offered in this edition", async () => {
    const unpinned = catalog.entries.find((entry) => entry.id === "postgres@16")!;
    const cases: Array<[CatalogEntry, "public" | "enterprise"]> = [
      [unpinned, "public"],
      [pinned("postgres@16", (entry) => { entry.status = "retired"; }), "public"],
      [pinned("postgres@16", (entry) => { entry.editions = ["enterprise"]; }), "public"],
    ];
    for (const [entry, edition] of cases) {
      const t = setup({}, { edition });
      const error = await t.run([{ id: "postgres", name: "postgres", entry, credentials: CREDENTIALS }]).then(() => undefined, (failure: unknown) => failure);
      expect((error as HelperStartError).reason).toBe("refused");
      expect((error as HelperStartError).message).toBe("postgres cannot be started here");
      expect(t.calls).toHaveLength(0);
    }
  });
});

describe("stopping", () => {
  it("removes every helper it started, by name, once", async () => {
    const t = setup();
    const started = await t.run([request("postgres", "postgres@16"), request("cache", "valkey@8")]);
    expect(t.containers.size).toBe(2);
    await started.stop();
    await started.stop();
    expect(t.containers.size).toBe(0);
    const removals = t.calls.filter((call) => call[0] === "rm" && call.includes("--force"));
    expect(removals.every((call) => call.includes("--volumes"))).toBe(true);
    expect(removals.flatMap((call) => call.slice(3)).sort()).toEqual([helperContainerName(makeNet(), "cache"), helperContainerName(makeNet(), "postgres")].sort());
  });
  it("container names are hashes of the run's network and the id, not the id", () => {
    const name = helperContainerName(makeNet(), "postgres");
    expect(name).toMatch(/^rovara-svc-[0-9a-f]{12}-h[0-9a-f]{10}$/u);
    expect(name).not.toContain("postgres");
    expect(helperContainerName(makeNet(), "cache")).not.toBe(name);
  });
});

describe("the worker-start sweep (TS-RN-3 rule 3)", () => {
  it("removes every family object of this workspace, whatever its expiry, through the run network's sweep", async () => {
    const calls: string[][] = [];
    const docker: DockerCli = {
      run(args) {
        calls.push([...args]);
        if (args[0] === "ps" || (args[0] === "network" && args[1] === "ls")) {
          const row = `abc123\t${runNetworkName(RUN)}\t${String(NOW)}\t${WS}\t${String(NOW + 10_000_000_000)}`;
          return Promise.resolve({ exitCode: 0, stdout: row, stderr: "" });
        }
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
    };
    const swept = await sweepServicesNetworksAtWorkerStart(docker, WS);
    expect(swept).toEqual({ containers: 1, networks: 1 });
    expect(calls.some((call) => call[0] === "rm" && call.includes("abc123"))).toBe(true);
    expect(calls.some((call) => call[0] === "network" && call[1] === "rm")).toBe(true);
  });
});

describe("a cache that wants a password still counts as alive", () => {
  it("NOAUTH from the health command is a live server; any other failure is not", async () => {
    const make = (stdout: string, exitCode: number): DockerCli => ({
      run(args) {
        if (args[0] === "image") return Promise.resolve({ exitCode: 0, stdout: "null\n", stderr: "" });
        if (args[0] === "inspect") return Promise.resolve({ exitCode: 0, stdout: "running\n", stderr: "" });
        if (args[0] === "exec") return Promise.resolve({ exitCode, stdout, stderr: "" });
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
    });
    const files = fakeFiles();
    const clock = fakeClock();
    const input = (): StartHelpersInput => ({ registry: REGISTRY, edition: "public", probeImage: PROBE_IMAGE, maxMemMiB: 3_072, helpers: [request("cache", "valkey@8")], files: files.helper, now: clock.now, sleep: clock.sleep });
    await expect(startHelpers(make("NOAUTH Authentication required.", 1), makeNet(), input())).resolves.toBeDefined();
    await expect(startHelpers(make("connection refused", 1), makeNet(), input())).rejects.toBeInstanceOf(HelperStartError);
  });
});

describe("the health probe (service-probe.ts)", () => {
  it("a TCP probe is true for a listening port and false for a closed one", async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    expect(await probeService({ host: "127.0.0.1", port, timeoutMs: 500 })).toBe(true);
    await new Promise<void>((done) => server.close(() => done()));
    expect(await probeService({ host: "127.0.0.1", port, timeoutMs: 500 })).toBe(false);
  });
  it("an HTTP probe needs a 2xx answer on the path", async () => {
    const server = createHttpServer((request, response) => { response.statusCode = request.url === "/ok" ? 200 : 503; response.end("x"); });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    expect(await probeService({ host: "127.0.0.1", port, path: "/ok", timeoutMs: 500 })).toBe(true);
    expect(await probeService({ host: "127.0.0.1", port, path: "/down", timeoutMs: 500 })).toBe(false);
    await new Promise<void>((done) => server.close(() => done()));
  });
  it("M1: a server that trickles its headers every 300 ms cannot keep the probe alive past its own limit", async () => {
    const server = createServer((socket) => {
      socket.write("HTTP/1.1 200 OK\r\n");
      const timer = setInterval(() => socket.write("X-Slow: 1\r\n"), 300);
      socket.on("close", () => clearInterval(timer));
      socket.on("error", () => clearInterval(timer));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    const started = Date.now();
    expect(await probeService({ host: "127.0.0.1", port, path: "/health", timeoutMs: 1_000 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_800);
    await new Promise<void>((done) => server.close(() => done()));
  });
  it("M1: a server that accepts and then trickles bytes without a response is also cut at the limit (TCP)", async () => {
    const server = createServer((socket) => { socket.on("error", () => undefined); });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    // A plain connect succeeds at once: that is the answer for a TCP probe.
    expect(await probeService({ host: "127.0.0.1", port, timeoutMs: 500 })).toBe(true);
    await new Promise<void>((done) => server.close(() => done()));
  });
  it("refuses a name, a bad port and a hostile path without connecting", async () => {
    expect(await probeService({ host: "localhost", port: 80 })).toBe(false);
    expect(await probeService({ host: "127.0.0.1", port: 0 })).toBe(false);
    expect(await probeService({ host: "127.0.0.1", port: 80, path: "/a b" })).toBe(false);
    expect(await probeService({ host: "127.0.0.1", port: 80, path: "http://evil/" })).toBe(false);
  });
});
