// Stdio MCP host redesign, task T3: the install task's program, run against a local https registry (a fixture served from 127.0.0.1). Real npm runs, with no network beyond this
// machine. Each case checks one thing the design promises: nothing fetched before the lockfile is checked, no install step ever runs, the bundle is exactly the approved bytes,
// and every failure is a fixed sentence.
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readBundleIndex, sha256File } from "../../packages/gateway/src/mcp-runner/bundle.js";
import { lockfileHash } from "../../packages/gateway/src/mcp-runner/lockfile-policy.js";
import {
  INSTALL_FAILURES, controllerUploader, defaultExec, main, runInstall, type Exec, type ExecInput, type InstallResult,
} from "../../packages/broker/src/mcp-runner/install-main.js";
import { startFixtureRegistry, type FixturePackage, type FixtureRegistry } from "../support/fixture-npm-registry.js";

let work: string;
let registry: FixtureRegistry;
let marker: string;

const NAME = "@acme/sim-mcp";
const sha512 = (text: string): string => `sha512-${createHash("sha512").update(text).digest("base64")}`;

function packages(): FixturePackage[] {
  const touch = `node -e "require('fs').writeFileSync('${marker}','ran')"`;
  return [
    { name: NAME, version: "1.4.2", bin: { "sim-mcp": "bin/sim.js" }, dependencies: { "dep-a": "^1.0.0" }, files: { "bin/sim.js": { content: "#!/usr/bin/env node\nconsole.log('sim')\n", mode: 0o755 }, "lib/x.js": "module.exports = 1\n" }, scripts: { postinstall: touch, prepare: touch }, devDependencies: { "dev-only": "1.0.0" } },
    { name: "dep-a", version: "1.0.0", dependencies: { "dep-b": "^1.0.0" }, files: { "index.js": "module.exports = 'a'\n" }, scripts: { postinstall: touch }, hasInstallScript: true },
    { name: "dep-b", version: "1.0.0", files: { "index.js": "module.exports = 'b'\n" } },
    { name: "dev-only", version: "1.0.0", files: { "index.js": "x" } },
    // a package whose own bin is missing
    { name: "no-bin", version: "1.0.0", files: { "index.js": "x" } },
    { name: "bin-escape", version: "1.0.0", bin: "../../escape.js", files: { "index.js": "x" } },
    { name: "bin-missing", version: "1.0.0", bin: "bin/missing.js", files: { "index.js": "x" } },
    // a registry that serves a different package from the one asked for
    { name: "liar", version: "1.0.0", tarballIdentity: { name: "someone-else", version: "9.9.9" }, bin: "i.js", files: { "i.js": "x" } },
    // a dependency written as a git address in package.json
    { name: "git-direct", version: "1.0.0", bin: "i.js", dependencies: { thing: "github:acme/thing#main" }, files: { "i.js": "x" } },
    { name: "git-shorthand", version: "1.0.0", bin: "i.js", dependencies: { thing: "acme/thing" }, files: { "i.js": "x" } },
    { name: "file-dep", version: "1.0.0", bin: "i.js", dependencies: { thing: "file:../thing" }, files: { "i.js": "x" } },
    // a dependency that is itself on the registry, but whose own dependency is a git address (found only when npm reads its metadata)
    { name: "git-transitive", version: "1.0.0", bin: "i.js", dependencies: { "has-git": "^1.0.0" }, files: { "i.js": "x" } },
    { name: "has-git", version: "1.0.0", dependencies: { thing: "git+https://github.com/acme/thing.git#abc" }, files: { "index.js": "x" } },
    // packages that ship a shrinkwrap
    { name: "shrunk", version: "1.0.0", bin: "i.js", dependencies: { "dep-b": "1.0.0" }, files: { "i.js": "x" }, shrinkwrap: (url, integrityOf) => ({
      name: "shrunk", version: "1.0.0", lockfileVersion: 3, requires: true,
      packages: { "": { name: "shrunk", version: "1.0.0", dependencies: { "dep-b": "1.0.0" } }, "node_modules/dep-b": { version: "1.0.0", resolved: `${url}dep-b/-/dep-b-1.0.0.tgz`, integrity: integrityOf("dep-b", "1.0.0") } },
    }) },
    { name: "shrink-git", version: "1.0.0", bin: "i.js", files: { "i.js": "x" }, shrinkwrap: { name: "shrink-git", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "shrink-git", version: "1.0.0" }, "node_modules/thing": { version: "1.0.0", resolved: "git+ssh://git@github.com/acme/thing.git#0123456789abcdef", integrity: sha512("x") } } } },
    { name: "shrink-sha1", version: "1.0.0", bin: "i.js", files: { "i.js": "x" }, shrinkwrap: (url) => ({ name: "shrink-sha1", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "shrink-sha1", version: "1.0.0" }, "node_modules/thing": { version: "1.0.0", resolved: `${url}thing/-/thing-1.0.0.tgz`, integrity: "sha1-qUHpFw1Pv//Lkz2Qx6hW8mQe0bU=" } } }) },
    { name: "shrink-foreign", version: "1.0.0", bin: "i.js", files: { "i.js": "x" }, shrinkwrap: { name: "shrink-foreign", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "shrink-foreign", version: "1.0.0" }, "node_modules/thing": { version: "1.0.0", resolved: "https://registry.npmjs.org/thing/-/thing-1.0.0.tgz", integrity: sha512("x") } } } },
    // a tarball that carries its own .npmrc
    { name: "with-npmrc", version: "1.0.0", bin: "i.js", files: { "i.js": "x", ".npmrc": "registry=https://evil.example/\nscript-shell=/bin/sh\nignore-scripts=false\n" } },
  ];
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "mcp-install-"));
  marker = join(work, "SCRIPT-RAN");
  registry = await startFixtureRegistry(join(work, "registry"), packages());
});
afterAll(async () => {
  await registry.close();
  await rm(work, { recursive: true, force: true });
});
beforeEach(() => { registry.requests.length = 0; });

