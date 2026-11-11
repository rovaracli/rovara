// Setup draft quality: the services list holds only hosts the tests could reach (no private, metadata, documentation or badge hosts), a command the draft lists twice under two spellings is listed once, and the files that say
// how a repository is built and run are read first and always fit the read budget.
import { describe, expect, it } from "vitest";
import type { SetupDraft } from "@rovara-code/contracts";
import { ENV_DETECT_MAX_FILE_BYTES, ENV_DETECT_MAX_TOTAL_BYTES, ENV_DETECT_RESERVED_BYTES, boundedReader, buildEnvironmentDraft, proposalFromDraft, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import { commandWords, sameCommandLine } from "../../packages/worker/src/env-detect/command-alias.js";
import { importantFirst, isImportantPath } from "../../packages/worker/src/env-detect/read-priority.js";
import { followsLinkKey, isDependencyHost, isNonServiceAddress } from "../../packages/worker/src/env-detect/service-hosts.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return { detection: await runDetectors(bounded.reader, "svc"), bounded };
}
const hosts = (detection: Awaited<ReturnType<typeof detect>>["detection"]): string[] => detection.services.map((service) => service.value.target).sort();
const cmd = (executable: string, ...args: string[]) => ({ executable, args });

describe("services not set up yet", () => {
  it("drops private, link-local and cloud-metadata addresses and keeps public ones", async () => {
    const { detection } = await detect({
      "config/app.yaml": [
        "internal: http://10.0.0.5:8080/api", "metadata: http://169.254.169.254/latest/meta-data/", "other_metadata: http://169.254.170.2/v2/credentials", "private172: http://172.16.4.2/x", "private192: https://192.168.1.10/x",
        "loopback: http://127.0.0.1:9000", "shared: http://100.64.0.9/x", "public: https://52.4.3.2/v1", "edge: http://172.32.0.1/x",
      ].join("\n"),
    });
    expect(hosts(detection)).toEqual(["172.32.0.1", "52.4.3.2"]);
  });

  it("drops documentation, website, badge and code-forge links and keeps a real service host", async () => {
    const { detection } = await detect({
      "package.json": JSON.stringify({ name: "x", scripts: { test: "vitest" }, homepage: "https://rovara.acme.dev/start", repository: { url: "https://github.com/acme/x" }, bugs: { url: "https://github.com/acme/x/issues" } }, null, 2),
      ".github/workflows/ci.yml": [
        "# docs: https://docs.acme.dev/guide", "badge: https://img.shields.io/badge/ci-passing", "cov: https://codecov.io/gh/acme/x", "see: https://github.com/acme/x/blob/main/README.md",
        "api: https://api.github.com/repos/acme/x", "forge: https://gitlab.example-corp.net/acme/x", "guide: https://partner.acme.dev/setup/README.md", "rtd: https://acme.readthedocs.io/en/latest/", "pages: https://acme.github.io/x",
        "meta: http://metadata.google.internal/computeMetadata/v1/", "wiki: https://wiki.acme.dev/page", "svc: https://api.partner-scoring.net/v1/score", "queue: https://sqs.us-east-1.amazonaws.com/123/q",
      ].join("\n"),
      "pyproject.toml": ["[project.urls]", 'Documentation = "https://partner-docs.acme.dev/"', 'Homepage = "https://acme.dev"', "[tool.x]", 'endpoint = "https://rules.partners-internal.net/v1"'].join("\n"),
      "package-lock.json": '{"packages":{"node_modules/a":{"resolved":"https://registry.example-mirror.io/a/-/a-1.0.0.tgz"}}}',
      "docs/setup.yaml": "url: https://docs-site.acme.dev/api",
      "examples/demo/config.yaml": "url: https://demo-service.acme.dev/api",
    });
    expect(hosts(detection)).toEqual(["api.github.com", "api.partner-scoring.net", "rules.partners-internal.net", "sqs.us-east-1.amazonaws.com"]);
  });

  it("lists a host once however many files name it", async () => {
    const { detection } = await detect({ "a.yaml": "u: https://api.partner-scoring.net/a", "b/c.yaml": "u: https://API.partner-scoring.net/b\nv: http://api.partner-scoring.net:8443/c" });
    expect(hosts(detection)).toEqual(["api.partner-scoring.net"]);
  });

  it("has no services entry for a repository whose only hosts are noise", async () => {
    const { detection } = await detect({ "config.yaml": "a: http://10.0.0.5\nb: http://169.254.169.254/\nc: https://docs.acme.dev/x" });
    expect(detection.services).toEqual([]);
  });

  it("judges an address by its range", () => {
    for (const address of ["10.0.0.5", "10.255.255.255", "172.16.0.1", "172.31.255.254", "192.168.0.1", "127.0.0.1", "127.8.8.8", "169.254.169.254", "169.254.0.1", "0.0.0.0", "100.100.100.200", "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "::ffff:169.254.169.254", "::ffff:10.0.0.5", "fd00:ec2::254"]) expect(isNonServiceAddress(address), address).toBe(true);
    for (const address of ["172.15.255.255", "172.32.0.1", "192.169.0.1", "169.255.0.1", "11.0.0.1", "52.4.3.2", "2606:4700::1111", "fe00::1", "not-an-address"]) expect(isNonServiceAddress(address), address).toBe(false);
  });

  it("judges a name by its words", () => {
    for (const host of ["localhost", "db.local", "metadata.google.internal", "svc.cluster.local", "docs.acme.dev", "doc.acme.dev", "acme.github.io", "github.com", "gist.github.com", "github.acme-corp.com", "gitlab.com", "img.shields.io", "www.w3.org", "127.1", "0x7f.1", "10.0.0", "foo", "www.apache.org", "en.wikipedia.org", "registry.npmjs.org", "x.example.com", "10.0.0.5", "169.254.169.254"]) expect(isDependencyHost(host), host).toBe(false);
    for (const host of ["api.github.com", "api.partner-scoring.net", "s3.amazonaws.com", "db.acme.dev", "sqs.us-west-2.amazonaws.com", "52.4.3.2", "kafka-1.prod.acme.dev"]) expect(isDependencyHost(host), host).toBe(true);
    expect(isDependencyHost("partner.acme.dev", "/setup/README.md")).toBe(false);
    expect(isDependencyHost("partner.acme.dev", "/guide.rst#top")).toBe(false);
    expect(isDependencyHost("git.acme.dev", "/o/r/blob/main/x")).toBe(false);
    expect(isDependencyHost("partner.acme.dev", "/o/r/issues/4")).toBe(false);
    expect(isDependencyHost("partner.acme.dev", "/v1/score")).toBe(true);
  });

  it("knows the keys that hold a link to a page about the project", () => {
    for (const before of ['  "homepage": ', "Documentation = ", "  docs: ", '"$schema": ', '"bugs": { "url": ', "repository: ", "  - license: "]) expect(followsLinkKey(before), before).toBe(true);
    for (const before of ["database_url: ", 'endpoint = "', '"scoring_service": ', "api: ", "url: "]) expect(followsLinkKey(before), before).toBe(false);
  });
});

describe("the same command under two spellings", () => {
  it("folds the spellings of one package.json script together", () => {
    for (const [left, right] of [
      [cmd("npm", "test"), cmd("npm", "run", "test")], [cmd("npm", "t"), cmd("npm", "run-script", "test")], [cmd("npm", "test"), cmd("npm", "test", "--")], [cmd("/usr/bin/npm", "test"), cmd("npm", "run", "test")],
      [cmd("npm", "run", "lint"), cmd("npm", "run-script", "lint")], [cmd("pnpm", "test"), cmd("pnpm", "run", "test")], [cmd("yarn", "lint"), cmd("yarn", "run", "lint")], [cmd("npm", "test", "--", "-x"), cmd("npm", "run", "test", "--", "-x")],
      [cmd("pytest", "-q"), cmd("pytest", "-q")],
    ] as const) expect(sameCommandLine(left, right), JSON.stringify([left, right])).toBe(true);
  });

  it("never folds different scripts, arguments or programs", () => {
    for (const [left, right] of [
      [cmd("npm", "run", "typecheck"), cmd("npm", "run", "typecheck:all")], [cmd("npm", "test"), cmd("npm", "test", "--", "--watch")], [cmd("npm", "test"), cmd("pnpm", "test")], [cmd("npm", "run", "lint"), cmd("npm", "run", "lint:fix")],
      [cmd("pnpm", "install"), cmd("pnpm", "run", "install")], [cmd("yarn", "install"), cmd("yarn", "run", "install")], [cmd("bun", "test"), cmd("bun", "run", "test")], [cmd("npm", "ci"), cmd("npm", "run", "ci")], [cmd("pytest", "-q"), cmd("pytest")],
    ] as const) expect(sameCommandLine(left, right), JSON.stringify([left, right])).toBe(false);
    expect(commandWords(cmd("npm", "install"))).toEqual(["npm", "install"]);
  });

  const draftWith = (testCommands: string[], setupCommands: string[] = []): SetupDraft => ({ basedOnRevision: 1, setupCommands, testCommands, allowedDomains: [], secretsNeeded: [], flaggedCommands: [], notes: "" });
  const NODE: Files = { "package.json": JSON.stringify({ scripts: { test: "vitest", typecheck: "tsc -b", lint: "eslint ." } }), "package-lock.json": "{}" };

  it("lists a command once when the setup agent names it as another spelling of a detected check", async () => {
    const { detection } = await detect(NODE);
    const draft = buildEnvironmentDraft(detection, { repositoryId: "svc" });
    if ("ok" in draft) throw new Error("no draft");
    const result = proposalFromDraft(draft, draftWith(["npm test", "npm run typecheck", "npm t", "npm run-script lint", "npm run typecheck:all", "npm test"], ["npm ci", "npm run ci"]), { cwd: "svc" });
    if (!result.ok) throw new Error("no proposal");
    const repo = result.proposal.environment.repos[0]!;
    expect(repo.checks.map((check) => [check.id, check.command.args.join(" ")])).toEqual([["unit", "run test"], ["lint", "run lint"], ["typecheck", "run typecheck"], ["model-1", "run typecheck:all"]]);
    expect(repo.setupCommands.map((command) => command.args.join(" "))).toEqual(["ci", "run ci"]);
  });

  it("keeps one check when two detectors propose the same script", async () => {
    const files: Files = { ...NODE, "Makefile": "test:\n\tnpm test\n" };
    const { detection } = await detect(files);
    expect(detection.checks.filter((check) => check.value.command.args.join(" ") === "run test")).toHaveLength(1);
  });
});

describe("the read budget", () => {
  const KIB = 1_024;
  const body = (bytes: number): string => "x".repeat(bytes);
  const big = ENV_DETECT_MAX_FILE_BYTES - 16;

  it("is a fixed hard cap with a reserve that is never more than a third of it", () => {
    expect(ENV_DETECT_MAX_TOTAL_BYTES).toBe(6 * 1_048_576);
    expect(ENV_DETECT_RESERVED_BYTES).toBeGreaterThan(0);
    expect(ENV_DETECT_RESERVED_BYTES * 3).toBeLessThanOrEqual(ENV_DETECT_MAX_TOTAL_BYTES);
  });

  it("recognises the files that say how a repository is built and run", () => {
    for (const path of ["package.json", "services/api/package.json", "pyproject.toml", "requirements-dev.txt", ".github/workflows/ci.yml", "Dockerfile", "docker/Dockerfile.api", "docker-compose.yml", "compose.override.yaml", ".devcontainer/devcontainer.json", ".devcontainer/Dockerfile", "Makefile", "README.md", ".gitlab-ci.yml", "pom.xml", "go.mod"]) expect(isImportantPath(path), path).toBe(true);
    for (const path of ["src/index.ts", "docs/README.md", "node_modules/a/package.json", "tests/fixtures/package.json", "a/b/c/d/package.json", "vendor/x/Dockerfile", ".github/CODEOWNERS", "docs/Makefile.md"]) expect(isImportantPath(path), path).toBe(false);
    expect(importantFirst(["src/a.ts", "b/package.json", "src/c.ts", "Makefile"])).toEqual(["b/package.json", "Makefile", "src/a.ts", "src/c.ts"]);
  });

  it("reads the build and run files even after source files used all the rest of the budget", async () => {
    const files: Files = {};
    for (let n = 0; n < 40; n += 1) files[`src/f${String(n)}.ts`] = body(big);
    // Each is padded so that the four of them need more than the little the ordinary files leave under the cap, and fit only in the reserve.
    const pad = body(200 * KIB);
    files["package.json"] = JSON.stringify({ scripts: { test: "vitest" }, pad });
    files["docker-compose.yml"] = `services:\n  db: { image: postgres:16 }\n# ${pad}\n`;
    files[".github/workflows/ci.yml"] = `on: push\n# ${pad}\n`;
    files["Makefile"] = `test:\n\tnpm test\n# ${pad}\n`;
    const bounded = boundedReader([...Object.keys(files).filter((path) => path.startsWith("src/")), "package.json", "docker-compose.yml", ".github/workflows/ci.yml", "Makefile"], (path) => Promise.resolve(files[path]));
    for (let n = 0; n < 40; n += 1) await bounded.reader.read(`src/f${String(n)}.ts`);
    expect(bounded.reader.budgetExhausted?.()).toBe(true);
    expect(bounded.bytesRead()).toBeLessThanOrEqual(ENV_DETECT_MAX_TOTAL_BYTES - ENV_DETECT_RESERVED_BYTES);
    for (const path of ["package.json", "docker-compose.yml", ".github/workflows/ci.yml", "Makefile"]) expect(await bounded.reader.read(path), path).toBe(files[path]);
    expect(bounded.reader.skippedImportant?.()).toEqual([]);
  });

  it("finds the database in a compose file that comes after more source than the budget holds", async () => {
    const files: Files = { "docker-compose.yml": "services:\n  db:\n    image: postgres:16\n    ports: ['5432:5432']\n", "package.json": JSON.stringify({ scripts: { test: "jest" } }) };
    for (let n = 0; n < 40; n += 1) files[`app/f${String(n)}.py`] = body(big);
    const paths = [...Object.keys(files).filter((path) => path.startsWith("app/")), "docker-compose.yml", "package.json"];
    const bounded = boundedReader(paths, (path) => Promise.resolve(files[path]));
    for (const path of paths.slice(0, 40)) await bounded.reader.read(path);
    const detection = await runDetectors(bounded.reader, "svc");
    expect(detection.dependencies?.some((item) => item.family === "postgres")).toBe(true);
    expect(detection.checks.some((check) => check.value.id === "unit")).toBe(true);
    expect(detection.notes).toContain("Some files were not read: the read budget ran out.");
    expect(detection.notes.join(" ")).not.toContain("which say how the repository is built and run");
  });

  it("stops at the hard cap and names the important files it could not read", async () => {
    const files: Files = {};
    for (let n = 0; n < 40; n += 1) files[`pkg${String(n).padStart(2, "0")}/package.json`] = JSON.stringify({ name: `p${String(n)}`, pad: body(big - 40) });
    const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
    for (const path of Object.keys(files)) await bounded.reader.read(path);
    expect(bounded.bytesRead()).toBeLessThanOrEqual(ENV_DETECT_MAX_TOTAL_BYTES);
    const skipped = bounded.reader.skippedImportant?.() ?? [];
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0]).toMatch(/^pkg\d\d\/package\.json$/u);
    const detection = await runDetectors(bounded.reader, "svc");
    const note = detection.notes.find((entry) => entry.includes("which say how the repository is built and run"));
    expect(note).toContain(skipped[0]!);
    expect(note).toContain("and more");
    expect(detection.notes).toContain("Some files were not read: the read budget ran out.");
  });

  it("names nothing when only ordinary files were cut", async () => {
    const files: Files = { "package.json": "{}" };
    for (let n = 0; n < 40; n += 1) files[`src/f${String(n)}.ts`] = body(big);
    const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
    for (const path of Object.keys(files)) await bounded.reader.read(path);
    expect(bounded.reader.skippedImportant?.()).toEqual([]);
    expect((await runDetectors(bounded.reader, "svc")).notes.join(" ")).not.toContain("which say how the repository is built and run");
  });

  it("scans the build and run settings files before the rest when there are more settings files than the cap", async () => {
    const files: Files = {};
    for (let n = 0; n < 200; n += 1) files[`config/a${String(n).padStart(3, "0")}.yaml`] = "k: v\n";
    files[".github/workflows/zz.yml"] = "env:\n  SCORER: https://api.partner-scoring.net/v1\n";
    const { detection } = await detect(files);
    expect(hosts(detection)).toEqual(["api.partner-scoring.net"]);
  });
});
