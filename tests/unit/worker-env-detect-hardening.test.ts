// Test services dependency detectors: hostile-input hardening (timing, userinfo, odd names, read budget, IaC names, YAML node cap, path list).
import { describe, expect, it } from "vitest";
import { ENV_DETECT_MAX_FILE_BYTES, ENV_DETECT_MAX_TOTAL_BYTES, boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import { detectCompose } from "../../packages/worker/src/env-detect/compose.js";
import { safeEnvName } from "../../packages/worker/src/env-detect/dependency-candidates.js";
import { parseSafeYaml, YAML_LIMITS } from "../../packages/worker/src/env-detect/safe-yaml.js";
import type { RepositoryReader } from "../../packages/worker/src/env-detect/types.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "svc");
}
const family = (detection: Awaited<ReturnType<typeof detect>>, id: string) => detection.dependencies?.find((item) => item.family === id);
const SIZE = ENV_DETECT_MAX_FILE_BYTES - 1;
const fill = (unit: string): string => unit.repeat(Math.floor(SIZE / unit.length)).slice(0, SIZE);

// One file of every kind a dependency detector reads, and bodies that make a backtracking pattern work hard: a run of newlines, of spaces, of one repeated token, of an unterminated opener.
const FILES = [
  "app.py", "tests/test_a.py", "tests/conftest.py", "A.java", "src/test/java/AT.java", "B.kt", "main.go", "pkg/x_test.go", "src/a.ts", "src/a.test.ts", "src/a.js",
  "requirements.txt", "pyproject.toml", "Pipfile", "package.json", "pom.xml", "build.gradle", "build.gradle.kts", "go.mod",
  "application.properties", "application.yml", "application-test.yml", "appsettings.json", "config/a.yaml", "app/settings.py", ".env", ".env.example",
  "docker-compose.yml", ".devcontainer/devcontainer.json", ".github/workflows/ci.yml", ".gitlab-ci.yml", ".circleci/config.yml",
  "template.yaml", "cdk.out/a.template.json", "main.tf", "lib/stack.ts", "infra/app_stack.py",
];
const BODIES: Record<string, string> = {
  newlines: fill("\n"), "space-newline": fill(" \n"), "tab-newline": fill("\t\n"), spaces: fill(" "), dots: fill("."), "word-dot": fill("a."), "word-slash": fill("aa/"), word: fill("a"),
  quote: fill("\""), "single-quote": fill("'"), bracket: fill("["), "word-bracket": fill("a["), brace: fill("{"), paren: fill("("), dash: fill("-"),
  import: fill("import "), "import-newline": fill("import\n"), assign: fill("x=\""), "key-colon": fill("a:\n  "), "require-line": fill("require \n"), "aws-types": fill("AWS::"), "host-eq": fill("host="),
};
// Whitespace-only files are what a backtracking `^\s*` pattern chokes on (the old failures took 26 s to minutes): those must finish in a second. The YAML library parses the other bodies in linear time, but with a big
// constant (about 1 s for 256 KiB of quotes on a busy machine), so they get a wider bound that a quadratic pattern would still miss by a wide margin.
const STRICT = new Set(["newlines", "space-newline", "tab-newline", "spaces"]);
const limitFor = (label: string): number => (STRICT.has(label) ? 1_000 : 5_000);

describe("no detector is slow on a hostile file of the largest size the reader allows", () => {
  for (const name of FILES) {
    it(`${name}`, async () => {
      const slow: string[] = [];
      for (const [label, body] of Object.entries(BODIES)) {
        const started = performance.now();
        await detect({ [name]: body });
        const took = performance.now() - started;
        if (took > limitFor(label)) slow.push(`${label}: ${String(Math.round(took))} ms`);
      }
      expect(slow).toEqual([]);
    }, 120_000);
  }
});

describe("test-side fake hosts never carry user information", () => {
  const user = ["jane", "doe"].join(".");
  const password = ["pw", "z".repeat(14), "5"].join("-");
  const jwtish = ["eyJ", "a".repeat(12)].join("") + "." + "b".repeat(12);
  it.each([
    ["responses.add", `import responses\nresponses.add(responses.GET, "https://${user}:${password}@api.partner.example.net/x")\n`, "tests/test_a.py"],
    ["requests_mock", `requests_mock.get("https://${user}@api.partner.example.net/x")\n`, "tests/test_b.py"],
    ["nock", `nock("https://${user}:${password}@api.partner.example.net").get("/x")\n`, "src/a.test.ts"],
    ["msw", `http.get("https://${jwtish}@api.partner.example.net/x", () => {})\n`, "src/b.test.ts"],
    ["a dotted token before the at sign", `nock("https://${jwtish}@host.example.net")\n`, "src/c.test.ts"],
  ])("%s", async (_label, text, path) => {
    const detection = await detect({ [path]: text });
    const out = JSON.stringify(detection);
    for (const secret of [user, password, jwtish, "partner"]) expect(out).not.toContain(secret);
    expect(detection.dependencies?.some((item) => item.family.startsWith("http:"))).toBeFalsy();
  });
  it("still takes an ordinary host, with a port or a path", async () => {
    const detection = await detect({ "src/a.test.ts": 'nock("https://api.partner.example.net:8443/v1").get("/x")\nnock(`http://other.example.net?x=1`)\n' });
    expect(detection.dependencies!.map((item) => item.family).sort()).toEqual(["http:api.partner.example.net", "http:other.example.net"]);
  });
});

