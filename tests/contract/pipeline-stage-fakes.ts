// Fakes for the stage CLI's ports (ops/pipeline/types.ts Ports): no AWS, no network, no git. Shared by the pipeline-stage-* tests.
import type { ChangeRow, ChangeSetDescription, ExecResult, Gate, Ports, StackDescription } from "../../ops/pipeline/types.ts";
import { StageError } from "../../ops/pipeline/types.ts";
import { loadConfig } from "../../ops/pipeline/config.ts";
import type { PipelineConfig } from "../../ops/pipeline/config.ts";
import { parseSwitches } from "../../ops/pipeline/switches.ts";
import type { SwitchesFile } from "../../ops/pipeline/switches.ts";
import { accountSource } from "../../ops/pipeline/lib/account.ts";
import type { Inputs, StepContext } from "../../ops/pipeline/lib/context.ts";
import { contextArgs, codeUrlFor, rowFor } from "../../ops/pipeline/switches.ts";
import type { PipelineEnv, StepName } from "../../ops/pipeline/types.ts";

export const sha = (c: string): string => c.repeat(40).slice(0, 40);
export const DIGEST_A = `sha256:${"a".repeat(64)}`;
export const DIGEST_B = `sha256:${"b".repeat(64)}`;
export const EXEC_ID = "1a2b3c4d-0000-4000-8000-000000000001";
export const EXEC8 = "1a2b3c4d";
export const FAKE_ACCOUNT = "123456789012";
/** A different, well-formed account for mismatch tests (built, not typed: only 123456789012 may appear as a literal). */
export const OTHER_ACCOUNT = String(Number(FAKE_ACCOUNT) + 1);

export const config: PipelineConfig = loadConfig();

/** The directory the fake build action provides as ROVARA_CODE_REPO (a full Code clone). */
export const CODE_REPO = "/code-clone";
/** An `exec` answer for a world with a Code clone: ROVARA_CODE_REPO is set, every commit is in it, and `git worktree add` into it succeeds (the others fall through to `rest`). */
export function withCodeClone(rest: FakeState["exec"] = () => ({ code: 0, stdout: "", stderr: "" }), known: (sha: string) => boolean = () => true): FakeState["exec"] {
  return (cmd, args) => {
    if (cmd === "printenv" && args[0] === "ROVARA_CODE_REPO") return { code: 0, stdout: `${CODE_REPO}\n`, stderr: "" };
    if (cmd === "git" && args[0] === "-C" && args[1] === CODE_REPO && args[2] === "cat-file") return { code: known(String(args[4]).replace("^{commit}", "")) ? 0 : 1, stdout: "", stderr: "" };
    return rest(cmd, args);
  };
}

/** A switches file with fake values (no real account or host), both rows filled. */
export const fakeSwitches: SwitchesFile = parseSwitches(JSON.stringify({
  schema: 1,
  about: "test",
  environments: {
    beta: { region: "us-east-1", deployAccount: "${DEPLOY_ACCOUNT}", codeUrl: "https://beta-code.example.test", aiSourceKinds: "openai", productAi: "on", rovaraAi: "on", rovaraAiExempt: null, rovaraAiDisabled: null, offeredPrices: "on", providerSecretNames: "generated", pending: [] },
    production: { region: "us-east-1", deployAccount: null, codeUrl: "https://prod-code.example.test", aiSourceKinds: "openai", productAi: "on", rovaraAi: "on", rovaraAiExempt: null, rovaraAiDisabled: null, offeredPrices: "on", providerSecretNames: "generated", pending: [] },
  },
}));

export interface FakeState {
  /** Oldest to newest; a sha is an ancestor of a later one. */
  history: string[];
  tags: Record<string, string>;
  /** branch name -> exists */
  branches: Record<string, boolean>;
  stacks: Record<string, Omit<StackDescription, "changeSetId" | "lastUpdatedTime"> & { changeSetId?: string | null; lastUpdatedTime?: string | null; templateSha: string }>;
  /** key stack/name */
  changeSets: Record<string, ChangeSetDescription & { template: string }>;
  /** What `cdk deploy --no-execute` creates per cdk stack id: rows, or null = no changes. */
  plan: Record<string, ChangeRow[] | null>;
  /** The status a stack ends in after execute (default UPDATE_COMPLETE, or CREATE_COMPLETE for a stack still in REVIEW_IN_PROGRESS). */
  executeOutcome: Record<string, string>;
  /** Eventual consistency: for this many `describe-stacks` reads after an execute, CloudFormation still shows the stack as it was before (a stack name -> reads left). */
  executeLag: Record<string, number>;
  /** What describe-stacks showed before the execute, kept while `executeLag` counts down. */
  lagSnapshot: Record<string, StackDescription>;
  ssm: Record<string, string>;
  files: Record<string, string>;
  dirs: Set<string>;
  http: (url: string) => number;
  exec: (cmd: string, args: readonly string[]) => ExecResult;
  account: string;
  calls: string[];
  /** Each `exec` call's working directory and whether AWS credential variables were removed from its environment (set to undefined), in order. */
  execRuns?: Array<{ cmd: string; args: readonly string[]; cwd: string | undefined; awsRemoved: boolean }>;
  /** The directory and the context of each cdk call, in order. */
  cdkRuns?: Array<{ dir: string; context: Record<string, string>; parameters: Record<string, string> }>;
  now: number;
  /** Template bodies (parsed JSON) the cfn port answers: `live:<stack>` is the live stack's, `cs:<stack>/<change set>` a change set's. A missing one is `null` / `{}`. */
  templates?: Record<string, unknown>;
  /** Called after an execute (the change sets are already gone, the stack already points at the executed one), so a test can change the world mid-run. */
  onExecute?: (stack: string) => void;
}

