// Plan 3 Task 14b (R1-1, R3-1): the scan of a repository's default branch for workflows and bots that act on comments, issues or labels.
// Everything runs on an in-memory repository (tests/support/fake-repository.ts), so what was read, and how often, is read off the record.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { OrgId } from "@rovara-code/contracts";
import {
  BOT_CONFIG_PATHS,
  MAX_FILE_BYTES,
  repoCommandTriggers,
  scriptCandidates,
  workflowTriggers,
} from "../../packages/broker/src/agents/comment-trigger-scan.js";
import { memoryRunCache, taskRunCache } from "../../packages/broker/src/agents/run-cache.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { blobSha, treeReader, workflow, type TreeReaderOptions } from "../support/fake-repository.js";
import { TEST_ORG } from "../support/orgs.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const WORKFLOW = ".github/workflows/ci.yml";
const FAILED_DIGEST = "0".repeat(64);

const scan = (files: Record<string, string>, options: TreeReaderOptions = {}) =>
  repoCommandTriggers({ repositoryReader: async () => treeReader(files, options) }, { orgId: TEST_ORG, repository: "example/demo" });

describe("which workflows count as acting on comments", () => {
  it.each<[string, string]>([
    ["issue_comment", "issue_comment"],
    ["issue_comment with types", "\n  issue_comment:\n    types: [created]"],
    ["pull_request_review_comment", "pull_request_review_comment"],
    ["pull_request_review", "pull_request_review"],
    ["discussion", "discussion"],
    ["discussion_comment", "discussion_comment"],
    ["issues with no types", "issues"],
    ["issues opened", "\n  issues:\n    types: [opened]"],
    ["issues edited", "{ issues: { types: [edited] } }"],
    ["a list that includes issue_comment", "[push, issue_comment]"],
    ["pull_request_target labeled", "\n  pull_request_target:\n    types: [labeled]"],
    ["pull_request labeled among others", "\n  pull_request:\n    types: [opened, labeled]"],
    ["pull_request labeled as a bare string", "\n  pull_request:\n    types: labeled"],
    ["an upper-case event name", "ISSUE_COMMENT"],
    ["issue_comment beside push", "\n  push:\n    branches: [main]\n  issue_comment:"],
  ])("%s gives triggers: true", async (_name, on) => {
    const result = await scan({ [WORKFLOW]: workflow(on) });
    expect(result).toMatchObject({ triggers: true, failedClosed: false, files: [WORKFLOW] });
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.digest).not.toBe(FAILED_DIGEST);
  });

  it.each<[string, string]>([
    ["push", "push"],
    ["a list of push and workflow_dispatch", "[push, workflow_dispatch]"],
    ["schedule", "\n  schedule:\n    - cron: '0 0 * * *'"],
    ["pull_request with no types", "pull_request"],
    ["pull_request opened and synchronize", "\n  pull_request:\n    types: [opened, synchronize]"],
    ["pull_request_target with no types", "pull_request_target"],
    ["workflow_run", "\n  workflow_run:\n    workflows: [CI]\n    types: [completed]"],
    ["release", "\n  release:\n    types: [published]"],
  ])("%s gives triggers: false and an empty file list", async (_name, on) => {
    const result = await scan({ [WORKFLOW]: workflow(on) });
    expect(result).toMatchObject({ triggers: false, failedClosed: false, files: [], fileShas: {} });
    // Nothing found hashes to the digest of nothing, the same for every repository that has nothing.
    expect(result.digest).toBe(createHash("sha256").update("").digest("hex"));
  });

  it("reads `on` as a string key in YAML 1.2, and a key that still reads as the boolean true as `on` too", async () => {
    // A YAML 1.1 parser reads `on:` as true; this file spells the key that way on purpose.
    const result = await scan({ [WORKFLOW]: "name: w\ntrue:\n  issue_comment:\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo\n" });
    expect(result).toMatchObject({ triggers: true, failedClosed: false });
    expect(workflowTriggers({ true: { issue_comment: null } })).toBe(true);
    expect(workflowTriggers({ on: "push" })).toBe(false);
    // A key `on` wins over `true`.
    expect(workflowTriggers({ on: "push", true: "issue_comment" })).toBe(false);
    expect(workflowTriggers({})).toBe(false);
    expect(workflowTriggers({ on: 5 })).toBe(false);
    expect(workflowTriggers({ on: ["issue_comment", 7, null] })).toBe(true);
  });

  it("counts a `.yaml` workflow too, and nothing that is not a workflow file", async () => {
    expect((await scan({ ".github/workflows/a.yaml": workflow("issues") })).triggers).toBe(true);
    expect((await scan({ ".github/workflows/README.md": "issue_comment", ".github/workflows/notes.txt": "x" })).triggers).toBe(false);
  });

  it("answers false for a repository with no workflows and no bot config", async () => {
    expect(await scan({ "README.md": "hello" })).toMatchObject({ triggers: false, failedClosed: false, files: [] });
  });
});

describe("bot configs", () => {
  it.each(BOT_CONFIG_PATHS)("%s alone gives triggers: true and is listed and hashed", async (path) => {
    const text = "queue_rules: []\n";
    expect(await scan({ [path]: text })).toMatchObject({ triggers: true, failedClosed: false, files: [path], fileShas: { [path]: blobSha(text) } });
  });

  it("covers exactly the configs the plan names", () => {
    expect([...BOT_CONFIG_PATHS].sort()).toEqual([".github/.kodiak.toml", ".github/bors.toml", ".github/mergify.yml", ".kodiak.toml", ".mergify.yml", ".mergify/config.yml", "atlantis.yaml", "atlantis.yml", "bors.toml"].sort());
  });

  it("does not parse a bot config, so one that is not valid YAML still counts", async () => {
    expect(await scan({ ".mergify.yml": "{{{ not yaml" })).toMatchObject({ triggers: true, failedClosed: false });
  });

  it("lists a bot config beside a workflow that does not trigger, which is read too (round 3, B1)", async () => {
    expect(await scan({ [WORKFLOW]: workflow("push"), "bors.toml": "status = []" })).toMatchObject({ triggers: true, files: [WORKFLOW, "bors.toml"].sort() });
  });
});

describe("failing closed", () => {
  const closed = { triggers: true, failedClosed: true, digest: FAILED_DIGEST, files: [], fileShas: {} };

  it("answers triggers and failedClosed when the listing fails", async () => {
    expect(await scan({ [WORKFLOW]: workflow("push") }, { failingDirectories: [".github/workflows"] })).toEqual(closed);
  });

  it("answers triggers and failedClosed when a file can't be read", async () => {
    expect(await scan({ [WORKFLOW]: workflow("push") }, { failing: [WORKFLOW] })).toEqual(closed);
    expect(await scan({ [WORKFLOW]: workflow("push") }, { failing: ["bors.toml"] })).toEqual(closed);
  });

  it("answers triggers and failedClosed when the reader can't be made (no token, no installation)", async () => {
    const result = await repoCommandTriggers({ repositoryReader: async () => { throw new Error("GITHUB_NOT_CONNECTED"); } }, { orgId: TEST_ORG, repository: "example/demo" });
    expect(result).toEqual(closed);
  });

  it.each<[string, string]>([
    ["a file that does not parse", "on: [issue_comment\njobs: {"],
    ["a duplicate key", "on: push\non: issue_comment\n"],
    ["a file that is not a mapping", "- on: push\n"],
    ["an empty file", ""],
    ["an alias bomb", `a: &a [x, x, x, x, x, x, x, x, x, x]\n${Array.from({ length: 12 }, (_, index) => `b${String(index)}: &b${String(index)} [${Array.from({ length: 10 }, () => (index === 0 ? "*a" : `*b${String(index - 1)}`)).join(", ")}]`).join("\n")}\non: push\n`],
  ])("answers triggers and failedClosed for %s", async (_name, text) => {
    expect(await scan({ [WORKFLOW]: text })).toEqual(closed);
  });

  it("answers triggers and failedClosed for a truncated listing", async () => {
    expect(await scan({ [WORKFLOW]: workflow("push") }, { truncated: [".github/workflows"] })).toEqual(closed);
  });

  it("answers triggers and failedClosed for 101 workflow files, and not for 100", async () => {
    const many = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`.github/workflows/w${String(index)}.yml`, workflow("push")]));
    expect(await scan(many(101))).toEqual(closed);
    expect(await scan(many(100))).toMatchObject({ triggers: false, failedClosed: false });
  });

  it("answers triggers and failedClosed for a file over 512 KiB, by its listed size and by what a read finds", async () => {
    expect(MAX_FILE_BYTES).toBe(512 * 1024);
    expect(await scan({ [WORKFLOW]: workflow("push") }, { sizes: { [WORKFLOW]: MAX_FILE_BYTES + 1 } })).toEqual(closed);
    expect(await scan({ "bors.toml": "x".repeat(MAX_FILE_BYTES + 1) })).toEqual(closed);
    // At the limit it is read.
    expect(await scan({ "bors.toml": "x".repeat(MAX_FILE_BYTES) })).toMatchObject({ triggers: true, failedClosed: false });
  });

  it("answers triggers and failedClosed for a workflow entry that is not a plain file", async () => {
    for (const type of ["dir", "symlink", "submodule"] as const) {
      expect(await scan({ [WORKFLOW]: workflow("push") }, { types: { [WORKFLOW]: type } }), type).toEqual(closed);
    }
  });

  it("does not say why, so nothing from the repository is repeated", async () => {
    const result = await scan({ [WORKFLOW]: "secret-name: [unclosed" });
    expect(JSON.stringify(result)).not.toContain("secret-name");
  });

  it("answers triggers and failedClosed when the work takes too long", async () => {
    let clock = 0;
    const slow = treeReader({ [WORKFLOW]: workflow("issue_comment", "./scripts/a.sh"), "scripts/a.sh": "echo" });
    const result = await repoCommandTriggers({ repositoryReader: async () => ({ ...slow, read: async (path, max) => { clock += 30_000; return slow.read(path, max); } }), now: () => clock }, { orgId: TEST_ORG, repository: "example/demo" });
    expect(result).toEqual(closed);
  });
});