let counter = 0;
async function install(request: unknown, over: { exec?: Exec; limits?: Parameters<typeof runInstall>[1]["limits"]; registry?: string } = {}): Promise<{ result: InstallResult; dir: string }> {
  const dir = join(work, `run-${(counter += 1)}`);
  await mkdir(dir, { recursive: true });
  const result = await runInstall(request, { registry: over.registry ?? registry.url, workDir: dir, caFile: registry.caFile, ...(over.exec === undefined ? {} : { exec: over.exec }), ...(over.limits === undefined ? {} : { limits: over.limits }) });
  return { result, dir };
}
const proposal = (name: string, version = "1.0.0", extra: Record<string, unknown> = {}) => ({ registry: "npm", name, version, args: [], ...extra });
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);
const failed = (result: InstallResult) => { if (result.ok) throw new Error("expected a failure"); return result; };

describe("T3 install: a package and its dependencies", () => {
  let first: { result: InstallResult; dir: string };
  beforeAll(async () => { first = await install(proposal(NAME, "1.4.2", { args: ["--read-only"] })); }, 120_000);

  it("installs the package and its dependencies from the registry, and reports the hashes the approval binds", async () => {
    expect(first.result.ok).toBe(true);
    if (!first.result.ok) return;
    const { report, bundlePath } = first.result;
    expect(report.integrity).toBe(registry.integrityOf(NAME, "1.4.2"));
    expect(report.bundleHash).toBe(await sha256File(bundlePath));
    expect(report.bundleHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.tarBytes).toBe((await stat(bundlePath)).size);
    expect(report.lockfileHash).toBe(lockfileHash(await readFile(join(first.dir, "pkg", "package-lock.json"))));
    expect(report.packageCount).toBe(3); // the package, dep-a, dep-b
    expect(report.bin).toBe("bin/sim.js");
    expect(report.unpackedBytes).toBeGreaterThan(0);
  });
  it("leaves a bundle that holds the package and its dependencies, with the program executable, and nothing of the install (no cache, no npmrc, no lock beside the check)", async () => {
    if (!first.result.ok) throw new Error("install failed");
    const index = await readBundleIndex(first.result.bundlePath);
    const paths = index.map((entry) => entry.path);
    expect(paths).toEqual(expect.arrayContaining(["package.json", "bin/sim.js", "lib/x.js", "node_modules/dep-a/index.js", "node_modules/dep-b/index.js"]));
    expect(index.find((entry) => entry.path === "bin/sim.js")).toMatchObject({ kind: "file", executable: true });
    expect(paths.some((path) => path.includes(".npmrc"))).toBe(false);
    expect(paths).not.toContain("node_modules/dev-only/index.js");
    expect(paths.some((path) => path.startsWith("node_modules/dev-only"))).toBe(false);
    expect(paths.every((path) => !path.startsWith("cache") && !path.startsWith("home"))).toBe(true);
  });
  it("lists the packages whose install steps were skipped, and never ran one (neither theirs nor the package's own postinstall or prepare)", async () => {
    if (!first.result.ok) throw new Error("install failed");
    expect(first.result.report.scriptsSkipped).toEqual(["dep-a"]);
    expect(await exists(marker)).toBe(false);
  });
  it("does not fetch the dev dependency at all", async () => {
    const { result } = await install(proposal(NAME, "1.4.2"));
    expect(result.ok).toBe(true);
    expect(registry.requests.some((path) => path.includes("dev-only"))).toBe(false);
    expect(registry.requests.some((path) => path.endsWith("dep-b-1.0.0.tgz"))).toBe(true);
  });
  it("gives the same bundle hash when the same package is installed again", async () => {
    const again = await install(proposal(NAME, "1.4.2"));
    if (!first.result.ok || !again.result.ok) throw new Error("install failed");
    expect(again.result.report.bundleHash).toBe(first.result.report.bundleHash);
    expect(again.result.report.lockfileHash).toBe(first.result.report.lockfileHash);
  });
});

