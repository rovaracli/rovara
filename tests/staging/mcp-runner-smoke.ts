// Stdio MCP host redesign, task T12: the smoke of the package-run MCP servers on an Enterprise STAGING install. It is run by a person (the controller) once, after the turn-on release is
// deployed to staging, by `tests/staging/mcp-runner-smoke.ts --run`. NOTHING here runs by itself, and nothing in the test suite calls AWS: the checks are tested below against fakes.
//
// Rules this file keeps:
//   - every AWS call goes through the staging guard (`staging-aws.sh aws ...`, ROVARA_STAGING_AWS), which pins the account and the region; it never calls `aws` directly, never passes
//     a profile or a region, and never calls secretsmanager get-secret-value (the host's token arrives in the environment, resolved by `asm-exec`; see the checklist);
//   - it refuses to run without `--run` and ROVARA_STAGING_SMOKE=1, and refuses an http:// host;
//   - it prints names, counts, codes and times only: never the token, a secret value, or an environment value.
//
// The server under test is the test-only package `@rovara-test/selfcheck-mcp` (tests/staging/selfcheck-mcp), published to the install's own registry mirror and approved by an admin
// in the staging UI like any other (that approval is the first real use of the admin flow). It reports, from inside a real serve task, what the task can reach.
//
// Phases (run in order; each is a separate invocation so a person can do the admin steps between them):
//   start     warm and call the server: cold start time, what the task can and cannot reach, the task's shape (no task role, locked-down containers, a group with no 0.0.0.0/0).
//   idle      wait for the idle stop (10 minutes with no call, plus a margin).
//   disable   run right after an admin pressed "Turn off": the task is gone within 60 seconds and the host says it released it.
//   restart   plant a leftover task, force the controller to restart, and see the new controller stop the leftover.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SmokeConfig {
  hostUrl: string;
  hostToken: string;
  /** The approved server's id (`mcp...`). */
  serverId: string;
  cluster: string;
  controllerService: string;
  runnerSubnets: string[];
  installSecurityGroup: string;
  /** The names the server was declared with (its secret names). Their presence is checked; their values are never read. */
  declaredEnv: string[];
  /** The address the admin approved (reachable), an address in the VPC that was not approved, and an address on the internet. */
  approved: { host: string; port: number };
  vpcProbe: { host: string; port: number };
  internetProbe: { host: string; port: number };
}

export interface SmokeDeps {
  fetch: typeof fetch;
  /** One AWS CLI call through the staging guard, as `aws <args>`. Returns stdout. Throws on a non-zero exit. */
  aws(args: string[]): Promise<string>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

export interface Check { name: string; ok: boolean; detail: string }
export interface SmokeReport { phase: Phase; ok: boolean; checks: Check[] }
export const PHASES = ["start", "idle", "disable", "restart"] as const;
export type Phase = (typeof PHASES)[number];

/** Limits (milliseconds). */
export const LIMITS = { coldStart: 120_000, idleStop: 13 * 60_000, disableStop: 60_000, plantRunning: 3 * 60_000, restartStop: 6 * 60_000, poll: 5_000 } as const;
const FORBIDDEN_ENV_PREFIXES = ["AWS_", "ECS_", "MCP_", "ROVARA_", "NODE_OPTIONS", "NPM_", "GIT_"];

const ok = (name: string, detail: string): Check => ({ name, ok: true, detail });
const bad = (name: string, detail: string): Check => ({ name, ok: false, detail });
const verdict = (phase: Phase, checks: Check[]): SmokeReport => ({ phase, ok: checks.every((check) => check.ok), checks });

export function checkConfig(config: SmokeConfig): void {
  let url: URL;
  try { url = new URL(config.hostUrl); } catch { throw new Error("the host address is not a web address"); }
  if (url.protocol !== "https:") throw new Error("the host must be reached over https");
  if (!/^mcp[a-z0-9]{6,24}$/u.test(config.serverId)) throw new Error("the server id is not valid");
  if (config.hostToken.length < 43) throw new Error("the host token is missing or too short (resolve it with asm-exec; see the checklist)");
  if (config.runnerSubnets.length === 0 || !config.runnerSubnets.every((subnet) => /^subnet-[0-9a-f]{8,17}$/u.test(subnet))) throw new Error("the runner subnets are not valid");
  if (!/^sg-[0-9a-f]{8,17}$/u.test(config.installSecurityGroup)) throw new Error("the install security group is not valid");
  for (const target of [config.approved, config.vpcProbe, config.internetProbe]) if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65_535 || target.host === "") throw new Error("a probe address is not valid");
}

