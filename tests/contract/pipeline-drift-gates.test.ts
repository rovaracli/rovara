// L5: gate 1 (deployed-drift) and gate 2 (gateway-runprice, gateway-settled) against fake ports. No AWS, no git, no network.
import { describe, expect, it } from "vitest";
import { gate as drift } from "../../ops/pipeline/gates/deployed-drift.gate.ts";
import { gate as runprice, judgeHealthz } from "../../ops/pipeline/gates/gateway-runprice.gate.ts";
import { gate as settled } from "../../ops/pipeline/gates/gateway-settled.gate.ts";
import { NO_AWS_ENV, codeShaThatWillBeLive } from "../../ops/pipeline/lib/gate-env.ts";
import { ATTEMPTS } from "../../ops/pipeline/lib/gate-poll.ts";
import type { ExecResult, GatePhase, GateInput, Manifest, Ports } from "../../ops/pipeline/types.ts";
import { DIGEST_A, DIGEST_B, EXEC8, EXEC_ID, config, liveStack, makePorts, newState, sha } from "./pipeline-stage-fakes.ts";
import type { FakeState } from "./pipeline-stage-fakes.ts";

const CODE = sha("c");
const OK_OUTPUT = "Code abc123456 (main) against this repository: 40 schemas compared, 0 drifts (0 accepted).\n\nCode text abc123456 (main): 12 sentences read, 0 refused by Cloud's strict parsers.\n";
const manifest = (over: { mode?: Manifest["mode"]; live?: string | null; release?: "run" | "skip"; codeSha?: string | null; pinned?: string | null; liveCode?: string | null; digest?: string | null } = {}): Manifest => ({
  schema: 1, executionId: EXEC_ID, exec8: EXEC8, createdAt: "2026-11-24T12:00:00.000Z", mode: over.mode ?? "release",
  cloud: { tag: "v0.13.10", sha: sha("4"), ref: "latest-tag", trunk: "cloud/next", liveSha: { beta: over.live === undefined ? sha("3") : over.live, production: null } },
  code: { sha: over.codeSha === undefined ? CODE : over.codeSha, release: over.release ?? "run", requestedRelease: "run", pinnedSha: { beta: over.pinned ?? null, production: null }, supersedes: null },
  gateway: { digest: over.digest === undefined ? DIGEST_A : over.digest, source: "built", imageTag: null, repository: null },
  stages: over.liveCode === undefined || over.liveCode === null ? {} : { beta: { env: "beta", startedAt: "x", skipped: null, account: null, dryRun: null, completed: [], gates: [], changeSets: [], rollback: { schema: 1, env: "beta", capturedAt: "x", executionId: EXEC_ID, cloud: { tag: null, sha: null }, gateway: { digest: null }, stacks: {}, code: { liveSha: over.liveCode, facts: {} } }, releaseCheck: null, summary: null, warnings: [] } },
});
const input = (state: FakeState, m: Manifest, phase: GatePhase = "preflight", logs: string[] = []): GateInput => ({
  env: "beta", phase, region: "us-east-1", config, manifest: m, changeSets: [], dirs: { pipeline: "/p", cloud: "/c", out: "/out", work: "/w" }, ports: makePorts(state), log: (l) => { logs.push(l); },
});
const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (code: number, stdout = "", stderr = ""): ExecResult => ({ code, stdout, stderr });

/** A world where the build has the Code clone, both trees have the script, and every drift check prints `drift`. */
function driftWorld(over: { env?: Record<string, string>; drift?: (cwd: string | undefined, args: readonly string[]) => ExecResult } = {}): { state: FakeState; runs: string[] } {
  const state = newState();
  const runs: string[] = [];
  const env: Record<string, string> = { ROVARA_CODE_REPO: "/code", ...over.env };
  state.files["/c/package.json"] = '{"scripts":{"contract:drift":"tsx scripts/contract-drift.ts"}}';
  state.files["/w/cloud-deployed-" + sha("3").slice(0, 12) + "/package.json"] = state.files["/c/package.json"]!;
  state.exec = (cmd, args) => {
    if (cmd === "printenv") return env[args[0]!] === undefined ? fail(1) : ok(`${env[args[0]!]}\n`);
    if (cmd === "git" && args.includes("cat-file")) return ok();
    return ok();
  };
  // The runner of npm needs the cwd: wrap the ports exec to record it.
  const original = state.exec;
  state.exec = (cmd, args) => {
    if (cmd === "npm" && args[0] === "run") { runs.push(args.join(" ")); return (over.drift ?? (() => ok(OK_OUTPUT)))(undefined, args); }
    return original(cmd, args);
  };
  return { state, runs };
}
// The fake worktree only records the directory; give it the package.json the real checkout would hold.
const withDeployedTree = (state: FakeState, sha40: string): void => {
  const dir = `/w/cloud-deployed-${sha40.slice(0, 12)}`;
  state.files[`${dir}/package.json`] = '{"scripts":{"contract:drift":"x"}}';
};