describe("what a triggering workflow reaches", () => {
  const trigger = (run = "echo hi", extra = "") => `name: w\non: issue_comment\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n${extra}      - run: ${run}\n`;

  it("hashes a script named in a run line, in each of the ways a script is run", async () => {
    for (const [run, path] of [
      ["./scripts/x.sh", "scripts/x.sh"], ["bash scripts/y.sh", "scripts/y.sh"], ["node tools/z.js", "tools/z.js"], ["python w.py", "w.py"],
      ["sh -e ./ci/run.sh --fast", "ci/run.sh"], ["source ci/env.sh", "ci/env.sh"], ["ts-node tools/t.ts", "tools/t.ts"], ["echo go && bash \"scripts/q.sh\"", "scripts/q.sh"],
      ["python3 -u tools/run.py", "tools/run.py"], ["scripts/direct.sh", "scripts/direct.sh"],
    ] as const) {
      const result = await scan({ [WORKFLOW]: trigger(run), [path]: "echo script" });
      expect(result.files, run).toEqual([WORKFLOW, path].sort());
      expect(result.fileShas[path], run).toBe(blobSha("echo script"));
    }
  });

  it("changes the digest when the script changes, and not when an unrelated file does", async () => {
    const base = { [WORKFLOW]: trigger("./scripts/x.sh"), "scripts/x.sh": "echo one", "docs/notes.md": "a" };
    const first = await scan(base);
    expect((await scan({ ...base, "scripts/x.sh": "echo two" })).digest).not.toBe(first.digest);
    expect((await scan({ ...base, "docs/notes.md": "b" })).digest).toBe(first.digest);
    expect((await scan({ ...base })).digest).toBe(first.digest);
  });

  it("ignores a path in a run line that is outside the repository", async () => {
    const result = await scan({ [WORKFLOW]: trigger("bash /etc/profile && bash ~/own.sh && curl https://example.com/x.sh") });
    expect(result).toMatchObject({ failedClosed: false, files: [WORKFLOW] });
  });

  it("follows a local action to its action.yml, and a composite action's own scripts and actions, transitively", async () => {
    const files = {
      [WORKFLOW]: trigger("echo hi", "      - uses: ./.github/actions/outer\n"),
      ".github/actions/outer/action.yml": "name: outer\nruns:\n  using: composite\n  steps:\n    - uses: ./.github/actions/inner\n    - run: ./scripts/outer.sh\n      shell: bash\n",
      ".github/actions/inner/action.yaml": "name: inner\nruns:\n  using: composite\n  steps:\n    - run: bash scripts/inner.sh\n      shell: bash\n",
      "scripts/outer.sh": "echo outer",
      "scripts/inner.sh": "echo inner",
    };
    const result = await scan(files);
    expect(result.files).toEqual([WORKFLOW, ".github/actions/outer/action.yml", ".github/actions/inner/action.yaml", "scripts/inner.sh", "scripts/outer.sh"].sort());
    const changed = await scan({ ...files, ".github/actions/inner/action.yaml": `${files[".github/actions/inner/action.yaml"]}# edit\n` });
    expect(changed.digest).not.toBe(result.digest);
    const deeper = await scan({ ...files, "scripts/inner.sh": "echo changed" });
    expect(deeper.digest).not.toBe(result.digest);
  });

  it("follows a reusable workflow, and the file a local action runs", async () => {
    const files = {
      [WORKFLOW]: `name: w\non: issue_comment\njobs:\n  call:\n    uses: ./.github/workflows/reuse.yml\n  act:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/js\n`,
      ".github/workflows/reuse.yml": "name: r\non: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: node tools/reuse.js\n",
      ".github/actions/js/action.yml": "name: js\nruns:\n  using: node20\n  main: dist/index.js\n  post: dist/post.js\n",
      ".github/actions/js/dist/index.js": "main()",
      ".github/actions/js/dist/post.js": "post()",
      "tools/reuse.js": "x",
    };
    const result = await scan(files);
    expect(result.files).toEqual([WORKFLOW, ".github/workflows/reuse.yml", ".github/actions/js/action.yml", ".github/actions/js/dist/index.js", ".github/actions/js/dist/post.js", "tools/reuse.js"].sort());
    // The reusable workflow does not trigger on its own and is not listed unless reached.
    expect((await scan({ ...files, [WORKFLOW]: workflow("push") })).files).toEqual([]);
  });

  it("follows a script that lives in a step's working directory", async () => {
    const files = { [WORKFLOW]: `name: w\non: issue_comment\njobs:\n  j:\n    runs-on: x\n    steps:\n      - working-directory: app\n        run: ./build.sh\n`, "app/build.sh": "echo build" };
    expect((await scan(files)).files).toEqual([WORKFLOW, "app/build.sh"].sort());
  });

  it("follows a root action named by uses: ./", async () => {
    const files = { [WORKFLOW]: trigger("echo", "      - uses: ./\n"), "action.yml": "name: root\nruns:\n  using: composite\n  steps:\n    - run: ./root.sh\n      shell: bash\n", "root.sh": "echo" };
    expect((await scan(files)).files).toEqual([WORKFLOW, "action.yml", "root.sh"].sort());
  });

  it("reads every workflow when the repository triggers, and what they reach (round 3, B1)", async () => {
    const files = { [WORKFLOW]: workflow("push", "./scripts/x.sh"), "scripts/x.sh": "echo", "bors.toml": "x" };
    const result = await scan(files);
    expect(result.files).toEqual([WORKFLOW, "bors.toml", "scripts/x.sh"].sort());
    expect(result.fileShas["bors.toml"]).toBe(blobSha("x"));
  });

  it("lists a remote action with its ref but does not hash it, so a different ref leaves the digest alone", async () => {
    const withRef = (ref: string) => ({ [WORKFLOW]: trigger("echo", `      - uses: actions/checkout@${ref}\n      - uses: acme/tools/deploy@${ref}\n      - uses: docker://alpine:3.20\n`) });
    const first = await scan(withRef("v4"));
    expect(first.files).toEqual(["acme/tools/deploy@v4", "actions/checkout@v4", "docker://alpine:3.20", WORKFLOW].sort());
    expect(Object.keys(first.fileShas)).toEqual([WORKFLOW]);
    // The digest covers the workflow's own blob and nothing of the actions it uses: what a remote ref points at is not read.
    expect(first.digest).toBe(createHash("sha256").update(`${WORKFLOW}\t${blobSha(withRef("v4")[WORKFLOW])}\n`).digest("hex"));
  });

  it("fails closed for a workflow that reaches more than 50 files, and not for 50", async () => {
    const scripts = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`scripts/s${String(index)}.sh`, "echo"]));
    const calling = (count: number) => ({ [WORKFLOW]: trigger(Array.from({ length: count }, (_, index) => `./scripts/s${String(index)}.sh`).join("; ")), ...scripts(count) });
    expect(await scan(calling(51))).toMatchObject({ triggers: true, failedClosed: true });
    expect(await scan(calling(50))).toMatchObject({ failedClosed: false });
    expect((await scan(calling(50))).files).toHaveLength(51);
  });

  it("fails closed for a reached file over 512 KiB", async () => {
    const files = { [WORKFLOW]: trigger("./scripts/big.sh"), "scripts/big.sh": "x".repeat(MAX_FILE_BYTES + 1) };
    expect(await scan(files)).toMatchObject({ triggers: true, failedClosed: true });
  });

  it("fails closed for a local action file that does not parse", async () => {
    const files = { [WORKFLOW]: trigger("echo", "      - uses: ./.github/actions/bad\n"), ".github/actions/bad/action.yml": "runs: [unclosed" };
    expect(await scan(files)).toMatchObject({ triggers: true, failedClosed: true });
  });

  it("goes around a loop of local actions", async () => {
    const files = {
      [WORKFLOW]: trigger("echo", "      - uses: ./.github/actions/a\n"),
      ".github/actions/a/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/b\n",
      ".github/actions/b/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/a\n",
    };
    expect((await scan(files)).files).toEqual([WORKFLOW, ".github/actions/a/action.yml", ".github/actions/b/action.yml"].sort());
  });

  it("makes the digest the SHA-256 of the sorted (path, blob sha) pairs", async () => {
    const files = { [WORKFLOW]: trigger("./scripts/x.sh"), "scripts/x.sh": "echo", "bors.toml": "b" };
    const result = await scan(files);
    const pairs = Object.keys(files).sort().map((path) => `${path}\t${blobSha(files[path as keyof typeof files])}\n`).join("");
    expect(result.digest).toBe(createHash("sha256").update(pairs).digest("hex"));
  });

  it("gives the same digest whatever order the files are listed in", async () => {
    const one = { [WORKFLOW]: workflow("issue_comment"), ".github/workflows/b.yml": workflow("issues"), "bors.toml": "x" };
    const two = { "bors.toml": "x", ".github/workflows/b.yml": workflow("issues"), [WORKFLOW]: workflow("issue_comment") };
    expect((await scan(one)).digest).toBe((await scan(two)).digest);
  });

  it("changes the digest when a triggering workflow is added or edited", async () => {
    const before = await scan({ [WORKFLOW]: workflow("issue_comment") });
    expect((await scan({ [WORKFLOW]: workflow("issue_comment"), ".github/workflows/new.yml": workflow("issues") })).digest).not.toBe(before.digest);
    expect((await scan({ [WORKFLOW]: workflow("issue_comment", "echo changed") })).digest).not.toBe(before.digest);
  });
});

describe("scriptCandidates", () => {
  it("finds paths after interpreters, with ./ and with a script extension, and leaves URLs and variables alone", () => {
    expect(scriptCandidates("bash scripts/a.sh\nnode tools/b.js && ./c.sh\npython d.py")).toEqual(["scripts/a.sh", "tools/b.js", "c.sh", "d.py"]);
    expect(scriptCandidates("curl https://example.com/x.sh | bash")).toEqual([]);
    expect(scriptCandidates("bash $SCRIPT_DIR/x.sh ${{ github.workspace }}/y.sh")).toEqual([]);
    expect(scriptCandidates("echo hi")).toEqual([]);
    expect(scriptCandidates("./a/../b.sh bash ../c.sh")).toEqual([]);
  });

  it("is bounded on a very long run block", () => {
    const run = Array.from({ length: 5_000 }, (_, index) => `./s${String(index)}.sh`).join("\n");
    expect(scriptCandidates(run).length).toBeLessThanOrEqual(200);
  });
});

