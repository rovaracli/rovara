// SH35: the team build runner contract (R3). Strict job kinds, no model credentials or edit permissions on a job, bounded sizes, a lease that binds a result to one job, and a result that is only evidence.
import { describe, expect, it } from "vitest";
import {
  RUNNER_GRANT_MAX_BYTES, RUNNER_JOB_KINDS, RUNNER_JOB_MAX_TOTAL_SECONDS, RUNNER_LEASE_MAX_SECONDS, RUNNER_MAX_COMMANDS, RUNNER_OUTPUT_TAIL_BYTES, RUNNER_RESULT_MAX_BYTES,
  RunnerGrantSchema, RunnerHeartbeatAckSchema, RunnerHeartbeatSchema, RunnerIdSchema, RunnerJobSchema, RunnerLeaseSchema, RunnerResultSchema, checkRunnerResult, findRunnerForbiddenField,
  type RunnerGrant,
} from "../../packages/contracts/src/index.js";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const LEASE_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const COMMIT = "a".repeat(40);
const TOKEN = "T".repeat(43);
const NOW = Date.parse("2026-11-02T10:00:00.000Z");
const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();

const command = (over: Record<string, unknown> = {}) => ({ cwd: "service", executable: "pytest", args: ["-q"], timeoutSeconds: 600, ...over });
const workspace = () => ({ repositories: [{ repositoryId: "service", commit: COMMIT }], envRevision: 3 });
const job = (over: Record<string, unknown> = {}) => ({ version: 1, jobId: JOB_ID, kind: "run_checks", workspace: workspace(), commands: [command()], ...over });
const lease = (over: Record<string, unknown> = {}) => ({
  leaseId: LEASE_ID, jobId: JOB_ID, runnerId: "build-host-1", operationId: OPERATION_ID, fence: 4, issuedAt: at(0), expiresAt: at(60), hardDeadlineAt: at(3_600),
  heartbeat: { intervalSeconds: 15, missedAllowed: 3 }, singleUse: true, leaseToken: TOKEN, ...over,
});
const grant = (jobOver: Record<string, unknown> = {}, leaseOver: Record<string, unknown> = {}) => ({ version: 1, lease: lease(leaseOver), job: job(jobOver) });
const commandResult = (index: number, over: Record<string, unknown> = {}) => ({ index, exitCode: 0, timedOut: false, durationMs: 1_000, outputTail: "ok\n", outputCut: false, ...over });
const result = (over: Record<string, unknown> = {}) => ({
  version: 1, jobId: JOB_ID, leaseId: LEASE_ID, fence: 4, kind: "run_checks", workspace: workspace(), outcome: "finished", commands: [commandResult(0)], finishedAt: at(120), leaseToken: TOKEN, ...over,
});
const ok = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) => schema.safeParse(value).success;

describe("job kinds are strict", () => {
  it("are exactly setup_command, run_checks, prove and nightly", () => {
    expect([...RUNNER_JOB_KINDS]).toEqual(["setup_command", "run_checks", "prove", "nightly"]);
    for (const kind of ["run_checks", "prove", "nightly"]) expect(ok(RunnerJobSchema, job({ kind })), kind).toBe(true);
    expect(ok(RunnerJobSchema, job({ kind: "setup_command", personApprovalId: OPERATION_ID }))).toBe(true);
  });

  it("refuses any other kind: an agent step, a publish, a model call, an unknown or missing kind", () => {
    for (const kind of ["agent", "task", "publish", "prepare", "maintain", "model_call", "edit", "RUN_CHECKS", "", undefined, 1]) {
      expect(ok(RunnerJobSchema, job({ kind })), String(kind)).toBe(false);
    }
  });

  it("holds a setup command to one command that a person approved", () => {
    expect(ok(RunnerJobSchema, job({ kind: "setup_command" }))).toBe(false);
    expect(ok(RunnerJobSchema, job({ kind: "setup_command", personApprovalId: OPERATION_ID, commands: [command(), command()] }))).toBe(false);
    expect(ok(RunnerJobSchema, job({ kind: "run_checks", personApprovalId: OPERATION_ID }))).toBe(false);
  });

  it("refuses unknown fields and empty command lists", () => {
    for (const kind of RUNNER_JOB_KINDS) {
      const extra = kind === "setup_command" ? { personApprovalId: OPERATION_ID } : {};
      expect(ok(RunnerJobSchema, job({ kind, ...extra })), kind).toBe(true);
      expect(ok(RunnerJobSchema, job({ kind, ...extra, surprise: 1 })), kind).toBe(false);
    }
    expect(ok(RunnerJobSchema, job({ commands: [] }))).toBe(false);
    expect(ok(RunnerJobSchema, job({ commands: [command({ extra: true })] }))).toBe(false);
  });
});