describe("variable names must look like variable names", () => {
  it("drops lower-case keys, one-letter names and long run-together names, keeps ordinary ones", () => {
    const pasted = ["HUNTER", "TWO", "PW", "1234567890"].join("");
    expect(["hunter2PW", "A", "DATABASE_URL", "PG1", pasted, "ABCDEFGHIJKLMNOPQRSTUVWXYZAB", "REDIS_URL_2"].map(safeEnvName)).toEqual([undefined, undefined, "DATABASE_URL", "PG1", undefined, undefined, "REDIS_URL_2"]);
  });
  it("keeps such a key out of a compose list entry and an env file", async () => {
    const pasted = ["HUNTER", "TWO", "PW", "1234567890"].join("");
    const compose = `services:\n  db:\n    image: postgres\n    environment:\n      - hunter2PW=x\n      - ${pasted}=y\n      - POSTGRES_DB=app\n`;
    const detection = await detect({ "docker-compose.yml": compose, ".env": `${pasted}=1\nhunter2PW=1\nREDIS_URL=1\n` });
    expect(family(detection, "postgres")!.hints.envNames).toEqual(["POSTGRES_DB"]);
    const out = JSON.stringify(detection);
    expect(out).not.toContain(pasted);
    expect(out).not.toContain("hunter2PW");
  });
});

describe("limits that need their own test", () => {
  it("refuses a wide, shallow YAML document on the node count alone", () => {
    const items = Array.from({ length: YAML_LIMITS.maxNodes + 100 }, () => "- a").join("\n");
    expect(Buffer.byteLength(items)).toBeLessThan(YAML_LIMITS.maxBytes);
    expect(parseSafeYaml(items)).toEqual({ ok: false, reason: "too_many_nodes" });
  });
  it("does not read a dev container's compose file that is not in the path list, even if the reader would serve it", async () => {
    const reads: string[] = [];
    const reader: RepositoryReader = {
      paths: [".devcontainer/devcontainer.json"],
      read: (path) => { reads.push(path); return Promise.resolve(path.endsWith("devcontainer.json") ? '{"dockerComposeFile": "../stack/dev.yml"}' : "services:\n  db: { image: postgres }\n"); },
    };
    expect(await detectCompose({ repo: reader, cwd: "svc" })).toEqual({});
    expect(reads).toEqual([".devcontainer/devcontainer.json"]);
  });
  it("says so when the shared read budget ran out", async () => {
    const files: Files = {};
    const each = ENV_DETECT_MAX_FILE_BYTES - 10;
    for (let index = 0; index <= Math.ceil(ENV_DETECT_MAX_TOTAL_BYTES / each); index += 1) files[`docs/f${String(index)}.txt`] = "x".repeat(each);
    files["docker-compose.yml"] = "services:\n  db: { image: postgres }\n";
    const bounded = boundedReader(["docs/a.md", ...Object.keys(files)], (path) => Promise.resolve(files[path]));
    for (const path of Object.keys(files).filter((name) => name.startsWith("docs/"))) await bounded.reader.read(path);
    const detection = await runDetectors(bounded.reader, "svc");
    expect(detection.notes).toContain("Some files were not read: the read budget ran out.");
    expect((await detect({ "docker-compose.yml": "services:\n  db: { image: postgres }\n" })).notes.join(" ")).not.toContain("read budget");
  });
});

describe("infrastructure resource names are carried, but never a key-shaped one", () => {
  const keyName = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
  it("falls back from a key-shaped physical name to the template's id, and drops a resource with neither", async () => {
    const template = `Resources:\n  Orders:\n    Type: AWS::SQS::Queue\n    Properties:\n      QueueName: ${keyName}\n  ${keyName}:\n    Type: AWS::SNS::Topic\n    Properties:\n      TopicName: ${keyName}\n`;
    const detection = await detect({ "template.yaml": template });
    expect(family(detection, "aws:sqs")!.hints.resources).toEqual([{ kind: "queue", name: "Orders" }]);
    expect(family(detection, "aws:sns")).toBeUndefined();
    expect(JSON.stringify(detection)).not.toContain(keyName);
  });
  it("applies the same rule to Terraform and CDK names", async () => {
    const tf = `resource "aws_sqs_queue" "q" {\n  name = "${keyName}"\n}\n`;
    const cdk = `import { Queue } from "aws-cdk-lib/aws-sqs";\nnew Queue(this, "${keyName}", { queueName: "${keyName}" });\n`;
    const detection = await detect({ "main.tf": tf, "lib/stack.ts": cdk });
    expect(family(detection, "aws:sqs")!.hints.resources).toEqual([{ kind: "queue", name: "q" }]);
    expect(JSON.stringify(detection)).not.toContain(keyName);
  });
});
