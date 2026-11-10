import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BOUNDARY_FILE,
  EXPECTED_PUBLIC_ADAPTERS,
  GRANDFATHERED_PUBLISH_CLOSURE,
  LINKS_DIR,
  PIN_FILE,
  SHIMS_DIR,
  VERIFY_SCRIPT,
  VENDOR_DIR,
  ALLOWED_THIRD_PARTY_LINKS,
  checkAwsAllowList,
  compositeActionProblems,
  importedPackages,
  checkPublishedPackages,
  checkVendorClean,
  checkVendorPin,
  main,
  parseBoundary,
  type BoundaryData,
  readBoundary,
  runAll,
  specifiers,
  workflowPublishProblems,
  type CheckResult,
} from "../../scripts/boundary-check.js";

// Lane W0-4 (decisions 71 and 72): Cloud's side of the public/private boundary. The real repository must pass; every refusal is shown on a small
// repository built here. Words that the Code guard refuses are assembled at run time, as in its tests.
const j = (...parts: string[]): string => parts.join("");
const CLOUD = j("clo", "ud");
const VENDOR = j("ven", "dor");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A small Cloud-shaped repository: the real boundary data, a workspace with one public-shaped CLI, a Cloud-only UI and the publish workflow. */
class Repo {
  readonly dir: string;
  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "boundary-check-"));
    roots.push(this.dir);
    git(this.dir, "init", "-q", "-b", "main");
    cpSync(BOUNDARY_FILE, join(this.dir, BOUNDARY_FILE), { recursive: true });
    this.json("package.json", { name: "root", private: true, workspaces: ["packages/*"] });
    this.json("packages/cli/package.json", { name: "@agentx/cli", private: true, dependencies: { "@agentx/contracts": "0.1.0", "@rovara/audit-verifier": "0.1.0", "@agentx/design-tokens": "0.1.0" } });
    this.json("packages/design-tokens/package.json", { name: "@agentx/design-tokens", private: true });
    this.json("packages/contracts/package.json", { name: "@agentx/contracts", private: true });
    this.json("packages/audit-verifier/package.json", { name: "@rovara/audit-verifier", private: true });
    this.json("packages/ui/package.json", { name: "@agentx/ui", private: true });
    this.json("packages/model-proxy/package.json", { name: "@agentx/model-proxy", private: true });
    this.write(
      ".github/workflows/release.yml",
      [
        "jobs:",
        "  npm:",
        "    if: github.repository == 'PrepLabsAI/Rovara' && (vars.PUBLISH == 'true')",
        "    steps:",
        "      - run: |",
        "          npm run release:pack-cli -- --version 1 --out \"$RUNNER_TEMP/cli\"",
        '          echo "skipping npm publish"',
        "          # npm publish is the next line",
        '          npm publish "$RUNNER_TEMP"/cli/*.tgz --access public',
        "",
      ].join("\n"),
    );
  }
  write(path: string, text: string | Buffer): void {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  json(path: string, value: unknown): void {
    this.write(path, `${JSON.stringify(value, null, 2)}\n`);
  }
  read(path: string): string {
    return readFileSync(join(this.dir, path), "utf8");
  }
  commit(): string {
    git(this.dir, "add", "-A");
    git(this.dir, "commit", "-q", "-m", "x");
    return git(this.dir, "rev-parse", "HEAD");
  }
}

const asData = (text: string): BoundaryData => JSON.parse(text) as BoundaryData;
const messages = (result: CheckResult): string[] => result.problems.map((p) => `${p.where}: ${p.message}`);

describe("this repository", () => {
  it("passes every check (vendor checks are skipped until the vendor folder exists)", () => {
    const results = runAll(process.cwd());
    for (const result of results) expect(messages(result), result.check).toEqual([]);
    expect(results.map((r) => r.check)).toEqual(["vendor-pin", "vendor-clean", "published-packages", "aws-allow-list"]);
  });

  it("keeps the data file the Code guard reads: four adapters, the three Cloud-only names", () => {
    const data = readBoundary(process.cwd());
    expect(data.publicAwsAdapters.adapters.map((a) => a.id).sort()).toEqual([...EXPECTED_PUBLIC_ADAPTERS]);
    expect(data.cloudOnlyPackages).toEqual(expect.arrayContaining(["@agentx/ui", "@agentx/web", "@rovara/audit-verifier"]));
  });

  it("names every Cloud-only workspace package as private and publishes only the packed CLI", () => {
    expect(Object.keys(GRANDFATHERED_PUBLISH_CLOSURE)).toEqual(["@preplabsai/rovara-code -> @rovara/audit-verifier", "@preplabsai/rovara-code -> @agentx/design-tokens"]);
    for (const file of ["packages/ui/package.json", "packages/web/package.json", "packages/audit-verifier/package.json"]) {
      expect((JSON.parse(readFileSync(file, "utf8")) as { private?: boolean }).private, file).toBe(true);
    }
  });
});