describe("a job never carries model credentials or edit permissions", () => {
  const forbidden: Array<[string, Record<string, unknown>]> = [
    ["model", { model: "some-model" }],
    ["modelCredentials", { modelCredentials: { apiKey: "x" } }],
    ["apiKey", { apiKey: "x" }],
    ["provider", { provider: "anthropic" }],
    ["prompt", { prompt: "do the thing" }],
    ["tools", { tools: ["bash", "edit"] }],
    ["allowedTools", { allowedTools: ["write"] }],
    ["editPermissions", { editPermissions: { write: true } }],
    ["canWrite", { canWrite: true }],
    ["writeAccess", { writeAccess: true }],
    ["permissions", { permissions: ["edit"] }],
    ["secrets", { secrets: {} }],
    ["token", { token: "x" }],
    ["password", { password: "x" }],
    ["authorization", { authorization: "x" }],
    ["callbackToken", { callbackToken: "x" }],
  ];
  it.each(forbidden)("refuses %s at the top of a job", (name, extra) => {
    expect(ok(RunnerJobSchema, job(extra)), name).toBe(false);
    expect(ok(RunnerGrantSchema, grant(extra)), name).toBe(false);
  });

  it("names the field in its own sentence, not only as an unknown key", () => {
    const parsed = RunnerJobSchema.safeParse(job({ modelCredentials: {} }));
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("modelCredentials");
    expect(JSON.stringify(parsed.error?.issues)).toContain("stay central");
    expect(findRunnerForbiddenField(job({ nested: [{ deep: { editPermissions: 1 } }] }))).toBe("nested.0.deep.editPermissions");
  });

  it("refuses them anywhere in the object, inside a command or the workspace pin", () => {
    expect(ok(RunnerJobSchema, job({ commands: [command({ model: "x" })] }))).toBe(false);
    expect(ok(RunnerJobSchema, job({ workspace: { ...workspace(), apiKey: "x" } }))).toBe(false);
  });

  it("refuses a command that sets a credential or model-access environment variable", () => {
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_ORG", "OPENAI_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN", "AWS_REGION", "AGENTX_MODEL", "ROVARA_BROKER_URL", "GITHUB_TOKEN", "DB_PASSWORD", "NPM_AUTH_TOKEN", "BEDROCK_PROFILE"]) {
      expect(ok(RunnerJobSchema, job({ commands: [command({ env: { [name]: "1" } })] })), name).toBe(false);
    }
    expect(ok(RunnerJobSchema, job({ commands: [command({ env: { CI: "1", PYTHONHASHSEED: "0", NODE_ENV: "test" } })] }))).toBe(true);
  });

  it("refuses a credential-shaped argument or environment value", () => {
    // Built at run time: no key-shaped text sits in this file.
    const shaped = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
    const bearer = `Authorization: Bearer ${"Zy9".repeat(12)}`;
    expect(ok(RunnerJobSchema, job({ commands: [command({ args: ["--header", bearer] })] }))).toBe(false);
    expect(ok(RunnerJobSchema, job({ commands: [command({ env: { MARKER: shaped } })] }))).toBe(false);
    expect(ok(RunnerJobSchema, job({ commands: [command({ args: [shaped] })] }))).toBe(false);
  });

  it("allows the lease token in its one place only", () => {
    expect(ok(RunnerGrantSchema, grant())).toBe(true);
    expect(ok(RunnerGrantSchema, { ...grant(), job: job({ leaseToken: TOKEN }) })).toBe(false);
    expect(ok(RunnerGrantSchema, { ...grant(), leaseToken: TOKEN })).toBe(false);
    expect(ok(RunnerLeaseSchema, lease())).toBe(true);
    expect(ok(RunnerLeaseSchema, lease({ accessToken: TOKEN }))).toBe(false);
  });
});