async function callTool(config: SmokeConfig, deps: SmokeDeps, name: string, args: Record<string, unknown>): Promise<{ status: number; result: unknown }> {
  const response = await deps.fetch(`${config.hostUrl.replace(/\/$/u, "")}/servers/${config.serverId}/mcp`, {
    method: "POST", headers: { authorization: `Bearer ${config.hostToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(LIMITS.coldStart + 60_000),
  });
  const text = await response.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data:"))?.slice(5) ?? "{}";
  try {
    const content = ((JSON.parse(json) as { result?: { content?: Array<{ text?: string }> } }).result?.content?.[0]?.text) ?? "null";
    return { status: response.status, result: JSON.parse(content) as unknown };
  } catch { return { status: response.status, result: undefined }; }
}

const post = async (config: SmokeConfig, deps: SmokeDeps, action: "warm" | "release"): Promise<{ status: number; body: unknown }> => {
  const response = await deps.fetch(`${config.hostUrl.replace(/\/$/u, "")}/servers/${config.serverId}/${action}`, { method: "POST", headers: { authorization: `Bearer ${config.hostToken}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(30_000) });
  return { status: response.status, body: await response.json().catch(() => undefined) };
};

const json = async (deps: SmokeDeps, args: string[]): Promise<Record<string, unknown>> => JSON.parse(await deps.aws([...args, "--output", "json"])) as Record<string, unknown>;

/** The ARNs of the running tasks of this server's family. */
async function serveTasks(config: SmokeConfig, deps: SmokeDeps): Promise<string[]> {
  const out = await json(deps, ["ecs", "list-tasks", "--cluster", config.cluster, "--family", `rovara-mcp-serve-${config.serverId}`, "--desired-status", "RUNNING"]);
  return (out.taskArns as string[] | undefined) ?? [];
}

async function waitUntil(deps: SmokeDeps, limitMs: number, done: () => Promise<boolean>): Promise<number | undefined> {
  const start = deps.now();
  for (;;) {
    if (await done().catch(() => false)) return deps.now() - start;
    if (deps.now() - start >= limitMs) return undefined;
    await deps.sleep(LIMITS.poll);
  }
}

// ---------------------------------------------------------------------------------------------
// Phase: start
// ---------------------------------------------------------------------------------------------

interface SelfcheckResult {
  credentials?: { uriVariable?: boolean; metadataStatus?: number | string };
  internet?: string; vpc?: string; approved?: string; environment?: string[];
}

export async function phaseStart(config: SmokeConfig, deps: SmokeDeps): Promise<SmokeReport> {
  const checks: Check[] = [];
  const started = deps.now();
  const warm = await post(config, deps, "warm").catch(() => ({ status: 0, body: undefined }));
  checks.push(warm.status === 202 || warm.status === 200 ? ok("warm", `the host answered ${warm.status}`) : bad("warm", `the host answered ${warm.status}`));
  const first = await callTool(config, deps, "selfcheck", { live: true, timeoutMs: 5_000, approved: config.approved, vpc: config.vpcProbe, internet: config.internetProbe }).catch(() => ({ status: 0, result: undefined }));
  const coldStartMs = deps.now() - started;
  checks.push(first.status === 200 ? ok("first call", `answered 200 after ${coldStartMs} ms (cold start, measured)`) : bad("first call", `answered ${first.status}`));
  checks.push(coldStartMs <= LIMITS.coldStart ? ok("cold start within bound", `${coldStartMs} ms of ${LIMITS.coldStart} ms`) : bad("cold start within bound", `${coldStartMs} ms is over ${LIMITS.coldStart} ms`));
  const result = (first.result ?? {}) as SelfcheckResult;
  checks.push(result.credentials?.uriVariable === false ? ok("no credentials variable", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI is not set") : bad("no credentials variable", "the task has a credentials variable or did not say"));
  checks.push(result.credentials?.metadataStatus !== 200 && result.credentials?.metadataStatus !== undefined ? ok("no credentials from 169.254.170.2", `status ${String(result.credentials?.metadataStatus)}`) : bad("no credentials from 169.254.170.2", `status ${String(result.credentials?.metadataStatus)}`));
  checks.push(result.internet === "timeout" ? ok("the internet times out", "timeout") : bad("the internet times out", String(result.internet)));
  checks.push(result.vpc === "timeout" ? ok("a VPC address that was not approved times out", "timeout") : bad("a VPC address that was not approved times out", String(result.vpc)));
  checks.push(result.approved === "connected" ? ok("the approved address answers", "connected") : bad("the approved address answers", String(result.approved)));
  const names = result.environment ?? [];
  const forbidden = names.filter((name) => FORBIDDEN_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)));
  const missing = config.declaredEnv.filter((name) => !names.includes(name));
  checks.push(names.length > 0 && forbidden.length === 0 && missing.length === 0 ? ok("environment holds only declared names", `${names.length} names, all declared secret names present, none reserved`) : bad("environment holds only declared names", `reserved names: ${forbidden.join(",") || "none"}; missing declared names: ${missing.join(",") || "none"}; ${names.length} names`));

  // The shape of the running task, read from the cloud (not from the task).
  try {
    const arns = await serveTasks(config, deps);
    checks.push(arns.length === 1 ? ok("one serve task", "1 running") : bad("one serve task", `${arns.length} running`));
    if (arns.length === 1) {
      const task = ((await json(deps, ["ecs", "describe-tasks", "--cluster", config.cluster, "--tasks", arns[0]!])).tasks as Array<Record<string, unknown>>)[0]!;
      const definition = ((await json(deps, ["ecs", "describe-task-definition", "--task-definition", String(task.taskDefinitionArn)])).taskDefinition as Record<string, unknown>);
      checks.push(definition.taskRoleArn === undefined || definition.taskRoleArn === null || definition.taskRoleArn === "" ? ok("no task role", "the task definition has none") : bad("no task role", "the task definition names a task role"));
      const containers = (definition.containerDefinitions as Array<{ name?: string; user?: string; readonlyRootFilesystem?: boolean; linuxParameters?: { capabilities?: { drop?: string[]; add?: string[] } }; privileged?: boolean }>);
      const locked = containers.length === 2 && containers.every((container) => container.readonlyRootFilesystem === true && container.privileged !== true && (container.linuxParameters?.capabilities?.drop ?? []).includes("ALL") && (container.linuxParameters?.capabilities?.add ?? []).length === 0 && /^100\d\d:100\d\d$/u.test(container.user ?? ""));
      checks.push(locked ? ok("containers locked down", "read-only root, all capabilities dropped, non-root users, not privileged") : bad("containers locked down", "a container is not read-only, keeps a capability, is privileged or runs as the wrong user"));
      const groups = ((task.attachments as Array<{ details?: Array<{ name?: string; value?: string }> }> | undefined) ?? []).flatMap((attachment) => attachment.details ?? []);
      const eni = groups.find((detail) => detail.name === "networkInterfaceId")?.value;
      if (eni !== undefined) {
        const described = (await json(deps, ["ec2", "describe-network-interfaces", "--network-interface-ids", eni])).NetworkInterfaces as Array<{ Groups?: Array<{ GroupId?: string }> }>;
        const groupIds = (described[0]?.Groups ?? []).map((group) => String(group.GroupId));
        const security = (await json(deps, ["ec2", "describe-security-groups", "--group-ids", ...groupIds])).SecurityGroups as Array<{ IpPermissionsEgress?: Array<{ IpRanges?: Array<{ CidrIp?: string }>; Ipv6Ranges?: unknown[] }> }>;
        const wide = security.flatMap((group) => group.IpPermissionsEgress ?? []).some((rule) => (rule.IpRanges ?? []).some((range) => range.CidrIp === "0.0.0.0/0") || (rule.Ipv6Ranges ?? []).length > 0);
        checks.push(groupIds.length === 1 && !wide ? ok("its own security group, no way out", "1 group; no 0.0.0.0/0 and no IPv6 rule") : bad("its own security group, no way out", `${groupIds.length} groups; wide rule: ${String(wide)}`));
      } else checks.push(bad("its own security group, no way out", "the task has no network interface to read"));
    }
  } catch { checks.push(bad("the task's shape", "the cloud could not be read")); }
  return verdict("start", checks);
}

// ---------------------------------------------------------------------------------------------
// Phases: idle, disable, restart
// ---------------------------------------------------------------------------------------------

export async function phaseIdle(config: SmokeConfig, deps: SmokeDeps): Promise<SmokeReport> {
  const before = await serveTasks(config, deps).catch(() => []);
  if (before.length === 0) return verdict("idle", [bad("a task to wait for", "no serve task is running; run the start phase first")]);
  const waited = await waitUntil(deps, LIMITS.idleStop, async () => (await serveTasks(config, deps)).length === 0);
  return verdict("idle", [waited === undefined ? bad("idle stop", `the task was still running after ${LIMITS.idleStop} ms`) : ok("idle stop", `the task stopped after ${waited} ms with no call`)]);
}

export async function phaseDisable(config: SmokeConfig, deps: SmokeDeps): Promise<SmokeReport> {
  const checks: Check[] = [];
  const waited = await waitUntil(deps, LIMITS.disableStop, async () => (await serveTasks(config, deps)).length === 0);
  checks.push(waited === undefined ? bad("the task stops within 60 s of Turn off", `still running after ${LIMITS.disableStop} ms (was Turn off pressed?)`) : ok("the task stops within 60 s of Turn off", `gone after ${waited} ms`));
  const released = await post(config, deps, "release").catch(() => ({ status: 0, body: undefined }));
  checks.push(released.status === 200 ? ok("the host released it", "released") : bad("the host released it", `answered ${released.status}`));
  const called = await callTool(config, deps, "selfcheck", { live: false }).catch(() => ({ status: 0, result: undefined }));
  checks.push(called.status === 404 || called.status === 403 ? ok("a call to a turned-off server is refused", `answered ${called.status}`) : bad("a call to a turned-off server is refused", `answered ${called.status}`));
  checks.push((await serveTasks(config, deps).catch(() => ["?"])).length === 0 ? ok("no task was started by that call", "none running") : bad("no task was started by that call", "a task is running"));
  return verdict("disable", checks);
}

export async function phaseRestart(config: SmokeConfig, deps: SmokeDeps): Promise<SmokeReport> {
  const checks: Check[] = [];
  const overrides = JSON.stringify({ containerOverrides: [{ name: "install", command: ["/usr/local/bin/node", "-e", "setTimeout(() => {}, 900000)"] }] });
  const network = `awsvpcConfiguration={subnets=[${config.runnerSubnets.join(",")}],securityGroups=[${config.installSecurityGroup}],assignPublicIp=DISABLED}`;
  const planted = await json(deps, ["ecs", "run-task", "--cluster", config.cluster, "--task-definition", "rovara-mcp-install", "--launch-type", "FARGATE", "--started-by", "smoke-plant", "--network-configuration", network, "--overrides", overrides, "--count", "1"]).catch(() => undefined);
  const arn = (planted?.tasks as Array<{ taskArn?: string }> | undefined)?.[0]?.taskArn;
  if (arn === undefined) return verdict("restart", [bad("a planted leftover task", "the task could not be started")]);
  const running = await waitUntil(deps, LIMITS.plantRunning, async () => (((await json(deps, ["ecs", "describe-tasks", "--cluster", config.cluster, "--tasks", arn])).tasks as Array<{ lastStatus?: string }>)[0]?.lastStatus) === "RUNNING");
  checks.push(running === undefined ? bad("a planted leftover task", "it did not reach RUNNING") : ok("a planted leftover task", `running after ${running} ms; the controller did not start it`));
  if (running === undefined) {
    await deps.aws(["ecs", "stop-task", "--cluster", config.cluster, "--task", arn, "--reason", "smoke cleanup"]).catch(() => undefined);
    return verdict("restart", checks);
  }
  await deps.aws(["ecs", "update-service", "--cluster", config.cluster, "--service", config.controllerService, "--force-new-deployment"]).catch(() => { checks.push(bad("controller restart", "the restart could not be asked for")); });
  const stopped = await waitUntil(deps, LIMITS.restartStop, async () => {
    const task = ((await json(deps, ["ecs", "describe-tasks", "--cluster", config.cluster, "--tasks", arn])).tasks as Array<{ lastStatus?: string; stoppedReason?: string }>)[0];
    return task?.lastStatus === "STOPPED" && /leftover/u.test(task.stoppedReason ?? "");
  });
  checks.push(stopped === undefined ? bad("the new controller stops the leftover", `not stopped for 'leftover' within ${LIMITS.restartStop} ms`) : ok("the new controller stops the leftover", `stopped as a leftover after ${stopped} ms`));
  if (stopped === undefined) await deps.aws(["ecs", "stop-task", "--cluster", config.cluster, "--task", arn, "--reason", "smoke cleanup"]).catch(() => undefined);
  return verdict("restart", checks);
}

export async function runPhase(phase: Phase, config: SmokeConfig, deps: SmokeDeps): Promise<SmokeReport> {
  checkConfig(config);
  if (phase === "start") return phaseStart(config, deps);
  if (phase === "idle") return phaseIdle(config, deps);
  if (phase === "disable") return phaseDisable(config, deps);
  return phaseRestart(config, deps);
}

// ---------------------------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------------------------

/** One AWS CLI call through the staging guard. The guard pins the account and the region; this passes neither. */
export function guardedAws(guard: string, spawnImpl: typeof spawn = spawn): SmokeDeps["aws"] {
  return (args) => new Promise((resolve, reject) => {
    const child = spawnImpl(guard, ["aws", ...args], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.on("error", () => reject(new Error("the staging guard could not be started")));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`aws exited ${String(code)}`))));
  });
}

