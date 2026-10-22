// Plan 3 Task 14b (R1-1, R3-1): the scan of a repository's default branch for workflows and bots that act on comments, issues or labels.
// Everything runs on an in-memory repository (tests/support/fake-repository.ts), so what was read, and how often, is read off the record.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { OrgId } from "@agentx/contracts";
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
    expect([...BOT_CONFIG_PATHS].sort()).toEqual([".github/.kodiak.toml", ".github/mergify.yml", ".kodiak.toml", ".mergify.yml", ".mergify/config.yml", "atlantis.yaml", "bors.toml"]);
  });

  it("does not parse a bot config, so one that is not valid YAML still counts", async () => {
    expect(await scan({ ".mergify.yml": "{{{ not yaml" })).toMatchObject({ triggers: true, failedClosed: false });
  });

  it("lists a bot config beside a workflow that does not trigger", async () => {
    expect(await scan({ [WORKFLOW]: workflow("push"), "bors.toml": "status = []" })).toMatchObject({ triggers: true, files: ["bors.toml"] });
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
      ["sh -e ./ci/run.sh --fast", "ci/run.sh"], ["source ci/env.sh", "ci/env.sh"], ["ts-node tools/t.ts", "tools/t.ts"], ["cd app && bash \"scripts/q.sh\"", "scripts/q.sh"],
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

  it("ignores a path in a run line that is not a file of the repository", async () => {
    const result = await scan({ [WORKFLOW]: trigger("./scripts/missing.sh && bash /etc/profile && ./a/../b.sh && ./$HOME/x.sh && ../outside.sh") });
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
    const files = { [WORKFLOW]: trigger("./build.sh", "      - working-directory: app\n        run: ./build.sh\n"), "app/build.sh": "echo build" };
    expect((await scan(files)).files).toEqual([WORKFLOW, "app/build.sh"].sort());
  });

  it("follows a root action named by uses: ./", async () => {
    const files = { [WORKFLOW]: trigger("echo", "      - uses: ./\n"), "action.yml": "name: root\nruns:\n  using: composite\n  steps:\n    - run: ./root.sh\n      shell: bash\n", "root.sh": "echo" };
    expect((await scan(files)).files).toEqual([WORKFLOW, "action.yml", "root.sh"].sort());
  });

  it("reads what only a non-triggering workflow reaches as nothing", async () => {
    const files = { [WORKFLOW]: workflow("push", "./scripts/x.sh"), "scripts/x.sh": "echo", "bors.toml": "x" };
    const result = await scan(files);
    expect(result.files).toEqual(["bors.toml"]);
    expect(result.fileShas).toEqual({ "bors.toml": blobSha("x") });
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
    expect(reader.reads).toEqual([WORKFLOW, ...BOT_CONFIG_PATHS]);
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
