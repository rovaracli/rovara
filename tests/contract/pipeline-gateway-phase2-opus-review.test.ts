// #1478 phase 2, Opus security review (test only): three properties the lane's own tests did not pin.
//  1. The switch gate compares EVERY top-level template section except Outputs, so the stack Description and the Metadata section are compared too (only stack-level
//     properties that are not in the template, such as the stack tags cdk passes, are outside it).
//  2. gateway-runprice (the gateway-check step) judges the live gateway against the Code that will be live in THAT environment, not against the Code commit the gateway was built from:
//     a production release that copies beta's gateway built from a newer Code fails closed when the run-price versions differ.
//  3. The post-switch case: when the switch run deployed the gateway from Code (same image, outputs only) and then failed before last-good was written, the pre-change last-good
//     record is completed by the DeployedCodeSha the live stack attests (fixed after this review; it used to be refused).
// No AWS, no network.
import { describe, expect, it } from "vitest";
import { gate as runprice } from "../../ops/pipeline/gates/gateway-runprice.gate.ts";
import { judgeGatewaySwitch } from "../../ops/pipeline/lib/gateway-switch.ts";
import { gatewayCodeForRecordedDigest } from "../../ops/pipeline/lib/gateway-code.ts";
import { parseLastGood } from "../../ops/pipeline/lib/lastgood.ts";
import type { GateInput, Manifest, Ports } from "../../ops/pipeline/types.ts";
import { DIGEST_A, DIGEST_B, EXEC8, EXEC_ID, config, liveStack, makePorts, newState, sha, stackFor } from "./pipeline-stage-fakes.ts";

const CODE_NEW = sha("e");
const CODE_PROD = sha("f");

describe("the switch gate compares the Description and Metadata sections too", () => {
  const live = {
    Description: "Rovara Cloud beta: the model gateway",
    Metadata: { Note: "a" },
    Parameters: { ImageDigest: { Type: "String" } },
    Resources: { Meter: { Type: "AWS::DynamoDB::GlobalTable", Properties: { Name: "m" } } },
    Outputs: { ServiceArn: { Value: "arn:svc" }, DeployedCloudSha: { Value: sha("3") } },
  };
  const next = (edit: (t: Record<string, unknown>) => void = () => undefined): unknown => {
    const copy = structuredClone(live) as unknown as Record<string, unknown>;
    const outputs = copy.Outputs as Record<string, unknown>;
    delete outputs.DeployedCloudSha;
    outputs.DeployedCodeSha = { Value: CODE_NEW };
    edit(copy);
    return copy;
  };

  it("passes the outputs-only switch, and fails a changed Description, a changed or removed Metadata section", () => {
    expect(judgeGatewaySwitch(live, next(), CODE_NEW).failures).toEqual([]);
    expect(judgeGatewaySwitch(live, next((t) => { t.Description = "something else"; }), CODE_NEW).failures.join("\n")).toMatch(/section Description differs/u);
    expect(judgeGatewaySwitch(live, next((t) => { t.Metadata = { Note: "b" }; }), CODE_NEW).failures.join("\n")).toMatch(/Metadata: changed Note/u);
    expect(judgeGatewaySwitch(live, next((t) => { delete t.Metadata; }), CODE_NEW).failures.join("\n")).toMatch(/section Metadata differs/u);
  });
});