describe("reading the default branch, once per repository per run", () => {
  it("reads one repository through one reader made for the org and the repository, at one commit", async () => {
    const made: Array<{ orgId: OrgId; repositoryUrl: string }> = [];
    const reader = treeReader({ [WORKFLOW]: workflow("issue_comment") });
    const result = await repoCommandTriggers({ repositoryReader: async (input) => { made.push(input); return reader; } }, { orgId: TEST_ORG, repository: "Example/Demo" });
    expect(result.triggers).toBe(true);
    expect(made).toEqual([{ orgId: TEST_ORG, repositoryUrl: "https://github.com/Example/Demo.git" }]);
    // Only the workflow listing and the fixed bot-config paths were read, and the file itself once.
    expect(reader.lists).toEqual([".github/workflows"]);
    expect(reader.reads).toEqual([WORKFLOW, ...BOT_CONFIG_PATHS, ".gitmodules"]);
  });

  it("scans once per repository per run when a cache is given, and again with none", async () => {
    let made = 0;
    const deps = (cache?: ReturnType<typeof memoryRunCache>) => ({ repositoryReader: async () => { made += 1; return treeReader({ [WORKFLOW]: workflow("issue_comment") }); }, ...(cache === undefined ? {} : { cache }) });
    const cache = memoryRunCache();
    const first = await repoCommandTriggers(deps(cache), { orgId: TEST_ORG, repository: "example/demo" });
    const second = await repoCommandTriggers(deps(cache), { orgId: TEST_ORG, repository: "Example/Demo" });
    expect(second).toEqual(first);
    expect(made).toBe(1);
    await repoCommandTriggers(deps(cache), { orgId: TEST_ORG, repository: "example/other" });
    expect(made).toBe(2);
    // Another org never shares an answer, nor does a run with a cache of its own.
    await repoCommandTriggers(deps(cache), { orgId: ORG_B, repository: "example/demo" });
    await repoCommandTriggers(deps(memoryRunCache()), { orgId: TEST_ORG, repository: "example/demo" });
    await repoCommandTriggers(deps(), { orgId: TEST_ORG, repository: "example/demo" });
    await repoCommandTriggers(deps(), { orgId: TEST_ORG, repository: "example/demo" });
    expect(made).toBe(6);
  });

  it("does not keep a scan that failed closed, so the next call tries again", async () => {
    let attempts = 0;
    const cache = memoryRunCache();
    const deps = { cache, repositoryReader: async () => { attempts += 1; if (attempts === 1) throw new Error("down"); return treeReader({ [WORKFLOW]: workflow("issue_comment") }); } };
    expect((await repoCommandTriggers(deps, { orgId: TEST_ORG, repository: "example/demo" })).failedClosed).toBe(true);
    expect((await repoCommandTriggers(deps, { orgId: TEST_ORG, repository: "example/demo" })).failedClosed).toBe(false);
    expect(attempts).toBe(2);
  });

  it("keeps nothing across runs: another task's cache reads again and sees a changed workflow", async () => {
    const db = new FakeDynamoDb();
    let files: Record<string, string> = { [WORKFLOW]: workflow("issue_comment") };
    let made = 0;
    const scanFor = (taskId: string) => repoCommandTriggers(
      { cache: taskRunCache({ documentClient: db, tableName: "state", now: Date.now }, { orgId: TEST_ORG, taskId }), repositoryReader: async () => { made += 1; return treeReader(files); } },
      { orgId: TEST_ORG, repository: "example/demo" },
    );
    const first = await scanFor("task-1");
    files = { ...files, "scripts/new.sh": "x", [WORKFLOW]: workflow("issue_comment", "./scripts/new.sh") };
    expect((await scanFor("task-1")).digest).toBe(first.digest);
    expect(made).toBe(1);
    expect((await scanFor("task-2")).digest).not.toBe(first.digest);
    expect(made).toBe(2);
  });

  it("hands the project's pinned installation to the reader, and only when there is one", async () => {
    const made: Array<Record<string, unknown>> = [];
    const deps = { repositoryReader: async (input: Record<string, unknown>) => { made.push(input); return treeReader({}); } };
    await repoCommandTriggers(deps, { orgId: TEST_ORG, repository: "example/demo", installationId: 55 });
    await repoCommandTriggers(deps, { orgId: TEST_ORG, repository: "example/demo" });
    expect(made).toEqual([{ orgId: TEST_ORG, repositoryUrl: "https://github.com/example/demo.git", installationId: 55 }, { orgId: TEST_ORG, repositoryUrl: "https://github.com/example/demo.git" }]);
  });

  it("refuses a repository that is not owner/name before reading anything", async () => {
    let made = 0;
    const deps = { repositoryReader: async () => { made += 1; return treeReader({}); } };
    for (const repository of ["", "demo", "a/b/c", "https://github.com/a/b", "a/b#c", "a/ b", "a/b\n", "../x", "a/..", "a/.", "-/b", "/b", "a/"]) {
      await expect(repoCommandTriggers(deps, { orgId: TEST_ORG, repository }), repository).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(made).toBe(0);
  });
});

describe("the run cache in the table", () => {
  const deps = (db: FakeDynamoDb) => ({ documentClient: db, tableName: "state", now: () => Date.parse("2026-10-22T00:00:00.000Z") });

  it("keeps a value under the org and the task, with an expiry", async () => {
    const db = new FakeDynamoDb();
    const cache = taskRunCache(deps(db), { orgId: TEST_ORG, taskId: "task-1" });
    await cache.set("repo-scan", "abc", { triggers: true });
    expect(await cache.get("repo-scan", "abc")).toEqual({ triggers: true });
    const [item] = db.find((candidate) => candidate.entityType === "RUN_CACHE");
    expect(item).toMatchObject({ pk: `ORG#${TEST_ORG}#RUN_CACHE#task-1`, sk: "repo-scan#abc", orgId: TEST_ORG, taskId: "task-1" });
    expect(item!.indexExpiresAt).toBe(Math.floor(Date.parse("2026-10-22T00:00:00.000Z") / 1000) + 30 * 86_400);
  });

  it("reads nothing for another org's or another task's value, or for an item that names another org", async () => {
    const db = new FakeDynamoDb();
    await taskRunCache(deps(db), { orgId: TEST_ORG, taskId: "task-1" }).set("repo-scan", "abc", { triggers: true });
    expect(await taskRunCache(deps(db), { orgId: ORG_B, taskId: "task-1" }).get("repo-scan", "abc")).toBeUndefined();
    expect(await taskRunCache(deps(db), { orgId: TEST_ORG, taskId: "task-2" }).get("repo-scan", "abc")).toBeUndefined();
    const [item] = db.find((candidate) => candidate.entityType === "RUN_CACHE");
    db.set({ ...item!, orgId: ORG_B });
    expect(await taskRunCache(deps(db), { orgId: TEST_ORG, taskId: "task-1" }).get("repo-scan", "abc")).toBeUndefined();
  });

  it("copies what it keeps, in memory too", async () => {
    const cache = memoryRunCache();
    const value = { list: [1] };
    await cache.set("k", "n", value);
    value.list.push(2);
    expect(await cache.get("k", "n")).toEqual({ list: [1] });
  });
});

// ---- Fix round 1 (review I1 to I4, M2 to M4)

describe("workflow_run chains (review I1)", () => {
  const A = ".github/workflows/a.yml";
  const B = ".github/workflows/b.yml";
  const C = ".github/workflows/c.yml";
  const chained = (name: string, from: string, run: string) => `name: ${name}\non:\n  workflow_run:\n    workflows: [${from}]\n    types: [completed]\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: ${run}\n`;
  const base = (): Record<string, string> => ({
    [A]: "name: Triage\non: issue_comment\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo hi\n",
    [B]: chained("Ship", "Triage", "./deploy.sh"),
    "deploy.sh": "echo deploy",
  });

  it("hashes a workflow_run workflow, and what it reaches, whenever the repository triggers", async () => {
    const result = await scan(base());
    expect(result.files).toEqual([A, B, "deploy.sh"].sort());
    expect((await scan({ ...base(), "deploy.sh": "echo changed" })).digest).not.toBe(result.digest);
    expect((await scan({ ...base(), [B]: chained("Ship", "Triage", "./deploy.sh --now") })).digest).not.toBe(result.digest);
  });

  it("hashes one that names no triggering workflow, a second link in the chain, and one added later", async () => {
    const files = { ...base(), [C]: chained("Notify", "Ship", "./notify.sh"), "notify.sh": "x", ".github/workflows/d.yml": chained("Other", "Something else", "./other.sh"), "other.sh": "y" };
    const result = await scan(files);
    expect(result.files).toEqual([A, B, C, ".github/workflows/d.yml", "deploy.sh", "notify.sh", "other.sh"].sort());
    expect((await scan({ ...base(), [C]: chained("Notify", "Ship", "./notify.sh"), "notify.sh": "x" })).digest).not.toBe((await scan(base())).digest);
  });

  it("reaches through a workflow_run workflow's local actions too", async () => {
    const files = { ...base(), [B]: `${base()[B]!}      - uses: ./.github/actions/ship\n`, ".github/actions/ship/action.yml": "runs:\n  using: composite\n  steps:\n    - run: ./ship.sh\n      shell: bash\n", "ship.sh": "z" };
    expect((await scan(files)).files).toEqual(expect.arrayContaining([".github/actions/ship/action.yml", "ship.sh"]));
  });

  it("does so when only a bot config makes the repository trigger, and not when nothing does", async () => {
    const withBot = await scan({ [B]: chained("Ship", "Triage", "./deploy.sh"), "deploy.sh": "x", "bors.toml": "status = []" });
    expect(withBot.files).toEqual([B, "bors.toml", "deploy.sh"].sort());
    expect(await scan({ [B]: chained("Ship", "Triage", "./deploy.sh"), "deploy.sh": "x" })).toMatchObject({ triggers: false, files: [] });
  });

  it("reads `on: workflow_run` in every spelling", async () => {
    for (const on of ["workflow_run", "[push, workflow_run]", "{ workflow_run: { workflows: [Triage] } }"]) {
      const text = `name: S\non: ${on}\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: ./deploy.sh\n`;
      expect((await scan({ ...base(), [B]: text })).files, on).toEqual([A, B, "deploy.sh"].sort());
    }
  });
});

describe("what a local action's directory holds (review I2)", () => {
  const WORKFLOW_FILE = ".github/workflows/ci.yml";
  const using = (path: string) => `name: w\non: issue_comment\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: ${path}\n`;
  const action = (run: string) => `name: ship\nruns:\n  using: composite\n  steps:\n    - run: ${run}\n      shell: bash\n`;
  const DIR = ".github/actions/ship";

  it.each<[string, string, string]>([
    ["${{ github.action_path }}/ship.sh", "ship.sh", "script"],
    ["${{github.action_path}}/ship.sh", "ship.sh", "script, no spaces"],
    ["bash $GITHUB_ACTION_PATH/ship.sh", "ship.sh", "variable"],
    ["bash ${GITHUB_ACTION_PATH}/ship.sh", "ship.sh", "braced variable"],
    ["$GITHUB_ACTION_PATH/ship", "ship", "extensionless script"],
    ["${{ github.action_path }}/bin/tool", "bin/tool", "nested extensionless script"],
  ])("hashes a script run through the action path: %s (%s)", async (run, name) => {
    const files = { [WORKFLOW_FILE]: using("./.github/actions/ship"), [`${DIR}/action.yml`]: action(run), [`${DIR}/${name}`]: "echo one" };
    const result = await scan(files);
    expect(result.files).toContain(`${DIR}/${name}`);
    expect((await scan({ ...files, [`${DIR}/${name}`]: "echo two" })).digest).not.toBe(result.digest);
  });

  it.each<[string, string]>([
    ["${{ github.workspace }}/scripts/w.sh", "scripts/w.sh"],
    ["$GITHUB_WORKSPACE/scripts/w.sh", "scripts/w.sh"],
    ["${GITHUB_WORKSPACE}/scripts/w", "scripts/w"],
  ])("hashes a script run through the workspace: %s", async (run, path) => {
    const files = { [WORKFLOW_FILE]: using("./.github/actions/ship"), [`${DIR}/action.yml`]: action(run), [path]: "echo one" };
    expect((await scan(files)).files).toContain(path);
    // The same in a workflow's own run line.
    const inWorkflow = { [WORKFLOW_FILE]: `name: w\non: issue_comment\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: ${run}\n`, [path]: "echo one" };
    expect((await scan(inWorkflow)).files).toContain(path);
  });

  it("hashes every file under a local action's directory, nested ones included, though no run line names them", async () => {
    const files = { [WORKFLOW_FILE]: using("./.github/actions/ship"), [`${DIR}/action.yml`]: action("echo hi"), [`${DIR}/lib/helper.js`]: "one", [`${DIR}/lib/deep/data.json`]: "{}", [`${DIR}/README.md`]: "r" };
    const result = await scan(files);
    expect(result.files).toEqual([WORKFLOW_FILE, `${DIR}/action.yml`, `${DIR}/lib/helper.js`, `${DIR}/lib/deep/data.json`, `${DIR}/README.md`].sort());
    expect((await scan({ ...files, [`${DIR}/lib/deep/data.json`]: "{\"a\":1}" })).digest).not.toBe(result.digest);
  });

  it("counts the directory's files against the 50, failing closed beyond them", async () => {
    const dir = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`${DIR}/f${String(index)}.txt`, "x"]));
    expect(await scan({ [WORKFLOW_FILE]: using("./.github/actions/ship"), [`${DIR}/action.yml`]: action("echo"), ...dir(49) })).toMatchObject({ failedClosed: false });
    expect(await scan({ [WORKFLOW_FILE]: using("./.github/actions/ship"), [`${DIR}/action.yml`]: action("echo"), ...dir(50) })).toMatchObject({ triggers: true, failedClosed: true });
  });

  it("fails closed for an entry of the directory it can't read (a link, a submodule) and for a truncated directory listing", async () => {
    const files = { [WORKFLOW_FILE]: using("./.github/actions/ship"), [`${DIR}/action.yml`]: action("echo"), [`${DIR}/link`]: "target" };
    expect(await scan(files, { types: { [`${DIR}/link`]: "symlink" } })).toMatchObject({ failedClosed: true });
    expect(await scan(files, { truncated: [DIR] })).toMatchObject({ failedClosed: true });
  });

  it("leaves a root action to its action file: the whole repository is not its directory", async () => {
    const files = { [WORKFLOW_FILE]: using("./"), "action.yml": action("echo"), "src/big.ts": "x", "README.md": "r" };
    expect((await scan(files)).files).toEqual([WORKFLOW_FILE, "action.yml"].sort());
  });
});

