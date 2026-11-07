// TS-UX-1 item 9 (security-sensitive): a dependency's seed FILE is read from the repository checkout only (no traversal, no symlink escape, no hidden folder, a size cap, the file that was resolved) and loaded into the
// disposable test database by its own client inside its container, over the local socket (no host, port or password), in one transaction, under a time limit. Every failure is a fixed reason.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_SERVICES_FILE_SEED_FEATURE, WORKER_INVOCATION_FEATURES } from "@agentx/contracts";
import { SEED_FILE_MAX_BYTES, SeedFileError, loadSeedFile, readSeedFile, seedFileLoadArgs } from "../../packages/worker/src/service-seed-file.js";
import { seedFileApplier } from "../../packages/worker/src/test-services-run.js";
import { SeedError, runSeeds } from "../../packages/worker/src/service-reset.js";

let root: string;
let outside: string;
const repo = () => join(root, "repo");
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "seed-file-root-"));
  outside = await mkdtemp(join(tmpdir(), "seed-file-outside-"));
  await mkdir(join(repo(), "db", "seeds"), { recursive: true });
  await writeFile(join(repo(), "db", "seeds", "users.sql"), "insert into users values (1);\n");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });

const read = (fixturePath: string, extra: { family?: string; hiddenPaths?: string[] } = {}) => readSeedFile({ rootPath: root, repositoryPaths: [repo()], hiddenPaths: extra.hiddenPaths ?? [], fixturePath, family: extra.family ?? "postgres" });
const reasonOf = async (promise: Promise<unknown>): Promise<string> => { try { await promise; return "loaded"; } catch (error) { return error instanceof SeedFileError ? error.reason : `other: ${String(error)}`; } };

describe("reading a seed file from the repository", () => {
  it("reads a SQL file inside a repository folder (positive control for every refusal below)", async () => {
    expect((await read("repo/db/seeds/users.sql")).toString("utf8")).toBe("insert into users values (1);\n");
  });
  it("refuses traversal and absolute paths, before touching the disk", async () => {
    await writeFile(join(outside, "x.sql"), "select 1;");
    expect(await reasonOf(read("repo/../../x.sql"))).toBe("outside");
    expect(await reasonOf(read(join(outside, "x.sql")))).toBe("outside");
  });
  it("refuses a symlink that points outside the repository, and a file outside any repository folder; a symlink inside it to a file inside it is fine", async () => {
    await writeFile(join(outside, "secret.sql"), "select 1;");
    await symlink(join(outside, "secret.sql"), join(repo(), "db", "seeds", "escape.sql"));
    expect(await reasonOf(read("repo/db/seeds/escape.sql"))).toBe("outside");
    await symlink(outside, join(repo(), "db", "linked"));
    expect(await reasonOf(read("repo/db/linked/secret.sql"))).toBe("outside");
    await writeFile(join(root, "loose.sql"), "select 1;");
    expect(await reasonOf(read("loose.sql"))).toBe("outside");
    await symlink(join(repo(), "db", "seeds", "users.sql"), join(repo(), "db", "seeds", "alias.sql"));
    expect((await read("repo/db/seeds/alias.sql")).length).toBeGreaterThan(0);
  });
  it("refuses a file under a hidden folder of the workspace", async () => {
    const hidden = join(repo(), ".rovara-state");
    await mkdir(hidden, { recursive: true });
    await writeFile(join(hidden, "seed.sql"), "select 1;");
    expect(await reasonOf(read("repo/.rovara-state/seed.sql", { hiddenPaths: [hidden] }))).toBe("outside");
  });
  it("refuses a file over the size cap, a missing file, a directory, another extension and a family whose client loads no file", async () => {
    await writeFile(join(repo(), "big.sql"), Buffer.alloc(SEED_FILE_MAX_BYTES + 1, 0x20));
    expect(await reasonOf(read("repo/big.sql"))).toBe("too_large");
    expect(await reasonOf(read("repo/missing.sql"))).toBe("not_a_file");
    await mkdir(join(repo(), "dir.sql"));
    expect(await reasonOf(read("repo/dir.sql"))).toBe("not_a_file");
    await writeFile(join(repo(), "seed.sh"), "rm -rf /");
    expect(await reasonOf(read("repo/seed.sh"))).toBe("unsupported");
    expect(await reasonOf(read("repo/db/seeds/users.sql", { family: "redis" }))).toBe("unsupported");
  });
});

