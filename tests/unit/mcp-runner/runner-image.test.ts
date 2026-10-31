// Stdio MCP host redesign, task T5: the runner image. Docker is not run here (the Linux CI job `mcp-runner-linux`, T11, builds the image and runs check-image.sh against it).
// What is checked here is everything that can be checked without a container: the Dockerfile's shape, that the three bundled programs build and RUN on their own with no
// node_modules around them, and that check-image.sh passes a clean image listing and fails each bad one (against a fake `docker`).
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeBundle } from "../../../packages/gateway/src/mcp-runner/bundle.js";

const dockerfile = await readFile("environments/mcp-runner/Dockerfile", "utf8");
const NODE_IMAGE = "public.ecr.aws/docker/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5";
const TOKEN = "t".repeat(40);

describe("T5 runner Dockerfile", () => {
  it("builds from the one pinned node image and from nothing else but scratch", () => {
    const froms = dockerfile.match(/^FROM\s.*$/gimu) ?? [];
    expect(froms).toHaveLength(3);
    for (const from of froms) expect(from === "FROM scratch" || from.startsWith(`FROM ${NODE_IMAGE} AS `), from).toBe(true);
  });
  it("ends in an image with no root user, no shell, and the three programs", () => {
    const last = dockerfile.slice(dockerfile.lastIndexOf("FROM scratch"));
    expect(last).toContain("USER 10003:10003");
    expect(last).not.toMatch(/USER\s+(root|0)\b/u);
    expect(last).toContain('CMD ["/usr/local/bin/node", "/opt/mcp-runner/serve.mjs"]');
    expect(dockerfile).not.toMatch(/apt-get install[^\n]*\bgit\b/u);
    for (const program of ["setpriv", "prlimit", "/usr/local/bin/node"]) expect(dockerfile).toContain(program);
    expect(dockerfile).toContain("--ignore-scripts");
  });
  it("makes the build fail if the assembled root holds a setuid file, a shell, git, or does not run", () => {
    expect(dockerfile).toContain('test -z "$(find "$root" -xdev -perm /6000)"');
    expect(dockerfile).toMatch(/for banned in git sh bash dash busybox apt apt-get dpkg curl wget/u);
    expect(dockerfile).toContain('chroot "$root" /usr/local/bin/node --version');
    expect(dockerfile).toContain("chroot \"$root\" /usr/bin/setpriv --no-new-privs --inh-caps=-all --bounding-set=-all -- /usr/bin/prlimit");
  });
  it("strips setuid and setgid bits as it assembles", () => {
    expect(dockerfile).toContain("-perm /6000 -exec chmod ug-s {} +");
  });
  it("owns the bundle and work folders by the fetch user and the home by the server user", () => {
    expect(dockerfile).toContain('chown 10002:10002 "$root/bundle" "$root/work"');
    expect(dockerfile).toContain('chown 10003:10003 "$root/home/server"');
  });
});

// ---------------------------------------------------------------------------------------------
// The bundled programs
// ---------------------------------------------------------------------------------------------

let out: string;
beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "runner-image-"));
  for (const [source, name] of [["serve-main", "serve"], ["fetch-main", "fetch"], ["install-main", "install"]] as const) {
    await build({
      entryPoints: [resolve(`packages/broker/src/mcp-runner/${source}.ts`)], bundle: true, platform: "node", target: "node22", format: "esm", legalComments: "none", outfile: join(out, "bin", `${name}.mjs`),
      banner: { js: "import { createRequire as __rovaraCreateRequire } from 'node:module'; const require = __rovaraCreateRequire(import.meta.url);" }, logLevel: "silent",
    });
  }
}, 120_000);
afterAll(async () => { await rm(out, { recursive: true, force: true }); });

const run = (file: string, args: string[], env: Record<string, string>, cwd = out): Promise<{ code: number | null; stdout: string; stderr: string }> => new Promise((done) => {
  execFile(process.execPath, [file, ...args], { env, cwd, timeout: 30_000 }, (error, stdout, stderr) => done({ code: error === null ? 0 : (error as { code?: number }).code ?? 1, stdout, stderr }));
});

