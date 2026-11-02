// Team build runner R3 (setup-test-health 10.2, task SH35): the CONTRACT of a runner's jobs, leases, heartbeats and results. Contract only: no runner, no lease endpoint and no client is built.
//
// TRUST MODEL (read this before changing anything below)
//   - A runner is CUSTOMER-HOSTED. It runs on a host the customer sanctioned (a team build host, a developer cloud host), under a service identity, outside Rovara's boundary. Rovara does not control its
//     operating system, its network or its operators.
//   - What comes back from a runner is EVIDENCE, NEVER AUTHORITY. A result says what a command printed and how it exited, as a runner claims it. The control plane decides what that is worth: it checks the
//     result against the lease it issued (`checkRunnerResult`), redacts the output, keeps it as raw evidence next to the sandbox's, and derives every verdict itself. No field of a result is a verdict, a
//     permission, an approval or an instruction, and none may become one. A result may be wrong, late, replayed or forged by whoever controls the host; it can never make a task pass or a person's gate open.
//   - The agent, its model calls and its edits stay CENTRAL. A runner runs build and test commands only: `setup_command`, `run_checks`, `prove`, `nightly`. A job can never carry a model credential, a
//     provider or model choice, a prompt, a tool list or an edit or write permission. Every object here is strict (an unknown field is refused) and every job is also scanned for such field names and for
//     credential-shaped environment names and values, so the refusal does not depend on strictness alone (`findRunnerForbiddenField`).
//   - A lease is bound to one job, one runner, one fence and one deadline. Its token is single-use: the first accepted result redeems it, and the control plane refuses a second. A lost lease is fenced and
//     re-leased at most once, never run twice (enterprise-foundations plan B). The token is an opaque random value; this file holds its SHAPE only, never a real one.
//   - Everything is bounded: commands per job, bytes per job, output bytes per command and per result, the lease's lifetime. A runner cannot make the control plane read an unbounded message.
// Pure: nothing here reads a file, a clock or a network, and it imports no Node module.
import { z } from "zod";
import { ProjectCommandSchema } from "./project.js";
import { canonicalJson } from "./canonical-json.js";
import { isCredentialKey, redactText } from "./redaction.js";

export const RUNNER_CONTRACT_VERSION = 1;

/** The only kinds of job a runner is given. Anything else (an agent step, a publish, a model call) is refused. */
export const RUNNER_JOB_KINDS = ["setup_command", "run_checks", "prove", "nightly"] as const;
export const RunnerJobKindSchema = z.enum(RUNNER_JOB_KINDS);
export type RunnerJobKind = z.infer<typeof RunnerJobKindSchema>;

/** The id of a runner, as `runner:<id>` and `/v1/runners/{id}/lease` name it. */
export const RunnerIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u, "a runner id (lowercase letters, digits, - and _, at most 63 characters)");

// ---- bounds

export const RUNNER_MAX_COMMANDS = 64;
export const RUNNER_MAX_REPOSITORIES = 16;
/** The most all of a job's command timeouts may add up to (6 hours). */
export const RUNNER_JOB_MAX_TOTAL_SECONDS = 21_600;
/** The longest a lease may live from issue to its hard deadline (8 hours). */
export const RUNNER_LEASE_MAX_SECONDS = 28_800;
export const RUNNER_HEARTBEAT_MIN_SECONDS = 5;
export const RUNNER_HEARTBEAT_MAX_SECONDS = 60;
export const RUNNER_MISSED_HEARTBEATS_MAX = 5;
/** A candidate patch is carried as a digest and a size; the bytes travel on the signed channel and are checked against both. */
export const RUNNER_PATCH_MAX_BYTES = 1_048_576;
/** The most one command's output the control plane reads: the last 4 KiB, as Prove keeps it. */
export const RUNNER_OUTPUT_TAIL_BYTES = 4_096;
/** The most a whole grant (lease and job) or a whole result may be, as JSON in UTF-8. */
export const RUNNER_GRANT_MAX_BYTES = 262_144;
export const RUNNER_RESULT_MAX_BYTES = 327_680;

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;
const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/u, "a sha256 in lowercase hex");
const GitCommit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u, "a git commit id in lowercase hex");
const RepositoryId = z.string().min(1).max(200).regex(/^[^\p{Cc}\p{Cf}\s]+$/u, "an id has no whitespace or control characters");
const Timestamp = z.string().datetime();
/** 256 bits as base64url. The SHAPE of a single-use lease token; the contract never holds a real one. */
export const RunnerLeaseTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u, "a lease token (43 base64url characters)");