export const stackFor = (env: PipelineEnv, part: "gateway" | "web" | "app"): string => `rovara-cloud-${env}-${part}`;

export function newState(overrides: Partial<FakeState> = {}): FakeState {
  const history = [sha("1"), sha("2"), sha("3"), sha("4")];
  return {
    history,
    // v0.13.10 is newer than v0.13.9 (a text sort would get it wrong); v0.14.0 and the prerelease tag point at commits that are not on the trunk.
    tags: { "v0.13.1": sha("1"), "v0.13.2": sha("2"), "v0.13.9": sha("3"), "v0.13.10": sha("4"), "v0.14.0": sha("9"), "v0.15.0-rc1": sha("4") },
    branches: { "cloud/next": true },
    stacks: {},
    changeSets: {},
    plan: {},
    executeOutcome: {},
    executeLag: {},
    lagSnapshot: {},
    ssm: {},
    files: {},
    dirs: new Set(),
    http: () => 200,
    exec: () => ({ code: 0, stdout: "", stderr: "" }),
    account: FAKE_ACCOUNT,
    calls: [],
    now: Date.UTC(2026, 10, 24, 12, 0, 0),
    ...overrides,
  };
}

export function liveStack(state: FakeState, name: string, extra: Partial<StackDescription> = {}): void {
  // A stack that was last updated a day ago by some earlier change set (an id no test uses).
  state.stacks[name] = { status: "UPDATE_COMPLETE", parameters: {}, outputs: {}, templateSha: `live-${name}`, changeSetId: `arn:aws:cloudformation:us-east-1:${FAKE_ACCOUNT}:changeSet/earlier/00000000`, lastUpdatedTime: new Date(state.now - 86_400_000).toISOString(), ...extra };
}

const describedStack = (s: FakeState["stacks"][string]): StackDescription => ({ status: s.status, parameters: s.parameters, outputs: s.outputs, changeSetId: s.changeSetId ?? null, lastUpdatedTime: s.lastUpdatedTime ?? null });

const STACK_ID_PART: Record<string, "gateway" | "web" | "app"> = { RovaraModelGateway: "gateway", RovaraCloudWeb: "web", RovaraCloudApp: "app" };