describe("loading it with the database's own client", () => {
  const target = { container: "rovara-svc-run1-postgres", family: "postgres", user: "rovara", database: "app" };
  it("runs psql in the helper's container over its socket: no host, no port, no password; one transaction, stop at the first error; the bytes only on stdin", async () => {
    const args = seedFileLoadArgs(target);
    expect(args).toEqual(["exec", "-i", "rovara-svc-run1-postgres", "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-U", "rovara", "-d", "app", "-f", "-"]);
    expect(args.some((arg) => /^-h$|^--host|^-p$|^--port|PGPASSWORD|password/iu.test(arg))).toBe(false);
    const execBytes = vi.fn(async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: "" }));
    const bytes = Buffer.from("insert into users values (1);");
    await loadSeedFile({ execBytes }, target, bytes, new AbortController().signal);
    expect(execBytes).toHaveBeenCalledTimes(1);
    const [, options] = execBytes.mock.calls[0]! as unknown as [string[], { stdin: Buffer; timeoutMs: number }];
    expect(options.stdin).toBe(bytes);
    expect(options.timeoutMs).toBeGreaterThan(0);
  });
  it("a bad SQL file (psql exits non-zero) is a load failure; a timeout is a timeout; no byte-level client is refused", async () => {
    expect(await reasonOf(loadSeedFile({ execBytes: async () => ({ exitCode: 3, stdout: Buffer.alloc(0), stderr: "ERROR: syntax error at or near \"inssert\"" }) }, target, Buffer.from("inssert"), new AbortController().signal))).toBe("load_failed");
    expect(await reasonOf(loadSeedFile({ execBytes: async () => ({ exitCode: null, stdout: Buffer.alloc(0), stderr: "", timedOut: true }) }, target, Buffer.from("select 1"), new AbortController().signal))).toBe("timeout");
    expect(await reasonOf(loadSeedFile({}, target, Buffer.from("select 1"), new AbortController().signal))).toBe("unsupported");
  });
  it("refuses names that are not the launcher's plain ones (nothing a repository wrote reaches an argument)", () => {
    expect(() => seedFileLoadArgs({ ...target, database: "app; drop" })).toThrow(SeedFileError);
    expect(() => seedFileLoadArgs({ ...target, user: undefined })).toThrow(SeedFileError);
    expect(() => seedFileLoadArgs({ ...target, container: "--privileged" })).toThrow(SeedFileError);
    expect(() => seedFileLoadArgs({ ...target, family: "mysql" })).toThrow(SeedFileError);
  });
});

describe("the run's seed port", () => {
  const item = { plan: { id: "postgres", family: "postgres" }, request: { credentials: { user: "rovara", database: "app" } } } as never;
  it("loads the file into THIS phase's helper, and a failed load fails the seeds with the fixed sentence (the error text never travels)", async () => {
    const execBytes = vi.fn(async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: "" }));
    const log = vi.fn();
    const apply = seedFileApplier({ docker: { execBytes }, rootPath: root, repositoryPaths: [repo()], items: [item], helpers: [{ id: "postgres", container: "rovara-svc-r1-postgres" }], log });
    await runSeeds("postgres", [{ fixturePath: "repo/db/seeds/users.sql" }], { runCommand: async () => ({ exitCode: 0, timedOut: false }), applyFixture: apply }, new AbortController().signal);
    expect((execBytes.mock.calls[0]! as unknown as [string[]])[0]).toContain("rovara-svc-r1-postgres");
    const bad = seedFileApplier({ docker: { execBytes: async () => ({ exitCode: 3, stdout: Buffer.alloc(0), stderr: "ERROR: relation \"users\" does not exist" }) }, rootPath: root, repositoryPaths: [repo()], items: [item], helpers: [{ id: "postgres", container: "c1" }], log });
    const failed = await runSeeds("postgres", [{ fixturePath: "repo/db/seeds/users.sql" }], { runCommand: async () => ({ exitCode: 0, timedOut: false }), applyFixture: bad }, new AbortController().signal).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(SeedError);
    expect((failed as Error).message).toBe("A test service's seed did not complete");
    expect(log).toHaveBeenLastCalledWith({ event: "test-services.seed-file.refused", reason: "load_failed" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("relation");
    expect(JSON.stringify(log.mock.calls)).not.toContain("users.sql");
  });
  it("refuses a dependency this phase has no helper for", async () => {
    const apply = seedFileApplier({ docker: { execBytes: async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: "" }) }, rootPath: root, repositoryPaths: [repo()], items: [item], helpers: [] });
    expect(await reasonOf(apply("postgres", "repo/db/seeds/users.sql", new AbortController().signal))).toBe("unsupported");
  });
  it("is a worker feature the broker checks before it sends a plan with a file seed", () => {
    expect(TEST_SERVICES_FILE_SEED_FEATURE).toBe("task.testServices.fileSeed.v1");
    expect(WORKER_INVOCATION_FEATURES).toContain(TEST_SERVICES_FILE_SEED_FEATURE);
  });
});