// ---- fields a job can never carry

/** Names (lowercase letters and digits only) that no field of a job may contain: model credentials and choices, prompts and tools, edit and write permissions. */
const FORBIDDEN_FIELD_PARTS = [
  "model", "prompt", "provider", "bedrock", "anthropic", "openai", "apikey", "credential", "secret", "password", "passwd", "bearer", "authorization", "privatekey", "accesskey", "sessiontoken",
  "tool", "edit", "write", "permission", "privilege", "sudo", "grant",
] as const;
/** Environment names a command may not set: credentials by their words (`isCredentialKey`), and the namespaces that hold model access or Rovara's own. */
const FORBIDDEN_ENV_PREFIXES = ["ANTHROPIC_", "OPENAI_", "AWS_", "AZURE_", "GOOGLE_", "GEMINI_", "MISTRAL_", "COHERE_", "BEDROCK_", "AGENTX_", "ROVARA_"] as const;
const SCAN_MAX_DEPTH = 12;
const SCAN_MAX_NODES = 5_000;

function forbiddenFieldName(name: string): boolean {
  const flat = name.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return isCredentialKey(name) || FORBIDDEN_FIELD_PARTS.some((part) => flat.includes(part));
}

function forbiddenEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return isCredentialKey(name) || FORBIDDEN_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * The path of the first field in `value` that a job may not carry, or undefined. Field names are checked everywhere except directly under an `env` object, whose names are checked as environment names.
 * `allowed` lists the paths (dot-joined) of the one field that is allowed to look like a credential: the lease token. Bounded in depth and size; anything deeper or larger is itself refused.
 */