describe("defaults.run.working-directory (review I3)", () => {
  const WORKFLOW_FILE = ".github/workflows/ci.yml";

  it("applies the workflow's default to a step's script", async () => {
    const files = { [WORKFLOW_FILE]: "name: w\non: issue_comment\ndefaults:\n  run:\n    working-directory: tools\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: ./deploy.sh\n", "tools/deploy.sh": "one" };
    const result = await scan(files);
    expect(result.files).toContain("tools/deploy.sh");
    expect((await scan({ ...files, "tools/deploy.sh": "two" })).digest).not.toBe(result.digest);
  });

  it("applies a job's default, which wins over the workflow's", async () => {
    const files = {
      [WORKFLOW_FILE]: "name: w\non: issue_comment\ndefaults:\n  run:\n    working-directory: wf\njobs:\n  j:\n    runs-on: x\n    defaults:\n      run:\n        working-directory: job\n    steps:\n      - run: ./deploy.sh\n  k:\n    runs-on: x\n    steps:\n      - run: ./other.sh\n",
      "job/deploy.sh": "one", "wf/deploy.sh": "no", "wf/other.sh": "three",
    };
    const result = await scan(files);
    expect(result.files).toEqual(expect.arrayContaining(["job/deploy.sh", "wf/other.sh"]));
    expect(result.files).not.toContain("wf/deploy.sh");
  });

  it("lets a step's own working-directory win over the defaults", async () => {
    const files = {
      [WORKFLOW_FILE]: "name: w\non: issue_comment\ndefaults:\n  run:\n    working-directory: a\njobs:\n  j:\n    runs-on: x\n    steps:\n      - working-directory: b\n        run: ./x.sh\n",
      "a/x.sh": "no", "b/x.sh": "yes",
    };
    const result = await scan(files);
    expect(result.files).toContain("b/x.sh");
    expect(result.files).not.toContain("a/x.sh");
  });

  it("applies a default in a composite action to its steps", async () => {
    const files = {
      [WORKFLOW_FILE]: "name: w\non: issue_comment\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: ./act\n",
      "act/action.yml": "runs:\n  using: composite\n  steps:\n    - working-directory: sub\n      run: ./go.sh\n      shell: bash\n",
      "sub/go.sh": "x",
    };
    expect((await scan(files)).files).toContain("sub/go.sh");
  });
});

describe("what a files entry may be (review I4)", () => {
  const trigger = (extra: string, run = "echo") => `name: w\non: issue_comment\njobs:\n  j:\n    runs-on: x\n    steps:\n${extra}      - run: ${run}\n`;

  it.each<[string]>([
    ["actions/checkout@v4"], ["acme/tools/deploy@v1.2.3"], ["acme/tools/.github/workflows/x.yml@refs/heads/main"], ["docker://alpine:3.20"], ["docker://ghcr.io/acme/tool@sha256:abc123"],
  ])("lists the remote action %s", async (uses) => {
    const result = await scan({ [WORKFLOW]: trigger(`      - uses: ${uses}\n`) });
    expect(result).toMatchObject({ failedClosed: false });
    expect(result.files).toContain(uses);
  });

  it.each<[string, string]>([
    ["a bidi override and an escape", "evil/x@v1\\u202E\\u001b[2J"],
    ["a zero-width space", "evil/x@v1\\u200B"],
    ["a name with no ref", "just-a-name"],
    ["an owner/repo with no @ref", "acme/tools"],
    ["a space", "acme/to ols@v1"],
    ["a docker image with a space", "docker://alpine 3.20"],
    ["an empty docker reference", "docker://"],
    ["a ref with a quote", "acme/tools@v1'x"],
  ])("fails closed for a remote action with %s", async (_name, uses) => {
    expect(await scan({ [WORKFLOW]: trigger(`      - uses: "${uses}"\n`) })).toMatchObject({ triggers: true, failedClosed: true, files: [] });
  });

  it("fails closed for a path with a control or format character, in a listed file, a script and a bot config", async () => {
    const bidi = "tools/\u202Ehs.yolped";
    expect(await scan({ [WORKFLOW]: trigger("", `./${bidi}`), [bidi]: "x" })).toMatchObject({ triggers: true, failedClosed: true });
    expect(await scan({ ".github/workflows/\u200Bci.yml": workflow("issue_comment") })).toMatchObject({ triggers: true, failedClosed: true });
    // The same path with no file there is a named file that is missing: also closed, and nothing odd is listed.
    expect(await scan({ [WORKFLOW]: trigger("", `./${bidi}`) })).toMatchObject({ failedClosed: true, files: [] });
  });
});

describe("the same repository named remotely (review M3)", () => {
  const deploy = ".github/workflows/deploy.yml";
  const caller = (uses: string) => `name: w\non: issue_comment\njobs:\n  call:\n    uses: ${uses}\n`;
  const reusable = "name: d\non: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: ./go.sh\n";

  it("hashes a reusable workflow or action of this repository named at its default branch as a local file", async () => {
    const files = { [WORKFLOW]: caller(`example/demo/${deploy}@main`), [deploy]: reusable, "go.sh": "x" };
    const result = await scan(files);
    expect(result.files).toEqual([WORKFLOW, deploy, "go.sh"].sort());
    expect(result.files.some((file) => file.includes("@"))).toBe(false);
    expect((await scan({ ...files, "go.sh": "y" })).digest).not.toBe(result.digest);
    const action = await scan({ [WORKFLOW]: `name: w\non: issue_comment\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: Example/Demo/.github/actions/x@main\n`, ".github/actions/x/action.yml": "runs:\n  using: composite\n  steps: []\n" });
    expect(action.files).toContain(".github/actions/x/action.yml");
  });

  it("keeps another ref of this repository, and another repository, as remote and unhashed", async () => {
    // The reusable file is a workflow of this repository, so it is read whichever way it is named; the remote name is listed and not hashed.
    const files = { [WORKFLOW]: caller(`example/demo/${deploy}@v1`), [deploy]: reusable, "go.sh": "x" };
    expect((await scan(files)).files).toEqual([WORKFLOW, deploy, "go.sh", `example/demo/${deploy}@v1`].sort());
    expect((await scan({ ...files, [WORKFLOW]: caller(`example/other/${deploy}@main`) })).files).toEqual([WORKFLOW, deploy, "go.sh", `example/other/${deploy}@main`].sort());
  });
});

describe("package managers and make (review M4)", () => {
  const trigger = (run: string, extra = "") => `name: w\non: issue_comment\njobs:\n  j:\n    runs-on: x\n${extra}    steps:\n      - run: ${run}\n`;

  it.each<[string, string]>([
    ["npm run triage", "package.json"], ["npm ci && npm test", "package.json"], ["yarn deploy", "package.json"], ["pnpm run x", "package.json"], ["npx tsx go", "package.json"],
    ["make deploy", "Makefile"], ["make -C app deploy", "Makefile"],
  ])("hashes %s's manifest (%s)", async (run, manifest) => {
    const files = { [WORKFLOW]: trigger(run), [manifest]: "one" };
    const result = await scan(files);
    expect(result.files).toContain(manifest);
    expect((await scan({ ...files, [manifest]: "two" })).digest).not.toBe(result.digest);
  });

  it("hashes the manifest in a step's working directory too, ignores one that is not there, and hashes nothing for a workflow that runs neither", async () => {
    const files = { [WORKFLOW]: `name: w\non: issue_comment\njobs:\n  j:\n    runs-on: x\n    steps:\n      - working-directory: app\n        run: npm run x\n`, "app/package.json": "x", "package.json": "y" };
    expect((await scan(files)).files).toEqual([WORKFLOW, "app/package.json", "package.json"].sort());
    expect((await scan({ [WORKFLOW]: trigger("npm test") })).files).toEqual([WORKFLOW]);
    expect((await scan({ [WORKFLOW]: trigger("echo hi"), "package.json": "x", Makefile: "y" })).files).toEqual([WORKFLOW]);
  });
});