export function makePorts(state: FakeState, env: PipelineEnv = "beta"): Ports {
  const ancestorIndex = (ref: string): number => {
    const resolved = ref.startsWith("origin/") ? state.history[state.history.length - 1]! : ref;
    return state.history.indexOf(resolved);
  };
  let csCounter = 0;
  const ports: Ports = {
    exec: (cmd, args, opts) => {
      state.calls.push(`exec ${cmd} ${args.join(" ")}`);
      (state.execRuns ??= []).push({ cmd, args, cwd: opts?.cwd, awsRemoved: opts?.env !== undefined && "AWS_ACCESS_KEY_ID" in opts.env && opts.env.AWS_ACCESS_KEY_ID === undefined });
      return Promise.resolve(state.exec(cmd, args));
    },
    aws: { json: (args) => { state.calls.push(`aws ${args.join(" ")}`); return Promise.resolve(null); } },
    git: {
      fetchTags: () => { state.calls.push("git fetchTags"); return Promise.resolve(); },
      fetchBranch: (b) => { state.calls.push(`git fetchBranch ${b}`); return Promise.resolve(state.branches[b] === true); },
      tags: () => Promise.resolve(Object.keys(state.tags)),
      revParse: (ref) => {
        const m = /^refs\/tags\/(.+)\^\{commit\}$/u.exec(ref);
        const found = m === null ? undefined : state.tags[m[1]!];
        if (found === undefined) return Promise.reject(new StageError("REF_FAILED", `cannot resolve ${ref}`));
        return Promise.resolve(found);
      },
      isAncestor: (a, d) => {
        const ia = ancestorIndex(a);
        const id = ancestorIndex(d);
        // A commit outside the trunk's history exists in git but is no ancestor; a descendant git has never heard of is an error.
        if (id < 0) return Promise.reject(new StageError("REF_FAILED", "unknown commit"));
        return Promise.resolve(ia >= 0 && ia <= id);
      },
      worktree: (sha40, dir) => { state.calls.push(`git worktree ${sha40.slice(0, 7)} ${dir}`); state.dirs.add(dir); return Promise.resolve(); },
    },
    cfn: {
      describeStack: (stack) => {
        const s = state.stacks[stack];
        if (s === undefined) return Promise.resolve(null);
        const lag = state.executeLag[stack] ?? 0;
        if (lag > 0 && state.lagSnapshot[stack] !== undefined) { state.executeLag[stack] = lag - 1; return Promise.resolve(state.lagSnapshot[stack]); }
        return Promise.resolve(describedStack(s));
      },
      describeChangeSet: (stack, name) => { const c = state.changeSets[`${stack}/${name}`]; return Promise.resolve(c === undefined ? null : { id: c.id, status: c.status, executionStatus: c.executionStatus, statusReason: c.statusReason, rows: c.rows }); },
      templateSha256: (stack, name) => Promise.resolve(state.changeSets[`${stack}/${name}`]?.template ?? "missing"),
      liveTemplateSha256: (stack) => Promise.resolve(state.stacks[stack]?.templateSha ?? null),
      templateBody: (stack, name) => Promise.resolve(state.templates?.[`cs:${stack}/${name}`] ?? {}),
      liveTemplateBody: (stack) => Promise.resolve(state.templates?.[`live:${stack}`] ?? null),
      executeChangeSet: (stack, name) => {
        state.calls.push(`cfn execute ${stack} ${name}`);
        const c = state.changeSets[`${stack}/${name}`];
        // What CloudFormation answers for a change set that is not there, or is not executable.
        if (c === undefined) return Promise.reject(new Error("ChangeSetNotFound: no such change set"));
        if (c.status !== "CREATE_COMPLETE" || c.executionStatus !== "AVAILABLE") return Promise.reject(new Error(`InvalidChangeSetStatus: ${c.status}/${c.executionStatus}`));
        const s = state.stacks[stack];
        if (s !== undefined && (state.executeLag[stack] ?? 0) > 0) state.lagSnapshot[stack] = describedStack(s);
        // As real CloudFormation does: executing a change set deletes ALL the change sets of that stack (this one too), and the stack remembers the id of the one it ran.
        for (const key of Object.keys(state.changeSets)) if (key.startsWith(`${stack}/`)) delete state.changeSets[key];
        if (s !== undefined) {
          s.status = state.executeOutcome[stack] ?? (s.status === "REVIEW_IN_PROGRESS" ? "CREATE_COMPLETE" : "UPDATE_COMPLETE");
          s.changeSetId = c.id;
          if (s.status.startsWith("UPDATE_")) s.lastUpdatedTime = new Date(state.now).toISOString(); // a created stack has no LastUpdatedTime
        }
        state.onExecute?.(stack);
        return Promise.resolve();
      },
      deleteChangeSet: (stack, name) => { state.calls.push(`cfn delete ${stack} ${name}`); delete state.changeSets[`${stack}/${name}`]; return Promise.resolve(); },
      listChangeSetNames: (stack) => Promise.resolve(Object.keys(state.changeSets).filter((k) => k.startsWith(`${stack}/`)).map((k) => k.slice(stack.length + 1))),
      waitSettled: (stack) => ports.cfn.describeStack(stack).then((d) => d?.status ?? "ABSENT"),
    },
    cdk: {
      deployNoExecute: (a) => {
        state.calls.push(`cdk ${a.stacks.map((s) => s.stackId).join(",")} ${a.changeSetName} ctx=${Object.keys(a.context).sort().join(",")} params=${a.stacks.flatMap((s) => Object.entries(s.parameters).map(([k, v]) => `${s.stackName}:${k}=${v}`)).join(",")}`);
        if (a.context.agentxAccount !== undefined) state.calls.push(`cdk-account ${a.context.agentxAccount}`);
        (state.cdkRuns ??= []).push({ dir: a.dir, context: a.context, parameters: Object.fromEntries(a.stacks.flatMap((s) => Object.entries(s.parameters))) });
        for (const { stackId: id } of a.stacks) {
          const part = STACK_ID_PART[id]!;
          const stack = stackFor(env, part);
          const rows = state.plan[id];
          if (rows === undefined) continue; // cdk "made" nothing (a bug): the change set is absent
          csCounter += 1;
          // As real CloudFormation does: a change set on a stack that does not exist yet makes the stack a REVIEW_IN_PROGRESS shell that holds it.
          if (state.stacks[stack] === undefined) state.stacks[stack] = { status: "REVIEW_IN_PROGRESS", parameters: {}, outputs: {}, templateSha: `shell-${stack}` };
          if (rows === null) {
            // What CloudFormation answers for an empty change set (cdk --no-execute leaves it).
            state.changeSets[`${stack}/${a.changeSetName}`] = { id: `empty-${csCounter}`, status: "FAILED", executionStatus: "UNAVAILABLE", statusReason: "The submitted information didn't contain changes. Submit different information to create a change set.", rows: [], template: "" };
            continue;
          }
          state.changeSets[`${stack}/${a.changeSetName}`] = { id: `arn:aws:cloudformation:us-east-1:${FAKE_ACCOUNT}:changeSet/${a.changeSetName}/${String(csCounter).padStart(8, "0")}`, status: "CREATE_COMPLETE", executionStatus: "AVAILABLE", statusReason: null, rows, template: `tpl-${stack}-${csCounter}` };
        }
        return Promise.resolve();
      },
    },
    ssm: { get: (n) => Promise.resolve(state.ssm[n] ?? null), put: (n, v) => { state.calls.push(`ssm put ${n}`); state.ssm[n] = v; return Promise.resolve(); } },
    http: { get: (url) => Promise.resolve({ status: state.http(url) }) },
    sts: { account: () => Promise.resolve(state.account) },
    fs: {
      readText: (p) => { const f = state.files[p]; if (f === undefined) throw new Error(`no file ${p}`); return f; },
      writeText: (p, t) => { state.files[p] = t; },
      exists: (p) => p in state.files || state.dirs.has(p),
      mkdirp: (p) => { state.dirs.add(p); },
      readdir: (p) => Object.keys(state.files).filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1)),
    },
    clock: { now: () => new Date(state.now), sleep: (ms) => { state.now += ms; return new Promise((resolve) => setImmediate(resolve)); } },
  };
  return ports;
}