describe("the command line", () => {
  it("exits 0 on a clean repository, 1 on a problem, 2 when it cannot run", () => {
    const repo = new Repo();
    expect(main(["--root", repo.dir])).toBe(0);
    repo.json("packages/ui/package.json", { name: "@agentx/ui" });
    expect(main(["--root", repo.dir])).toBe(1);
    expect(main(["--root", join(repo.dir, "nowhere")])).toBe(2);
    expect(main(["--nope"])).toBe(2);
    expect(main(["--root"])).toBe(2);
  });
});

describe("vendor-pin: vendor/rovara-code equals its pin (W0-1's verifier decides)", () => {
  /** A repository with a vendored folder, a PIN and a stand-in for W0-1's verifier: it exits 1 with a message on stderr when the PIN says "stale". */
  function vendored(): Repo {
    const repo = new Repo();
    repo.write(`${VENDOR_DIR}/packages/contracts/src/index.ts`, "export const a = 1;\n");
    repo.write(PIN_FILE, "sha=1c3880cbe4320f05680e99bc35cf1565efc58eb9\nfiles=1\n");
    repo.write(
      VERIFY_SCRIPT,
      [
        'import { readFileSync } from "node:fs";',
        'if (readFileSync("vendor/rovara-code/PIN", "utf8").includes("stale")) {',
        '  console.error("vendor/rovara-code does not match its pin:\\n  the copy files do not hash to the manifest in PIN");',
        "  process.exit(1);",
        "}",
        "",
      ].join("\n"),
    );
    return repo;
  }

  it("is skipped, with a note, while the folder does not exist", () => {
    const result = checkVendorPin(new Repo().dir);
    expect(result.status).toBe("skipped");
    expect(result.problems).toEqual([]);
  });

  it("fails, rather than skipping, when the folder is gone but W0-1's verifier is here (deleting the copy must not pass)", () => {
    const repo = vendored();
    rmSync(join(repo.dir, VENDOR_DIR), { recursive: true });
    expect(messages(checkVendorPin(repo.dir))).toEqual([expect.stringContaining("is missing, but the vendor verifier")]);
    expect(messages(checkVendorClean(repo.dir))).toEqual([expect.stringContaining("is missing, but the vendor verifier")]);
  });

  it("(B20) stops with an error, not a pass, when the verifier cannot even be started", () => {
    expect(() => checkVendorPin(vendored().dir, { node: join(tmpdir(), "no-such-node-binary") })).toThrow(/could not run scripts\/vendor\/verify-rovara-code\.ts/);
  });

  it("(B21) fails when the verifier is killed by a signal before it answers", () => {
    const repo = vendored();
    repo.write(VERIFY_SCRIPT, 'process.kill(process.pid, "SIGKILL");\n');
    expect(messages(checkVendorPin(repo.dir))).toEqual([expect.stringContaining("stopped by SIGKILL before it answered")]);
  });

  it("passes when the verifier is satisfied, and runs it from the repository root", () => {
    expect(messages(checkVendorPin(vendored().dir))).toEqual([]);
  });

  it("fails a vendored copy with no PIN file", () => {
    const repo = vendored();
    rmSync(join(repo.dir, PIN_FILE));
    expect(messages(checkVendorPin(repo.dir))).toEqual([`${PIN_FILE}: the vendored copy has no PIN file; a copy with no pin cannot be checked`]);
  });

  it("fails when the verifier script is missing, rather than passing unchecked", () => {
    const repo = vendored();
    rmSync(join(repo.dir, VERIFY_SCRIPT));
    expect(messages(checkVendorPin(repo.dir))).toEqual([expect.stringContaining("the vendor verifier is missing")]);
  });

  it("reports the verifier's own words when it refuses the copy", () => {
    const repo = vendored();
    repo.write(PIN_FILE, "stale\n");
    const text = messages(checkVendorPin(repo.dir)).join("\n");
    expect(text).toContain("vendor/rovara-code does not match its pin");
    expect(text).toContain("do not hash to the manifest in PIN");
  });

  it("fails a verifier that exits without saying why", () => {
    const repo = vendored();
    repo.write(VERIFY_SCRIPT, "process.exit(3);\n");
    expect(messages(checkVendorPin(repo.dir))).toEqual([expect.stringContaining("exited 3 with no message")]);
  });
});