function configFromEnv(env: Record<string, string | undefined>): SmokeConfig {
  const need = (name: string): string => { const value = env[name]; if (value === undefined || value === "") throw new Error(`${name} is not set`); return value; };
  const target = (name: string): { host: string; port: number } => { const [host, port] = need(name).split(":"); return { host: host ?? "", port: Number(port) }; };
  return {
    hostUrl: need("MCP_HOST_URL"), hostToken: need("MCP_HOST_TOKEN"), serverId: need("SMOKE_SERVER_ID"), cluster: need("SMOKE_CLUSTER"), controllerService: need("SMOKE_CONTROLLER_SERVICE"),
    runnerSubnets: need("SMOKE_RUNNER_SUBNETS").split(","), installSecurityGroup: need("SMOKE_INSTALL_SECURITY_GROUP"), declaredEnv: (env.SMOKE_DECLARED_ENV ?? "").split(",").filter(Boolean),
    approved: target("SMOKE_APPROVED"), vpcProbe: target("SMOKE_VPC_PROBE"), internetProbe: target("SMOKE_INTERNET_PROBE"),
  };
}

export async function main(argv: readonly string[], env: Record<string, string | undefined>, deps?: SmokeDeps): Promise<number> {
  const phase = argv.find((arg): arg is Phase => (PHASES as readonly string[]).includes(arg));
  if (!argv.includes("--run") || env.ROVARA_STAGING_SMOKE !== "1" || phase === undefined) {
    process.stderr.write(`usage: ROVARA_STAGING_SMOKE=1 npx tsx tests/staging/mcp-runner-smoke.ts --run <${PHASES.join("|")}>   (settings from the environment; see the turn-on checklist)\nThis calls an AWS account. It does nothing without --run and ROVARA_STAGING_SMOKE=1.\n`);
    return 2;
  }
  const real: SmokeDeps = deps ?? {
    fetch, aws: guardedAws(env.ROVARA_STAGING_AWS ?? join(homedir(), ".local/share/rovara-tools/staging-aws.sh")), now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log: (line) => { process.stdout.write(`${line}\n`); },
  };
  const report = await runPhase(phase, configFromEnv(env), real);
  for (const check of report.checks) real.log(`${check.ok ? "ok  " : "FAIL"}  ${check.name}: ${check.detail}`);
  real.log(report.ok ? `phase ${phase}: all checks passed` : `phase ${phase}: FAILED`);
  return report.ok ? 0 : 1;
}

if (process.argv[1]?.endsWith("mcp-runner-smoke.ts")) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; }, (error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "smoke failed"}\n`); process.exitCode = 1; });
}