// ---- Fix round 2 (re-check: what the scan can't resolve fails closed)

const closedScan = { triggers: true, failedClosed: true, files: [] as string[] };
/** A workflow that triggers, with the given job body (YAML text under `j:`) and optional text before `jobs:`. */
const workflowWith = (job: string, before = "") => `name: w\non: issue_comment\n${before}jobs:\n  j:\n    runs-on: x\n${job}`;
const steps = (...lines: string[]) => `    steps:\n${lines.map((line) => `      ${line}`).join("\n")}\n`;

describe("an expression in a path position fails closed (round 2, item 1)", () => {
  it.each<[string, string]>([
    ["a script named by a matrix value", "bash ${{ matrix.script }}"],
    ["a script after ./ built from a matrix value", "./${{ matrix.script }}"],
    ["a script path starting with an expression", "${{ matrix.dir }}/run.sh"],
    ["an interpreter's file from an input", "python ${{ inputs.file }}"],
    ["the command itself", "${{ inputs.cmd }} now"],
    ["a variable in a script path", "./scripts/$NAME.sh"],
    ["a variable as the command", "$TOOL --go"],
    ["a variable after an interpreter", "bash $SCRIPT"],
    ["an expression inside quotes", "bash \"${{ matrix.script }}\""],
    ["an expression in a later command of a pipeline", "echo hi && bash ${{ matrix.script }}"],
  ])("fails closed for %s", async (_name, run) => {
    expect(await scan({ [WORKFLOW]: workflowWith(steps(`- run: ${run}`)) })).toMatchObject(closedScan);
  });

  it.each<[string, string]>([
    ["a step's working directory from a matrix", "- working-directory: ${{ matrix.dir }}\n        run: ./x.sh"],
    ["a step's working directory from env", "- working-directory: ${{ env.D }}/tools\n        run: ./x.sh"],
    ["a shell chosen by a matrix", "- shell: ${{ matrix.shell }}\n        run: echo hi"],
    ["a local action chosen by a matrix", "- uses: ./${{ matrix.dir }}"],
    ["a remote action chosen by a matrix", "- uses: ${{ matrix.action }}"],
  ])("fails closed for %s", async (_name, step) => {
    expect(await scan({ [WORKFLOW]: workflowWith(steps(step)) })).toMatchObject(closedScan);
  });

  it("fails closed for an expression in a default working directory, at workflow and job level", async () => {
    expect(await scan({ [WORKFLOW]: workflowWith(steps("- run: ./x.sh"), "defaults:\n  run:\n    working-directory: ${{ env.D }}\n") })).toMatchObject(closedScan);
    expect(await scan({ [WORKFLOW]: workflowWith(`    defaults:\n      run:\n        working-directory: \${{ env.D }}\n${steps("- run: ./x.sh")}`) })).toMatchObject(closedScan);
  });

  it("lets an expression stand where it is not a path: arguments, messages and package manager scripts", async () => {
    for (const run of ["echo ${{ github.sha }}", "gh pr comment ${{ github.event.issue.number }} --body hi", "npm run ${{ matrix.script }}", "curl -d '${{ toJSON(github.event) }}' https://example.com/hook", "echo \"v=${{ steps.a.outputs.v }}\" >> $GITHUB_OUTPUT"]) {
      expect(await scan({ [WORKFLOW]: workflowWith(steps(`- run: ${run}`)) }), run).toMatchObject({ failedClosed: false });
    }
  });

  it("still substitutes github.workspace and github.action_path, now in working-directory too", async () => {
    const files = { [WORKFLOW]: workflowWith(steps("- working-directory: ${{ github.workspace }}/tools\n        run: ./x.sh")), "tools/x.sh": "one" };
    const result = await scan(files);
    expect(result).toMatchObject({ failedClosed: false });
    expect(result.files).toContain("tools/x.sh");
    const inAction = {
      [WORKFLOW]: workflowWith(steps("- uses: ./.github/actions/ship")),
      ".github/actions/ship/action.yml": "runs:\n  using: composite\n  steps:\n    - working-directory: ${{ github.action_path }}/bin\n      run: ./go.sh\n      shell: bash\n",
      ".github/actions/ship/bin/go.sh": "x",
    };
    expect(await scan(inAction)).toMatchObject({ failedClosed: false });
    expect((await scan({ [WORKFLOW]: workflowWith(steps("- working-directory: $GITHUB_WORKSPACE/tools\n        run: ./x.sh")), "tools/x.sh": "one" })).files).toContain("tools/x.sh");
  });

  it("does not look at a workflow that does not trigger and reaches nothing", async () => {
    expect(await scan({ [WORKFLOW]: "name: w\non: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: bash ${{ matrix.script }}\n" })).toMatchObject({ triggers: false, failedClosed: false });
  });
});

describe("cd, pushd and popd fail closed (round 2, item 2)", () => {
  it.each<[string]>([
    ["cd tools && ./x.sh"], ["pushd tools; ./x.sh; popd"], ["popd"], ["bash -c 'cd scripts && ./x.sh'"], ["sh -euc \"cd scripts; ./x.sh\""], ["echo go\ncd scripts\n./x.sh"], ["(cd tools && make)"],
  ])("fails closed for %j", async (run) => {
    expect(await scan({ [WORKFLOW]: workflowWith(`    steps:\n      - run: |\n${run.split("\n").map((line) => `          ${line}`).join("\n")}\n`), "scripts/x.sh": "x", "tools/x.sh": "x" })).toMatchObject(closedScan);
  });

  it("leaves a word that merely contains cd alone, and a cd in a workflow nothing reaches", async () => {
    expect(await scan({ [WORKFLOW]: workflowWith(steps("- run: echo abcd cdrom && ./x.sh")), "x.sh": "x" })).toMatchObject({ failedClosed: false });
    expect(await scan({ [WORKFLOW]: workflow("push", "cd tools") })).toMatchObject({ failedClosed: false });
  });
});

describe("a path that leaves the folder fails closed (round 2, item 3)", () => {
  it.each<[string, string]>([
    ["a script above the working directory", "- working-directory: tools\n        run: ../bin/y.sh"],
    ["a script above the root", "- run: ../outside.sh"],
    ["a script after an interpreter", "- run: bash ../c.sh"],
    ["a middle ..", "- run: ./a/../b.sh"],
    ["a working directory above the root", "- working-directory: ../x\n        run: ./y.sh"],
    ["a glob", "- run: bash scripts/*.sh"],
    ["a brace expansion", "- run: bash scripts/{a,b}.sh"],
  ])("fails closed for %s", async (_name, step) => {
    expect(await scan({ [WORKFLOW]: workflowWith(steps(step)), "bin/y.sh": "x" })).toMatchObject(closedScan);
  });

  it("fails closed for a local action path that can't be resolved, and ignores absolute and home paths", async () => {
    expect(await scan({ [WORKFLOW]: workflowWith(steps("- uses: ./../elsewhere")) })).toMatchObject(closedScan);
    expect(await scan({ [WORKFLOW]: workflowWith(steps("- run: bash /opt/tool/run.sh && bash ~/mine.sh")) })).toMatchObject({ failedClosed: false });
  });
});

describe("BASH_ENV and a custom shell (round 2, item 4)", () => {
  const files = { "scripts/env.sh": "export A=1", "scripts/wrap.sh": "echo wrapped" };

  it("hashes the file BASH_ENV names, at workflow, job and step level and in a run line", async () => {
    for (const where of [
      workflowWith(steps("- run: echo hi"), "env:\n  BASH_ENV: ./scripts/env.sh\n"),
      workflowWith(`    env:\n      BASH_ENV: scripts/env.sh\n${steps("- run: echo hi")}`),
      workflowWith(steps("- env:\n          BASH_ENV: ./scripts/env.sh\n        run: echo hi")),
      workflowWith(steps("- run: BASH_ENV=./scripts/env.sh bash -e x")),
    ]) {
      const result = await scan({ [WORKFLOW]: where, ...files });
      expect(result.files, where).toContain("scripts/env.sh");
      expect((await scan({ [WORKFLOW]: where, ...files, "scripts/env.sh": "export A=2" })).digest).not.toBe(result.digest);
    }
  });

  it("fails closed for a BASH_ENV it can't resolve", async () => {
    expect(await scan({ [WORKFLOW]: workflowWith(steps("- run: echo hi"), "env:\n  BASH_ENV: ${{ matrix.env }}\n") })).toMatchObject(closedScan);
    expect(await scan({ [WORKFLOW]: workflowWith(steps("- run: echo hi"), "env:\n  BASH_ENV: $HOME/.bashrc\n") })).toMatchObject(closedScan);
    // A file outside the repository is not one of its files.
    expect(await scan({ [WORKFLOW]: workflowWith(steps("- run: echo hi"), "env:\n  BASH_ENV: /etc/bash.env\n") })).toMatchObject({ failedClosed: false });
  });

  it("hashes a custom shell that is a plain path, and leaves the standard shells and their flags alone", async () => {
    const custom = await scan({ [WORKFLOW]: workflowWith(steps("- shell: ./scripts/wrap.sh {0}\n        run: echo hi")), ...files });
    expect(custom.files).toContain("scripts/wrap.sh");
    expect((await scan({ [WORKFLOW]: workflowWith(steps("- shell: ./scripts/wrap.sh {0}\n        run: echo hi")), ...files, "scripts/wrap.sh": "other" })).digest).not.toBe(custom.digest);
    for (const shell of ["bash", "sh", "pwsh", "python", "cmd", "powershell", "bash --noprofile --norc -eo pipefail {0}", "pwsh -command \". '{0}'\""]) {
      expect(await scan({ [WORKFLOW]: workflowWith(steps(`- shell: ${shell}\n        run: echo hi`)) }), shell).toMatchObject({ failedClosed: false });
    }
    const inDefaults = await scan({ [WORKFLOW]: workflowWith(steps("- run: echo hi"), "defaults:\n  run:\n    shell: ./scripts/wrap.sh {0}\n"), ...files });
    expect(inDefaults.files).toContain("scripts/wrap.sh");
  });

  it("fails closed for a custom shell that is neither a plain path nor a standard shell", async () => {
    expect(await scan({ [WORKFLOW]: workflowWith(steps("- shell: wrapper {0}\n        run: echo hi")) })).toMatchObject(closedScan);
    expect(await scan({ [WORKFLOW]: workflowWith(steps("- shell: ${{ matrix.shell }}\n        run: echo hi")) })).toMatchObject(closedScan);
    expect(await scan({ [WORKFLOW]: workflowWith(steps("- shell: ./scripts/$SHELLNAME {0}\n        run: echo hi")) })).toMatchObject(closedScan);
  });
});