describe("vendor-clean: Code in the vendored copy holds no Cloud", () => {
  it("is skipped without the folder and passes ordinary Code", () => {
    const repo = new Repo();
    expect(checkVendorClean(repo.dir).status).toBe("skipped");
    repo.write(`${VENDOR_DIR}/packages/worker/src/run.ts`, 'import { a } from "@agentx/contracts";\nimport { z } from "zod";\nexport const r = [a, z];\n');
    expect(messages(checkVendorClean(repo.dir))).toEqual([]);
  });

  it.each([
    ["an import of a cloud-* package", `import { a } from "@agentx/${CLOUD}-contracts";\n`],
    ["an import of the web UI package", 'import { App } from "@agentx/ui/app";\n'],
    ["a dynamic import of the audit verifier", 'const v = await import("@rovara/audit-verifier");\n'],
    ["a require of a cloud-* package", `const a = require("@rovara/${CLOUD}-x");\n`],
  ])("fails %s", (_name, source) => {
    const repo = new Repo();
    repo.write(`${VENDOR_DIR}/packages/worker/src/run.ts`, source);
    expect(messages(checkVendorClean(repo.dir))).toEqual([expect.stringContaining("Code never imports Cloud")]);
  });

  /** A repository with a vendored copy of two packages and the links W0-1 writes (the good ones; tests then break one thing at a time). */
  function linked(): Repo {
    const repo = new Repo();
    repo.write(`${VENDOR_DIR}/packages/contracts/src/index.ts`, "export const a = 1;\n");
    repo.write(`${VENDOR_DIR}/packages/worker/src/run.ts`, 'import { a } from "@agentx/contracts";\nexport const r = a;\n');
    repo.write(`${SHIMS_DIR}/contracts/index.js`, 'export * from "@agentx/contracts";\n');
    repo.write(`${SHIMS_DIR}/contracts/package.json`, '{ "name": "@rovara-code/contracts", "private": true }\n');
    mkdirSync(join(repo.dir, LINKS_DIR, "@agentx"), { recursive: true });
    symlinkSync("../../rovara-code/packages/contracts", join(repo.dir, LINKS_DIR, "@agentx/contracts"));
    symlinkSync("../../rovara-code/packages/worker", join(repo.dir, LINKS_DIR, "@agentx/worker"));
    mkdirSync(join(repo.dir, "node_modules/@e2e-dev/web/node_modules/playwright-core"), { recursive: true });
    symlinkSync(ALLOWED_THIRD_PARTY_LINKS["playwright-core"]!, join(repo.dir, LINKS_DIR, "playwright-core"));
    return repo;
  }

  it("leaves W0-1's generated shims and its vendor/node_modules links alone, and still catches a real Cloud-only import inside the copy", () => {
    const repo = linked();
    expect(messages(checkVendorClean(repo.dir))).toEqual([]);
    repo.write(`${VENDOR_DIR}/packages/worker/src/run.ts`, 'import { App } from "@agentx/ui";\nexport const r = App;\n');
    expect(messages(checkVendorClean(repo.dir))).toEqual([`${VENDOR_DIR}/packages/worker/src/run.ts:1: Code imports a Cloud-only package (@agentx/ui); Code never imports Cloud`]);
  });

  it("(B-M1 escape 1) refuses a link into Cloud's own node_modules/@agentx/*, which is a workspace link to a Cloud package", () => {
    const repo = linked();
    mkdirSync(join(repo.dir, "node_modules/@agentx"), { recursive: true });
    mkdirSync(join(repo.dir, "packages/web"), { recursive: true });
    symlinkSync("../../packages/web", join(repo.dir, "node_modules/@agentx/web"));
    symlinkSync("../../../node_modules/@agentx/web", join(repo.dir, LINKS_DIR, "@agentx/evil"));
    expect(messages(checkVendorClean(repo.dir)).join("\n")).toContain(`${LINKS_DIR}/@agentx/evil: a link that does not resolve to ${VENDOR_DIR}/packages/evil (it resolves to a Cloud-only package)`);
  });

  it("(B-M1 escape 2) refuses a chained link: a link whose target is a link inside the copy that leads to Cloud's code", () => {
    const repo = linked();
    mkdirSync(join(repo.dir, "packages/web"), { recursive: true });
    symlinkSync("../../../packages/web", join(repo.dir, VENDOR_DIR, "packages/hop"));
    symlinkSync("../../rovara-code/packages/hop", join(repo.dir, LINKS_DIR, "@agentx/hop"));
    const text = messages(checkVendorClean(repo.dir)).join("\n");
    expect(text).toContain(`${VENDOR_DIR}/packages/hop: a symlink inside the vendored copy`);
    expect(text).toContain(`${LINKS_DIR}/@agentx/hop: a link that does not resolve to ${VENDOR_DIR}/packages/hop (it resolves to a Cloud-only package)`);
  });

  it("(B-M1 escape 2b) refuses a vendored package folder that is itself a link, even to a harmless place", () => {
    const repo = linked();
    mkdirSync(join(repo.dir, "elsewhere"), { recursive: true });
    rmSync(join(repo.dir, VENDOR_DIR, "packages/worker"), { recursive: true });
    symlinkSync("../../../elsewhere", join(repo.dir, VENDOR_DIR, "packages/worker"));
    const text = messages(checkVendorClean(repo.dir)).join("\n");
    expect(text).toContain(`${VENDOR_DIR}/packages/worker: a symlink inside the vendored copy`);
    expect(text).toContain(`${LINKS_DIR}/@agentx/worker: a link that does not resolve to`);
  });

  it("(B-M1 escape 3) refuses a real folder with code under vendor/node_modules, at the top and inside @agentx", () => {
    const repo = linked();
    repo.write(`${LINKS_DIR}/left-pad/index.js`, "module.exports = 1;\n");
    repo.write(`${LINKS_DIR}/@agentx/injected/index.js`, "module.exports = 1;\n");
    repo.write(`${LINKS_DIR}/stray.js`, "module.exports = 1;\n");
    const text = messages(checkVendorClean(repo.dir)).join("\n");
    expect(text).toContain(`${LINKS_DIR}/left-pad: a real file or folder under vendor/node_modules`);
    expect(text).toContain(`${LINKS_DIR}/stray.js: a real file or folder under vendor/node_modules`);
    expect(text).toContain(`${LINKS_DIR}/@agentx/injected: not a link`);
  });

  it("(B-M1 escape 4) refuses a relative import that leaves the copy and lands in Cloud's code, but not one that stays inside, in a test, or in a string", () => {
    const repo = linked();
    repo.write(`${VENDOR_DIR}/packages/worker/src/deep/a.ts`, 'import { x } from "../../../../../packages/web/src/a.js";\nimport { y } from "../../../contracts/src/index.js";\nexport const r = [x, y];\n');
    repo.write(`${VENDOR_DIR}/packages/worker/tests/b.test.ts`, 'import { x } from "../../../../../packages/web/src/a.js";\n');
    repo.write(`${VENDOR_DIR}/packages/worker/src/c.ts`, "const t = 'import { x } from \"../../../../../packages/web/src/a.js\"';\n");
    expect(messages(checkVendorClean(repo.dir))).toEqual([`${VENDOR_DIR}/packages/worker/src/deep/a.ts:1: a relative import that leaves the vendored copy (it would reach Cloud's own code)`]);
  });

  it("(B-M1 escape 5) refuses the model proxy and the design tokens as Cloud-only, by import and by folder", () => {
    const repo = linked();
    repo.write(`${VENDOR_DIR}/packages/worker/src/run.ts`, 'import { p } from "@agentx/model-proxy";\nimport { t } from "@agentx/design-tokens";\nexport const r = [p, t];\n');
    repo.write(`${VENDOR_DIR}/packages/model-proxy/src/a.ts`, "export {};\n");
    const text = messages(checkVendorClean(repo.dir)).join("\n");
    expect(text).toContain("run.ts:1: Code imports a Cloud-only package (@agentx/model-proxy)");
    expect(text).toContain("run.ts:2: Code imports a Cloud-only package (@agentx/design-tokens)");
    expect(text).toContain("a Cloud-only package inside the vendored copy of Code");
  });

  it("refuses a third-party link with other text than W0-1 records, a link not in its list, and a vendored link that resolves into a Cloud-only package", () => {
    const repo = linked();
    rmSync(join(repo.dir, LINKS_DIR, "playwright-core"));
    symlinkSync("../../node_modules/playwright-core", join(repo.dir, LINKS_DIR, "playwright-core"));
    symlinkSync("../../node_modules/zod", join(repo.dir, LINKS_DIR, "zod"));
    const text = messages(checkVendorClean(repo.dir)).join("\n");
    expect(text).toContain(`${LINKS_DIR}/playwright-core: a third-party link whose target is not the one W0-1 records`);
    expect(text).toContain(`${LINKS_DIR}/zod: a link that is not one W0-1 creates`);
  });

  it("refuses a third-party link that resolves into a Cloud-only package", () => {
    const repo = linked();
    rmSync(join(repo.dir, "node_modules/@e2e-dev/web"), { recursive: true });
    mkdirSync(join(repo.dir, "packages/ui/node_modules/playwright-core"), { recursive: true });
    mkdirSync(join(repo.dir, "node_modules/@e2e-dev"), { recursive: true });
    symlinkSync("../../packages/ui", join(repo.dir, "node_modules/@e2e-dev/web"));
    expect(messages(checkVendorClean(repo.dir)).join("\n")).toContain(`${LINKS_DIR}/playwright-core: a third-party link that resolves into a Cloud-only package`);
  });

  it("fails a Cloud-only package folder and a nested vendor folder inside the copy", () => {
    const repo = new Repo();
    repo.write(`${VENDOR_DIR}/packages/ui/src/App.tsx`, "export {};\n");
    repo.write(`${VENDOR_DIR}/packages/worker/${VENDOR}/x.js`, "export {};\n");
    const text = messages(checkVendorClean(repo.dir)).join("\n");
    expect(text).toContain("Cloud-only package inside the vendored copy");
    expect(text).toContain("vendor/ folder inside the vendored copy");
  });
});