export function findRunnerForbiddenField(value: unknown, allowed: readonly string[] = []): string | undefined {
  let nodes = 0;
  const visit = (node: unknown, path: string[], underEnv: boolean): string | undefined => {
    nodes += 1;
    if (nodes > SCAN_MAX_NODES || path.length > SCAN_MAX_DEPTH) return path.join(".") || "(too large)";
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        const found = visit(node[index], [...path, String(index)], false);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (node === null || typeof node !== "object") return undefined;
    for (const key of Object.keys(node)) {
      const here = [...path, key];
      if (key === "__proto__") return here.join(".");
      if (!allowed.includes(here.join(".")) && (underEnv ? forbiddenEnvName(key) : forbiddenFieldName(key))) return here.join(".");
      const found = visit((node as Record<string, unknown>)[key], here, key === "env");
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(value, [], false);
}

/** Runs before the shape is read, so a forbidden field gets its own sentence whatever else is wrong. */
const refuseForbiddenFields = (allowed: readonly string[]) => (raw: unknown, context: z.RefinementCtx): void => {
  const found = findRunnerForbiddenField(raw, allowed);
  if (found !== undefined) context.addIssue({ code: "custom", message: `a runner job or result may not carry ${found}: model credentials, edit permissions and secrets stay central` });
};

// ---- commands

/** A command as a runner is given it: the project's command, with no credential-shaped environment name or value and no credential-shaped argument. */
export const RunnerCommandSchema = ProjectCommandSchema.superRefine((command, context) => {
  const text = [command.executable, ...command.args, ...Object.values(command.env ?? {})];
  if (text.some((item) => redactText(item) !== item)) context.addIssue({ code: "custom", message: "a runner command may not carry a credential" });
  if (Object.keys(command.env ?? {}).some(forbiddenEnvName)) context.addIssue({ code: "custom", path: ["env"], message: "a runner command may not set a credential or model-access variable" });
});
export type RunnerCommand = z.infer<typeof RunnerCommandSchema>;

// ---- the job

export const RunnerWorkspacePinSchema = z.object({
  /** One entry per repository, each at the commit the central worker resolved. The runner clones it with its own identity. */
  repositories: z.array(z.object({ repositoryId: RepositoryId, commit: GitCommit }).strict()).min(1).max(RUNNER_MAX_REPOSITORIES),
  /** The test environment's revision the commands come from. */
  envRevision: z.number().int().min(1),
  /** The environment key (saved-env.ts) a runner's own workspace cache is keyed by. */
  environmentKey: Sha256Hex.optional(),
}).strict().superRefine((pin, context) => {
  const seen = new Set<string>();
  for (const [index, repository] of pin.repositories.entries()) {
    if (seen.has(repository.repositoryId)) context.addIssue({ code: "custom", path: ["repositories", index, "repositoryId"], message: "a repository is pinned twice" });
    seen.add(repository.repositoryId);
  }
});
export type RunnerWorkspacePin = z.infer<typeof RunnerWorkspacePinSchema>;

const CandidatePatchSchema = z.object({
  repositoryId: RepositoryId,
  sha256: Sha256Hex,
  sizeBytes: z.number().int().min(1).max(RUNNER_PATCH_MAX_BYTES),
}).strict();

const JobBase = {
  version: z.literal(RUNNER_CONTRACT_VERSION),
  jobId: z.string().uuid(),
  workspace: RunnerWorkspacePinSchema,
  /** The code to check on top of the pinned commit, as a digest and size; absent when the pinned commit is the code. */
  candidatePatch: CandidatePatchSchema.optional(),
};
const Commands = z.array(RunnerCommandSchema).min(1).max(RUNNER_MAX_COMMANDS);

const JobObjectSchema = z.discriminatedUnion("kind", [
  // One command a person approved in setup mode (Q10). No autonomous shell on a corporate host.
  z.object({ ...JobBase, kind: z.literal("setup_command"), commands: Commands.max(1), personApprovalId: z.string().uuid() }).strict(),
  z.object({ ...JobBase, kind: z.literal("run_checks"), commands: Commands }).strict(),
  z.object({ ...JobBase, kind: z.literal("prove"), commands: Commands }).strict(),
  z.object({ ...JobBase, kind: z.literal("nightly"), commands: Commands }).strict(),
]);

function checkJob(job: z.infer<typeof JobObjectSchema>, context: z.RefinementCtx): void {
  const total = job.commands.reduce((sum, command) => sum + command.timeoutSeconds, 0);
  if (total > RUNNER_JOB_MAX_TOTAL_SECONDS) context.addIssue({ code: "custom", path: ["commands"], message: `a job's command timeouts add up to at most ${String(RUNNER_JOB_MAX_TOTAL_SECONDS)} seconds` });
  if (job.candidatePatch !== undefined && !job.workspace.repositories.some((repository) => repository.repositoryId === job.candidatePatch?.repositoryId)) {
    context.addIssue({ code: "custom", path: ["candidatePatch", "repositoryId"], message: "the patch is for a repository the job does not pin" });
  }
}

/** One job, strict by kind. A kind that is not one of the four is refused. */
export const RunnerJobSchema = z.unknown().superRefine(refuseForbiddenFields([])).pipe(JobObjectSchema).superRefine(checkJob);
export type RunnerJob = z.infer<typeof JobObjectSchema>;

// ---- the lease

const LeaseObjectSchema = z.object({
  leaseId: z.string().uuid(),
  jobId: z.string().uuid(),
  runnerId: RunnerIdSchema,
  /** The invocation's operation and fence (enterprise-foundations): a stale fence is refused, so a job is never run twice. */
  operationId: z.string().uuid(),
  fence: z.number().int().positive(),
  issuedAt: Timestamp,
  /** When the lease lapses unless a heartbeat is accepted; each accepted heartbeat moves it forward, never past the hard deadline. */
  expiresAt: Timestamp,
  hardDeadlineAt: Timestamp,
  heartbeat: z.object({
    intervalSeconds: z.number().int().min(RUNNER_HEARTBEAT_MIN_SECONDS).max(RUNNER_HEARTBEAT_MAX_SECONDS),
    /** Heartbeats that may be missed before the lease lapses. */
    missedAllowed: z.number().int().min(1).max(RUNNER_MISSED_HEARTBEATS_MAX),
  }).strict(),
  /** Redeemed by the first accepted result; a second use is refused. */
  singleUse: z.literal(true),
  leaseToken: RunnerLeaseTokenSchema,
}).strict();
export type RunnerLease = z.infer<typeof LeaseObjectSchema>;

function checkLease(lease: RunnerLease, context: z.RefinementCtx): void {
  const issued = Date.parse(lease.issuedAt);
  const expires = Date.parse(lease.expiresAt);
  const hard = Date.parse(lease.hardDeadlineAt);
  if (!(issued < expires)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "a lease expires after it is issued" });
  if (!(expires <= hard)) context.addIssue({ code: "custom", path: ["hardDeadlineAt"], message: "the hard deadline is not before the expiry" });
  if (hard - issued > RUNNER_LEASE_MAX_SECONDS * 1000) context.addIssue({ code: "custom", path: ["hardDeadlineAt"], message: `a lease lives at most ${String(RUNNER_LEASE_MAX_SECONDS)} seconds` });
}
export const RunnerLeaseSchema = z.unknown().superRefine(refuseForbiddenFields(["leaseToken"])).pipe(LeaseObjectSchema).superRefine(checkLease);

/** What the long-poll hands a runner: the lease and the job it is for. */
export const RunnerGrantSchema = z.unknown()
  .superRefine((raw, context) => {
    refuseForbiddenFields(["lease.leaseToken"])(raw, context);
    if (utf8Bytes(JSON.stringify(raw) ?? "") > RUNNER_GRANT_MAX_BYTES) context.addIssue({ code: "custom", message: `a grant is at most ${String(RUNNER_GRANT_MAX_BYTES)} bytes` });
  })
  .pipe(z.object({ version: z.literal(RUNNER_CONTRACT_VERSION), lease: LeaseObjectSchema, job: JobObjectSchema }).strict())
  .superRefine((grant, context) => {
    checkLease(grant.lease, context);
    checkJob(grant.job, context);
    if (grant.lease.jobId !== grant.job.jobId) context.addIssue({ code: "custom", path: ["lease", "jobId"], message: "the lease is for another job" });
    const total = grant.job.commands.reduce((sum, command) => sum + command.timeoutSeconds, 0);
    if (total * 1000 > Date.parse(grant.lease.hardDeadlineAt) - Date.parse(grant.lease.issuedAt)) context.addIssue({ code: "custom", path: ["lease", "hardDeadlineAt"], message: "the commands' timeouts do not fit in the lease" });
  });
export type RunnerGrant = z.infer<typeof RunnerGrantSchema>;

// ---- heartbeat

export const RunnerHeartbeatSchema = z.unknown().superRefine(refuseForbiddenFields([])).pipe(z.object({
  version: z.literal(RUNNER_CONTRACT_VERSION),
  leaseId: z.string().uuid(),
  jobId: z.string().uuid(),
  fence: z.number().int().positive(),
  /** 0, 1, 2 ...: a repeated or older number is ignored. */
  seq: z.number().int().min(0).max(1_000_000),
  sentAt: Timestamp,
  /** The command in progress, by its place in the job. */
  commandIndex: z.number().int().min(0).max(RUNNER_MAX_COMMANDS - 1).optional(),
}).strict());
export type RunnerHeartbeat = z.infer<typeof RunnerHeartbeatSchema>;

/** The control plane's answer: keep going, or stop. `continue` carries the new expiry. */
export const RunnerHeartbeatAckSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("continue"), expiresAt: Timestamp }).strict(),
  z.object({ action: z.enum(["cancel", "revoked", "expired"]) }).strict(),
]);
export type RunnerHeartbeatAck = z.infer<typeof RunnerHeartbeatAckSchema>;