describe("gateway-check in production judges the gateway against PRODUCTION's Code, not the Code the gateway was built from", () => {
  const controlPlane = (version: number): string => `new CfnOutput(this, "ModelRunPriceVersion", { value: "${version}" });`;
  const HEALTHZ = (version: number): string => JSON.stringify({ ok: true, runPrice: { version, admissionVersion: 1, snapshotVersion: 6 } });
  // A Cloud-only release (Code skipped): production stays on CODE_PROD; the gateway was built in beta from CODE_NEW (beta's pinned Code), which publishes a newer run-price version.
  const manifest: Manifest = {
    schema: 1, executionId: EXEC_ID, exec8: EXEC8, createdAt: "2026-11-25T12:00:00.000Z", mode: "release",
    cloud: { tag: "v0.13.30", sha: sha("4"), ref: "latest-tag", trunk: "cloud/next", liveSha: { beta: sha("3"), production: sha("3") } },
    code: { sha: null, release: "skip", requestedRelease: "skip", pinnedSha: { beta: CODE_NEW, production: CODE_PROD }, supersedes: null },
    gateway: { digest: DIGEST_A, source: "copied", imageTag: null, repository: null, codeSha: CODE_NEW },
    stages: {},
  };
  const world = (served: number): { input: GateInput; shown: string[] } => {
    const state = newState();
    liveStack(state, stackFor("production", "web"), { parameters: { ModelGatewayUrl: "https://gateway.example.test" } });
    const shown: string[] = [];
    state.exec = (cmd, args) => {
      if (cmd === "printenv") return { code: 0, stdout: "/code\n", stderr: "" };
      if (cmd === "git" && args.includes("cat-file")) return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args.includes("show")) {
        const spec = String(args[args.length - 1]);
        shown.push(spec);
        return { code: 0, stdout: spec.startsWith(CODE_PROD) ? controlPlane(2) : spec.startsWith(CODE_NEW) ? controlPlane(3) : "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const ports: Ports = { ...makePorts(state, "production"), http: { get: () => Promise.resolve({ status: 200, body: HEALTHZ(served) }) } };
    return {
      input: { env: "production", phase: "gateway-live", region: "us-east-1", config, manifest, changeSets: [], dirs: { pipeline: "/p", cloud: null, out: "/out", work: "/w" }, ports, log: () => undefined },
      shown,
    };
  };

  it("reads production's pinned Code, and FAILS when the gateway (built from the newer Code) serves another run-price version", async () => {
    const newer = world(3);
    const outcome = await runprice.run(newer.input);
    expect(newer.shown).toEqual([`${CODE_PROD}:infra/lib/control-plane.ts`]);
    expect(outcome.result).toBe("fail");
    expect(outcome.failures?.join(" ")).toMatch(/runPrice.version is 3, this Code needs 2/u);
  });

  it("passes when the gateway serves the version production's Code needs", async () => {
    expect((await runprice.run(world(2).input)).result).toBe("pass");
  });
});

describe("the rollback window today: the switch run deployed the gateway from Code, then failed before last-good was written", () => {
  // last-good is still the pre-change record (no Code commit beside the digest); the live stack runs the SAME image (the content tag was reused) and now carries DeployedCodeSha.
  const preChange = JSON.stringify({
    schema: 1, env: "beta", recordedAt: "2026-11-24T00:00:00.000Z", executionId: "earlier", mode: "release", cloud: { tag: "v0.13.29", sha: sha("3") }, gateway: { digest: DIGEST_A },
    code: { sha: CODE_NEW }, proofGates: [], previous: { cloudTag: "v0.13.28", cloudSha: sha("2"), gatewayDigest: DIGEST_B },
  });

  it("a rollback that names the running digest uses the Code commit the stack attests (the change set from it is a no-op); a malformed DeployedCodeSha is still refused", async () => {
    const state = newState();
    liveStack(state, stackFor("beta", "gateway"), { parameters: { ImageDigest: DIGEST_A }, outputs: { DeployedCodeSha: CODE_NEW, ServiceArn: "arn:svc" } });
    await expect(gatewayCodeForRecordedDigest(makePorts(state), config, parseLastGood(preChange), DIGEST_A, "beta", "rollback")).resolves.toBe(CODE_NEW);
    const bad = newState();
    liveStack(bad, stackFor("beta", "gateway"), { parameters: { ImageDigest: DIGEST_A }, outputs: { DeployedCodeSha: "garbage", ServiceArn: "arn:svc" } });
    const attempt = gatewayCodeForRecordedDigest(makePorts(bad), config, parseLastGood(preChange), DIGEST_A, "beta", "rollback");
    await expect(attempt).rejects.toMatchObject({ exitName: "ROLLBACK_REFUSED" });
    await expect(attempt).rejects.toThrow(/not a 40-hex commit/u);
  });
});