describe("sizes are bounded", () => {
  it("limits commands, timeouts, patch size and the whole grant", () => {
    expect(ok(RunnerJobSchema, job({ commands: Array.from({ length: RUNNER_MAX_COMMANDS }, () => command({ timeoutSeconds: 60 })) }))).toBe(true);
    expect(ok(RunnerJobSchema, job({ commands: Array.from({ length: RUNNER_MAX_COMMANDS + 1 }, () => command({ timeoutSeconds: 60 })) }))).toBe(false);
    expect(ok(RunnerJobSchema, job({ commands: [command({ timeoutSeconds: RUNNER_JOB_MAX_TOTAL_SECONDS })] }))).toBe(true);
    expect(ok(RunnerJobSchema, job({ commands: [command({ timeoutSeconds: RUNNER_JOB_MAX_TOTAL_SECONDS }), command({ timeoutSeconds: 1 })] }))).toBe(false);
    const patch = { repositoryId: "service", sha256: "b".repeat(64), sizeBytes: 1_048_576 };
    expect(ok(RunnerJobSchema, job({ candidatePatch: patch }))).toBe(true);
    expect(ok(RunnerJobSchema, job({ candidatePatch: { ...patch, sizeBytes: 1_048_577 } }))).toBe(false);
    expect(ok(RunnerJobSchema, job({ candidatePatch: { ...patch, repositoryId: "other" } }))).toBe(false);
    const bigCommands = (count: number, args: number, size: number) => Array.from({ length: count }, () => command({ args: Array.from({ length: args }, () => "x".repeat(size)), timeoutSeconds: 60 }));
    // Every part is within its own limit; only the whole is too large.
    const big = { ...grant(), job: job({ commands: bigCommands(8, 8, 8_000) }) };
    expect(JSON.stringify(big).length).toBeGreaterThan(RUNNER_GRANT_MAX_BYTES);
    expect(ok(RunnerJobSchema, big.job)).toBe(true);
    expect(ok(RunnerGrantSchema, big)).toBe(false);
    expect(ok(RunnerGrantSchema, { ...grant(), job: job({ commands: bigCommands(2, 8, 8_000) }) })).toBe(true);
    // Too many fields to read at all is refused too, before any of them is looked at.
    expect(ok(RunnerJobSchema, job({ commands: bigCommands(40, 256, 1) }))).toBe(false);
  });

  it("bounds the lease: ordering, lifetime, heartbeat and that the commands fit in it", () => {
    expect(ok(RunnerLeaseSchema, lease({ expiresAt: at(0) }))).toBe(false);
    expect(ok(RunnerLeaseSchema, lease({ hardDeadlineAt: at(30) }))).toBe(false);
    expect(ok(RunnerLeaseSchema, lease({ hardDeadlineAt: at(RUNNER_LEASE_MAX_SECONDS) }))).toBe(true);
    expect(ok(RunnerLeaseSchema, lease({ hardDeadlineAt: at(RUNNER_LEASE_MAX_SECONDS + 1) }))).toBe(false);
    for (const heartbeat of [{ intervalSeconds: 4, missedAllowed: 3 }, { intervalSeconds: 61, missedAllowed: 3 }, { intervalSeconds: 15, missedAllowed: 0 }, { intervalSeconds: 15, missedAllowed: 6 }]) {
      expect(ok(RunnerLeaseSchema, lease({ heartbeat })), JSON.stringify(heartbeat)).toBe(false);
    }
    expect(ok(RunnerGrantSchema, grant({ commands: [command({ timeoutSeconds: 7_200 })] }))).toBe(false);
    expect(ok(RunnerGrantSchema, grant({ jobId: OPERATION_ID }))).toBe(false);
  });

  it("limits a result's output per command, in bytes, and the whole result", () => {
    const tail = (text: string) => result({ commands: [commandResult(0, { outputTail: text })] });
    expect(ok(RunnerResultSchema, tail("a".repeat(RUNNER_OUTPUT_TAIL_BYTES)))).toBe(true);
    expect(ok(RunnerResultSchema, tail("a".repeat(RUNNER_OUTPUT_TAIL_BYTES + 1)))).toBe(false);
    // 2,048 two-byte characters are 4,096 bytes; 2,049 are over, though they are fewer than 4,096 characters.
    expect(ok(RunnerResultSchema, tail("é".repeat(2_048)))).toBe(true);
    expect(ok(RunnerResultSchema, tail("é".repeat(2_049)))).toBe(false);
    expect(ok(RunnerResultSchema, tail("bell\u0007"))).toBe(false);
    expect(ok(RunnerResultSchema, tail("line\n\ttab"))).toBe(true);
    const many = result({ commands: Array.from({ length: RUNNER_MAX_COMMANDS + 1 }, (_, index) => commandResult(index)) });
    expect(ok(RunnerResultSchema, many)).toBe(false);
    const full = result({ commands: Array.from({ length: RUNNER_MAX_COMMANDS }, (_, index) => commandResult(index, { outputTail: "a".repeat(RUNNER_OUTPUT_TAIL_BYTES) })) });
    expect(JSON.stringify(full).length).toBeLessThan(RUNNER_RESULT_MAX_BYTES);
    expect(ok(RunnerResultSchema, full)).toBe(true);
    expect(ok(RunnerResultSchema, { ...result(), padding: "x".repeat(RUNNER_RESULT_MAX_BYTES) })).toBe(false);
    // Each tail is within 4 KiB, but newlines are two bytes each once written as JSON: the whole result is too large.
    const escaped = result({ commands: Array.from({ length: RUNNER_MAX_COMMANDS }, (_, index) => commandResult(index, { outputTail: "\n".repeat(RUNNER_OUTPUT_TAIL_BYTES) })) });
    expect(JSON.stringify(escaped).length).toBeGreaterThan(RUNNER_RESULT_MAX_BYTES);
    expect(ok(RunnerResultSchema, escaped)).toBe(false);
    expect(ok(RunnerResultSchema, result({ commands: [commandResult(0, { exitCode: 256 })] }))).toBe(false);
  });
});

