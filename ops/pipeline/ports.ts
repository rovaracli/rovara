// The real ports: every outside effect of the stage CLI goes through one of these, so tests pass fakes (L2-STAGE-CLI-INTERFACE.md 3.3).
// Rules kept here: every AWS call names the region; nothing reads a secret value (no get-secret-value, no --with-decryption); every CloudFormation call
// runs with the credentials of the account's CDK bootstrap deploy role (4.2).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { PipelineConfig } from "./config.ts";
import { canonicalSha256, sha256Hex } from "./lib/hash.ts";
import { StageError } from "./types.ts";
import type { ChangeRow, ExecOptions, ExecResult, PipelineEnv, Ports } from "./types.ts";

export class AwsError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.stderr = stderr;
  }
}

export interface RealPortsArgs { config: PipelineConfig; env: PipelineEnv; region: string; exec8: string; profile: string | null; cwd: string }

function run(cmd: string, args: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error: NodeJS.ErrnoException) => resolve({ code: error.code === "ENOENT" ? 127 : 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const stringMap = (list: unknown, key: string, value: string): Record<string, string> => {
  const out: Record<string, string> = {};
  if (Array.isArray(list)) for (const item of list as Array<Record<string, unknown>>) if (typeof item[key] === "string" && typeof item[value] === "string") out[item[key]] = item[value];
  return out;
};

export function createRealPorts(args: RealPortsArgs): Ports {
  const { config, region, profile } = args;
  const baseEnv: Record<string, string | undefined> = { AWS_REGION: region, AWS_DEFAULT_REGION: region, AWS_PAGER: "", ...(profile === null ? {} : { AWS_PROFILE: profile }) };
  const exec: Ports["exec"] = (cmd, a, opts) => run(cmd, a, { ...opts, env: { ...baseEnv, ...opts?.env } });
  const aws: Ports["aws"] = {
    async json(a, opts) {
      const awsEnv = { ...baseEnv, ...(opts?.profile === undefined ? {} : opts.profile === null ? { AWS_PROFILE: undefined } : { AWS_PROFILE: opts.profile }), ...opts?.env };
      const result = await run("aws", [...a, "--region", region, "--output", "json"], { env: awsEnv });
      if (result.code !== 0) throw new AwsError(`aws ${a.slice(0, 2).join(" ")} failed: ${result.stderr.trim().split("\n").slice(-1)[0] ?? ""}`, result.stderr);
      return result.stdout.trim() === "" ? null : (JSON.parse(result.stdout) as unknown);
    },
  };
  let account: string | null = null;
  const sts: Ports["sts"] = {
    async account() {
      if (account === null) {
        const who = (await aws.json(["sts", "get-caller-identity"])) as { Account?: string };
        if (typeof who.Account !== "string" || !/^[0-9]{12}$/u.test(who.Account)) throw new StageError("REFUSED", "STS returned no account id");
        account = who.Account;
      }
      return account;
    },
  };
  let creds: { env: Record<string, string>; at: number } | null = null;
  const deployEnv = async (): Promise<Record<string, string>> => {
    if (creds !== null && Date.now() - creds.at < 40 * 60_000) return creds.env;
    const acct = await sts.account();
    const answer = (await aws.json(["sts", "assume-role", "--role-arn", `arn:aws:iam::${acct}:role/cdk-${config.bootstrapQualifier}-deploy-role-${acct}-${region}`, "--role-session-name", `rovara-pipeline-${args.exec8}`])) as { Credentials: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string } };
    creds = { at: Date.now(), env: { AWS_ACCESS_KEY_ID: answer.Credentials.AccessKeyId, AWS_SECRET_ACCESS_KEY: answer.Credentials.SecretAccessKey, AWS_SESSION_TOKEN: answer.Credentials.SessionToken } };
    return creds.env;
  };
  // CloudFormation, always as the deploy role: no profile, so the CLI uses the credential variables above.
  const cfnJson = async (a: readonly string[]): Promise<unknown> => aws.json(["cloudformation", ...a], { env: await deployEnv(), profile: null });
  const notThere = (error: unknown, pattern: RegExp): boolean => error instanceof AwsError && pattern.test(error.stderr);
  const body = (template: unknown): unknown => {
    const t = (template as { TemplateBody?: unknown }).TemplateBody;
    return t;
  };
  const hashTemplate = (t: unknown): string => {
    if (typeof t === "string") { try { return canonicalSha256(JSON.parse(t)); } catch { return sha256Hex(t); } }
    return canonicalSha256(t);
  };
  const cfn: Ports["cfn"] = {
    async describeStack(stack) {
      try {
        const doc = (await cfnJson(["describe-stacks", "--stack-name", stack])) as { Stacks?: Array<Record<string, unknown>> };
        const s = doc.Stacks?.[0];
        if (s === undefined) return null;
        return { status: String(s.StackStatus), parameters: stringMap(s.Parameters, "ParameterKey", "ParameterValue"), outputs: stringMap(s.Outputs, "OutputKey", "OutputValue") };
      } catch (error) {
        if (notThere(error, /does not exist/u)) return null;
        throw error;
      }
    },
    async describeChangeSet(stack, name) {
      try {
        const doc = (await cfnJson(["describe-change-set", "--stack-name", stack, "--change-set-name", name])) as Record<string, unknown>;
        const rows: ChangeRow[] = [];
        for (const change of (doc.Changes as Array<{ ResourceChange?: Record<string, unknown> }> | undefined) ?? []) {
          const rc = change.ResourceChange ?? {};
          const replacement = rc.Replacement === "True" || rc.Replacement === "False" || rc.Replacement === "Conditional" ? rc.Replacement : null;
          const details = Array.isArray(rc.Details) ? (rc.Details as Array<{ Target?: { Attribute?: unknown; Name?: unknown } }>) : null;
          const changedProperties = details === null ? null : [...new Set(details.map((d) => (typeof d.Target?.Attribute === "string" ? (typeof d.Target.Name === "string" ? `${d.Target.Attribute}:${d.Target.Name}` : d.Target.Attribute) : "")).filter((name) => name !== ""))];
          rows.push({ action: str(rc.Action), logicalId: str(rc.LogicalResourceId), physicalId: typeof rc.PhysicalResourceId === "string" ? rc.PhysicalResourceId : null, resourceType: str(rc.ResourceType), replacement, ...(changedProperties === null ? {} : { changedProperties }) });
        }
        return { id: String(doc.ChangeSetId), status: String(doc.Status), executionStatus: String(doc.ExecutionStatus), statusReason: typeof doc.StatusReason === "string" ? doc.StatusReason : null, rows };
      } catch (error) {
        if (notThere(error, /ChangeSetNotFound|Stack \[[^\]]*\] does not exist/u)) return null; // no such change set, or no such stack (so none)
        throw error;
      }
    },
    async templateSha256(stack, changeSetName) {
      return hashTemplate(body(await cfnJson(["get-template", "--stack-name", stack, "--change-set-name", changeSetName, "--template-stage", "Original"])));
    },
    async liveTemplateSha256(stack) {
      try { return hashTemplate(body(await cfnJson(["get-template", "--stack-name", stack, "--template-stage", "Original"]))); } catch (error) {
        if (notThere(error, /does not exist/u)) return null;
        throw error;
      }
    },
    async executeChangeSet(stack, name) { await cfnJson(["execute-change-set", "--stack-name", stack, "--change-set-name", name]); },
    async deleteChangeSet(stack, name) { await cfnJson(["delete-change-set", "--stack-name", stack, "--change-set-name", name]); },
    async listChangeSetNames(stack) {
      const doc = (await cfnJson(["list-change-sets", "--stack-name", stack])) as { Summaries?: Array<{ ChangeSetName?: string }> };
      return (doc.Summaries ?? []).map((s) => s.ChangeSetName).filter((n): n is string => typeof n === "string");
    },
    async waitSettled(stack, timeoutSeconds) {
      const started = Date.now();
      for (;;) {
        const described = await cfn.describeStack(stack);
        const status = described?.status ?? "ABSENT";
        if (!status.endsWith("_IN_PROGRESS")) return status;
        if (Date.now() - started > timeoutSeconds * 1000) throw new StageError("DEPLOY_FAILED", `${stack} is still ${status} after ${timeoutSeconds} s`);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    },
  };
  const git = async (a: readonly string[], cwd = args.cwd): Promise<ExecResult> => run("git", a, { cwd });
  return {
    exec,
    aws,
    git: {
      async fetchTags() {
        const r = await git(["fetch", "--force", "--quiet", "origin", "refs/tags/*:refs/tags/*"]);
        if (r.code !== 0) throw new StageError("REF_FAILED", `git fetch of the tags failed: ${r.stderr.trim()}`);
      },
      async fetchBranch(branch) { return (await git(["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`])).code === 0; },
      async tags() { return (await git(["tag", "--list"])).stdout.split("\n").filter((t) => t !== ""); },
      async revParse(ref) {
        const r = await git(["rev-parse", "--verify", ref]);
        if (r.code !== 0) throw new StageError("REF_FAILED", `cannot resolve ${ref}`);
        return r.stdout.trim();
      },
      async isAncestor(ancestor, descendant) {
        const r = await git(["merge-base", "--is-ancestor", ancestor, descendant]);
        if (r.code === 0) return true;
        if (r.code === 1) return false;
        throw new StageError("REF_FAILED", `git could not compare ${ancestor.slice(0, 12)} with ${descendant}: ${r.stderr.trim()}`);
      },
      async worktree(sha, dir) {
        const r = await git(["worktree", "add", "--detach", dir, sha]);
        if (r.code !== 0) throw new StageError("FAILED", `git worktree add failed: ${r.stderr.trim()}`);
      },
    },
    cfn,
    cdk: {
      async deployNoExecute(a) {
        const context = Object.entries(a.context).flatMap(([k, v]) => ["-c", `${k}=${v}`]);
        // `--exclusively`: only the named stacks, never their dependency stacks (a dependency would be handed parameters it does not declare).
        // Every parameter is `<stack name>:<Key>=<value>`: cdk matches the part before the colon with the stack's own name (not its construct id), and an unprefixed one goes to every stack.
        for (const s of a.stacks) if (s.stackName === "" || s.stackName.includes(":") || Object.keys(s.parameters).some((k) => k === "" || k.includes(":"))) throw new StageError("USAGE", `cdk deploy: the stack name ${JSON.stringify(s.stackName)} or one of its parameter names is not usable in --parameters`);
        const parameters = a.stacks.flatMap((s) => Object.entries(s.parameters).flatMap(([k, v]) => ["--parameters", `${s.stackName}:${k}=${v}`]));
        const r = await exec("npx", ["--no-install", "cdk", "deploy", ...a.stacks.map((s) => s.stackId), "--exclusively", "--app", "node infra/dist/bin/agentx.js", "--no-execute", "--require-approval", "never", "--change-set-name", a.changeSetName, "--progress", "events", ...context, ...parameters], { cwd: a.dir });
        if (r.code !== 0) throw new StageError("FAILED", `cdk deploy --no-execute failed (exit ${r.code}): ${(r.stderr || r.stdout).split("\n").filter((l) => l !== "").slice(-4).join(" / ")}`);
      },
    },
    ssm: {
      async get(name) {
        try { return String(((await aws.json(["ssm", "get-parameter", "--name", name])) as { Parameter: { Value: string } }).Parameter.Value); } catch (error) {
          if (notThere(error, /ParameterNotFound/u)) return null;
          throw error;
        }
      },
      async put(name, value) { await aws.json(["ssm", "put-parameter", "--name", name, "--value", value, "--type", "String", "--overwrite"]); },
    },
    http: {
      async get(url, timeoutMs) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual", headers: { accept: "application/json" } });
          return { status: response.status, body: (await response.text()).slice(0, 65_536) };
        } catch { return { status: 0 }; }
      },
    },
    sts,
    fs: {
      readText: (p) => readFileSync(p, "utf8"),
      writeText: (p, text) => writeFileSync(p, text),
      exists: (p) => existsSync(p),
      mkdirp: (p) => { mkdirSync(p, { recursive: true }); },
      readdir: (p) => readdirSync(p),
    },
    clock: { now: () => new Date(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
  };
}