describe("T5 the bundled programs run on their own", () => {
  it("holds no reference to node_modules, and the three files are the whole program", async () => {
    expect((await readdir(join(out, "bin"))).sort()).toEqual(["fetch.mjs", "install.mjs", "serve.mjs"]);
    for (const name of ["fetch", "install", "serve"]) {
      const text = await readFile(join(out, "bin", `${name}.mjs`), "utf8");
      // no import of a package by name (only node: built-ins are imported), and nothing of the AWS SDK
      expect(text.match(/^import\s[^\n]*\sfrom\s+["'](?!node:)[^"']+["']/gmu) ?? [], name).toEqual([]);
      expect(text, name).not.toMatch(/@aws-sdk/u);
    }
  });
  it("refuses at once, with a fixed line, when it has no settings", async () => {
    const fetched = await run(join(out, "bin", "fetch.mjs"), [], {});
    expect(fetched.code).toBe(1);
    expect(JSON.parse(fetched.stdout.trim())).toEqual({ component: "mcp-fetch", ok: false, code: "bad_request" });
    const installed = await run(join(out, "bin", "install.mjs"), [], {});
    expect(installed.code).toBe(1);
    expect(installed.stdout).toContain('"code":"invalid_request"');
    const served = await run(join(out, "bin", "serve.mjs"), [], {});
    expect(served.code).toBe(1);
    expect(served.stdout).toContain("bridge.start_failed");
  });

  it("fetches a bundle and serves it, from a folder that has no node_modules, through stub setpriv and prlimit", async () => {
    // The package the bundle holds: its program imports the test fixture (which finds the MCP SDK in this repository's node_modules).
    const tree = join(out, "src-tree");
    await mkdir(join(tree, "bin"), { recursive: true });
    await writeFile(join(tree, "package.json"), JSON.stringify({ name: "@acme/sim-mcp", version: "1.0.0", bin: "bin/server.mjs" }));
    await writeFile(join(tree, "bin", "server.mjs"), `import ${JSON.stringify(resolve("tests/support/stdio-runner-fixture.mjs"))};\n`);
    const tar = join(out, "bundle.tar");
    const { bundleHash } = await writeBundle(tree, tar);
    const bytes = await readFile(tar);
    const controller = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${TOKEN}` || req.url !== `/bundles/${bundleHash}`) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-length": bytes.length });
      res.end(bytes);
    });
    await new Promise<void>((done) => controller.listen(0, "127.0.0.1", done));
    try {
      const volume = join(out, "volume");
      for (const folder of ["", "home", "tmp"]) await mkdir(join(volume, folder === "" ? "" : `../${folder}`), { recursive: true });
      const controllerUrl = `http://127.0.0.1:${(controller.address() as AddressInfo).port}/`;
      const fetched = await run(join(out, "bin", "fetch.mjs"), [], { MCP_CONTROLLER_URL: controllerUrl, MCP_RUNNER_TOKEN: TOKEN, MCP_BUNDLE_HASH: bundleHash, MCP_BUNDLE_DIR: volume });
      expect(fetched.code).toBe(0);
      expect(fetched.stdout.trim()).toBe(JSON.stringify({ component: "mcp-fetch", ok: true }));
      expect((await readdir(volume)).sort()).toEqual(["tree", "verified.json"]);

      // serve: stub setpriv and prlimit (macOS has neither), then ask the bridge for its tools
      const stub = (): string => '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n';
      await writeFile(join(out, "setpriv"), stub());
      await writeFile(join(out, "prlimit"), stub());
      await chmod(join(out, "setpriv"), 0o755);
      await chmod(join(out, "prlimit"), 0o755);
      const probe = createServer();
      await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
      const port = (probe.address() as AddressInfo).port;
      await new Promise<void>((done) => probe.close(() => done()));
      const { spawn } = await import("node:child_process");
      const server = spawn(process.execPath, [join(out, "bin", "serve.mjs")], {
        cwd: out, stdio: ["ignore", "pipe", "pipe"],
        env: { MCP_RUNNER_TOKEN: TOKEN, MCP_BUNDLE_HASH: bundleHash, MCP_PACKAGE_NAME: "@acme/sim-mcp", MCP_SERVER_ARGS: "[]", MCP_SECRET_ENV: "[]", MCP_MEMORY_MIB: "512", PORT: String(port), MCP_BUNDLE_DIR: volume, MCP_HOME_DIR: join(out, "home"), MCP_TMP_DIR: join(out, "tmp"), MCP_SETPRIV: join(out, "setpriv"), MCP_PRLIMIT: join(out, "prlimit"), MCP_NODE: process.execPath },
      });
      try {
        let ready = false;
        for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
          ready = await fetch(`http://127.0.0.1:${port}/ready`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.status === 200, () => false);
          if (!ready) await new Promise((wait) => setTimeout(wait, 100));
        }
        expect(ready).toBe(true);
        const reply = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
        const body = await reply.json() as { result: { tools: Array<{ name: string }> } };
        expect(body.result.tools.map((tool) => tool.name)).toContain("echo");
      } finally { server.kill("SIGKILL"); }
    } finally { controller.close(); controller.closeAllConnections(); }
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// check-image.sh, against a fake docker
// ---------------------------------------------------------------------------------------------

describe("T5 check-image.sh", () => {
  const MUST_HAVE = ["usr/local/bin/node", "usr/bin/setpriv", "usr/bin/prlimit", "opt/mcp-runner/serve.mjs", "opt/mcp-runner/fetch.mjs", "opt/mcp-runner/install.mjs", "etc/ssl/certs/ca-certificates.crt", "usr/local/lib/node_modules/npm/bin/npm-cli.js"];

  /** A fake docker whose `export` is a tar of `root`. */
  async function fakeDocker(root: string, user = "10003:10003", cmd = '["/usr/local/bin/node"]', runOk = true): Promise<string> {
    const bin = join(root, "..", `fakebin-${Math.random().toString(36).slice(2)}`);
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "docker"), `#!/bin/sh
case "$1" in
  create) echo fakecid ;;
  export) tar -cf - -C ${JSON.stringify(root)} . ;;
  inspect) case "$*" in *Config.User*) echo ${JSON.stringify(user)} ;; *Config.Cmd*) echo '${cmd}' ;; esac ;;
  run) ${runOk ? "exit 0" : "exit 1"} ;;
  rm) exit 0 ;;
esac
`);
    await chmod(join(bin, "docker"), 0o755);
    return bin;
  }
  async function image(files: string[], extra: (root: string) => Promise<void> = async () => undefined): Promise<string> {
    const root = await mkdtemp(join(out, "root-"));
    for (const file of files) { await mkdir(join(root, file, ".."), { recursive: true }); await writeFile(join(root, file), "x"); await chmod(join(root, file), 0o755); }
    await extra(root);
    return root;
  }
  const check = (bin: string, extraEnv: Record<string, string> = {}) => new Promise<{ code: number; stdout: string }>((done) => {
    execFile("sh", [resolve("environments/mcp-runner/check-image.sh"), "img"], { env: { PATH: `${bin}:${process.env.PATH ?? ""}`, ...extraEnv } }, (error, stdout) => done({ code: error === null ? 0 : (error as { code?: number }).code ?? 1, stdout }));
  });

  it("passes a clean image", async () => {
    const result = await check(await fakeDocker(await image(MUST_HAVE)));
    expect(result.stdout).not.toContain("FAIL");
    expect(result.code).toBe(0);
  });
  it("fails an image with a setuid file, and one with a setgid file", async () => {
    for (const mode of [0o4755, 0o2755]) {
      const root = await image(MUST_HAVE, async (r) => { await writeFile(join(r, "usr", "bin", "su"), "x"); await chmod(join(r, "usr", "bin", "su"), mode); });
      const result = await check(await fakeDocker(root));
      expect(result.code, mode.toString(8)).toBe(1);
      expect(result.stdout).toContain("setuid or setgid");
    }
  });
  it("fails an image with git, a shell or another banned program, by file or by link", async () => {
    for (const banned of ["git", "sh", "bash", "dash", "busybox", "apt-get", "curl"]) {
      const root = await image(MUST_HAVE, async (r) => { await writeFile(join(r, "usr", "bin", banned), "x"); });
      const result = await check(await fakeDocker(root));
      expect(result.code, banned).toBe(1);
      expect(result.stdout).toContain(`${banned} is in the image`);
    }
    const linked = await image(MUST_HAVE, async (r) => { await symlink("node", join(r, "usr", "local", "bin", "sh")); });
    expect((await check(await fakeDocker(linked))).code).toBe(1);
  });
  it("does not mistake a program that merely has a banned name inside its name, or a link TO a banned name", async () => {
    const root = await image([...MUST_HAVE, "usr/lib/git-core-docs.txt", "usr/lib/shell.js"], async (r) => { await symlink("../local/bin/node", join(r, "usr", "bin", "nodelink")); await mkdir(join(r, "usr", "lib", "x")); await symlink("sh", join(r, "usr", "lib", "x", "points-at-sh")); });
    const result = await check(await fakeDocker(root));
    expect(result.stdout).not.toContain("FAIL");
    expect(result.code).toBe(0);
  });
  it("fails an image that is missing a program it must have", async () => {
    for (const missing of MUST_HAVE) {
      const result = await check(await fakeDocker(await image(MUST_HAVE.filter((file) => file !== missing))));
      expect(result.code, missing).toBe(1);
      expect(result.stdout).toContain(`missing ${missing}`);
    }
  });
  it("fails an image whose user is root, another user or unset, or that has no command", async () => {
    const root = await image(MUST_HAVE);
    for (const user of ["", "root", "0", "10003", "10001:10001"]) expect((await check(await fakeDocker(root, user))).code, user).toBe(1);
    expect((await check(await fakeDocker(root, "10003:10003", "null"))).code).toBe(1);
  });
  it("fails when the image does not run the way ECS runs it, and can skip that step on a machine that cannot run containers", async () => {
    const root = await image(MUST_HAVE);
    expect((await check(await fakeDocker(root, "10003:10003", '["x"]', false))).code).toBe(1);
    expect((await check(await fakeDocker(root, "10003:10003", '["x"]', false), { CHECK_IMAGE_SKIP_RUN: "1" })).code).toBe(0);
  });
});
void cp;