describe("a script that runs another script (round 2, item 5)", () => {
  const caller = (run: string) => workflowWith(steps(`- run: ${run}`));

  it("follows the paths in a shell script's text, transitively, and hashes each", async () => {
    const files = { [WORKFLOW]: caller("./a.sh"), "a.sh": "#!/bin/bash\n./b.sh\n", "b.sh": "echo b\nsource scripts/c.sh\nbash tools/d", "scripts/c.sh": "echo c", "tools/d": "echo d" };
    const result = await scan(files);
    expect(result.files).toEqual([WORKFLOW, "a.sh", "b.sh", "scripts/c.sh", "tools/d"].sort());
    for (const changed of ["scripts/c.sh", "tools/d", "b.sh"]) expect((await scan({ ...files, [changed]: "echo changed" })).digest, changed).not.toBe(result.digest);
  });

  it("reads a script by its shebang when it has no extension, and leaves a file that is not a shell script alone", async () => {
    const files = { [WORKFLOW]: caller("./tools/run"), "tools/run": "#!/usr/bin/env bash\n./helper.sh\n", "helper.sh": "x" };
    expect((await scan(files)).files).toContain("helper.sh");
    expect((await scan({ ...files, "tools/run": "\u007fELF ./helper.sh" })).files).not.toContain("helper.sh");
    // A script in another language is hashed, and what it imports is an accepted residual risk.
    expect((await scan({ [WORKFLOW]: caller("node tools/go.js"), "tools/go.js": "require('./lib.sh'); // ./helper.sh", "helper.sh": "x" })).files).toEqual([WORKFLOW, "tools/go.js"].sort());
  });

  it("leaves a positional parameter alone: what the caller passed is read in the caller", async () => {
    const files = { [WORKFLOW]: caller("./wrap.sh ./real.sh"), "wrap.sh": "#!/bin/sh\nexec \"$@\"\nbash \"$1\"\n", "real.sh": "x" };
    const result = await scan(files);
    expect(result).toMatchObject({ failedClosed: false });
    expect(result.files).toEqual([WORKFLOW, "wrap.sh", "real.sh"].sort());
  });

  it("goes round a loop of scripts", async () => {
    const files = { [WORKFLOW]: caller("./a.sh"), "a.sh": "./b.sh", "b.sh": "./a.sh" };
    expect((await scan(files)).files).toEqual([WORKFLOW, "a.sh", "b.sh"].sort());
  });

  it("counts the chain against the 50 files, failing closed beyond it", async () => {
    const chain = (length: number) => ({ [WORKFLOW]: caller("./s0.sh"), ...Object.fromEntries(Array.from({ length }, (_, index) => [`s${String(index)}.sh`, index + 1 < length ? `./s${String(index + 1)}.sh` : "echo end"])) });
    expect(await scan(chain(50))).toMatchObject({ failedClosed: false });
    expect(await scan(chain(51))).toMatchObject(closedScan);
  });

  it.each<[string, string]>([
    ["a cd", "cd scripts\n./c.sh"],
    ["a path from a variable", "source \"$DIR/lib.sh\""],
    ["a path from the script's own folder", "source \"$(dirname \"$0\")/lib.sh\""],
    ["a path above the folder", "bash ../up.sh"],
    ["an expansion", "bash scripts/*.sh"],
  ])("fails closed for a script holding %s", async (_name, text) => {
    expect(await scan({ [WORKFLOW]: caller("./a.sh"), "a.sh": `#!/bin/bash\n${text}\n` })).toMatchObject(closedScan);
  });

  it("hashes package.json and Makefile for a script that runs npm or make", async () => {
    const files = { [WORKFLOW]: caller("./a.sh"), "a.sh": "npm run build\nmake all", "package.json": "{}", Makefile: "all:" };
    expect((await scan(files)).files).toEqual([WORKFLOW, "a.sh", "package.json", "Makefile"].sort());
  });

  it("scans the shell scripts in a local action's folder too", async () => {
    const files = {
      [WORKFLOW]: caller("echo").replace("- run: echo", "- uses: ./.github/actions/ship"),
      ".github/actions/ship/action.yml": "runs:\n  using: composite\n  steps: []\n",
      ".github/actions/ship/go.sh": "#!/bin/sh\n./outside.sh\n", "outside.sh": "x",
    };
    expect((await scan(files)).files).toContain("outside.sh");
  });
});

describe("a script in a local action's folder (round 2, mutant)", () => {
  it("reads $GITHUB_ACTION_PATH in it as that folder, not the root", async () => {
    const files = {
      [WORKFLOW]: workflowWith(steps("- uses: ./.github/actions/ship")),
      ".github/actions/ship/action.yml": "runs:\n  using: composite\n  steps: []\n",
      ".github/actions/ship/go.sh": "#!/bin/sh\nsource $GITHUB_ACTION_PATH/extra/lib.sh\n",
      ".github/actions/ship/extra/lib.sh": "inside", "extra/lib.sh": "at the root",
    };
    const result = await scan(files);
    expect(result.files).toContain(".github/actions/ship/extra/lib.sh");
    expect(result.files).not.toContain("extra/lib.sh");
  });
});

describe("a root action (round 2, item 6)", () => {
  const using = workflowWith(steps("- uses: ./"));

  it("fails closed for a root action that is not composite: its code is anywhere in the repository", async () => {
    expect(await scan({ [WORKFLOW]: using, "action.yml": "runs:\n  using: node20\n  main: index.js\n", "index.js": "x", "lib.js": "y" })).toMatchObject(closedScan);
    expect(await scan({ [WORKFLOW]: using, "action.yml": "runs:\n  using: docker\n  image: Dockerfile\n", Dockerfile: "FROM x" })).toMatchObject(closedScan);
    expect(await scan({ [WORKFLOW]: using, "action.yml": "name: no runs here\n" })).toMatchObject(closedScan);
  });

  it("follows a composite root action through the action path, which the root's folder is not hashed for", async () => {
    const files = { [WORKFLOW]: using, "action.yml": "runs:\n  using: composite\n  steps:\n    - run: ${{ github.action_path }}/helper.sh\n      shell: bash\n", "helper.sh": "one" };
    const result = await scan(files);
    expect(result.files).toEqual([WORKFLOW, "action.yml", "helper.sh"].sort());
    expect((await scan({ ...files, "helper.sh": "two" })).digest).not.toBe(result.digest);
  });

  it.each<[string, string]>([
    ["${{ github.action_path }}/helper.sh", "helper.sh"],
    ["$GITHUB_ACTION_PATH/helper", "helper"],
    ["bash ${GITHUB_ACTION_PATH}/bin/tool", "bin/tool"],
  ])("hashes a script of a root action run through the action path: %s", async (run, name) => {
    const files = { [WORKFLOW]: using, "action.yml": `runs:\n  using: composite\n  steps:\n    - run: ${run}\n      shell: bash\n`, [name]: "one" };
    const result = await scan(files);
    expect(result.files).toContain(name);
    expect((await scan({ ...files, [name]: "two" })).digest).not.toBe(result.digest);
  });
});

describe("this repository at refs/heads/<default branch> (round 2, item 7)", () => {
  it("is the same file as at the branch name", async () => {
    const deploy = ".github/workflows/deploy.yml";
    const files = {
      [WORKFLOW]: `name: w\non: issue_comment\njobs:\n  call:\n    uses: example/demo/${deploy}@refs/heads/main\n`,
      [deploy]: "name: d\non: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: ./go.sh\n", "go.sh": "x",
    };
    const result = await scan(files);
    expect(result.files).toEqual([WORKFLOW, deploy, "go.sh"].sort());
    expect(result.files.some((file) => file.includes("@"))).toBe(false);
  });
});

describe("merge keys (round 2, item 8)", () => {
  it("resolves << before walking, so a merged default working directory reaches the steps", async () => {
    const text = "name: w\non: issue_comment\nx-defaults: &d\n  run:\n    working-directory: tools\njobs:\n  j:\n    runs-on: x\n    defaults:\n      <<: *d\n    steps:\n      - run: ./x.sh\n";
    const result = await scan({ [WORKFLOW]: text, "tools/x.sh": "one" });
    expect(result.files).toContain("tools/x.sh");
    // A merged step body too.
    const merged = "name: w\non: issue_comment\nx-step: &s\n  run: ./a.sh\njobs:\n  j:\n    runs-on: x\n    steps:\n      - <<: *s\n        name: reused\n";
    expect((await scan({ [WORKFLOW]: merged, "a.sh": "x" })).files).toContain("a.sh");
  });
});

describe("what the scan says it covers (round 2, item 10)", () => {
  it("has one fixed note the page can show", async () => {
    const { COMMENT_TRIGGER_COVERAGE_NOTE } = await import("@rovara-code/contracts");
    expect(COMMENT_TRIGGER_COVERAGE_NOTE).toBe("Rovara reads every workflow of the repository, the scripts and manifests they name, local actions and the shell scripts those run in turn. For npm, make and well-known Python tools it reads their configuration files, not the tests or code they run. It can't see code fetched or built at run time, a command run by bare name or found on the PATH, files a Python or JavaScript script imports, or a Docker build context; where it can't tell which file runs, it asks a person.");
  });
});

// ---- Fix round 3 (re-check 2: B1 to B9, and the hint)

/** A workflow whose one step runs the given lines as a block. */
const block = (...lines: string[]) => workflowWith(`    steps:\n      - run: |\n${lines.map((line) => `          ${line}`).join("\n")}\n`);
const TOOLS_X = { "tools/x.sh": "x", "scripts/x.sh": "x" };

describe("every workflow is read when the repository triggers (round 3, B1)", () => {
  const DEPLOY = ".github/workflows/deploy.yml";
  const dispatch = (on: string) => `name: Deploy\non: ${on}\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: ./deploy.sh\n`;

  it.each<[string]>([["workflow_dispatch"], ["repository_dispatch"], ["push"], ["{ schedule: [{ cron: '0 0 * * *' }] }"]])("hashes a %s workflow and what it reaches", async (on) => {
    const files = { [WORKFLOW]: workflow("issue_comment", "gh workflow run deploy.yml"), [DEPLOY]: dispatch(on), "deploy.sh": "one" };
    const result = await scan(files);
    expect(result.files).toEqual([WORKFLOW, DEPLOY, "deploy.sh"].sort());
    expect((await scan({ ...files, "deploy.sh": "two" })).digest).not.toBe(result.digest);
    expect((await scan({ ...files, [DEPLOY]: `${dispatch(on)}# edited\n` })).digest).not.toBe(result.digest);
  });

  it("reads none of them when nothing triggers", async () => {
    expect(await scan({ [DEPLOY]: dispatch("workflow_dispatch"), "deploy.sh": "x" })).toMatchObject({ triggers: false, files: [] });
  });
});