describe("a result is evidence bound to its lease", () => {
  const issued = RunnerGrantSchema.parse(grant({ commands: [command(), command()] })) as RunnerGrant;
  const parsed = (over: Record<string, unknown>) => RunnerResultSchema.parse(result({ commands: [commandResult(0), commandResult(1)], ...over }));

  it("matches the grant it answers", () => {
    expect(checkRunnerResult(issued, parsed({}))).toEqual({ ok: true });
  });

  it("is voided by another job, lease, fence, kind, token or workspace pin", () => {
    expect(checkRunnerResult(issued, parsed({ jobId: OPERATION_ID }))).toEqual({ ok: false, reason: "wrong_job" });
    expect(checkRunnerResult(issued, parsed({ leaseId: OPERATION_ID }))).toEqual({ ok: false, reason: "wrong_lease" });
    expect(checkRunnerResult(issued, parsed({ fence: 3 }))).toEqual({ ok: false, reason: "wrong_lease" });
    expect(checkRunnerResult(issued, parsed({ kind: "nightly" }))).toEqual({ ok: false, reason: "wrong_lease" });
    expect(checkRunnerResult(issued, parsed({ leaseToken: "U".repeat(43) }))).toEqual({ ok: false, reason: "wrong_token" });
    expect(checkRunnerResult(issued, parsed({ workspace: { ...workspace(), envRevision: 4 } }))).toEqual({ ok: false, reason: "wrong_workspace" });
    expect(checkRunnerResult(issued, parsed({ workspace: { ...workspace(), repositories: [{ repositoryId: "service", commit: "b".repeat(40) }] } }))).toEqual({ ok: false, reason: "wrong_workspace" });
  });

  it("holds no more commands than the job has, and all of them when it says finished", () => {
    expect(checkRunnerResult(issued, parsed({ commands: [commandResult(0), commandResult(1), commandResult(2)] }))).toEqual({ ok: false, reason: "too_many_commands" });
    expect(checkRunnerResult(issued, parsed({ commands: [commandResult(0)] }))).toEqual({ ok: false, reason: "incomplete" });
    expect(checkRunnerResult(issued, parsed({ commands: [commandResult(0)], outcome: "stopped" }))).toEqual({ ok: true });
  });

  it("has no field that is a verdict, an approval or a permission, and refuses one", () => {
    for (const extra of [{ passed: true }, { verdict: "pass" }, { approved: true }, { permissions: ["merge"] }, { model: "x" }, { editPermissions: {} }]) {
      expect(ok(RunnerResultSchema, result(extra)), JSON.stringify(extra)).toBe(false);
    }
  });

  it("keeps command results in order from zero", () => {
    expect(ok(RunnerResultSchema, result({ commands: [commandResult(1)] }))).toBe(false);
    expect(ok(RunnerResultSchema, result({ commands: [commandResult(0), commandResult(0)] }))).toBe(false);
  });

  it("takes a lease token only in its 43-character base64url shape", () => {
    for (const leaseToken of ["short", "T".repeat(42), "T".repeat(44), `${"T".repeat(42)}=`, `${"T".repeat(42)} `]) {
      expect(ok(RunnerLeaseSchema, lease({ leaseToken })), leaseToken).toBe(false);
      expect(ok(RunnerResultSchema, result({ leaseToken })), leaseToken).toBe(false);
    }
    expect(ok(RunnerLeaseSchema, lease({ singleUse: false }))).toBe(false);
  });
});