describe("T3 install: the integrity the admin typed", () => {
  it("accepts a typed integrity that equals the tarball's", async () => {
    expect((await install(proposal(NAME, "1.4.2", { integrity: registry.integrityOf(NAME, "1.4.2") }))).result.ok).toBe(true);
  });
  it("refuses a different one and shows the computed one, before unpacking or fetching anything else", async () => {
    const wrong = `sha512-${"A".repeat(86)}==`;
    const { result, dir } = await install(proposal(NAME, "1.4.2", { integrity: wrong }));
    expect(failed(result)).toMatchObject({ code: "integrity_mismatch", sentence: INSTALL_FAILURES.integrity_mismatch, computedIntegrity: registry.integrityOf(NAME, "1.4.2") });
    expect(await exists(join(dir, "pkg"))).toBe(false);
    expect(registry.requests.some((path) => path.includes("dep-a"))).toBe(false);
  });
});

describe("T3 install: dependencies that do not come from the registry are refused before anything is fetched", () => {
  it("refuses a git address in package.json, naming git, with no lockfile made and no dependency fetched", async () => {
    for (const name of ["git-direct", "git-shorthand", "file-dep"]) {
      registry.requests.length = 0;
      const { result, dir } = await install(proposal(name));
      expect(failed(result).code, name).toBe("git_dependency");
      expect(await exists(join(dir, "pkg", "package-lock.json")), name).toBe(false);
      expect(await exists(join(dir, "pkg", "node_modules")), name).toBe(false);
      expect(registry.requests.every((path) => path === `/${name}` || path === `/${name}/-/${name}-1.0.0.tgz`), name).toBe(true);
    }
  });
  it("refuses a git dependency that only a dependency's own metadata reveals, with no `npm ci` run and the sentence naming git", async () => {
    const { result, dir } = await install(proposal("git-transitive"));
    expect(failed(result)).toMatchObject({ code: "git_dependency", sentence: INSTALL_FAILURES.git_dependency });
    expect(await exists(join(dir, "pkg", "node_modules"))).toBe(false);
  });
  it("refuses a shipped shrinkwrap with a git address, an sha1 checksum or a foreign host, by the lockfile rules, before `npm ci`", async () => {
    const cases: Array<[string, string]> = [["shrink-git", "registry_only"], ["shrink-sha1", "integrity"], ["shrink-foreign", "registry_only"]];
    for (const [name, rule] of cases) {
      registry.requests.length = 0;
      const { result, dir } = await install(proposal(name));
      expect(failed(result), name).toMatchObject({ code: "lockfile_policy", rule, package: "thing" });
      expect(failed(result).sentence.length, name).toBeGreaterThan(20);
      expect(await exists(join(dir, "pkg", "node_modules")), name).toBe(false);
      expect(registry.requests.every((path) => path === `/${name}` || path === `/${name}/-/${name}-1.0.0.tgz`), name).toBe(true);
    }
  });
  it("uses a clean shipped shrinkwrap as the lockfile, and hashes exactly its bytes", async () => {
    const { result, dir } = await install(proposal("shrunk"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.lockfileHash).toBe(lockfileHash(await readFile(join(dir, "pkg", "npm-shrinkwrap.json"))));
    expect(await exists(join(dir, "pkg", "package-lock.json"))).toBe(false);
    expect(result.report.packageCount).toBe(2);
  });
  it("applies the package-count limit to the lockfile before installing", async () => {
    const { result, dir } = await install(proposal(NAME, "1.4.2"), { limits: { maxPackages: 1 } });
    expect(failed(result)).toMatchObject({ code: "lockfile_policy", rule: "bounds" });
    expect(await exists(join(dir, "pkg", "node_modules"))).toBe(false);
  });
});

describe("T3 install: the rest of the failures are fixed sentences", () => {
  it("refuses a request that is not a package at an exact version, or a registry that is not https", async () => {
    for (const request of [{}, proposal("x", "^1.0.0"), proposal("x", "latest"), proposal("../../x"), { ...proposal("x"), bundleHash: "a".repeat(64) }, null, "x"]) expect(failed((await install(request)).result).code).toBe("invalid_request");
    expect(failed((await install(proposal(NAME, "1.4.2"), { registry: "http://127.0.0.1:1/" })).result).code).toBe("invalid_request");
    expect(failed((await install(proposal(NAME, "1.4.2"), { registry: "https://user:pw@127.0.0.1:1/" })).result).code).toBe("invalid_request");
  });
  it("says the registry does not have a package or version it does not have", async () => {
    expect(failed((await install(proposal("nonexistent-pkg"))).result)).toMatchObject({ code: "not_found", sentence: INSTALL_FAILURES.not_found });
    expect(failed((await install(proposal(NAME, "9.9.9"))).result).code).toBe("not_found");
  });
  it("refuses a tarball that is another package from the one asked for", async () => {
    expect(failed((await install(proposal("liar"))).result).code).toBe("wrong_package");
  });
  it("refuses a package with no program, or one that points outside the package or at a file that is not there", async () => {
    for (const name of ["no-bin", "bin-escape", "bin-missing"]) expect(failed((await install(proposal(name))).result).code, name).toBe("no_program");
  });
  it("does not let a tarball's own .npmrc change the install", async () => {
    const { result, dir } = await install(proposal("with-npmrc"));
    expect(result.ok).toBe(true);
    expect(await exists(join(dir, "pkg", ".npmrc"))).toBe(false);
    expect(registry.requests.some((path) => path.includes("evil"))).toBe(false);
  });
  it("checks what `npm ci` really installed against the same rules (npm's own record of the tree), and refuses a tree that is not what the lockfile said", async () => {
    // A wrapper lets `npm ci` run and then rewrites the record it leaves, as if a dependency had come from somewhere else.
    const tamper: Exec = async (input) => {
      const output = await defaultExec(input);
      if (input.args[1] === "ci") {
        const path = join(input.cwd, "node_modules", ".package-lock.json");
        const lock = JSON.parse(await readFile(path, "utf8")) as { packages: Record<string, Record<string, unknown>> };
        lock.packages["node_modules/dep-b"]!.resolved = "git+ssh://git@github.com/acme/dep-b.git#abc";
        await writeFile(path, JSON.stringify(lock));
      }
      return output;
    };
    const { result } = await install(proposal(NAME, "1.4.2"), { exec: tamper });
    expect(failed(result)).toMatchObject({ code: "lockfile_policy", rule: "registry_only", package: "dep-b" });
    const lost: Exec = async (input) => {
      const output = await defaultExec(input);
      if (input.args[1] === "ci") await rm(join(input.cwd, "node_modules", ".package-lock.json"), { force: true });
      return output;
    };
    expect(failed((await install(proposal(NAME, "1.4.2"), { exec: lost })).result).code).toBe("install_failed");
  });
  it("stops at the time limit", async () => {
    expect(failed((await install(proposal(NAME, "1.4.2"), { limits: { timeoutMs: 1 } })).result).code).toBe("timed_out");
    const slow: Exec = (input) => new Promise((resolve) => { setTimeout(() => resolve({ code: 0, timedOut: true, stdout: "", stderr: "" }), 5); void input; });
    expect(failed((await install(proposal(NAME, "1.4.2"), { exec: slow })).result).code).toBe("timed_out");
  });
  it("never shows npm's own text: a failure carries only a fixed code and sentence", async () => {
    const noisy: Exec = async () => ({ code: 1, timedOut: false, stdout: "", stderr: "npm error at https://user:SECRET-TOKEN@registry.example/ /home/someone/.npmrc" });
    const result = failed((await install(proposal(NAME, "1.4.2"), { exec: noisy })).result);
    expect(JSON.stringify(result)).not.toMatch(/SECRET-TOKEN|someone|registry\.example/u);
    expect(result.sentence).toBe(INSTALL_FAILURES.download_failed);
  });
});

describe("T3 install: what npm is given", () => {
  it("runs every npm call with scripts off, git unreachable, the install's registry and an environment built from nothing (no variable of the parent's)", async () => {
    const seen: ExecInput[] = [];
    const recording: Exec = (input) => { seen.push(input); return defaultExec(input); };
    process.env.ROVARA_TEST_SECRET = "must-not-leak";
    process.env.AWS_ACCESS_KEY_ID = "AKIAFAKEFAKEFAKEFAKE";
    process.env.npm_config_registry = "https://registry.npmjs.org/";
    try {
      const { result } = await install(proposal(NAME, "1.4.2"), { exec: recording });
      expect(result.ok).toBe(true);
    } finally {
      delete process.env.ROVARA_TEST_SECRET;
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.npm_config_registry;
    }
    expect(seen.map((input) => input.args[1])).toEqual(["pack", "install", "ci"]);
    for (const input of seen) {
      expect(input.env.npm_config_ignore_scripts).toBe("true");
      expect(input.env.npm_config_git).toBe("/nonexistent/git");
      expect(input.env.npm_config_registry).toBe(registry.url);
      expect(input.env.npm_config_userconfig).toMatch(/empty-user-npmrc$/u);
      expect(input.env.npm_config_globalconfig).toMatch(/empty-global-npmrc$/u);
      expect(Object.keys(input.env).filter((key) => !key.startsWith("npm_config_")).sort()).toEqual(["HOME", "NODE_ENV", "PATH", "TMPDIR"]);
      expect(JSON.stringify(input.env)).not.toMatch(/must-not-leak|AKIAFAKE/u);
      expect(input.args).toContain("--ignore-scripts");
    }
    expect(seen[2]!.args).toEqual(expect.arrayContaining(["--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"]));
    expect(seen[1]!.args).toEqual(expect.arrayContaining(["--package-lock-only", "--ignore-scripts", "--omit=dev"]));
  });
});

describe("T3 install: handing the bundle to the controller", () => {
  let received: { method?: string | undefined; url?: string | undefined; auth?: string | undefined; body: Buffer } | undefined;
  let status = 200;
  const controller = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => { received = { method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks) }; res.writeHead(status); res.end(); });
  });
  let controllerUrl = "";
  beforeAll(async () => { await new Promise<void>((resolve) => controller.listen(0, "127.0.0.1", resolve)); controllerUrl = `http://127.0.0.1:${(controller.address() as AddressInfo).port}/`; });
  afterAll(() => { controller.close(); controller.closeAllConnections(); });
  afterEach(() => { received = undefined; status = 200; });

  const env = (over: Record<string, string | undefined> = {}) => ({
    MCP_INSTALL_REQUEST: JSON.stringify(proposal(NAME, "1.4.2")), ROVARA_MCP_NPM_REGISTRY: registry.url, ROVARA_MCP_NPM_CAFILE: registry.caFile, MCP_CONTROLLER_URL: controllerUrl,
    MCP_RUNNER_TOKEN: "t".repeat(40), MCP_INSTALL_WORKDIR: "", ...over,
  });

  it("PUTs the tar to /bundles/<its hash> with the task's token, and prints one result line that holds no token", async () => {
    const lines: string[] = [];
    const dir = join(work, `main-${(counter += 1)}`);
    await mkdir(dir, { recursive: true });
    const code = await main({ env: env({ MCP_INSTALL_WORKDIR: dir }), getuid: () => 10_002, write: (line) => lines.push(line) });
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    const report = JSON.parse(lines[0]!.replace("ROVARA_MCP_INSTALL_RESULT ", "")) as { ok: boolean; bundleHash: string; lockfileHash: string; scriptsSkipped: string[] };
    expect(report).toMatchObject({ ok: true, scriptsSkipped: ["dep-a"] });
    expect(received).toMatchObject({ method: "PUT", url: `/bundles/${report.bundleHash}`, auth: `Bearer ${"t".repeat(40)}` });
    expect(createHash("sha256").update(received!.body).digest("hex")).toBe(report.bundleHash);
    expect(lines.join("\n")).not.toContain("t".repeat(40));
  });
  it("reports upload_failed, and not success, when the controller refuses or cannot be reached", async () => {
    for (const refuse of [500, 401]) {
      status = refuse;
      const lines: string[] = [];
      const dir = join(work, `main-${(counter += 1)}`);
      await mkdir(dir, { recursive: true });
      expect(await main({ env: env({ MCP_INSTALL_WORKDIR: dir }), getuid: () => 10_002, write: (line) => lines.push(line) })).toBe(1);
      expect(lines[0]).toContain('"code":"upload_failed"');
      expect(lines[0]).not.toContain('"ok":true');
    }
    const lines: string[] = [];
    const dir = join(work, `main-${(counter += 1)}`);
    await mkdir(dir, { recursive: true });
    expect(await main({ env: env({ MCP_INSTALL_WORKDIR: dir, MCP_CONTROLLER_URL: "http://127.0.0.1:1/" }), getuid: () => 10_002, write: (line) => lines.push(line) })).toBe(1);
    expect(lines[0]).toContain("upload_failed");
  });
  it("uploads nothing for an install that failed, and prints the failure", async () => {
    const lines: string[] = [];
    const dir = join(work, `main-${(counter += 1)}`);
    await mkdir(dir, { recursive: true });
    const code = await main({ env: env({ MCP_INSTALL_WORKDIR: dir, MCP_INSTALL_REQUEST: JSON.stringify(proposal("git-direct")) }), getuid: () => 10_002, write: (line) => lines.push(line) });
    expect(code).toBe(1);
    expect(received).toBeUndefined();
    expect(lines[0]).toContain('"code":"git_dependency"');
  });
  it("refuses to run as root, and says nothing was started", async () => {
    const lines: string[] = [];
    await expect(main({ env: env(), getuid: () => 0, write: (line) => lines.push(line) })).rejects.toThrow("must not run as root");
    expect(lines).toEqual([]);
    expect(received).toBeUndefined();
  });
  it("reads no token from, and passes none on in, its environment: the token is removed once read", async () => {
    const environment = env({ MCP_INSTALL_REQUEST: "not json" });
    const lines: string[] = [];
    expect(await main({ env: environment, getuid: () => 10_002, write: (line) => lines.push(line) })).toBe(1);
    expect(environment.MCP_RUNNER_TOKEN).toBeUndefined();
    expect(lines[0]).toContain('"code":"invalid_request"');
  });
  it("sends the controller token only over https, or to this machine's own loopback", () => {
    expect(() => controllerUploader({ url: "http://controller.internal:8080/", token: "x".repeat(40) })).toThrow();
    expect(() => controllerUploader({ url: "https://user:pw@controller.internal/", token: "x".repeat(40) })).toThrow();
    expect(() => controllerUploader({ url: "not a url", token: "x".repeat(40) })).toThrow();
    expect(() => controllerUploader({ url: "https://controller.internal:8080/", token: "x".repeat(40) })).not.toThrow();
    expect(() => controllerUploader({ url: "http://127.0.0.1:8080/", token: "x".repeat(40) })).not.toThrow();
  });
});