describe("the word after a wrapper is a command (round 3, B2)", () => {
  it.each<[string]>([
    ["env ${{ vars.CMD }}"], ["env FOO=1 -i ${{ vars.CMD }}"], ["env -u HOME $CMD"], ["sudo ${{ vars.CMD }}"], ["sudo -u root -E $CMD"], ["exec ${{ vars.CMD }}"], ["eval \"${{ vars.CMD }}\""],
    ["timeout 60 ${{ vars.CMD }}"], ["timeout -k 5 60 $CMD"], ["nohup $CMD"], ["nice -n 5 $CMD"], ["time ${{ vars.CMD }}"], ["command $CMD"], ["xargs -n1 $CMD"], ["stdbuf -oL $CMD"],
    ["env sudo timeout 5 $CMD"],
  ])("fails closed for %s", async (run) => {
    expect(await scan({ [WORKFLOW]: block(run) })).toMatchObject(closedScan);
  });

  it.each<[string, string]>([
    ["env FOO=1 ./scripts/x.sh", "scripts/x.sh"], ["timeout 60 ./scripts/x.sh", "scripts/x.sh"], ["sudo -E ./scripts/x.sh", "scripts/x.sh"], ["nohup bash scripts/x.sh", "scripts/x.sh"],
    ["time ./scripts/x.sh", "scripts/x.sh"], ["exec scripts/x.sh", "scripts/x.sh"], ["xargs -n1 ./scripts/x.sh", "scripts/x.sh"], ["nice -n 5 ./scripts/x.sh", "scripts/x.sh"],
  ])("hashes the file after a wrapper: %s", async (run, path) => {
    const files = { [WORKFLOW]: block(run), [path]: "one" };
    expect((await scan(files)).files).toContain(path);
    expect((await scan({ ...files, [path]: "two" })).digest).not.toBe((await scan(files)).digest);
  });

  it("leaves a wrapper of a bare command alone", async () => {
    for (const run of ["timeout 60 npm test", "env CI=1 make test", "time git status", "xargs -n1 echo", "xargs rm -f", "sudo apt-get update", "nohup sleep 1"]) {
      expect(await scan({ [WORKFLOW]: block(run), "package.json": "{}", Makefile: "t:" }), run).toMatchObject({ failedClosed: false });
    }
  });
});

describe("a folder or file chosen by a tool flag (round 3, B3)", () => {
  it.each<[string, string]>([
    ["make -C tools deploy", "tools/Makefile"], ["make --directory=tools deploy", "tools/Makefile"], ["make --directory tools deploy", "tools/Makefile"], ["make -Ctools deploy", "tools/Makefile"],
    ["make -f ci.mk deploy", "ci.mk"], ["make --file ci.mk", "ci.mk"], ["make --file=ci.mk", "ci.mk"], ["gmake -C tools -f ci.mk", "tools/ci.mk"],
    ["npm --prefix tools run deploy", "tools/package.json"], ["npm --prefix=tools test", "tools/package.json"], ["pnpm -C tools install", "tools/package.json"], ["pnpm --dir tools run x", "tools/package.json"],
    ["yarn --cwd tools build", "tools/package.json"],
  ])("hashes what %s reads (%s)", async (run, hashed) => {
    const files = { [WORKFLOW]: block(run), "tools/Makefile": "a", "ci.mk": "b", "tools/ci.mk": "c", "tools/package.json": "{}", Makefile: "r", "package.json": "{}" };
    const result = await scan(files);
    expect(result.files).toContain(hashed);
    expect((await scan({ ...files, [hashed]: "changed" })).digest).not.toBe(result.digest);
  });

  it.each<[string]>([
    ["make -C $DIR"], ["make -C ${{ matrix.dir }} all"], ["make -C ../x"], ["make -f $MK"], ["npm --prefix ${{ inputs.p }} test"], ["pnpm -C ../up i"], ["yarn --cwd $D build"], ["make -C"], ["npm --prefix"], ["make -f"], ["make --file"], ["make -C tools -f"],
  ])("fails closed for %s", async (run) => {
    expect(await scan({ [WORKFLOW]: block(run) })).toMatchObject(closedScan);
  });

  it("ignores a folder outside the repository and the same tools without those flags", async () => {
    expect(await scan({ [WORKFLOW]: block("make -C /opt/build all", "npm -g install x") })).toMatchObject({ failedClosed: false });
  });
});

describe("a directory change that is not spelled cd (round 3, B4)", () => {
  it.each<[string]>([
    ["env -C tools ./x.sh"], ["env --chdir=tools ./x.sh"], ["env --chdir tools ./x.sh"], ["git -C tools submodule foreach ./x.sh"], ["git -C tools status"], ["sudo -D tools ./x.sh"],
    ["\\cd tools"], ["c''d tools"], ["c\"\"d tools"], ["\\pushd tools"], ["ec''ho hi"],
  ])("fails closed for %s", async (run) => {
    expect(await scan({ [WORKFLOW]: block(run), ...TOOLS_X })).toMatchObject(closedScan);
  });

  it("leaves a git command without -C and a quoted string alone", async () => {
    expect(await scan({ [WORKFLOW]: block("git status", "git log -n 1", "echo \"say it\" 'ok'") })).toMatchObject({ failedClosed: false });
  });
});

describe("files found or listed at run time (round 3, B5)", () => {
  it.each<[string]>([
    ["find tools -name '*.sh' -exec bash {} \\;"], ["find . -execdir ./x {} +"], ["find tools -ok bash {} \\;"], ["run-parts tools/ci"], ["find tools -name x.sh | xargs -n1 bash"], ["xargs -a jobs.txt bash"],
    ["echo a | xargs"], ["ls | xargs -n1 sh"], ["xargs -I{} python {}"],
  ])("fails closed for %s", async (run) => {
    expect(await scan({ [WORKFLOW]: block(run), ...TOOLS_X })).toMatchObject(closedScan);
  });

  it("leaves find without an exec, and xargs of a bare command, alone", async () => {
    expect(await scan({ [WORKFLOW]: block("find . -name '*.orig' -delete", "git ls-files | xargs wc -l", "find tools -type f | xargs rm") })).toMatchObject({ failedClosed: false });
  });
});

describe("a script that runs what its caller passes (round 3, B6)", () => {
  const caller = (call: string) => block(call);

  it("reads the caller's arguments as candidate files, whatever they look like", async () => {
    const files = { [WORKFLOW]: caller("./a.sh deploy"), "a.sh": "#!/bin/bash\nbash \"$1\"\n", deploy: "echo one" };
    const result = await scan(files);
    expect(result.files).toEqual([WORKFLOW, "a.sh", "deploy"].sort());
    expect((await scan({ ...files, deploy: "echo two" })).digest).not.toBe(result.digest);
  });

  it.each<[string, string, string]>([
    ["./a.sh tools/deploy extra", "bash $@", "tools/deploy"],
    ["bash a.sh run ci", "exec $*", "run"],
    ["./a.sh --flag deploy", "source \"${1}\"", "deploy"],
  ])("reads %s for a script using the parameters", async (call, body, path) => {
    const files = { [WORKFLOW]: caller(call), "a.sh": `#!/bin/bash\n${body}\n`, [path]: "one", ci: "ci", extra: "e" };
    expect((await scan(files)).files).toContain(path);
  });

  it("passes the arguments on through a chain of scripts", async () => {
    const files = { [WORKFLOW]: caller("./a.sh deploy"), "a.sh": "#!/bin/bash\n./b.sh \"$@\"\n", "b.sh": "#!/bin/bash\nbash \"$1\"\n", deploy: "one" };
    expect((await scan(files)).files).toEqual([WORKFLOW, "a.sh", "b.sh", "deploy"].sort());
  });

  it("fails closed when the arguments can't be read: an expression, or a script reached some other way", async () => {
    expect(await scan({ [WORKFLOW]: caller("./a.sh \"$TARGET\""), "a.sh": "#!/bin/bash\nbash \"$1\"\n" })).toMatchObject(closedScan);
    expect(await scan({ [WORKFLOW]: caller("./a.sh ${{ matrix.t }}"), "a.sh": "#!/bin/bash\nbash \"$1\"\n" })).toMatchObject(closedScan);
    expect(await scan({ [WORKFLOW]: workflowWith(steps("- run: echo hi"), "env:\n  BASH_ENV: ./a.sh\n"), "a.sh": "bash \"$1\"\n" })).toMatchObject(closedScan);
  });

  it("fails closed for an argument that points into a submodule, though it looks like a bare word", async () => {
    const modules = "[submodule \"ci\"]\n\tpath = vendor/ci\n";
    expect(await scan({ [WORKFLOW]: caller("./a.sh vendor/ci/tool"), "a.sh": "#!/bin/bash\nbash \"$1\"\n", ".gitmodules": modules })).toMatchObject(closedScan);
  });

  it("is not triggered by a script that only mentions a parameter as an argument", async () => {
    const files = { [WORKFLOW]: caller("./a.sh deploy"), "a.sh": "#!/bin/bash\necho \"got $1\"\n", deploy: "x" };
    expect((await scan(files)).files).toEqual([WORKFLOW, "a.sh"].sort());
  });

  it("ignores an argument that is not a file", async () => {
    expect(await scan({ [WORKFLOW]: caller("./a.sh production --fast"), "a.sh": "#!/bin/bash\nbash \"$1\"\n" })).toMatchObject({ failedClosed: false });
  });
});