describe("published-packages: nothing Cloud-only is published", () => {
  it("fails a Cloud-only package that is not private, or carries a publish config", () => {
    const repo = new Repo();
    repo.json("packages/ui/package.json", { name: "@agentx/ui", publishConfig: { access: "public" } });
    repo.json("packages/cloud-contracts/package.json", { name: `@agentx/${CLOUD}-contracts`, private: true, publishConfig: { access: "public" } });
    repo.json("packages/web/package.json", { name: "@agentx/web", private: false });
    const text = messages(checkPublishedPackages(repo.dir)).join("\n");
    expect(text).toContain('packages/ui/package.json: @agentx/ui is Cloud-only and must have "private": true');
    expect(text).toContain("packages/ui/package.json: @agentx/ui is Cloud-only and must have no publishConfig");
    expect(text).toContain(`@agentx/${CLOUD}-contracts is Cloud-only and must have no publishConfig`);
    expect(text).toContain("packages/web/package.json: @agentx/web is Cloud-only and must have");
  });

  it("recognises a Cloud-only package by its folder even when its name is something else", () => {
    const repo = new Repo();
    repo.json("packages/audit-verifier/package.json", { name: "plain-name" });
    expect(messages(checkPublishedPackages(repo.dir))).toEqual([expect.stringContaining("plain-name is Cloud-only")]);
  });

  it("fails any other workspace package that could be published, unless the data lists it", () => {
    const repo = new Repo();
    repo.json("packages/tool/package.json", { name: "@agentx/tool" });
    expect(messages(checkPublishedPackages(repo.dir))).toEqual([expect.stringContaining("@agentx/tool is publishable but the boundary data does not list it")]);
    repo.json("packages/tool/package.json", { name: "@agentx/tool", private: true });
    expect(messages(checkPublishedPackages(repo.dir))).toEqual([]);
  });

  it("fails when the published CLI reaches a Cloud-only package, and when a grandfathered entry went stale", () => {
    const repo = new Repo();
    // the data's published package is built from packages/cli (name "@agentx/cli" here stands for its workspace package)
    const data = asData(repo.read(BOUNDARY_FILE));
    expect(data.publicNpmPackages[0]!.source).toBe("packages/cli");
    repo.json("packages/cli/package.json", { name: "@agentx/cli", private: true, dependencies: { "@agentx/contracts": "0.1.0" } });
    repo.json("packages/contracts/package.json", { name: "@agentx/contracts", private: true, dependencies: { "@agentx/ui": "0.1.0" } });
    const text = messages(checkPublishedPackages(repo.dir)).join("\n");
    expect(text).toContain("@preplabsai/rovara-code -> @agentx/ui");
    expect(text).toContain('GRANDFATHERED_PUBLISH_CLOSURE lists "@preplabsai/rovara-code -> @rovara/audit-verifier" but nothing reaches it any more');
  });

  describe("workflows", () => {
    const publishJob = (guard: string, run: string, extra = ""): string =>
      `jobs:\n  npm:\n    if: ${JSON.stringify(guard)}\n    steps:\n${extra}      - run: |\n${run.split("\n").map((line) => `          ${line}`).join("\n")}\n`;
    const guard = "github.repository == 'PrepLabsAI/Rovara' && (vars.PUBLISH == 'true')";
    const OUT = 'npm run release:pack-cli -- --version 1 --out "$RUNNER_TEMP/cli"';
    const good = `${OUT}\nnpm publish "$RUNNER_TEMP"/cli/*.tgz --access public`;
    const problems = (yaml: string, scripts: Record<string, string> = {}): string => workflowPublishProblems("w.yml", yaml, scripts).map((p) => p.message).join("\n");

    it("accepts the packed CLI published from a job that runs only in the public repository, as the real release workflow does", () => {
      expect(workflowPublishProblems("w.yml", publishJob(guard, good))).toEqual([]);
      expect(workflowPublishProblems("w.yml", publishJob("github.repository == 'PrepLabsAI/Rovara'", good))).toEqual([]);
      expect(workflowPublishProblems("w.yml", publishJob("${{ github.repository == 'PrepLabsAI/Rovara' }}", good))).toEqual([]);
      expect(workflowPublishProblems("w.yml", publishJob(guard, `${OUT}\necho "skipping npm publish"\n# npm publish -w x\nnpm publish "$RUNNER_TEMP"/cli/*.tgz --access public --provenance`))).toEqual([]);
    });

    it("is not fooled by an echo or a comment that names a publish, and reads no job that does not publish", () => {
      expect(workflowPublishProblems("w.yml", publishJob("true", 'echo "run npm publish later"\n# npm publish -w packages/ui'))).toEqual([]);
    });

    it("fails a job with no guard, a guard that an OR opens, and a guard that is only a prefix of another test", () => {
      expect(problems(publishJob("true", good))).toContain("must run only in the public repository");
      expect(problems(publishJob(`vars.X == 'y' || ${guard}`, good))).toContain("must run only in the public repository");
      expect(problems(publishJob("github.repository == 'PrepLabsAI/Rovara' || true", good))).toContain("must run only in the public repository");
      expect(problems(publishJob("github.repository == 'PrepLabsAI/Rovara' ||true", good))).toContain("must run only in the public repository");
      expect(problems(publishJob("github.repository == 'PrepLabsAI/Rovara-fork'", good))).toContain("must run only in the public repository");
      expect(problems(publishJob("github.repository == 'PrepLabsAI/Rovara' && github.event_name == 'push' || true", good))).toContain("must run only in the public repository");
      expect(problems(publishJob("github.repository == 'PrepLabsAI/Rovara' && (github.ref == 'x' || github.ref == 'y')", good))).toContain("must run only in the public repository");
      expect(problems(publishJob("${{ github.repository == 'PrepLabsAI/Rovara' && vars.A == 'b' || vars.C }}", good))).toContain("must run only in the public repository");
      expect(problems(publishJob(`${guard}`, good))).toBe("");
    });

    it.each([
      ["npm run of a script that publishes (by name)", `${OUT}\nnpm run publish:all`, { "publish:all": "echo x" }, "other than"],
      ["npm run of a script that publishes (by body)", `${OUT}\nnpm run ship`, { ship: "npm publish --workspaces" }, "other than"],
      ["bash -c", `${OUT}\nbash -c "npm publish --workspaces"`, {}, "other than"],
      ["an env prefix", `${OUT}\nenv NODE_AUTH_TOKEN=x npm publish packages/web`, {}, "other than"],
      ["an assignment prefix", `${OUT}\nNODE_AUTH_TOKEN=x npm publish "$RUNNER_TEMP"/cli/*.tgz`, {}, "other than"],
      ["node -e", `${OUT}\nnode -e "require('child_process').execSync('npm publish packages/web')"`, {}, "other than"],
      ["another publisher", `${OUT}\nyarn publish`, {}, "other than"],
      ["changesets", `${OUT}\nnpx changeset publish`, {}, "other than"],
      ["a workspace publish", `${OUT}\nnpm publish -w packages/ui "$RUNNER_TEMP"/cli/a.tgz`, {}, "other than"],
      ["a workspaces publish", `${OUT}\nnpm publish --workspaces x.tgz`, {}, "other than"],
      ["a folder", `${OUT}\nnpm publish packages/cli`, {}, "other than"],
      ["an extra flag", `${OUT}\nnpm publish "$RUNNER_TEMP"/cli/*.tgz --registry https://example.test`, {}, "other than"],
      ["a publish after another command on the line", `${OUT}\ncd x && npm publish "$RUNNER_TEMP"/cli/a.tgz`, {}, "other than"],
      ["a Cloud tarball", `${OUT}\nnpm pack ./packages/web && npm publish ./agentx-web-0.1.0.tgz`, {}, "other than"],
      ["a tarball from somewhere else", `${OUT}\nnpm publish ./agentx-web-0.1.0.tgz --access public`, {}, "not one release:pack-cli wrote"],
      ["a tarball in a sibling folder", `${OUT}\nnpm publish "$RUNNER_TEMP"/cli2/a.tgz`, {}, "not one release:pack-cli wrote"],
      ["a pack of a Cloud package next to the real publish", `${OUT}\nnpm pack ./packages/web --pack-destination "$RUNNER_TEMP/cli"\nnpm publish "$RUNNER_TEMP"/cli/*.tgz`, {}, "npm pack in a job that publishes"],
      ["npm -w before the verb", `${OUT}\nnpm -w packages/web publish "$RUNNER_TEMP"/cli/a.tgz`, {}, "other than"],
      ["npm --workspace= before the verb", `${OUT}\nnpm --workspace=packages/web publish`, {}, "other than"],
      ["npm --prefix before the verb", `${OUT}\nnpm --prefix packages/web publish`, {}, "other than"],
      ["pnpm -r publish", `${OUT}\npnpm -r publish`, {}, "other than"],
      ["pnpm --filter before the verb", `${OUT}\npnpm --filter web publish --no-git-checks`, {}, "other than"],
      ["a backslash-continued line", `${OUT}\nnpm \\\n  publish \\\n  packages/web`, {}, "other than"],
      ["a backslash-continued flag line", `${OUT}\nnpm --prefix packages/web \\\n  publish`, {}, "other than"],
      ["npx np", `${OUT}\nnpx np patch`, {}, "other than"],
      ["npx with a flag then np", `${OUT}\nnpx --yes np`, {}, "other than"],
      ["a variable standing for the tool", `${OUT}\n$NPM publish packages/web`, {}, "other than"],
      ["a pack with a flag before the verb, next to the real publish", `${OUT}\nnpm --prefix packages/web pack --pack-destination "$RUNNER_TEMP/cli"\nnpm publish "$RUNNER_TEMP"/cli/*.tgz`, {}, "npm pack in a job that publishes"],
      ["a publish with no pack step", 'npm publish "$T"/a.tgz', {}, "without release:pack-cli --out"],
    ])("fails %s", (_name, run, scripts, expected) => {
      expect(problems(publishJob(guard, run), scripts)).toContain(expected);
    });

    it("fails a publish action, in the guarded job or in another one, and a reusable workflow job that names one", () => {
      expect(problems(publishJob(guard, good, "      - uses: JS-DevTools/npm-publish@v3\n"))).toContain("a publish action (JS-DevTools/npm-publish@v3)");
      expect(problems("jobs:\n  other:\n    steps:\n      - uses: pypa/gh-action-pypi-publish@release/v1\n")).toContain("must run only in the public repository");
      expect(problems("jobs:\n  other:\n    uses: ./.github/workflows/publish-all.yml\n")).toContain("a publish action (./.github/workflows/publish-all.yml)");
    });

    it("fails a workflow it cannot parse", () => {
      expect(workflowPublishProblems("w.yml", "jobs: [")[0]!.message).toContain("not valid YAML");
    });

    it("reads every workflow in the repository, and every composite action", () => {
      const repo = new Repo();
      repo.write(".github/workflows/other.yml", publishJob("true", `${OUT}\nnpm publish "$T"/a.tgz`));
      repo.write(".github/actions/ship/action.yml", "runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: npm publish ./packages/web\n");
      const text = messages(checkPublishedPackages(repo.dir)).join("\n");
      expect(text).toContain(".github/workflows/other.yml job npm");
      expect(text).toContain(".github/actions/ship/action.yml: a composite action that publishes or packs");
    });

    it("reads a composite action by what it runs and uses, and passes one that does neither", () => {
      expect(compositeActionProblems("a.yml", "runs:\n  steps:\n    - run: npm run build\n")).toEqual([]);
      expect(compositeActionProblems("a.yml", "runs:\n  steps:\n    - run: npm pack ./packages/web\n")).toHaveLength(1);
      expect(compositeActionProblems("a.yml", "runs:\n  steps:\n    - uses: x/npm-publish@v1\n")).toHaveLength(1);
      expect(compositeActionProblems("a.yml", "runs:\n  steps:\n    - run: npm run ship\n", { ship: "npm publish" })).toHaveLength(1);
      expect(compositeActionProblems("a.yml", "runs: [")[0]!.message).toContain("not valid YAML");
    });
  });

  describe("what the published CLI really bundles (its imports, not only its package.json)", () => {
    it("reads imports: an undeclared import of a Cloud-only package, a relative path into one, and an import through another package", () => {
      const repo = new Repo();
      repo.json("packages/cli/package.json", { name: "@agentx/cli", private: true, dependencies: { "@agentx/contracts": "0.1.0", "@rovara/audit-verifier": "0.1.0", "@agentx/design-tokens": "0.1.0" } });
      repo.write("packages/cli/src/a.ts", 'import { m } from "@agentx/model-proxy";\nexport const a = m;\n');
      let text = messages(checkPublishedPackages(repo.dir)).join("\n");
      expect(text).toContain("@preplabsai/rovara-code -> @agentx/model-proxy");
      rmSync(join(repo.dir, "packages/cli/src/a.ts"));
      repo.write("packages/cli/src/b.ts", 'import { w } from "../../web/src/app.js";\nexport const b = w;\n');
      repo.json("packages/web/package.json", { name: "@agentx/web", private: true });
      text = messages(checkPublishedPackages(repo.dir)).join("\n");
      expect(text).toContain("@preplabsai/rovara-code -> @agentx/web");
      rmSync(join(repo.dir, "packages/cli/src/b.ts"));
      repo.write("packages/contracts/src/c.ts", 'import { u } from "@agentx/ui";\nexport const c = u;\n');
      text = messages(checkPublishedPackages(repo.dir)).join("\n");
      expect(text).toContain("@preplabsai/rovara-code -> @agentx/ui");
    });

    it("does not read tests or text inside strings as imports, and reports what a package imports by name", () => {
      const repo = new Repo();
      repo.write("packages/cli/src/a.test.ts", 'import { m } from "@agentx/model-proxy";\n');
      repo.write("packages/cli/src/tests/b.ts", 'import { m } from "@agentx/model-proxy";\n');
      repo.write("packages/cli/src/c.ts", "const t = 'import { m } from \"@agentx/model-proxy\"';\nimport { z } from \"zod\";\nimport \"node:fs\";\n");
      expect(messages(checkPublishedPackages(repo.dir))).toEqual([]);
      const dirToName = new Map([["packages/cli", "@agentx/cli"], ["packages/contracts", "@agentx/contracts"]]);
      repo.write("packages/cli/src/d.ts", 'import { a } from "../../contracts/src/index.js";\nimport { b } from "./c.js";\n');
      expect([...importedPackages(repo.dir, "packages/cli", dirToName)].sort()).toEqual(["@agentx/contracts", "zod"]);
    });
  });
});

