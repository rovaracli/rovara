// Facts about the EC2 worker image, read from its Dockerfile (the image itself is built only by the
// release workflow): what a repository's setup and test commands can count on.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { webApiProbeRunnerConfig } from "../../packages/verifier/src/install-qualification-cli.js";

const dockerfile = readFileSync("environments/base/Dockerfile", "utf8");
/** The final stage: everything after the last FROM line. */
const finalStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
const toolsStage = dockerfile.slice(dockerfile.indexOf(" AS tools"), dockerfile.lastIndexOf("\nFROM "));

describe("the worker image", () => {
  it("installs Python 3, pip and venv from Debian in the final stage", () => {
    const install = /apt-get install --yes --no-install-recommends ([^\n\\]+)/.exec(finalStage)?.[1] ?? "";
    for (const pkg of ["python3", "python3-pip", "python3-venv", "git", "openssh-client", "ca-certificates"]) {
      expect(install.split(/\s+/), pkg).toContain(pkg);
    }
    expect(finalStage).toContain("rm -rf /var/lib/apt/lists/*");
  });

  // TS-SEAL-5 (b): the sealed round's resolver guard runs `iptables-nft` from this image (packages/worker/src/check-sandbox.ts RESOLVER_GUARD_BINARY and RESOLVER_GUARD_STEPS).
  it("carries the iptables package, which provides the iptables-nft the sealed round's resolver guard runs by absolute path", () => {
    const install = /apt-get install --yes --no-install-recommends ([^\n\\]+)/.exec(finalStage)?.[1] ?? "";
    expect(install.split(/\s+/)).toContain("iptables");
    const guard = readFileSync("packages/worker/src/check-sandbox.ts", "utf8");
    expect(guard).toContain('export const RESOLVER_GUARD_BINARY = "/usr/sbin/iptables-nft";');
    expect(guard).toContain('insert: ["-w", "5", "-I", "OUTPUT", "1", "-d", `${EMBEDDED_RESOLVER_ADDRESS}/32`, "-j", "DROP"]');
  });

  // R56: a project without a devcontainer runs its commands in a container of this image.
  it("carries what the task sandbox needs: curl, git, python3, bash, a POSIX shell, and the node user (uid 1000) it runs as", () => {
    const install = /apt-get install --yes --no-install-recommends ([^\n\\]+)/.exec(finalStage)?.[1] ?? "";
    for (const pkg of ["curl", "git", "python3", "tini=0.19.0-1+b3"]) expect(install.split(/\s+/), pkg).toContain(pkg);
    // bash and /bin/sh (dash) come with Debian bookworm-slim, which the final stage is based on.
    expect(finalStage.slice(0, finalStage.indexOf("\n", 1))).toMatch(/node:22\.23\.2-bookworm-slim@sha256:/);
    expect(finalStage).toMatch(/\nUSER node\n/);
    const policyUser = readFileSync("packages/worker/src/task-sandbox.ts", "utf8").match(/TASK_SANDBOX_USER = "(\d+:\d+)"/)?.[1];
    expect(policyUser).toBe("1000:1000");
  });

  // R56 (Projects plan 2, Task 1): the file-tool helper is copied alone into a devcontainer, and tsc does not bundle, so it
  // may import only Node's own modules.
  it("ships a file-tool helper that imports nothing but node: modules, so it runs as one copied file", () => {
    const imports = (text: string) => [...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gu)].map((match) => match[1]!);
    const source = readFileSync("packages/worker/src/sandbox-file-ops.ts", "utf8");
    expect(imports(source).length).toBeGreaterThan(0);
    for (const specifier of imports(source)) expect(specifier, specifier).toMatch(/^node:/u);
    // Where a build exists (the image build, CI after tsc -b), the compiled file is checked too.
    const compiled = "packages/worker/dist/sandbox-file-ops.js";
    if (existsSync(compiled)) for (const specifier of imports(readFileSync(compiled, "utf8"))) expect(specifier, specifier).toMatch(/^node:/u);
    expect(dockerfile).toContain("COPY --from=build /opt/agentx/packages/worker ./packages/worker");
    const helper = readFileSync("packages/worker/src/task-sandbox.ts", "utf8").match(/SANDBOX_FILE_OPS_HELPER = "([^"]+)"/)?.[1];
    expect(helper).toBe("/opt/agentx/packages/worker/dist/sandbox-file-ops.js");
  });

  it("pins uv by version and by SHA-256 for each architecture, and verifies the download", () => {
    expect(toolsStage).toContain("ARG UV_VERSION=0.12.20");
    expect(toolsStage).toContain("uv_sha=8a7aad7bc76a2fae5151566ff3e43eacce0b2a113d5e4de3e4afe3e58fa2441e");
    expect(toolsStage).toContain("uv_sha=6590717592ace991ff83a63fef799e3ad9d33ecc8f96c5d6bdd732496e79337f");
    expect(toolsStage).toMatch(/arm64\) uv_arch=aarch64; uv_sha=8a7aad7bc76a2fae5151566ff3e43eacce0b2a113d5e4de3e4afe3e58fa2441e ;/);
    expect(toolsStage).toMatch(/amd64\) uv_arch=x86_64; uv_sha=6590717592ace991ff83a63fef799e3ad9d33ecc8f96c5d6bdd732496e79337f ;/);
    expect(toolsStage).toContain('https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$uv_arch-unknown-linux-gnu.tar.gz');
    expect(toolsStage).toMatch(/echo "\$uv_sha {2}\/tmp\/uv\.tgz" \| sha256sum -c -/);
  });

  it("carries an empty, root-owned, read-only git directory for each object format, made before the image drops to its user", () => {
    const user = finalStage.indexOf("\nUSER node");
    const block = finalStage.slice(finalStage.indexOf("for format in sha1 sha256"), finalStage.indexOf("\n\n", finalStage.indexOf("for format in sha1 sha256")));
    expect(finalStage.indexOf("/usr/share/agentx/empty-$format.git")).toBeGreaterThan(0);
    expect(finalStage.indexOf("/usr/share/agentx/empty-$format.git")).toBeLessThan(user);
    expect(block).toContain('git init --bare --quiet --template= "--object-format=$format"');
    expect(block).toContain("chown -R root:root /usr/share/agentx");
    expect(block).toContain("find /usr/share/agentx -type d -exec chmod 0555 {} +");
    expect(block).toContain("find /usr/share/agentx -type f -exec chmod 0444 {} +");
  });

  it("copies uv and uvx into the final stage", () => {
    expect(finalStage).toContain("COPY --from=tools /usr/local/bin/uv /usr/local/bin/uv");
    expect(finalStage).toContain("COPY --from=tools /usr/local/bin/uvx /usr/local/bin/uvx");
  });

  it("still pins the Docker CLI and Compose by checksum (characterization)", () => {
    expect(toolsStage).toMatch(/echo "\$docker_sha {2}\/tmp\/docker\.tgz" \| sha256sum -c -/);
    expect(toolsStage).toMatch(/echo "\$compose_sha {2}\/tmp\/docker-compose" \| sha256sum -c -/);
  });

  it("runs the worker under tini, a pinned Debian package, so orphaned command processes are reaped (#170)", () => {
    // Commands run in their own process group (#170); a grandchild they leave behind is reparented
    // to PID 1, which must reap it.
    const install = /apt-get install --yes --no-install-recommends ([^\n\\]+)/.exec(finalStage)?.[1] ?? "";
    expect(install.split(/\s+/)).toContain("tini=0.19.0-1+b3");
    expect(finalStage).toMatch(/\nENTRYPOINT \["\/usr\/bin\/tini", "--"\]\n/);
    expect(finalStage).toMatch(/\nCMD \["node", "packages\/worker\/dist\/main\.js"\]\n?$/);
    expect(finalStage.indexOf("ENTRYPOINT")).toBeLessThan(finalStage.indexOf("\nCMD "));
  });

  it("is started by the EC2 boot script without overriding its entrypoint (#170, characterization)", () => {
    // The unit and launcher are written by stage 2 of the boot, which ships in this image (Task 10).
    const boot = readFileSync("packages/worker/ec2/boot-stage2.sh", "utf8");
    const unit = boot.slice(boot.indexOf('cat >"/etc/systemd/system/$WORKER_UNIT" <<EOF'), boot.indexOf("EOF\n}", boot.indexOf('cat >"/etc/systemd/system/$WORKER_UNIT" <<EOF')));
    const launcher = /cat >\/usr\/local\/libexec\/agentx-worker-start <<'LAUNCHER'\n([\s\S]*?)\nLAUNCHER/.exec(boot)?.[1] ?? "";
    expect(unit).toContain("ExecStart=/usr/local/libexec/agentx-worker-start");
    expect(launcher).not.toBe("");
    expect(launcher).toContain('[[ "$worker_image" =~ ^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$ ]]');
    expect(launcher).toContain('args=(run --rm --name "$WORKER_CONTAINER" "${network_args[@]}" --env-file "$WORKER_ENV_FILE" --volume "$MOUNT_PATH:$MOUNT_PATH")');
    expect(launcher).not.toContain("--entrypoint");
    expect(launcher).not.toContain("--init");
    // The generated launcher uses the pinned image as the final docker run argument and leaves
    // its image ENTRYPOINT (tini) and CMD (the worker) in effect.
    expect(launcher).toMatch(/args\+=\([^\n]*"\$worker_image"\)\nexec "\$docker" "\$\{args\[@\]\}"/);
    expect(launcher.trimEnd().endsWith('exec "$docker" "${args[@]}"')).toBe(true);
  });

  it("runs as the node user", () => {
    expect(finalStage).toMatch(/\nUSER node\n/);
  });

  it("ships the exact Node, Docker CLI, runner package, and verifier needed by contained setup smoke", () => {
    expect(dockerfile).toContain("node:22.23.2-bookworm-slim@sha256:");
    expect(finalStage).toContain("COPY --from=tools /usr/local/bin/docker /usr/local/bin/docker");
    expect(finalStage).toContain("COPY --from=build /opt/agentx/node_modules ./node_modules");
    expect(finalStage).toContain("COPY --from=build /opt/agentx/package-lock.json ./package-lock.json");
    expect(finalStage).toContain("COPY --from=build /opt/agentx/packages/verifier ./packages/verifier");
    expect(dockerfile).toContain("COPY upstream/e2e-0.20.0.tgz upstream/e2e-0.20.0.tgz");
    expect(dockerfile).toContain("WORKDIR /opt/agentx");
  });

  it("hands the browser executor image to the processes that qualify the web/API runtime, and fails closed without it", () => {
    const boot = readFileSync("packages/worker/ec2/boot-stage2.sh", "utf8");
    // worker.env feeds the container, so docker exec --user node agentx-worker (the qualifier) sees EXECUTOR_IMAGE.
    expect(boot).toContain(`[[ -z "\${EXECUTOR_IMAGE:-}" ]] || printf 'EXECUTOR_IMAGE=%s\\n' "$EXECUTOR_IMAGE" >>"$WORKER_ENV_FILE"`);
    expect(boot).toContain('--env-file "$WORKER_ENV_FILE"');
    // The qualifier ships in the worker image, where the boot hook runs it.
    expect(finalStage).toContain("COPY --from=build /opt/agentx/packages/verifier ./packages/verifier");
    expect(boot).toContain("/opt/agentx/packages/verifier/dist/install-qualification-cli.js");
    // No executor image, no qualification: the runner configuration refuses rather than choosing an image itself.
    expect(() => webApiProbeRunnerConfig({}, "linux", "arm64")).toThrow(/EXECUTOR_IMAGE/);
    expect(() => webApiProbeRunnerConfig({ EXECUTOR_IMAGE: "" }, "linux", "arm64")).toThrow(/EXECUTOR_IMAGE/);
  });
});