describe("environment variables that load files (round 3, B7)", () => {
  const env = (name: string, value: string) => workflowWith(steps("- run: npm test"), `env:\n  ${name}: ${JSON.stringify(value)}\n`);
  const FILES = { "hook.js": "one", "hook.mjs": "m", "pre.py": "p", "lib.so": "l", "x.rb": "r", "ph.pl": "q", "package.json": "{}" };

  it.each<[string, string, string]>([
    ["NODE_OPTIONS", "--require ./hook.js", "hook.js"], ["NODE_OPTIONS", "-r ./hook.js --max-old-space-size=4096", "hook.js"], ["NODE_OPTIONS", "--import hook.mjs", "hook.mjs"], ["NODE_OPTIONS", "--require hook.js", "hook.js"], ["NODE_OPTIONS", "-r hook.js", "hook.js"], ["NODE_OPTIONS", "--require=./hook.js", "hook.js"],
    ["PYTHONSTARTUP", "./pre.py", "pre.py"], ["LD_PRELOAD", "./lib.so", "lib.so"], ["RUBYOPT", "-r ./x.rb", "x.rb"], ["RUBYOPT", "-I ./x.rb", "x.rb"], ["PERL5OPT", "-I ./ph.pl", "ph.pl"],
  ])("hashes the file %s=%s names, in an env map", async (name, value, path) => {
    const files = { [WORKFLOW]: env(name, value), ...FILES };
    const result = await scan(files);
    expect(result.files).toContain(path);
    expect((await scan({ ...files, [path]: "changed" })).digest).not.toBe(result.digest);
  });

  it("reads them in a GITHUB_ENV line and in an assignment in a run line", async () => {
    for (const line of ["echo \"NODE_OPTIONS=--require ./hook.js\" >> $GITHUB_ENV", "NODE_OPTIONS='--require ./hook.js' npm test", "export NODE_OPTIONS=\"-r ./hook.js\""]) {
      expect((await scan({ [WORKFLOW]: block(line), ...FILES })).files, line).toContain("hook.js");
    }
  });

  it("fails closed for a value it can't resolve, and leaves other node options alone", async () => {
    expect(await scan({ [WORKFLOW]: env("NODE_OPTIONS", "--require ${{ matrix.hook }}"), ...FILES })).toMatchObject(closedScan);
    expect(await scan({ [WORKFLOW]: env("PYTHONSTARTUP", "$HOME/.pythonrc"), ...FILES })).toMatchObject(closedScan);
    expect(await scan({ [WORKFLOW]: env("LD_PRELOAD", "../lib.so"), ...FILES })).toMatchObject(closedScan);
    expect(await scan({ [WORKFLOW]: env("NODE_OPTIONS", "--max-old-space-size=4096"), ...FILES })).toMatchObject({ failedClosed: false });
  });
});

describe("things that are not there, and submodules (round 3, B8)", () => {
  it("fails closed for a local action with no action file", async () => {
    expect(await scan({ [WORKFLOW]: workflowWith(steps("- uses: ./.github/actions/nowhere")) })).toMatchObject(closedScan);
    expect(await scan({ [WORKFLOW]: workflowWith(steps("- uses: ./.github/actions/ok")), ".github/actions/ok/action.yaml": "runs:\n  using: composite\n  steps: []\n" })).toMatchObject({ failedClosed: false });
  });

  it("fails closed for a named file or workflow that answers 404, and ignores one that is built at run time or is only a word", async () => {
    expect(await scan({ [WORKFLOW]: block("./scripts/missing.sh") })).toMatchObject(closedScan);
    expect(await scan({ [WORKFLOW]: block("bash scripts/missing.sh") })).toMatchObject(closedScan);
    expect(await scan({ [WORKFLOW]: block("python missing.py") })).toMatchObject(closedScan);
    expect(await scan({ [WORKFLOW]: workflowWith("    uses: ./.github/workflows/missing.yml\n") })).toMatchObject(closedScan);
    for (const run of ["./node_modules/.bin/jest", "bash -c \"echo hi\"", "node --version", "python -c \"print(1)\"", "./.venv/bin/pytest"]) {
      expect(await scan({ [WORKFLOW]: block(run) }), run).toMatchObject({ failedClosed: false });
    }
  });

  it("is satisfied by the working-directory variant of a name, and by the plain one", async () => {
    expect(await scan({ [WORKFLOW]: workflowWith(steps("- working-directory: app\n        run: ./build.sh")), "app/build.sh": "x" })).toMatchObject({ failedClosed: false });
    expect(await scan({ [WORKFLOW]: workflowWith(steps("- working-directory: app\n        run: ./build.sh")), "build.sh": "x" })).toMatchObject({ failedClosed: false });
    expect(await scan({ [WORKFLOW]: workflowWith(steps("- working-directory: app\n        run: ./build.sh")) })).toMatchObject(closedScan);
  });

  it("hashes .gitmodules and fails closed for a file under a submodule", async () => {
    const modules = "[submodule \"ci\"]\n\tpath = vendor/ci\n\turl = https://example.com/ci.git\n";
    const clean = await scan({ [WORKFLOW]: block("./scripts/x.sh"), ".gitmodules": modules, "scripts/x.sh": "x" });
    expect(clean.files).toContain(".gitmodules");
    expect((await scan({ [WORKFLOW]: block("./scripts/x.sh"), ".gitmodules": `${modules}# edit\n`, "scripts/x.sh": "x" })).digest).not.toBe(clean.digest);
    expect(await scan({ [WORKFLOW]: block("./vendor/ci/deploy.sh"), ".gitmodules": modules })).toMatchObject(closedScan);
    expect(await scan({ [WORKFLOW]: workflowWith(steps("- uses: ./vendor/ci/action")), ".gitmodules": modules })).toMatchObject(closedScan);
    expect(await scan({ [WORKFLOW]: block("bash vendor/ci/x"), ".gitmodules": modules })).toMatchObject(closedScan);
    expect(await scan({ [WORKFLOW]: block("./vendor/other/deploy.sh"), ".gitmodules": modules, "vendor/other/deploy.sh": "x" })).toMatchObject({ failedClosed: false });
  });
});

describe("python -m (round 3, B9)", () => {
  it.each<[string]>([["python -m something_else"], ["python3 -m tools.deploy"], ["python -mtools"], ["env python -m tools"], ["sudo python3 -m tools.run x"]])("fails closed for %s", async (run) => {
    expect(await scan({ [WORKFLOW]: block(run) })).toMatchObject(closedScan);
  });

  it.each<[string]>([["python -m pip install x"], ["python3 -m venv .venv"], ["python -m json.tool x.json"], ["python3 -m http.server 8000"], ["python -mpip list"], ["python -m ensurepip"]])("leaves %s alone", async (run) => {
    expect(await scan({ [WORKFLOW]: block(run) })).toMatchObject({ failedClosed: false });
  });

  it("fails closed for shell: python -m and leaves shell: python alone", async () => {
    expect(await scan({ [WORKFLOW]: workflowWith(steps("- shell: python -m tools {0}\n        run: echo hi")) })).toMatchObject(closedScan);
    expect(await scan({ [WORKFLOW]: workflowWith(steps("- shell: python -m pip {0}\n        run: echo hi")) })).toMatchObject({ failedClosed: false });
    expect(await scan({ [WORKFLOW]: workflowWith(steps("- shell: python\n        run: echo hi")) })).toMatchObject({ failedClosed: false });
  });
});

describe("python -m of a well-known tool (round 3b)", () => {
  const CONFIGS = ["pyproject.toml", "setup.cfg", "pytest.ini", "tox.ini", "noxfile.py"];
  const config = Object.fromEntries(CONFIGS.map((name) => [name, `# ${name}`]));

  it.each<[string]>([["pytest"], ["mypy"], ["ruff"], ["black"], ["flake8"], ["isort"], ["coverage"], ["tox"], ["nox"]])("python -m %s scans clean and hashes the root configuration files", async (tool) => {
    const files = { [WORKFLOW]: block(`python -m ${tool} tests`), ...config };
    const result = await scan(files);
    expect(result).toMatchObject({ failedClosed: false });
    expect(result.files).toEqual([WORKFLOW, ...CONFIGS].sort());
    for (const name of CONFIGS) expect((await scan({ ...files, [name]: "changed" })).digest, name).not.toBe(result.digest);
  });

  it("hashes the ones that exist, in the working directory too, and none for a standard module", async () => {
    expect((await scan({ [WORKFLOW]: block("python3 -m pytest"), "pyproject.toml": "x" })).files).toEqual([WORKFLOW, "pyproject.toml"].sort());
    const inDirectory = { [WORKFLOW]: workflowWith(steps("- working-directory: app\n        run: python -m pytest")), "app/pytest.ini": "a", "pyproject.toml": "b" };
    expect((await scan(inDirectory)).files).toEqual([WORKFLOW, "app/pytest.ini", "pyproject.toml"].sort());
    expect((await scan({ [WORKFLOW]: block("python -m pip install x"), ...config })).files).toEqual([WORKFLOW]);
    expect((await scan({ [WORKFLOW]: block("python -mpytest -q"), "tox.ini": "t" })).files).toContain("tox.ini");
  });

  it("works after a wrapper and in shell: python -m, and any other module still fails closed", async () => {
    expect((await scan({ [WORKFLOW]: block("env CI=1 python -m pytest"), "pytest.ini": "p" })).files).toContain("pytest.ini");
    const shell = await scan({ [WORKFLOW]: workflowWith(steps("- shell: python -m pytest {0}\n        run: echo hi")), "pyproject.toml": "p" });
    expect(shell).toMatchObject({ failedClosed: false });
    expect(shell.files).toContain("pyproject.toml");
    expect(await scan({ [WORKFLOW]: block("python -m something_else"), ...config })).toMatchObject({ failedClosed: true, hint: "run Python scripts by path instead of python -m" });
    expect(await scan({ [WORKFLOW]: block("python -m pytest_plugin_of_ours") })).toMatchObject({ failedClosed: true });
  });
});

describe("what a scan that failed closed says (round 3, hint)", () => {
  it.each<[string, string, string]>([
    ["a cd", "cd tools && ./x.sh", "use working-directory instead of cd"],
    ["a variable path", "bash $SCRIPT", "name scripts by a fixed path, not by an expression or a variable"],
    ["a parent folder", "bash ../x.sh", "keep paths inside the repository: no .., glob or brace expansion"],
    ["make -C with a variable", "make -C $D", "use working-directory instead of -C, --prefix, --cwd or --chdir"],
    ["env -C", "env -C tools ./x.sh", "use working-directory instead of -C, --prefix, --cwd or --chdir"],
    ["find -exec", "find . -exec bash {} \\;", "name each script in the run block instead of finding or piping them"],
    ["a missing file", "./nowhere.sh", "name only files that exist in the repository"],
    ["python -m", "python -m tools", "run Python scripts by path instead of python -m"],
  ])("gives one fixed hint for %s", async (_name, run, hint) => {
    const result = await scan({ [WORKFLOW]: block(run) });
    expect(result).toMatchObject({ failedClosed: true, hint });
  });

  it("gives none when it has nothing specific to say, and none for a scan that did not fail", async () => {
    expect((await scan({ [WORKFLOW]: block("echo hi") })).hint).toBeUndefined();
    expect(await scan({ [WORKFLOW]: "on: [unclosed" })).not.toHaveProperty("hint");
  });

  it("never puts text from the repository in it", async () => {
    const result = await scan({ [WORKFLOW]: block("cd secret-folder-name && ./secret-script.sh") });
    expect(result.hint).toBe("use working-directory instead of cd");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
