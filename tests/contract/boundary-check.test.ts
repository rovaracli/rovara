import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BOUNDARY_FILE,
  EXPECTED_PUBLIC_ADAPTERS,
  GRANDFATHERED_PUBLISH_CLOSURE,
  PIN_FILES,
  VENDOR_DIR,
  checkAwsAllowList,
  checkPublishedPackages,
  checkVendorClean,
  checkVendorPin,
  contentDigest,
  main,
  parseBoundary,
  type BoundaryData,
  readBoundary,
  readVendor,
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
    this.json("packages/cli/package.json", { name: "@agentx/cli", private: true, dependencies: { "@agentx/contracts": "0.1.0", "@rovara/audit-verifier": "0.1.0" } });
    this.json("packages/contracts/package.json", { name: "@agentx/contracts", private: true });
    this.json("packages/audit-verifier/package.json", { name: "@rovara/audit-verifier", private: true });
    this.json("packages/ui/package.json", { name: "@agentx/ui", private: true });
    this.write(
      ".github/workflows/release.yml",
      [
        "jobs:",
        "  npm:",
        "    if: github.repository == 'PrepLabsAI/Rovara' && (vars.PUBLISH == 'true')",
        "    steps:",
        "      - run: |",
        "          npm run release:pack-cli -- --out out",
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
    expect(Object.keys(GRANDFATHERED_PUBLISH_CLOSURE)).toEqual(["@preplabsai/rovara-code -> @rovara/audit-verifier"]);
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

describe("vendor-pin: vendor/rovara-code equals its pin", () => {
  /** A "public" repository commit with two files, then the same files vendored with a pin. */
  function vendored(options: { pinInside?: boolean } = {}): { repo: Repo; commit: string; digest: string } {
    const repo = new Repo();
    repo.write("packages/contracts/src/index.ts", "export const a = 1;\n");
    repo.write("packages/worker/src/run.ts", 'import { a } from "@agentx/contracts";\nexport const r = a;\n');
    const commit = repo.commit();
    const files = git(repo.dir, "ls-files", "packages/contracts", "packages/worker").split("\n");
    for (const file of files) repo.write(`${VENDOR_DIR}/${file}`, repo.read(file));
    const digest = contentDigest(readVendor(repo.dir).entries);
    const pin = JSON.stringify({ commit, contentSha256: digest, paths: ["packages/contracts", "packages/worker"] });
    repo.write(options.pinInside === true ? PIN_FILES[1]! : PIN_FILES[0]!, `${pin}\n`);
    return { repo, commit, digest };
  }

  it("is skipped, with a note, while the folder does not exist", () => {
    const result = checkVendorPin(new Repo().dir);
    expect(result).toMatchObject({ check: "vendor-pin", status: "skipped" });
    expect(result.problems).toEqual([]);
  });

  it.each([false, true])("passes an exact copy, with the pin beside the folder or inside it (inside: %s)", (pinInside) => {
    const { repo } = vendored({ pinInside });
    expect(messages(checkVendorPin(repo.dir))).toEqual([]);
  });

  it("fails a copy with no pin file", () => {
    const { repo } = vendored();
    rmSync(join(repo.dir, PIN_FILES[0]!));
    expect(messages(checkVendorPin(repo.dir))).toEqual([expect.stringContaining("has no pin file")]);
  });

  it("names an edited file, a missing file and an extra file, against the pinned commit", () => {
    const { repo } = vendored();
    repo.write(`${VENDOR_DIR}/packages/contracts/src/index.ts`, "export const a = 2;\n");
    rmSync(join(repo.dir, VENDOR_DIR, "packages/worker/src/run.ts"));
    repo.write(`${VENDOR_DIR}/packages/worker/src/extra.ts`, "export {};\n");
    const text = messages(checkVendorPin(repo.dir)).join("\n");
    expect(text).toContain("does not match the pin's contentSha256");
    expect(text).toContain("changed: packages/contracts/src/index.ts");
    expect(text).toContain("missing: packages/worker/src/run.ts");
    expect(text).toContain("extra: packages/worker/src/extra.ts");
  });

  it("fails an edit even when the pinned commit is not in this clone (the digest alone catches it), and says what it could not compare", () => {
    const { repo, digest } = vendored();
    repo.write(PIN_FILES[0]!, `${JSON.stringify({ commit: "a".repeat(40), contentSha256: digest })}\n`);
    const noted = checkVendorPin(repo.dir);
    expect(noted.status).toBe("ok");
    expect(noted.note).toContain("not in this clone");
    repo.write(`${VENDOR_DIR}/packages/contracts/src/index.ts`, "export const a = 3;\n");
    expect(messages(checkVendorPin(repo.dir))).toEqual([expect.stringContaining("contentSha256")]);
  });

  it("fails a pin that was not updated with the copy, and a symlink in the copy", () => {
    const { repo, commit } = vendored();
    repo.write(PIN_FILES[0]!, `${JSON.stringify({ commit, contentSha256: "0".repeat(64), paths: ["packages/contracts", "packages/worker"] })}\n`);
    symlinkSync("/etc/hosts", join(repo.dir, VENDOR_DIR, "link"));
    const text = messages(checkVendorPin(repo.dir)).join("\n");
    expect(text).toContain("contentSha256");
    expect(text).toContain("a symlink in the vendored copy");
  });

  it.each([
    ["a pin that is not JSON", "{"],
    ["a pin with a short commit", JSON.stringify({ commit: "abc", contentSha256: "0".repeat(64) })],
    ["a pin with no digest", JSON.stringify({ commit: "a".repeat(40) })],
    ["a pin whose paths climb out", JSON.stringify({ commit: "a".repeat(40), contentSha256: "0".repeat(64), paths: ["../x"] })],
  ])("refuses %s", (_name, text) => {
    const { repo } = vendored();
    repo.write(PIN_FILES[0]!, text);
    expect(() => checkVendorPin(repo.dir)).toThrow();
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
    const publishJob = (guard: string, run: string): string => `jobs:\n  npm:\n    if: ${guard}\n    steps:\n      - run: |\n${run.split("\n").map((line) => `          ${line}`).join("\n")}\n`;
    const guard = "github.repository == 'PrepLabsAI/Rovara' && (vars.PUBLISH == 'true')";
    const good = 'npm run release:pack-cli -- --out out\nnpm publish "$RUNNER_TEMP"/cli/*.tgz --access public';

    it("accepts the packed CLI published from a job that runs only in the public repository", () => {
      expect(workflowPublishProblems("w.yml", publishJob(guard, good))).toEqual([]);
    });

    it("is not fooled by an echo or a comment that names a publish, and reads no job that does not publish", () => {
      expect(workflowPublishProblems("w.yml", publishJob("true", 'echo "run npm publish later"\n# npm publish -w packages/ui'))).toEqual([]);
    });

    it.each([
      ["a job with no public-repository guard", "true", good, "must run only in the public repository"],
      ["a guard that is only part of an OR", `vars.X == 'y' || ${guard}`, good, "must run only in the public repository"],
      ["a workspace publish", guard, 'npm run release:pack-cli\nnpm publish -w packages/ui "$T"/a.tgz', "workspace packages"],
      ["a workspaces publish", guard, "npm run release:pack-cli\nnpm publish --workspaces x.tgz", "workspace packages"],
      ["a publish of a folder", guard, "npm run release:pack-cli\nnpm publish packages/cli", "must name the tarball"],
      ["a publish after another command on the line", guard, "npm run release:pack-cli\ncd x && npm publish .", "must name the tarball"],
      ["a publish with no pack step", guard, 'npm publish "$T"/a.tgz', "without release:pack-cli"],
      ["a different publisher", guard, "npm run release:pack-cli\nyarn publish", "something other than"],
      ["changesets", guard, "npm run release:pack-cli\nnpx changeset publish", "something other than"],
    ])("fails %s", (_name, g, run, expected) => {
      expect(workflowPublishProblems("w.yml", publishJob(g, run)).map((p) => p.message).join("\n")).toContain(expected);
    });

    it("fails a workflow it cannot parse", () => {
      expect(workflowPublishProblems("w.yml", "jobs: [")[0]!.message).toContain("not valid YAML");
    });

    it("reads every workflow in the repository", () => {
      const repo = new Repo();
      repo.write(".github/workflows/other.yml", publishJob("true", 'npm run release:pack-cli\nnpm publish "$T"/a.tgz'));
      expect(messages(checkPublishedPackages(repo.dir)).join("\n")).toContain(".github/workflows/other.yml job npm");
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
        { specifier: "one", line: 1 },
        { specifier: "two", line: 2 },
        { specifier: "three", line: 3 },
        { specifier: "four", line: 4 },
      ]),
    );
    expect(specifiers(source).some((s) => s.specifier === "five")).toBe(false);
  });
});