describe("gate deployed-drift", () => {
  it("passes when the deployed tree and the candidate both read the Code that will be live, and runs the deployed tree's own check", async () => {
    const { state, runs } = driftWorld();
    state.dirs.add(`/w/cloud-deployed-${sha("3").slice(0, 12)}`);
    const result = await drift.run(input(state, manifest()));
    expect(result.result).toBe("pass");
    expect(result.data).toMatchObject({ deployedSha: sha("3"), deployedSource: "stack-output", candidateSha: sha("4"), codeSha: CODE });
    expect(runs).toHaveLength(2);
    expect(runs[0]).toBe(`run contract:drift -- check --code-ref ${CODE} --code-repo /code`);
  });

  it("checks out the deployed sha and runs npm ci in it when it is not there yet", async () => {
    const { state } = driftWorld();
    expect((await drift.run(input(state, manifest()))).result).toBe("pass");
    expect(state.calls).toContain(`git worktree ${sha("3").slice(0, 7)} /w/cloud-deployed-${sha("3").slice(0, 12)}`);
    expect(state.calls).toContain("exec npm ci --no-audit --no-fund");
  });

  it("the deployed Cloud failing is 'release Cloud first' (run with CODE_RELEASE=skip, then Code); the candidate is still reported", async () => {
    let call = 0;
    const { state } = driftWorld({ drift: () => { call += 1; return call === 1 ? fail(1, "DRIFT text: the repair card sentence is not taken\n  at x y\n\nCode text abc (main): 12 sentences read, 1 refused by Cloud's strict parsers.\n") : ok(OK_OUTPUT); } });
    state.dirs.add(`/w/cloud-deployed-${sha("3").slice(0, 12)}`);
    withDeployedTree(state, sha("3"));
    const result = await drift.run(input(state, manifest()));
    expect(result.result).toBe("fail");
    const text = (result.failures ?? []).join("\n");
    expect(text).toMatch(/deployed 333333333: contract:drift exited 1/);
    expect(text).toMatch(/DRIFT text: the repair card sentence/);
    expect(text).toMatch(/release Cloud first: run with CODE_RELEASE=skip, then Code/);
    expect(text).not.toMatch(/candidate Cloud cannot read/);
  });

  it("the candidate failing is reported too, and a skip run whose deployed Cloud fails says the live pair already disagrees", async () => {
    const { state } = driftWorld({ drift: () => fail(1, "DRIFT shape: x\n") });
    withDeployedTree(state, sha("3"));
    state.dirs.add(`/w/cloud-deployed-${sha("3").slice(0, 12)}`);
    const run = await drift.run(input(state, manifest()));
    expect((run.failures ?? []).join("\n")).toMatch(/candidate Cloud cannot read that Code either/);
    const skip = await drift.run(input(state, manifest({ release: "skip", liveCode: sha("e") })));
    expect((skip.failures ?? []).join("\n")).toMatch(/already disagree/);
  });

  it("a deployed tree whose check predates the text rules proves nothing: a pass without the sentence line fails; a tree with no script fails", async () => {
    const { state } = driftWorld({ drift: () => ok("Code abc (main) against this repository: 40 schemas compared, 0 drifts.\n") });
    state.dirs.add(`/w/cloud-deployed-${sha("3").slice(0, 12)}`);
    withDeployedTree(state, sha("3"));
    expect((await drift.run(input(state, manifest()))).failures?.join("\n")).toMatch(/never read Code's sentences/);
    state.files[`/w/cloud-deployed-${sha("3").slice(0, 12)}/package.json`] = '{"scripts":{}}';
    expect((await drift.run(input(state, manifest()))).failures?.join("\n")).toMatch(/no contract:drift script/);
  });

  it("runs npm ci and the drift checks with AWS credentials removed from the child environment (they need none)", async () => {
    const { state } = driftWorld();
    const seen: Array<{ cmd: string; env: Record<string, string | undefined> | undefined }> = [];
    const ports = makePorts(state);
    const inner = makePorts(state);
    ports.exec = (cmd, args, opts) => { if (cmd === "npm") seen.push({ cmd: `${cmd} ${args[0]}`, env: opts?.env }); return inner.exec(cmd, args, opts); };
    expect((await drift.run({ ...input(state, manifest()), ports })).result).toBe("pass");
    expect(seen.map((s) => s.cmd)).toEqual(["npm ci", "npm run", "npm run"]);
    for (const call of seen) {
      for (const name of Object.keys(NO_AWS_ENV)) expect(Object.hasOwn(call.env ?? {}, name) && call.env![name] === undefined, `${call.cmd}: ${name}`).toBe(true);
      expect(Object.keys(NO_AWS_ENV)).toEqual(expect.arrayContaining(["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_WEB_IDENTITY_TOKEN_FILE"]));
    }
  });

  it("installs the Code workspace packages the contracts import into each tree before its check, with the pipeline tree's helper, the pinned Code sha and no AWS credentials", async () => {
    const { state } = driftWorld();
    const seen: Array<{ args: readonly string[]; env: Record<string, string | undefined> | undefined }> = [];
    const order: string[] = [];
    const ports = makePorts(state);
    const inner = makePorts(state);
    ports.exec = (cmd, args, opts) => {
      if (cmd === "node") seen.push({ args, env: opts?.env });
      if (cmd === "node" || (cmd === "npm" && args[0] === "run")) order.push(cmd === "node" ? `link ${args[1]}` : "check");
      return inner.exec(cmd, args, opts);
    };
    expect((await drift.run({ ...input(state, manifest()), ports })).result).toBe("pass");
    expect(seen.map((s) => s.args)).toEqual([
      ["/p/scripts/contract-drift/link-code-workspaces.ts", `/w/cloud-deployed-${sha("3").slice(0, 12)}`, "/code", CODE],
      ["/p/scripts/contract-drift/link-code-workspaces.ts", "/c", "/code", CODE],
    ]);
    expect(order).toEqual([`link /w/cloud-deployed-${sha("3").slice(0, 12)}`, "check", "link /c", "check"]);
    for (const call of seen) for (const name of Object.keys(NO_AWS_ENV)) expect(Object.hasOwn(call.env ?? {}, name) && call.env![name] === undefined, name).toBe(true);
  });

  it("fails closed when the Code workspace packages cannot be installed: the check does not run and the tree is reported", async () => {
    const { state, runs } = driftWorld();
    const real = state.exec;
    state.exec = (cmd, args) => (cmd === "node" ? fail(1, "", "link-code-workspaces: Code workspace @preplabsai/rovara-code-api (packages/code-api) has no src directory\n") : real(cmd, args));
    state.dirs.add(`/w/cloud-deployed-${sha("3").slice(0, 12)}`);
    withDeployedTree(state, sha("3"));
    const result = await drift.run(input(state, manifest()));
    expect(result.result).toBe("fail");
    expect((result.failures ?? []).join("\n")).toMatch(/deployed 333333333: the Code workspace packages that Code's contracts import could not be installed \(exit 1\): link-code-workspaces: Code workspace @preplabsai\/rovara-code-api/);
    expect((result.failures ?? []).join("\n")).toMatch(/candidate 444444444: the Code workspace packages/);
    expect(runs).toHaveLength(0);
  });

  it("a deployed commit that cannot be checked out or installed fails closed", async () => {
    const { state } = driftWorld();
    const ports = makePorts(state);
    ports.git.worktree = () => Promise.reject(new Error("bad object"));
    const result = await drift.run({ ...input(state, manifest()), ports });
    expect(result.failures?.join("\n")).toMatch(/could not be checked out and prepared: bad object/);
  });

  it("when the candidate IS the deployed Cloud it is checked once", async () => {
    const { state, runs } = driftWorld();
    expect((await drift.run(input(state, manifest({ live: sha("4") })))).result).toBe("pass");
    expect(runs).toHaveLength(1);
  });

  describe("first release: no DeployedCloudSha on the environment", () => {
    it("fails closed with the first-release message and names the two ways forward; nothing runs", async () => {
      const { state, runs } = driftWorld();
      const result = await drift.run(input(state, manifest({ live: null })));
      expect(result.result).toBe("fail");
      expect(result.failures?.[0]).toMatch(/first release: beta has no DeployedCloudSha/);
      expect(result.failures?.[0]).toMatch(/adoption run \(manifest mode adoption/);
      expect(result.failures?.[0]).toMatch(/ROVARA_ADOPT_DEPLOYED_CLOUD_SHA/);
      expect(runs).toHaveLength(0);
    });

    it("an adoption run (mode adoption, CLOUD_REF is the tag live) takes the candidate as the deployed Cloud and checks it once", async () => {
      const { state, runs } = driftWorld();
      const result = await drift.run(input(state, manifest({ live: null, mode: "adoption" })));
      expect(result).toMatchObject({ result: "pass", data: { deployedSource: "adoption", deployedSha: sha("4") } });
      expect(runs).toHaveLength(1);
    });

    it("the explicit flag names a release tag's commit that is the candidate or its ancestor; it is recorded, and anything else is refused", async () => {
      const logs: string[] = [];
      const good = driftWorld({ env: { ROVARA_ADOPT_DEPLOYED_CLOUD_SHA: sha("3") } });
      good.state.dirs.add(`/w/cloud-deployed-${sha("3").slice(0, 12)}`);
      const result = await drift.run(input(good.state, manifest({ live: null }), "preflight", logs));
      expect(result).toMatchObject({ result: "pass", data: { deployedSource: "operator-flag", deployedSha: sha("3") } });
      expect(logs.join("\n")).toMatch(/Using v0\.13\.9/);
      const notHex = driftWorld({ env: { ROVARA_ADOPT_DEPLOYED_CLOUD_SHA: "v0.13.9" } });
      expect((await drift.run(input(notHex.state, manifest({ live: null })))).failures?.[0]).toMatch(/40-character lowercase hex/);
      const notTag = driftWorld({ env: { ROVARA_ADOPT_DEPLOYED_CLOUD_SHA: sha("7") } });
      expect((await drift.run(input(notTag.state, manifest({ live: null })))).failures?.[0]).toMatch(/not the commit of a release tag/);
      const newer = driftWorld({ env: { ROVARA_ADOPT_DEPLOYED_CLOUD_SHA: sha("2") } });
      const candidateOlder: Manifest = { ...manifest({ live: null }), cloud: { ...manifest({ live: null }).cloud, sha: sha("1") } };
      expect((await drift.run(input(newer.state, candidateOlder))).failures?.[0]).toMatch(/neither the candidate .* nor an ancestor/);
    });

    it("the flag is ignored when the stack has an output (the output wins)", async () => {
      const { state } = driftWorld({ env: { ROVARA_ADOPT_DEPLOYED_CLOUD_SHA: sha("1") } });
      state.dirs.add(`/w/cloud-deployed-${sha("3").slice(0, 12)}`);
      expect((await drift.run(input(state, manifest()))).data).toMatchObject({ deployedSource: "stack-output", deployedSha: sha("3") });
    });
  });

  describe("which Code, and where it is", () => {
    it("a Code release checks the commit it promotes; a skipped Code checks the pin or CODE_LIVE_SHA, and with neither fails closed", async () => {
      expect(codeShaThatWillBeLive(manifest(), "beta").sha).toBe(CODE);
      expect(codeShaThatWillBeLive(manifest({ release: "skip", pinned: sha("d") }), "beta").sha).toBe(sha("d"));
      expect(codeShaThatWillBeLive(manifest({ release: "skip", liveCode: sha("e") }), "beta").sha).toBe(sha("e"));
      const { state } = driftWorld();
      expect((await drift.run(input(state, manifest({ release: "skip" })))).failures?.[0]).toMatch(/needs the Code sha that is live \(CODE_LIVE_SHA\)/);
      expect((await drift.run(input(state, manifest({ codeSha: null })))).failures?.[0]).toMatch(/no CODE_SHA/);
    });

    it("needs the Code clone and the commit in it", async () => {
      const { state } = driftWorld();
      state.exec = (cmd, args) => (cmd === "printenv" ? fail(1) : args.includes("cat-file") ? fail(1) : ok());
      expect((await drift.run(input(state, manifest()))).failures?.[0]).toMatch(/ROVARA_CODE_REPO is not set/);
      const withRepo = driftWorld();
      const inner = withRepo.state.exec;
      withRepo.state.exec = (cmd, args) => (cmd === "git" && args.includes("cat-file") ? fail(1) : inner(cmd, args));
      expect((await drift.run(input(withRepo.state, manifest()))).failures?.[0]).toMatch(/is not in the Code clone/);
    });

    it("fails with no candidate tree", async () => {
      const { state } = driftWorld();
      const i = input(state, manifest());
      expect((await drift.run({ ...i, dirs: { ...i.dirs, cloud: null } })).failures?.[0]).toMatch(/no candidate tree/);
    });
  });
});

describe("gate gateway-runprice", () => {
  const HEALTHZ = (over: Record<string, unknown> = {}): string => JSON.stringify({ ok: true, runPrice: { version: 1, admissionVersion: 1, snapshotVersion: 4, ...over } });
  const world = (answers: Array<{ status: number; body?: string }>, over: { gatewayUrl?: string | null; codeRepo?: boolean; controlPlane?: string } = {}) => {
    const state = newState();
    const url = over.gatewayUrl === undefined ? "https://gateway.example.test" : over.gatewayUrl;
    if (url !== null) liveStack(state, "rovara-cloud-beta-web", { parameters: { ModelGatewayUrl: url } });
    state.exec = (cmd, args) => {
      if (cmd === "printenv") return over.codeRepo === false ? fail(1) : ok("/code\n");
      if (cmd === "git" && args.includes("cat-file")) return ok();
      if (cmd === "git" && args.includes("show")) return over.controlPlane === undefined ? fail(128) : ok(over.controlPlane);
      return ok();
    };
    const urls: string[] = [];
    let n = 0;
    const ports: Ports = { ...makePorts(state), http: { get: (u) => { urls.push(u); const a = answers[Math.min(n, answers.length - 1)]!; n += 1; return Promise.resolve(a); } } };
    return { state, urls, i: { ...input(state, manifest(), "gateway-live"), ports } };
  };

  it("passes on 200 with run-price v1, admission v1 and a positive snapshot; reads the web stack's own gateway address", async () => {
    const w = world([{ status: 200, body: HEALTHZ() }]);
    const result = await runprice.run(w.i);
    expect(result).toMatchObject({ result: "pass", data: { requiredVersion: 1, snapshotVersion: 4, attempts: 1 } });
    expect(w.urls).toEqual(["https://gateway.example.test/healthz"]);
  });

  it("requires the version the Code that will be live publishes (ModelRunPriceVersion), never below 1", async () => {
    const two = world([{ status: 200, body: HEALTHZ() }], { controlPlane: 'new CfnOutput(this, "ModelRunPriceVersion", { value: "2", description: "x" });' });
    const failed = await runprice.run(two.i);
    expect(failed.result).toBe("fail");
    expect(failed.failures?.[0]).toMatch(/runPrice.version is 1, this Code needs 2/);
    expect(failed.notes?.join(" ")).toMatch(/ModelRunPriceVersion 2/);
    const passes = world([{ status: 200, body: HEALTHZ({ version: 2 }) }], { controlPlane: 'new CfnOutput(this, "ModelRunPriceVersion", { value: "2" });' });
    expect((await runprice.run(passes.i)).result).toBe("pass");
    const unreadable = world([{ status: 200, body: HEALTHZ() }], { codeRepo: false });
    const outcome = await runprice.run(unreadable.i);
    expect(outcome.result).toBe("pass");
    expect(outcome.notes?.join(" ")).toMatch(/baseline run-price version 1/);
  });

  it("judges the answer: status, JSON, ok, runPrice section, versions, snapshot", () => {
    expect(judgeHealthz(200, HEALTHZ(), 1)).toBeNull();
    expect(judgeHealthz(0, undefined, 1)).toMatch(/connection failed/);
    expect(judgeHealthz(503, "{}", 1)).toMatch(/503/);
    expect(judgeHealthz(200, "<html>", 1)).toMatch(/not answer JSON/);
    expect(judgeHealthz(200, JSON.stringify({ ok: false }), 1)).toMatch(/does not say ok/);
    expect(judgeHealthz(200, JSON.stringify({ ok: true }), 1)).toMatch(/older gateway/);
    expect(judgeHealthz(200, HEALTHZ({ version: 2 }), 1)).toMatch(/version is 2/);
    expect(judgeHealthz(200, HEALTHZ({ admissionVersion: 2 }), 1)).toMatch(/admissionVersion/);
    for (const snapshotVersion of [0, -1, 1.5, "4", null]) expect(judgeHealthz(200, HEALTHZ({ snapshotVersion }), 1), String(snapshotVersion)).toMatch(/snapshotVersion/);
  });

  it("waits for a rolling deployment (tries again after a fixed pause), and gives up after the attempts with the last reason", async () => {
    const eventually = world([{ status: 503 }, { status: 200, body: HEALTHZ({ version: 0 }) }, { status: 200, body: HEALTHZ() }]);
    const before = eventually.state.now;
    expect(await runprice.run(eventually.i)).toMatchObject({ result: "pass", data: { attempts: 3 } });
    expect(eventually.state.now - before).toBe(30_000);
    const never = world([{ status: 503 }]);
    const result = await runprice.run(never.i);
    expect(result.result).toBe("fail");
    expect(result.failures?.[0]).toMatch(new RegExp(`after ${ATTEMPTS} tries: /healthz answered 503`));
    expect(never.urls).toHaveLength(ATTEMPTS);
  });

  it("fails when the web stack names no usable gateway address (missing stack, empty, or not an https origin)", async () => {
    for (const gatewayUrl of [null, "", "http://gateway.example.test", "https://gateway.example.test/path", "https://user@gateway.example.test"]) {
      const result = await runprice.run(world([{ status: 200, body: HEALTHZ() }], { gatewayUrl }).i);
      expect(result.result, String(gatewayUrl)).toBe("fail");
      expect(result.failures?.[0]).toMatch(/no usable gateway address/);
    }
  });
});

describe("gate gateway-settled", () => {
  const ARN = "arn:aws:ecs:us-east-1:123456789012:service/gw-cluster/gw-service";
  const TD = "arn:aws:ecs:us-east-1:123456789012:task-definition/gw:9";
  interface Aws { services?: unknown; taskDefinition?: unknown; list?: unknown }
  const world = (aws: () => Aws, over: { outputs?: Record<string, string>; digest?: string | null } = {}) => {
    const state = newState();
    liveStack(state, "rovara-cloud-beta-gateway", { outputs: over.outputs === undefined ? { ServiceArn: ARN } : over.outputs });
    const calls: string[] = [];
    const ports: Ports = {
      ...makePorts(state),
      aws: {
        json: (args) => {
          calls.push(args.join(" "));
          const a = aws();
          if (args[0] === "ecs" && args[1] === "describe-services") return Promise.resolve({ services: a.services });
          if (args[0] === "ecs" && args[1] === "describe-task-definition") return Promise.resolve(a.taskDefinition);
          if (args[0] === "cloudformation") return a.list instanceof Error ? Promise.reject(a.list) : Promise.resolve(a.list);
          return Promise.resolve(null);
        },
      },
    };
    return { state, calls, i: { ...input(state, manifest(over.digest === undefined ? {} : { digest: over.digest }), "gateway-live"), ports } };
  };
  const service = (over: Record<string, unknown> = {}) => ({ services: [{ runningCount: 2, desiredCount: 2, deployments: [{ rolloutState: "COMPLETED", taskDefinition: TD }], ...over }] });
  const definition = (image: string) => ({ taskDefinition: { containerDefinitions: [{ image }] } });
  const settledAws = (digest = DIGEST_A): Aws => ({ ...service(), taskDefinition: definition(`123456789012.dkr.ecr.us-east-1.amazonaws.com/repo@${digest}`) });

  it("passes when one deployment is COMPLETED, running equals desired, and the image is pinned to the manifest's digest; asks ECS for the right cluster and service", async () => {
    const w = world(() => settledAws());
    const result = await settled.run(w.i);
    expect(result).toMatchObject({ result: "pass", data: { digest: DIGEST_A, source: "stack output", attempts: 1 } });
    expect(w.calls).toContain(`ecs describe-services --cluster gw-cluster --services ${ARN}`);
    expect(w.calls).toContain(`ecs describe-task-definition --task-definition ${TD}`);
  });

  it("fails on another digest than the one deployed, an image not pinned by digest, and with no manifest digest checks only the pin", async () => {
    expect((await settled.run(world(() => settledAws(DIGEST_B)).i)).failures?.[0]).toMatch(/not the deployed digest/);
    expect((await settled.run(world(() => ({ ...service(), taskDefinition: definition("repo:latest") })).i)).failures?.[0]).toMatch(/not pinned by digest/);
    // No manifest digest: nothing says which image settled, so it fails closed (and never asks ECS).
    const noDigest = world(() => settledAws(DIGEST_B), { digest: null });
    const refused = await settled.run(noDigest.i);
    expect(refused.result).toBe("fail");
    expect(refused.failures?.[0]).toMatch(/manifest has no gateway digest/);
    expect(noDigest.calls).toEqual([]);
  });

  it("waits while a rollout is in progress and fails when it never settles (two deployments, not COMPLETED, running below desired, desired zero)", async () => {
    let n = 0;
    const rolling = world(() => { n += 1; return n < 3 ? { ...service({ runningCount: 1, deployments: [{ rolloutState: "IN_PROGRESS", taskDefinition: TD }, { rolloutState: "COMPLETED", taskDefinition: TD }] }) } : settledAws(); });
    expect(await settled.run(rolling.i)).toMatchObject({ result: "pass", data: { attempts: 3 } });
    for (const over of [{ runningCount: 1 }, { desiredCount: 0, runningCount: 0 }, { deployments: [{ rolloutState: "IN_PROGRESS", taskDefinition: TD }] }, { deployments: [{ rolloutState: "COMPLETED", taskDefinition: TD }, { rolloutState: "COMPLETED", taskDefinition: TD }] }]) {
      const stuck = world(() => ({ ...service(over), taskDefinition: definition(`r@${DIGEST_A}`) }));
      const result = await settled.run(stuck.i);
      expect(result.result, JSON.stringify(over)).toBe("fail");
      expect(result.failures?.[0]).toMatch(new RegExp(`after ${ATTEMPTS} tries: not settled`));
    }
  });

  it("fails when ECS does not know the service or cannot be read", async () => {
    expect((await settled.run(world(() => ({ services: [] })).i)).failures?.[0]).toMatch(/ECS does not know the gateway service/);
    const ports: Ports = { ...world(() => settledAws()).i.ports, aws: { json: () => Promise.reject(new Error("AccessDenied")) } };
    expect((await settled.run({ ...world(() => settledAws()).i, ports })).failures?.[0]).toMatch(/ECS could not be read: AccessDenied/);
  });

  it("without the ServiceArn output it reads the stack's resources instead, and says so; refuses a missing stack, a bad output, a failed or ambiguous listing", async () => {
    const listed = world(() => ({ ...settledAws(), list: { StackResourceSummaries: [{ ResourceType: "AWS::ECS::Service", PhysicalResourceId: ARN }, { ResourceType: "AWS::ECS::Cluster", PhysicalResourceId: "gw-cluster" }] } }), { outputs: {} });
    expect(await settled.run(listed.i)).toMatchObject({ result: "pass", data: { source: "stack resources" } });
    expect(listed.calls[0]).toBe("cloudformation list-stack-resources --stack-name rovara-cloud-beta-gateway");
    const failedList = await settled.run(world(() => ({ list: new Error("AccessDenied") }), { outputs: {} }).i);
    expect(failedList.failures?.[0]).toMatch(/no ServiceArn output and listing its resources failed: AccessDenied/);
    const none = await settled.run(world(() => ({ list: { StackResourceSummaries: [] } }), { outputs: {} }).i);
    expect(none.failures?.[0]).toMatch(/0 ECS service resource/);
    expect((await settled.run(world(() => settledAws(), { outputs: { ServiceArn: "not-an-arn" } }).i)).failures?.[0]).toMatch(/not an ECS service ARN/);
    const state = newState();
    expect((await settled.run(input(state, manifest(), "gateway-live"))).failures?.[0]).toMatch(/does not exist/);
  });
});