// ---- result

export const RunnerCommandResultSchema = z.object({
  /** The command's place in the job. */
  index: z.number().int().min(0).max(RUNNER_MAX_COMMANDS - 1),
  /** Raw facts as the runner saw them. A verdict is made centrally from these. */
  exitCode: z.number().int().min(0).max(255).nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().min(0).max(RUNNER_LEASE_MAX_SECONDS * 1000),
  /** The last part of what the command printed (stdout and stderr), plain text, at most 4 KiB. The control plane redacts it again before keeping it. */
  outputTail: z.string().max(RUNNER_OUTPUT_TAIL_BYTES).refine((text) => utf8Bytes(text) <= RUNNER_OUTPUT_TAIL_BYTES, "output tail is over 4096 bytes")
    .refine((text) => !/[^\P{Cc}\n\t]/u.test(text), "output tail is plain text"),
  /** Whether the runner cut the output to fit. */
  outputCut: z.boolean(),
}).strict();

const ResultObjectSchema = z.object({
  version: z.literal(RUNNER_CONTRACT_VERSION),
  jobId: z.string().uuid(),
  leaseId: z.string().uuid(),
  fence: z.number().int().positive(),
  kind: RunnerJobKindSchema,
  /** The pin the runner says it ran at. The control plane compares it to the job's; a difference voids the result. */
  workspace: RunnerWorkspacePinSchema,
  /** `finished`: every command ran. `stopped`: the runner stopped after a failure or a cancel. `infrastructure`: the host could not run the job (no result about the code). */
  outcome: z.enum(["finished", "stopped", "infrastructure"]),
  commands: z.array(RunnerCommandResultSchema).max(RUNNER_MAX_COMMANDS),
  finishedAt: Timestamp,
  /** Redeems the lease token. */
  leaseToken: RunnerLeaseTokenSchema,
}).strict();
export type RunnerResult = z.infer<typeof ResultObjectSchema>;