describe("aws-allow-list: four generic adapters are public, everything else AWS is private", () => {
  const ADAPTERS = "packages/aws-adapters";

  it("passes the data as shipped and a package with the four adapters", () => {
    const repo = new Repo();
    repo.write(`${ADAPTERS}/src/dynamodb/store.ts`, 'import { DynamoDBClient } from "@aws-sdk/client-dynamodb";\nimport { x } from "@aws-sdk/lib-dynamodb";\nexport const s = [DynamoDBClient, x];\n');
    repo.write(`${ADAPTERS}/src/sqs/queue.ts`, 'import { SQSClient } from "@aws-sdk/client-sqs";\nexport const q = SQSClient;\n');
    repo.write(`${ADAPTERS}/src/s3/objects.ts`, 'import { S3Client } from "@aws-sdk/client-s3";\nexport const o = S3Client;\n');
    repo.write(`${ADAPTERS}/src/secrets-manager/secrets.ts`, 'import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";\nexport const s = SecretsManagerClient;\n');
    repo.write(`${ADAPTERS}/src/index.ts`, 'export * from "./sqs/queue.js";\n');
    expect(messages(checkAwsAllowList(repo.dir))).toEqual([]);
  });

  it("fails a data file that names a different set of adapters, so a quiet edit of the list is caught", () => {
    const repo = new Repo();
    const data = asData(repo.read(BOUNDARY_FILE));
    data.publicAwsAdapters.adapters.push({ id: "ec2", port: "workers", sdk: ["@aws-sdk/client-ec2"] });
    repo.json(BOUNDARY_FILE, data);
    expect(messages(checkAwsAllowList(repo.dir))).toEqual([expect.stringContaining("must be exactly dynamodb, s3, secrets-manager, sqs")]);
    data.publicAwsAdapters.adapters = data.publicAwsAdapters.adapters.filter((a) => a.id !== "ec2" && a.id !== "sqs");
    repo.json(BOUNDARY_FILE, data);
    expect(messages(checkAwsAllowList(repo.dir))).toEqual([expect.stringContaining("must be exactly")]);
  });

  it("fails a private adapter, another service's client, the CDK and a Cloud-only package inside the public package, in either copy", () => {
    for (const base of [ADAPTERS, `${VENDOR_DIR}/${ADAPTERS}`]) {
      const repo = new Repo();
      repo.write(`${base}/src/ec2/workers.ts`, 'import { EC2Client } from "@aws-sdk/client-ec2";\nexport const w = EC2Client;\n');
      repo.write(`${base}/src/sqs/queue.ts`, `import { SNSClient } from "@aws-sdk/client-sns";\nimport { Stack } from "aws-cdk-lib";\nimport { c } from "@agentx/${CLOUD}-contracts";\nexport const q = [SNSClient, Stack, c];\n`);
      const text = messages(checkAwsAllowList(repo.dir)).join("\n");
      expect(text).toContain(`${base}/src/ec2/workers.ts: a private adapter`);
      expect(text).toContain("imports @aws-sdk/client-ec2");
      expect(text).toContain(`${base}/src/sqs/queue.ts:1: the public adapters package imports @aws-sdk/client-sns`);
      expect(text).toContain(`${base}/src/sqs/queue.ts:2: the public adapters package imports the AWS CDK`);
      expect(text).toContain(`${base}/src/sqs/queue.ts:3: the public adapters package imports a Cloud-only package`);
    }
  });

  it("leaves the private AWS code elsewhere in Cloud alone", () => {
    const repo = new Repo();
    repo.write("packages/broker/src/aws/ec2.ts", 'import { EC2Client } from "@aws-sdk/client-ec2";\nexport const w = EC2Client;\n');
    repo.write(`packages/${CLOUD}-aws/src/ec2/workers.ts`, 'import { EC2Client } from "@aws-sdk/client-ec2";\nexport const w = EC2Client;\n');
    expect(messages(checkAwsAllowList(repo.dir))).toEqual([]);
  });

  it("compares its data file with the vendored copy: identical passes, any difference fails, a vendor folder without one is noted", () => {
    const repo = new Repo();
    repo.write(`${VENDOR_DIR}/README.md`, "x\n");
    const noted = checkAwsAllowList(repo.dir);
    expect(noted.status).toBe("ok");
    expect(noted.note).toContain("were not compared");
    repo.write(`${VENDOR_DIR}/${BOUNDARY_FILE}`, repo.read(BOUNDARY_FILE));
    expect(messages(checkAwsAllowList(repo.dir))).toEqual([]);
    repo.write(`${VENDOR_DIR}/${BOUNDARY_FILE}`, repo.read(BOUNDARY_FILE).replace('"version": 1', '"version": 2'));
    expect(messages(checkAwsAllowList(repo.dir))).toEqual([expect.stringContaining("differs from the copy in vendor/rovara-code")]);
  });

  it("refuses a data file it cannot read, loudly", () => {
    expect(() => parseBoundary("{", "x")).toThrow();
    expect(() => parseBoundary("{}", "x")).toThrow();
    expect(() => parseBoundary(JSON.stringify({ ...readBoundary(process.cwd()), cloudOnlyPackagePatterns: ["("] }), "x")).toThrow();
    const repo = new Repo();
    rmSync(join(repo.dir, BOUNDARY_FILE));
    expect(() => checkAwsAllowList(repo.dir)).toThrow(/is missing/);
  });
});

describe("import reading", () => {
  it("finds from, dynamic import, require and side-effect imports, with their lines", () => {
    const source = 'import a from "one";\nconst b = await import("two");\nconst c = require("three");\nimport "four";\nconst s = "five";\n';
    expect(specifiers(source)).toEqual(
      expect.arrayContaining([
        { specifier: "one", line: 1, inString: false },
        { specifier: "two", line: 2, inString: false },
        { specifier: "three", line: 3, inString: false },
        { specifier: "four", line: 4, inString: false },
      ]),
    );
    expect(specifiers(source).some((s) => s.specifier === "five")).toBe(false);
  });
});