/** A last-good record for an environment: the proof that an environment has had its first (adoption) run. */
export function seedLastGood(state: FakeState, env: PipelineEnv): void {
  state.ssm[`/rovara-cloud/${env}/release/last-good`] = JSON.stringify({ schema: 1, env, recordedAt: "2026-11-20T00:00:00.000Z", executionId: "earlier", mode: "adoption", cloud: { tag: "v0.13.1", sha: sha("1") }, gateway: { digest: DIGEST_B, codeSha: sha("c") } });
}

export const row = (action: string, logicalId: string, resourceType: string, replacement: ChangeRow["replacement"] = "False"): ChangeRow => ({ action, logicalId, physicalId: null, resourceType, replacement });
export const MODIFY_FUNCTION: ChangeRow = row("Modify", "ServerFn", "AWS::Lambda::Function");
export const CDK_METADATA: ChangeRow = row("Modify", "CDKMetadata", "AWS::CDK::Metadata", null);

export function makeInputs(over: Partial<Inputs> = {}): Inputs {
  return {
    execId: EXEC_ID, cloudRef: null, cloudSourceCommit: null, codeRelease: "run", codeTrigger: null, cloudProd: false, codeSha: sha("c"), codeLiveSha: null, codeLiveFacts: {}, supersedes: null, codeTarget: null, declaredRollback: false, codeCtxGiven: true, adopt: false,
    gatewayDigest: null, target: null, expectedAccount: FAKE_ACCOUNT, dryRun: false, region: "us-east-1", manifestPath: null, outDir: "out", workDir: "/work", ...over,
  };
}

export function makeCtx(state: FakeState, env: PipelineEnv, step: StepName, over: { inputs?: Partial<Inputs>; gates?: readonly Gate[]; required?: Record<string, string[]>; logs?: string[] } = {}): StepContext {
  const logs = over.logs ?? [];
  const ctx: StepContext = {
    env, step, config, row: rowFor(env, fakeSwitches), contextFor: (target) => contextArgs(env, target, fakeSwitches, accountSource(ctx)), codeUrl: codeUrlFor(env, fakeSwitches), account: null,
    inputs: makeInputs(over.inputs), ports: makePorts(state, env), gates: over.gates ?? [], requiredGates: over.required ?? { preflight: [], "change-sets": [], "gateway-live": [], proof: [] },
    pipelineDir: "/pipeline", log: (line) => { logs.push(line); },
  };
  return ctx;
}