export const RunnerResultSchema = z.unknown()
  .superRefine((raw, context) => {
    refuseForbiddenFields(["leaseToken"])(raw, context);
    if (utf8Bytes(JSON.stringify(raw) ?? "") > RUNNER_RESULT_MAX_BYTES) context.addIssue({ code: "custom", message: `a result is at most ${String(RUNNER_RESULT_MAX_BYTES)} bytes` });
  })
  .pipe(ResultObjectSchema)
  .superRefine((result, context) => {
    result.commands.forEach((command, at) => {
      if (command.index !== at) context.addIssue({ code: "custom", path: ["commands", at, "index"], message: "command results are in order, from 0, with no gaps" });
    });
  });

/**
 * Whether a parsed result answers a grant the control plane issued: same job, lease, fence, kind, token and pin, no result for a command the job does not have, and a `finished` result holds every command.
 * Returns fixed words, never the runner's. This is the check that keeps a result evidence: it binds the claim to the lease. It does not make any claim true.
 */
export function checkRunnerResult(grant: RunnerGrant, result: RunnerResult): { ok: true } | { ok: false; reason: "wrong_job" | "wrong_lease" | "wrong_token" | "wrong_workspace" | "too_many_commands" | "incomplete" } {
  if (result.jobId !== grant.job.jobId) return { ok: false, reason: "wrong_job" };
  if (result.leaseId !== grant.lease.leaseId || result.fence !== grant.lease.fence || result.kind !== grant.job.kind) return { ok: false, reason: "wrong_lease" };
  if (result.leaseToken !== grant.lease.leaseToken) return { ok: false, reason: "wrong_token" };
  if (canonicalJson(result.workspace) !== canonicalJson(grant.job.workspace)) return { ok: false, reason: "wrong_workspace" };
  if (result.commands.length > grant.job.commands.length) return { ok: false, reason: "too_many_commands" };
  if (result.outcome === "finished" && result.commands.length !== grant.job.commands.length) return { ok: false, reason: "incomplete" };
  return { ok: true };
}