// The environment detectors run in a thread started from packages/worker/dist/env-detect/detect-thread.js (guarded.ts). The image has no tsx (npm prune --omit=dev), so if that compiled file were missing the detectors would run
// unguarded. There is no Docker in CI for this test, so it follows the chain through the files: build context -> build stage compile -> final stage copy -> the path guarded.ts resolves.
describe("the worker image ships the detector thread", () => {
  const buildStage = dockerfile.slice(dockerfile.indexOf("AS build"), dockerfile.indexOf(" AS tools"));
  const THREAD_SOURCES = ["packages/worker/src/env-detect/detect-thread.ts", "packages/worker/src/env-detect/guarded.ts", "packages/worker/src/env-detect/index.ts", "packages/worker/src/worker-log.ts", "packages/worker/tsconfig.json", "packages/worker/package.json"];

  /** Docker's .dockerignore rules, for the patterns this repository uses: rooted, `*` and `?` stay inside one path part, `**` crosses parts, `!` re-includes, and an ignored directory ignores everything in it. */
  const ignoreRules = readFileSync(".dockerignore", "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
  const globToRegex = (pattern: string): RegExp => {
    const body = pattern.replace(/\/+$/u, "");
    let out = "";
    for (let index = 0; index < body.length; index += 1) {
      const char = body[index]!;
      if (char === "*" && body[index + 1] === "*") { out += body[index + 2] === "/" ? "(?:.*/)?" : ".*"; index += body[index + 2] === "/" ? 2 : 1; }
      else if (char === "*") out += "[^/]*";
      else if (char === "?") out += "[^/]";
      else out += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    }
    return new RegExp(`^${out}$`, "u");
  };
  const ignored = (path: string): boolean => {
    const parts = path.split("/");
    let result = false;
    for (const rule of ignoreRules) {
      const negate = rule.startsWith("!");
      const regex = globToRegex(negate ? rule.slice(1) : rule);
      // A pattern matches the path itself or any directory above it.
      if (parts.some((_, index) => regex.test(parts.slice(0, index + 1).join("/")))) result = !negate;
    }
    return result;
  };

  it("keeps the thread's sources in the build context, while host build output stays out of it (so the image must compile them)", () => {
    expect(ignored("packages/worker/dist/env-detect/detect-thread.js")).toBe(true);
    expect(ignored("packages/worker/node_modules/yaml/index.js")).toBe(true);
    for (const file of THREAD_SOURCES) {
      expect(existsSync(file), `${file} exists`).toBe(true);
      expect(ignored(file), `${file} is sent to the build`).toBe(false);
    }
    // The pattern list holds nothing that names the detectors or the worker's source.
    expect(ignoreRules.filter((rule) => /env-detect|detect-thread|packages\/worker|\bsrc\b/u.test(rule))).toEqual([]);
  });

  it("compiles packages/worker with tsc -b inside the build stage, from the sources copied into it, after the dependencies are installed", () => {
    const install = buildStage.indexOf("RUN npm ci");
    const copy = buildStage.indexOf("COPY packages/worker packages/worker\n");
    const compile = /RUN npx tsc -b ([^\n]*)packages\/worker\b[^\n]*/u.exec(buildStage);
    expect(install).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(install);
    expect(compile, "a tsc -b line that builds packages/worker").not.toBeNull();
    expect(buildStage.indexOf(compile![0])).toBeGreaterThan(copy);
  });

  it("takes packages/worker, with its compiled dist, from the build stage into the final stage, never from the host", () => {
    const copies = finalStage.split("\n").filter((line) => /^COPY\b/u.test(line) && line.includes("packages/worker"));
    expect(copies).toContain("COPY --from=build /opt/agentx/packages/worker ./packages/worker");
    // The only other copy of a worker file from the host is the read-only boot script; nothing copies a host dist over the compiled one. (The signed service catalog comes from the build stage, which copied its directory.)
    expect(copies.filter((line) => !line.includes("--from=build"))).toEqual(["COPY --chown=root:root --chmod=0444 packages/worker/ec2/boot-stage2.sh /opt/agentx/boot/stage2.sh"]);
    expect(finalStage.indexOf("COPY --from=build /opt/agentx/packages/worker ./packages/worker")).toBeGreaterThan(finalStage.indexOf("COPY --from=build /opt/agentx/node_modules ./node_modules"));
    // Dev dependencies are pruned in the build stage, so the image has no tsx: the thread must start from the compiled file.
    expect(buildStage).toContain("npm prune --omit=dev --workspaces");
  });

  it("compiles src/env-detect/detect-thread.ts to dist/env-detect/detect-thread.js, the file the build check and guarded.ts name", () => {
    const tsconfig = JSON.parse(readFileSync("packages/worker/tsconfig.json", "utf8")) as { compilerOptions: { rootDir: string; outDir: string }; include: string[]; exclude?: string[] };
    expect(tsconfig.include).toContain("src/**/*.ts");
    expect(tsconfig.exclude ?? []).toEqual([]);
    const { rootDir, outDir } = tsconfig.compilerOptions;
    const emitted = `${outDir}/${"src/env-detect/detect-thread.ts".slice(`${rootDir}/`.length).replace(/\.ts$/u, ".js")}`;
    expect(emitted).toBe("dist/env-detect/detect-thread.js");
    expect(readFileSync("scripts/worker-dist-files.ts", "utf8")).toContain(`packages/worker/${emitted}`);
    const base = JSON.parse(readFileSync("tsconfig.base.json", "utf8")) as { compilerOptions: { module?: string } };
    expect(base.compilerOptions.module ?? "").toMatch(/^(?:node16|nodenext|esnext|es20\d\d)$/iu);
  });

  it("starts the worker from dist/main.js, and guarded.ts looks for the thread beside its own compiled file", () => {
    expect(finalStage).toContain('CMD ["node", "packages/worker/dist/main.js"]');
    expect(finalStage).toMatch(/WORKDIR \/opt\/agentx\n/u);
    const guarded = readFileSync("packages/worker/src/env-detect/guarded.ts", "utf8");
    expect(guarded).toContain('new URL("./detect-thread.js", import.meta.url)');
    // The compiled file is preferred; the tsx source route is only for a checkout that has not been built.
    expect(guarded.indexOf("existsSync(fileURLToPath(compiled))")).toBeGreaterThan(-1);
    expect(guarded.indexOf("return { url: compiled, execArgv: [] }")).toBeLessThan(guarded.indexOf('execArgv: ["--import", "tsx"]'));
    // The environment draft (the only caller of the detectors) goes through the guard.
    expect(readFileSync("packages/worker/src/test-env-detect.ts", "utf8")).toContain('from "./env-detect/guarded.js"');
  });

  it("lists the thread's runtime dependency (yaml) as a production dependency of the worker, and relies on no dev tool", () => {
    const worker = JSON.parse(readFileSync("packages/worker/package.json", "utf8")) as { dependencies: Record<string, string>; devDependencies?: Record<string, string> };
    expect(worker.dependencies["yaml"]).toBeDefined();
    expect(Object.keys(worker.dependencies)).not.toContain("tsx");
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { packages: Record<string, { dependencies?: Record<string, string> }> };
    expect(lock.packages["packages/worker"]?.dependencies?.["yaml"]).toBe(worker.dependencies["yaml"]);
  });
});
