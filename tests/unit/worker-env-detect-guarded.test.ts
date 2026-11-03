// Test services: the detector pass under a wall-clock limit (a worker thread that the caller can end).
import { describe, expect, it } from "vitest";
import { ENV_DETECT_MAX_FILE_BYTES, ENV_DETECT_MAX_TOTAL_BYTES, boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import { ENV_DETECT_TIMEOUT_NOTE, runDetectorsGuarded, type ThreadEntry } from "../../packages/worker/src/env-detect/guarded.js";
import type { RepositoryReader } from "../../packages/worker/src/env-detect/types.js";

type Files = Record<string, string>;
const reader = (files: Files) => boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
const entryOf = (name: string): ThreadEntry => ({ url: new URL(`../support/${name}`, import.meta.url), execArgv: ["--import", "tsx"] });

const REPOS: Record<string, Files> = {
  node: { "package.json": '{"scripts":{"test":"vitest","lint":"eslint ."},"dependencies":{"pg":"8"}}', "package-lock.json": "{}", "src/a.ts": 'import { Pool } from "pg";\nnew Pool({ host: "db.internal" });\n' },
  compose: { "docker-compose.yml": "services:\n  db:\n    image: postgres:16\n    ports: ['5432:5432']\n  r: { image: redis:7 }\n", ".env.example": "REDIS_URL=redis://localhost:6379\n" },
  python: { "pyproject.toml": "[tool.pytest.ini_options]\naddopts = '-q'\n", "requirements.txt": "psycopg2-binary\n", "tests/test_a.py": "from moto import mock_s3\n@mock_s3\ndef test_a(): pass\n", "app.py": 'import boto3\nboto3.client("s3")\n' },
  iac: { "template.yaml": "Resources:\n  T:\n    Type: AWS::SQS::Queue\n", "cdk.json": "{}" },
  empty: { "README.md": "hello" },
};

describe("a repository that finishes in time", () => {
  it.each(Object.keys(REPOS))("%s: the guarded pass returns exactly what the direct pass returns", async (name) => {
    const files = REPOS[name]!;
    const direct = await runDetectors(reader(files).reader, "svc");
    const guarded = await runDetectorsGuarded(reader(files).reader, "svc", { timeoutMs: 30_000 });
    expect(JSON.stringify(guarded)).toBe(JSON.stringify(direct));
    expect(guarded.notes).not.toContain(ENV_DETECT_TIMEOUT_NOTE);
  });
  it("only ever hands the thread text that the bounded reader serves, and keeps the read-budget note", async () => {
    const files: Files = { "docker-compose.yml": "services:\n  db: { image: postgres }\n" };
    const each = ENV_DETECT_MAX_FILE_BYTES - 10;
    for (let index = 0; index <= Math.ceil(ENV_DETECT_MAX_TOTAL_BYTES / each); index += 1) files[`docs/f${String(index)}.txt`] = "x".repeat(each);
    const bounded = reader(files);
    for (const path of Object.keys(files).filter((name) => name.startsWith("docs/"))) await bounded.reader.read(path);
    const served: string[] = [];
    const watching: RepositoryReader = { ...bounded.reader, read: (path) => { served.push(path); return bounded.reader.read(path); } };
    const detection = await runDetectorsGuarded(watching, "svc", { timeoutMs: 30_000 });
    expect(detection.notes).toContain("Some files were not read: the read budget ran out.");
    expect(served).toContain("docker-compose.yml");
    expect(served.every((path) => Object.hasOwn(files, path))).toBe(true);
  });
});

describe("a pass that does not finish", () => {
  it("is ended at the limit, and today's detection comes back without dependency candidates, with the note", async () => {
    const files = REPOS["node"]!;
    const started = Date.now();
    const detection = await runDetectorsGuarded(reader(files).reader, "svc", { timeoutMs: 4_000, entry: entryOf("env-detect-slow-thread.ts") });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(Object.hasOwn(detection, "dependencies")).toBe(false);
    expect(detection.checks.map((check) => check.value.id)).toContain("unit");
    expect(detection.notes).toContain(ENV_DETECT_TIMEOUT_NOTE);
    const direct = await runDetectors(reader(files).reader, "svc", { legacyOnly: true });
    expect(JSON.stringify({ ...detection, notes: detection.notes.filter((note) => note !== ENV_DETECT_TIMEOUT_NOTE) })).toBe(JSON.stringify(direct));
  });
  it("gives an empty detection with the note when even the shorter pass is stuck", async () => {
    const detection = await runDetectorsGuarded(reader(REPOS["node"]!).reader, "svc", { timeoutMs: 500, entry: entryOf("env-detect-stuck-thread.ts") });
    expect(detection.checks).toEqual([]);
    expect(detection.notes).toEqual([ENV_DETECT_TIMEOUT_NOTE]);
  });
  it("runs in the calling thread, as before, when the thread cannot be started", async () => {
    const files = REPOS["compose"]!;
    const direct = await runDetectors(reader(files).reader, "svc");
    const detection = await runDetectorsGuarded(reader(files).reader, "svc", { timeoutMs: 5_000, entry: { url: new URL("../support/no-such-thread.ts", import.meta.url), execArgv: ["--import", "tsx"] } });
    expect(JSON.stringify(detection)).toBe(JSON.stringify(direct));
  });
});

describe("the legacy-only pass", () => {
  it("drops every dependency candidate, including the manifest ones from the language detectors", async () => {
    const files = REPOS["python"]!;
    const full = await runDetectors(reader(files).reader, "svc");
    const legacy = await runDetectors(reader(files).reader, "svc", { legacyOnly: true });
    expect(full.dependencies?.length).toBeGreaterThan(0);
    expect(Object.hasOwn(legacy, "dependencies")).toBe(false);
    expect(legacy.checks).toEqual(full.checks);
  });
});