describe("heartbeats", () => {
  const beat = (over: Record<string, unknown> = {}) => ({ version: 1, leaseId: LEASE_ID, jobId: JOB_ID, fence: 4, seq: 0, sentAt: at(15), ...over });
  it("are strict", () => {
    expect(ok(RunnerHeartbeatSchema, beat({ commandIndex: 2 }))).toBe(true);
    expect(ok(RunnerHeartbeatSchema, beat({ seq: -1 }))).toBe(false);
    expect(ok(RunnerHeartbeatSchema, beat({ commandIndex: RUNNER_MAX_COMMANDS }))).toBe(false);
    expect(ok(RunnerHeartbeatSchema, beat({ output: "x" }))).toBe(false);
    expect(ok(RunnerHeartbeatSchema, beat({ leaseToken: TOKEN }))).toBe(false);
    expect(ok(RunnerHeartbeatAckSchema, { action: "continue", expiresAt: at(75) })).toBe(true);
    expect(ok(RunnerHeartbeatAckSchema, { action: "revoked" })).toBe(true);
    expect(ok(RunnerHeartbeatAckSchema, { action: "continue" })).toBe(false);
    expect(ok(RunnerHeartbeatAckSchema, { action: "run_more" })).toBe(false);
  });
});

describe("runner ids", () => {
  it("are short lowercase names", () => {
    expect(ok(RunnerIdSchema, "build-host_1")).toBe(true);
    for (const bad of ["", "Build", "-x", "a b", "a/b", "a:b", "a".repeat(64)]) expect(ok(RunnerIdSchema, bad), bad).toBe(false);
  });
});
