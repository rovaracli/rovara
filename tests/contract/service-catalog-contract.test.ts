// Test services TS2 (contract and data): the image catalog's schema, its closed list of fixed arguments, the unpinned v1 data file and the Rovara local AWS entry's service tiers.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as cat from "../../packages/contracts/src/service-catalog.js";

const FILE = "environments/service-catalog/catalog.json";
/** The data file as the tests edit it: loosely typed on purpose, so a test can break any field and the schema, not the compiler, is what refuses it. */
interface RawEntry {
  id: string;
  status: string;
  licence: string;
  editions: unknown;
  sbomRef?: unknown;
  scan?: unknown;
  process?: unknown;
  image: { repository: unknown; digest?: unknown; platforms: unknown; [key: string]: unknown };
  run: { user: unknown; readOnlyRoot: unknown; tmpfs: unknown; ports: unknown; extraArgs: unknown; [key: string]: unknown };
  health: unknown;
  resources: Record<string, unknown>;
  connect: { templates: Record<string, string>; defaultAliases: unknown };
  reset: { kind: unknown };
  emulator?: { services: { supported: string[]; functions: string[]; model_endpoint_front: string[]; available: string[]; [key: string]: string[] }; iamEnforced: unknown; storage: unknown } | undefined;
  [key: string]: unknown;
}
interface RawCatalog { pinned: boolean; entries: RawEntry[]; [key: string]: unknown }
const raw = (): RawCatalog => JSON.parse(readFileSync(FILE, "utf8")) as RawCatalog;
const entryAt = (data: RawCatalog, index: number): RawEntry => {
  const found = data.entries[index];
  if (found === undefined) throw new Error(`no entry at ${String(index)}`);
  return found;
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const entryOf = (id: string): RawEntry => {
  const found = raw().entries.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no entry ${id}`);
  return clone(found);
};
const sha = (letter: string) => letter.repeat(64);
const entryOk = (value: unknown) => cat.CatalogEntrySchema.safeParse(value).success;
const catalogOk = (value: unknown) => cat.ServiceCatalogSchema.safeParse(value).success;
const withEntry = (id: string, change: (entry: RawEntry) => void) => {
  const entry = entryOf(id);
  change(entry);
  return entry;
};
const pinnedEntry = (id: string) => withEntry(id, (entry) => {
  entry.image.digest = sha("a");
  entry.sbomRef = sha("b");
  entry.scan = { scannedAt: "2026-11-02T00:00:00.000Z", criticalOpen: 0, highOpen: 2 };
});

describe("the v1 data file", () => {
  const catalog = cat.ServiceCatalogSchema.parse(raw());
  it("parses, as unpinned revision 1", () => {
    expect(catalog).toMatchObject({ schemaVersion: 1, revision: 1, pinned: false });
  });
  it("lists the v1 starting set of 2.5", () => {
    expect(catalog.entries.map((entry) => entry.id)).toEqual(["postgres@15", "postgres@16", "postgres@17", "mysql@8", "valkey@8", "redis@7", "rabbitmq@3", "local-aws@r1", "fake-server@r1", "test-account-proxy@r1", "dns-helper@r1"]);
    expect(Object.fromEntries(catalog.entries.filter((entry) => entry.status === "default").map((entry) => [entry.family, entry.id]))).toEqual({ postgres: "postgres@16", mysql: "mysql@8", redis: "valkey@8", "local-aws": "local-aws@r1", "fake-server": "fake-server@r1" });
  });
  it("carries no digest, SBOM, scan or process artifact until the pin task", () => {
    for (const entry of catalog.entries) {
      expect(entry.image.digest, entry.id).toBeUndefined();
      expect(entry.sbomRef, entry.id).toBeUndefined();
      expect(entry.scan, entry.id).toBeUndefined();
      expect(entry.process, entry.id).toBeUndefined();
    }
    expect(readFileSync(FILE, "utf8")).not.toMatch(/sha256|[a-f0-9]{64}/u);
  });
  it("holds the starting sizes of 2.5", () => {
    const size = (id: string) => catalog.entries.find((entry) => entry.id === id)!.resources;
    expect(size("postgres@16")).toMatchObject({ memMiB: 512, cpus: 1 });
    expect(size("mysql@8")).toMatchObject({ memMiB: 768, cpus: 1 });
    expect(size("valkey@8")).toMatchObject({ memMiB: 128, cpus: 0.5 });
    expect(size("rabbitmq@3")).toMatchObject({ memMiB: 256, cpus: 0.5 });
    expect(size("local-aws@r1")).toMatchObject({ memMiB: 640, cpus: 1 });
    expect(size("fake-server@r1")).toMatchObject({ memMiB: 128, cpus: 0.5 });
    expect(size("test-account-proxy@r1")).toMatchObject({ memMiB: 64, cpus: 0.25 });
    expect(size("dns-helper@r1")).toMatchObject({ memMiB: 128, cpus: 0.5 });
  });
  it("runs every entry without root, on a read-only root, and starts the emulator within 30 seconds", () => {
    for (const entry of catalog.entries) {
      expect(entry.run.readOnlyRoot, entry.id).toBe(true);
      expect(entry.run.user.split(":").every((part) => Number(part) > 0), entry.id).toBe(true);
    }
    expect(catalog.entries.find((entry) => entry.id === "local-aws@r1")!.health).toMatchObject({ kind: "http", path: "/_rovara/health", startTimeoutS: 30 });
    // Rovara local AWS is built for arm64 only (the workers are arm64); every other entry lists both platforms.
    expect(catalog.entries.find((entry) => entry.id === "local-aws@r1")!.image.platforms).toEqual(["linux/arm64"]);
    expect(catalog.entries.filter((entry) => entry.id !== "local-aws@r1").every((entry) => entry.image.platforms.join() === "linux/arm64,linux/amd64")).toBe(true);
  });
  it("gives the database entries a template database reset and the cache a flush", () => {
    const reset = (id: string) => catalog.entries.find((entry) => entry.id === id)!.reset.kind;
    expect([reset("postgres@16"), reset("valkey@8"), reset("redis@7"), reset("local-aws@r1")]).toEqual(["template_db", "flush", "flush", "http_reset"]);
  });
  it("never names the upstream emulator, a registry or an address", () => {
    const text = readFileSync(FILE, "utf8").toLowerCase();
    expect(text).not.toContain(["flo", "ci"].join(""));
    expect(text).not.toMatch(/https?:|localstack|moto|minio/u);
    expect(text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/u);
  });
  it("is the same data with and without a trailing key order change (round-trips through the schema)", () => {
    expect(cat.ServiceCatalogSchema.parse(JSON.parse(JSON.stringify(catalog)))).toEqual(catalog);
  });
});

describe("Rovara local AWS entry", () => {
  const emulator = cat.ServiceCatalogSchema.parse(raw()).entries.find((entry) => entry.id === "local-aws@r1")!.emulator!;
  it("lists the services of 5.2 in four tiers", () => {
    expect(emulator.services).toEqual({
      supported: ["s3", "dynamodb", "sqs", "sns", "sts", "secretsmanager", "ssm", "kms", "events"],
      functions: ["lambda"],
      model_endpoint_front: ["sagemaker-runtime"],
      available: ["dynamodbstreams", "kinesis", "stepfunctions", "apigateway", "cognito-idp", "logs"],
    });
    expect(cat.EMULATOR_SERVICE_TIERS).toEqual(["supported", "functions", "model_endpoint_front", "available"]);
  });
  it("does not enforce IAM and keeps its data in memory, and says so", () => {
    expect(emulator).toMatchObject({ iamEnforced: false, storage: "memory" });
    expect(entryOk(withEntry("local-aws@r1", (entry) => { entry.emulator!.iamEnforced = true; }))).toBe(false);
    expect(entryOk(withEntry("local-aws@r1", (entry) => { entry.emulator!.storage = "disk"; }))).toBe(false);
  });
  it("lets the chooser pick the supported, function and model-endpoint tiers but not the available one", () => {
    for (const service of ["s3", "dynamodb", "sqs", "sns", "sts", "secretsmanager", "ssm", "kms", "events", "lambda", "sagemaker-runtime"]) expect(cat.emulatorChoosable(emulator, service), service).toBe(true);
    for (const service of ["kinesis", "stepfunctions", "apigateway", "cognito-idp", "logs", "dynamodbstreams"]) expect(cat.emulatorChoosable(emulator, service), service).toBe(false);
    for (const service of ["ec2", "bedrock", "ecr", "codeartifact", "rds"]) {
      expect(cat.emulatorServiceTier(emulator, service), service).toBeUndefined();
      expect(cat.emulatorChoosable(emulator, service), service).toBe(false);
    }
    expect(cat.emulatorServiceTier(emulator, "lambda")).toBe("functions");
    expect(cat.emulatorServiceTier(emulator, "kinesis")).toBe("available");
  });
  it("keeps a service in one tier and needs at least one supported service", () => {
    expect(entryOk(withEntry("local-aws@r1", (entry) => { entry.emulator!.services.available.push("s3"); }))).toBe(false);
    expect(entryOk(withEntry("local-aws@r1", (entry) => { entry.emulator!.services.supported = []; }))).toBe(false);
    expect(entryOk(withEntry("local-aws@r1", (entry) => { entry.emulator!.services.extra = ["x1"]; }))).toBe(false);
  });
  it("is on the emulated entry only", () => {
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.emulator = clone(entryOf("local-aws@r1").emulator); }))).toBe(false);
    expect(entryOk(withEntry("local-aws@r1", (entry) => { Reflect.deleteProperty(entry, "emulator"); }))).toBe(false);
  });
  it("is the only entry that may hold AWS variables", () => {
    expect(entryOk(withEntry("local-aws@r1", (entry) => { entry.connect.templates.AWS_ENDPOINT_URL = "http://{host}:{port}"; }))).toBe(true);
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.connect.templates.AWS_REGION = "{region}"; }))).toBe(false);
  });
});

describe("fixed arguments", () => {
  it("is a closed list: an entry holds ids, and an unknown id or free text is refused", () => {
    expect(Object.keys(cat.CATALOG_FIXED_ARGS).sort()).toEqual(["mysql_flush_log_lazily", "mysql_skip_log_bin", "postgres_fsync_off", "postgres_full_page_writes_off", "postgres_synchronous_commit_off", "redis_appendonly_off", "redis_save_off"]);
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.run.extraArgs = ["postgres_fsync_off"]; }))).toBe(true);
    for (const free of ["-c fsync=off", "--privileged", "postgres_unknown", "", "-c", "fsync=off; rm -rf /"]) expect(entryOk(withEntry("postgres@16", (entry) => { entry.run.extraArgs = [free]; })), free).toBe(false);
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.run.extraArgs = [["-c", "fsync=off"]]; }))).toBe(false);
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.run.extraArgs = [{ argv: ["--x"] }]; }))).toBe(false);
  });
  it("has no argument that mounts, publishes, escalates or reaches out", () => {
    const all = Object.values(cat.CATALOG_FIXED_ARGS).flatMap((arg) => [...arg.argv]).join(" ");
    expect(all).not.toMatch(/privileged|cap-add|--user|--network|--volume|-v\b|--publish|--device|--pid|--security-opt|http|\/|;|\|/u);
  });
  it("takes an argument only on a family it is valid for", () => {
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.run.extraArgs = ["redis_save_off"]; }))).toBe(false);
    expect(entryOk(withEntry("valkey@8", (entry) => { entry.run.extraArgs = ["mysql_skip_log_bin"]; }))).toBe(false);
    expect(entryOk(withEntry("mysql@8", (entry) => { entry.run.extraArgs = ["postgres_fsync_off"]; }))).toBe(false);
    expect(entryOk(withEntry("valkey@8", (entry) => { entry.run.extraArgs = ["redis_save_off"]; }))).toBe(true);
  });
  it("takes an argument once and at most eight", () => {
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.run.extraArgs = ["postgres_fsync_off", "postgres_fsync_off"]; }))).toBe(false);
  });
  it("expands ids to their arguments in order", () => {
    expect(cat.catalogFixedArgv(["postgres_fsync_off", "postgres_synchronous_commit_off"])).toEqual(["-c", "fsync=off", "-c", "synchronous_commit=off"]);
    expect(cat.catalogFixedArgv(["redis_save_off"])).toEqual(["--save", ""]);
    expect(cat.catalogFixedArgv([])).toEqual([]);
  });
  it("applies to the process backend's arguments too", () => {
    const process = (args: string[]) => withEntry("postgres@16", (entry) => { entry.process = { artifactDigest: sha("c"), entry: "bin/postgres", args }; });
    expect(entryOk(process(["postgres_fsync_off"]))).toBe(true);
    expect(entryOk(process(["--anything"]))).toBe(false);
    expect(entryOk(process(["redis_save_off"]))).toBe(false);
    expect(entryOk(process(Array.from({ length: 9 }, () => "postgres_fsync_off")))).toBe(false);
  });
});

describe("hardening profile", () => {
  const run = (id: string, change: (run: RawEntry["run"]) => void) => withEntry(id, (entry) => change(entry.run));
  it("refuses root, a missing or odd user", () => {
    for (const user of ["0:0", "0:999", "999:0", "root", "999", "999:999:1", "-1:5", ""]) expect(entryOk(run("postgres@16", (r) => { r.user = user; })), user).toBe(false);
  });
  it("keeps the tmpfs mounts inside the helper's memory", () => {
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.resources.memMiB = 296; }))).toBe(true);
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.resources.memMiB = 295; }))).toBe(false);
  });
  it("takes plain absolute mount paths, listed once, at most four", () => {
    for (const path of ["data", "/", "/a/../b", "/a b", "/a//b", "/a;b", "../x"]) expect(entryOk(run("postgres@16", (r) => { r.tmpfs = [{ path, sizeMiB: 8 }]; })), path).toBe(false);
    expect(entryOk(run("postgres@16", (r) => { r.tmpfs = [{ path: "/a", sizeMiB: 8 }, { path: "/a", sizeMiB: 8 }]; }))).toBe(false);
    expect(entryOk(run("postgres@16", (r) => { r.tmpfs = ["/a", "/b", "/c", "/d", "/e"].map((path) => ({ path, sizeMiB: 1 })); }))).toBe(false);
  });
  it("takes valid ports, listed once, at most four", () => {
    for (const port of [0, 65536, 1.5, -1]) expect(entryOk(run("postgres@16", (r) => { r.ports = [port]; })), String(port)).toBe(false);
    expect(entryOk(run("postgres@16", (r) => { r.ports = [5432, 5432]; }))).toBe(false);
    expect(entryOk(run("postgres@16", (r) => { r.ports = [5432, 1, 2, 3, 4]; }))).toBe(false);
  });
  it("bounds memory, CPUs and processes", () => {
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.resources = { memMiB: 9000, cpus: 1, pids: 100 }; }))).toBe(false);
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.resources = { memMiB: 512, cpus: 0, pids: 100 }; }))).toBe(false);
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.resources = { memMiB: 512, cpus: 1, pids: 5000 }; }))).toBe(false);
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.resources = { memMiB: 512, cpus: 1 }; }))).toBe(false);
  });
  it("is strict at every level", () => {
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.privileged = true; }))).toBe(false);
    expect(entryOk(run("postgres@16", (r) => { r.capAdd = ["NET_ADMIN"]; }))).toBe(false);
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.image.extra = 1; }))).toBe(false);
  });
});

describe("health, reset and connection templates", () => {
  it("takes a health check from a closed list, within 120 seconds, on a port the helper exposes", () => {
    const health = (value: Record<string, unknown>) => withEntry("postgres@16", (entry) => { entry.health = value; });
    expect(entryOk(health({ kind: "command", check: "pg_isready", startTimeoutS: 120 }))).toBe(true);
    expect(entryOk(health({ kind: "command", check: "pg_isready", startTimeoutS: 121 }))).toBe(false);
    expect(entryOk(health({ kind: "command", check: "pg_isready", startTimeoutS: 0 }))).toBe(false);
    expect(entryOk(health({ kind: "command", check: "sh -c 'curl x'", startTimeoutS: 5 }))).toBe(false);
    expect(entryOk(health({ kind: "command", command: "ls", startTimeoutS: 5 }))).toBe(false);
    expect(entryOk(health({ kind: "tcp", port: 5432, startTimeoutS: 5 }))).toBe(true);
    expect(entryOk(health({ kind: "tcp", port: 9999, startTimeoutS: 5 }))).toBe(false);
    expect(entryOk(health({ kind: "http", port: 5432, path: "/health", startTimeoutS: 5 }))).toBe(true);
    for (const path of ["health", "/a/../b", "//x", "/a b", "/a?x=1"]) expect(entryOk(health({ kind: "http", port: 5432, path, startTimeoutS: 5 })), path).toBe(false);
  });
  it("takes connection templates with the run's own placeholders only", () => {
    const templates = (value: Record<string, string>) => withEntry("postgres@16", (entry) => { entry.connect.templates = value; });
    expect(entryOk(templates({ DATABASE_URL: "postgres://{user}:{password}@{host}:{port}/{db}" }))).toBe(true);
    expect(entryOk(templates({ DATABASE_URL: "postgres://app:hunter2@{host}/{db}" }))).toBe(false);
    expect(entryOk(templates({ DATABASE_URL: "{token}" }))).toBe(false);
    expect(entryOk(templates({ database_url: "{host}" }))).toBe(false);
    expect(entryOk(templates({ PATH: "{host}" }))).toBe(false);
    expect(entryOk(templates({ NODE_OPTIONS: "{host}" }))).toBe(false);
    expect(entryOk(templates({ HTTPS_PROXY: "{host}" }))).toBe(false);
  });
  it("keeps Rovara's helper names off as aliases and lists an alias once", () => {
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.connect.defaultAliases = ["proxy"]; }))).toBe(false);
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.connect.defaultAliases = ["db", "db"]; }))).toBe(false);
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.connect.defaultAliases = ["a", "b", "c", "d", "e"]; }))).toBe(false);
  });
  it("takes a reset kind from the closed list", () => {
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.reset.kind = "script"; }))).toBe(false);
  });
});

describe("identity, status and licence", () => {
  it("keeps real software, the emulator, the fake server and the helpers apart", () => {
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.id = "local-aws@r2"; }))).toBe(false);
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.id = "dns-helper@r2"; }))).toBe(false);
    expect(entryOk(withEntry("local-aws@r1", (entry) => { entry.id = "postgres@16"; }))).toBe(false);
    expect(entryOk(withEntry("fake-server@r1", (entry) => { entry.id = "postgres@16"; }))).toBe(false);
    expect(entryOk(withEntry("dns-helper@r1", (entry) => { entry.id = "postgres@16"; }))).toBe(false);
    expect(entryOk(withEntry("dns-helper@r1", (entry) => { entry.id = "test-account-proxy@r2"; }))).toBe(true);
  });
  it("has no default helper: Rovara starts them, nobody chooses them", () => {
    expect(entryOk(withEntry("dns-helper@r1", (entry) => { entry.status = "default"; }))).toBe(false);
  });
  it("names the image by a repository under the install's registry, not a host", () => {
    for (const repository of ["registry.example.internal/svc/postgres", "postgres", "svc/", "svc/Postgres", "svc/a b", "../svc/x", "https://x/svc/y"]) expect(entryOk(withEntry("postgres@16", (entry) => { entry.image.repository = repository; })), repository).toBe(false);
  });
  it("lists a platform and an edition once", () => {
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.image.platforms = ["linux/arm64", "linux/arm64"]; }))).toBe(false);
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.image.platforms = []; }))).toBe(false);
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.image.platforms = ["linux/s390x"]; }))).toBe(false);
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.editions = ["public", "public"]; }))).toBe(false);
    expect(entryOk(withEntry("postgres@16", (entry) => { entry.editions = []; }))).toBe(false);
  });
  it("takes a licence as an SPDX identifier or expression", () => {
    expect(entryOk(withEntry("local-aws@r1", (entry) => { entry.licence = "LicenseRef-Rovara AND MIT"; }))).toBe(true);
    for (const licence of ["", "MIT\nGPL", "<script>", "x".repeat(129)]) expect(entryOk(withEntry("postgres@16", (entry) => { entry.licence = licence; })), licence).toBe(false);
  });
});

describe("the catalog as a whole", () => {
  const file = (): RawCatalog => clone(raw());
  const entryIn = (data: RawCatalog, id: string): RawEntry => {
    const found = data.entries.find((entry) => entry.id === id);
    if (found === undefined) throw new Error(`no entry ${id}`);
    return found;
  };
  it("lists an id once and gives a family one default", () => {
    const duplicated = file();
    duplicated.entries.push(clone(entryAt(duplicated, 0)));
    expect(catalogOk(duplicated)).toBe(false);
    const twoDefaults = file();
    entryIn(twoDefaults, "postgres@15").status = "default";
    expect(catalogOk(twoDefaults)).toBe(false);
  });
  it("is strict and versioned", () => {
    expect(catalogOk({ ...file(), extra: 1 })).toBe(false);
    expect(catalogOk({ ...file(), schemaVersion: 2 })).toBe(false);
    expect(catalogOk({ ...file(), entries: [] })).toBe(false);
  });
  it("finds an entry by id, retired ones included", () => {
    const catalog = cat.ServiceCatalogSchema.parse(raw());
    expect(cat.catalogEntryById(catalog, "postgres@16")?.status).toBe("default");
    expect(cat.catalogEntryById(catalog, "postgres@99")).toBeUndefined();
    const retired = file();
    entryIn(retired, "postgres@15").status = "retired";
    expect(cat.catalogEntryById(cat.ServiceCatalogSchema.parse(retired), "postgres@15")?.status).toBe("retired");
  });
  describe("unpinned and pinned", () => {
    it("refuses a digest, an SBOM, a scan or a process artifact in an unpinned file", () => {
      const unpinned = (change: (entry: RawEntry) => void) => {
        const data = file();
        change(entryAt(data, 0));
        return data;
      };
      expect(catalogOk(unpinned((entry) => { entry.image.digest = sha("a"); }))).toBe(false);
      expect(catalogOk(unpinned((entry) => { entry.sbomRef = sha("a"); }))).toBe(false);
      expect(catalogOk(unpinned((entry) => { entry.scan = { scannedAt: "2026-11-02T00:00:00.000Z", criticalOpen: 0, highOpen: 0 }; }))).toBe(false);
      expect(catalogOk(unpinned((entry) => { entry.process = { artifactDigest: sha("a"), entry: "bin/x", args: [] }; }))).toBe(false);
    });
    it("needs a digest, an SBOM and a scan on every live entry of a pinned file", () => {
      const pinned = () => {
        const data = file();
        data.pinned = true;
        data.entries = data.entries.map((entry) => ({ ...entry, image: { ...entry.image, digest: sha("a") }, sbomRef: sha("b"), scan: { scannedAt: "2026-11-02T00:00:00.000Z", criticalOpen: 0, highOpen: 1 } }));
        return data;
      };
      expect(catalogOk(pinned())).toBe(true);
      for (const drop of ["digest", "sbomRef", "scan"]) {
        const data = pinned();
        if (drop === "digest") delete entryAt(data, 1).image.digest;
        else delete entryAt(data, 1)[drop];
        expect(catalogOk(data), drop).toBe(false);
      }
      const retired = pinned();
      const first = entryAt(retired, 0);
      first.status = "retired";
      delete first.image.digest;
      delete first.sbomRef;
      delete first.scan;
      expect(catalogOk(retired)).toBe(true);
    });
    it("slice 1: a pinned file may hold entries that are not pinned yet (none of the three), but never a half-pinned entry, and it pins at least one image", () => {
      const pinnedOnly = (ids: string[]) => {
        const data = file();
        data.pinned = true;
        data.entries = data.entries.map((entry) => (ids.includes(entry.id) ? { ...entry, image: { ...entry.image, digest: sha("a") }, sbomRef: sha("b"), scan: { scannedAt: "2026-11-02T00:00:00.000Z", criticalOpen: 0, highOpen: 1 } } : entry));
        return data;
      };
      expect(catalogOk(pinnedOnly(["postgres@16"]))).toBe(true);
      const parsed = cat.ServiceCatalogSchema.parse(pinnedOnly(["postgres@16"]));
      expect(parsed.entries.filter((entry) => entry.image.digest !== undefined).map((entry) => entry.id)).toEqual(["postgres@16"]);
      // No image pinned at all is not a pinned file.
      expect(catalogOk(pinnedOnly([]))).toBe(false);
      // A pinned entry with only some of the three, or an unpinned one that carries a process artifact, is refused.
      for (const drop of ["digest", "sbomRef", "scan"] as const) {
        const data = pinnedOnly(["postgres@16", "mysql@8"]);
        const entry = data.entries.find((candidate) => candidate.id === "mysql@8") as RawEntry;
        if (drop === "digest") delete entry.image.digest;
        else delete entry[drop];
        expect(catalogOk(data), drop).toBe(false);
      }
      const withProcess = pinnedOnly(["postgres@16"]);
      (withProcess.entries.find((candidate) => candidate.id === "mysql@8") as RawEntry).process = { artifactDigest: sha("a"), entry: "bin/x", args: [] };
      expect(catalogOk(withProcess)).toBe(false);
      // The unpinned file still holds no pin anywhere.
      expect(catalogOk(file())).toBe(true);
    });
    it("refuses a scan with a critical finding open, and a malformed digest", () => {
      expect(cat.CatalogScanSchema.safeParse({ scannedAt: "2026-11-02T00:00:00.000Z", criticalOpen: 1, highOpen: 0 }).success).toBe(false);
      expect(entryOk(withEntry("postgres@16", (entry) => { entry.image.digest = "sha256:abc"; }))).toBe(false);
      expect(entryOk(pinnedEntry("postgres@16"))).toBe(true);
    });
  });
});
