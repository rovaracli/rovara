import { describe, expect, it } from "vitest";
import { doctorReport, guarded, reportText } from "../../packages/cli/src/doctor/checks.js";
import { releaseMismatch, stackChecks } from "../../packages/cli/src/doctor/stacks.js";
import { doctorContext, doctorServices, healthyStacks, MANIFEST, SETTINGS } from "../support/doctor-fakes.js";

const withStack = (name: string, change: Partial<ReturnType<typeof healthyStacks>[string]> | undefined) => {
  const stacks = healthyStacks();
  if (change === undefined) delete stacks[name];
  else stacks[name] = { ...stacks[name]!, ...change };
  return doctorContext({ services: doctorServices({ stackMap: stacks }) });
};

describe("doctor: stacks (FR-050)", () => {
  it("passes a healthy environment deployed from the release in its settings", async () => {
    const checks = await stackChecks(doctorContext());
    expect(checks.filter((entry) => entry.status !== "ok")).toEqual([]);
    expect(checks.map((entry) => entry.name)).toEqual([
      "rovara-cloud-staging-access", "rovara-cloud-staging-foundation", "rovara-cloud-staging-identity", "rovara-cloud-staging-control-plane", "rovara-cloud-staging-runtime", "rovara-cloud-staging-slack",
      "engine", "drift", "rovara-cloud-staging-runtime boot hash", "release 1.2.3",
    ]);
  });

  it("passes a runtime stack whose worker image comes with a 64-hex boot stage 2 hash", async () => {
    const found = (await stackChecks(doctorContext())).find((entry) => entry.name === "rovara-cloud-staging-runtime boot hash")!;
    expect(found).toMatchObject({ status: "ok" });
  });

  it.each([
    ["is none (a release from before the boot split)", "none"],
    ["is not 64 lower-case hex digits", "E".repeat(63)],
    ["is empty", ""],
  ])("fails a runtime stack whose boot stage 2 hash %s, and points at rovara upgrade", async (_why, value) => {
    const stacks = healthyStacks();
    stacks["rovara-cloud-staging-runtime"] = { ...stacks["rovara-cloud-staging-runtime"]!, parameters: { ...stacks["rovara-cloud-staging-runtime"]!.parameters, BootStage2Sha256: value } };
    const found = (await stackChecks(doctorContext({ services: doctorServices({ stackMap: stacks }) }))).find((entry) => entry.name === "rovara-cloud-staging-runtime boot hash")!;
    expect(found.status).toBe("fail");
    expect(found.detail).toContain("no boot hash for its worker image");
    expect(found.detail).toContain("cannot launch");
    expect(found.fix).toContain("rovara --env staging upgrade");
  });

  it("fails a runtime stack that has no boot stage 2 hash parameter at all", async () => {
    const stacks = healthyStacks();
    const rest = { ...stacks["rovara-cloud-staging-runtime"]!.parameters };
    delete rest.BootStage2Sha256;
    stacks["rovara-cloud-staging-runtime"] = { ...stacks["rovara-cloud-staging-runtime"]!, parameters: rest };
    const found = (await stackChecks(doctorContext({ services: doctorServices({ stackMap: stacks }) }))).find((entry) => entry.name === "rovara-cloud-staging-runtime boot hash")!;
    expect(found.status).toBe("fail");
  });

  it("does not check the boot hash of a runtime stack that does not exist (its own check already fails)", async () => {
    const names = (await stackChecks(withStack("rovara-cloud-staging-runtime", undefined))).map((entry) => entry.name);
    expect(names).not.toContain("rovara-cloud-staging-runtime boot hash");
  });

  it("fails a missing stack and says upgrade deploys it again", async () => {
    const found = (await stackChecks(withStack("rovara-cloud-staging-slack", undefined))).find((entry) => entry.name === "rovara-cloud-staging-slack")!;
    expect(found).toMatchObject({ status: "fail", detail: "does not exist", fix: "rovara --env staging upgrade deploys it again" });
  });

  it("never sends a missing control-plane or access stack to upgrade, which refuses both: resume the install, or destroy and install again", async () => {
    for (const name of ["rovara-cloud-staging-control-plane", "rovara-cloud-staging-access"]) {
      const found = (await stackChecks(withStack(name, undefined))).find((entry) => entry.name === name)!;
      expect(found).toMatchObject({
        status: "fail", detail: "does not exist",
        fix: "rovara upgrade cannot deploy it again. If the install never finished, run rovara init --env staging --region us-east-1 --resume; otherwise remove the environment with rovara --env staging destroy --region us-east-1, then install it again with rovara init",
      });
    }
  });

  it("fails a stack whose first create failed, offering the delete command and rovara destroy", async () => {
    const found = (await stackChecks(withStack("rovara-cloud-staging-identity", { status: "ROLLBACK_COMPLETE" }))).find((entry) => entry.name === "rovara-cloud-staging-identity")!;
    expect(found.status).toBe("fail");
    expect(found.fix).toContain("aws cloudformation delete-stack --stack-name rovara-cloud-staging-identity --region us-east-1");
    expect(found.fix).toContain("rovara --env staging destroy --region us-east-1");
  });

  it("warns about a rolled-back update and a stack that is still busy", async () => {
    expect((await stackChecks(withStack("rovara-cloud-staging-runtime", { status: "UPDATE_ROLLBACK_COMPLETE" }))).find((entry) => entry.name === "rovara-cloud-staging-runtime")?.status).toBe("warn");
    expect((await stackChecks(withStack("rovara-cloud-staging-runtime", { status: "UPDATE_IN_PROGRESS" }))).find((entry) => entry.name === "rovara-cloud-staging-runtime")?.status).toBe("warn");
  });

  it("fails an engine mismatch: a cdk-deployed stack (BootstrapVersion) in a templates environment", async () => {
    const stacks = healthyStacks();
    stacks["rovara-cloud-staging-slack"] = { ...stacks["rovara-cloud-staging-slack"]!, parameters: { ...stacks["rovara-cloud-staging-slack"]!.parameters, BootstrapVersion: "/cdk-bootstrap/hnb659fds/version" } };
    const engine = (await stackChecks(doctorContext({ services: doctorServices({ stackMap: stacks }) }))).find((entry) => entry.name === "engine")!;
    expect(engine.status).toBe("fail");
    expect(engine.detail).toContain("rovara-cloud-staging-slack (cdk)");
  });

  it("names the stacks whose drift was never checked when others were checked in sync", async () => {
    const stacks = healthyStacks();
    for (const name of ["rovara-cloud-staging-access", "rovara-cloud-staging-foundation", "rovara-cloud-staging-identity", "rovara-cloud-staging-control-plane"]) stacks[name] = { ...stacks[name]!, drift: "IN_SYNC" };
    const drift = (await stackChecks(doctorContext({ services: doctorServices({ stackMap: stacks }) }))).find((entry) => entry.name === "drift")!;
    expect(drift.status).toBe("ok");
    expect(drift.detail).not.toContain("no drift at the last drift check;");
    expect(drift.detail).toContain("no drift at the last drift check for rovara-cloud-staging-access, rovara-cloud-staging-foundation, rovara-cloud-staging-identity, rovara-cloud-staging-control-plane");
    expect(drift.detail).toContain("drift has not been checked for rovara-cloud-staging-runtime, rovara-cloud-staging-slack");
    expect(drift.detail).toContain("aws cloudformation detect-stack-drift --stack-name rovara-cloud-staging-runtime --region us-east-1");
    expect(drift.detail).toContain("aws cloudformation detect-stack-drift --stack-name rovara-cloud-staging-slack --region us-east-1");
    expect(drift.detail).not.toContain("--stack-name rovara-cloud-staging-access");
  });

  it("warns about drift found by the last drift check, with the admin command to see it", async () => {
    const drift = (await stackChecks(withStack("rovara-cloud-staging-control-plane", { drift: "DRIFTED" }))).find((entry) => entry.name === "drift")!;
    expect(drift.status).toBe("warn");
    expect(drift.fix).toContain("aws cloudformation describe-stack-resource-drifts --stack-name rovara-cloud-staging-control-plane --region us-east-1");
  });

  it("fails a stack running another release's code, and warns about a testing image", async () => {
    const stacks = healthyStacks();
    stacks["rovara-cloud-staging-control-plane"] = { ...stacks["rovara-cloud-staging-control-plane"]!, parameters: { ...stacks["rovara-cloud-staging-control-plane"]!.parameters, AssetHash: "f".repeat(64) } };
    const release = (await stackChecks(doctorContext({ services: doctorServices({ stackMap: stacks }) }))).find((entry) => entry.name === "release 1.2.3")!;
    expect(release).toMatchObject({ status: "fail", fix: "rovara --env staging upgrade --to 1.2.3" });
    expect(releaseMismatch("runtime", { WorkerImageUri: `x@sha256:${"9".repeat(64)}` }, MANIFEST)).toEqual({ code: [], images: ["WorkerImageUri"] });
  });

  // Ruling F4: a cdk-deployed stack (DefaultStackSynthesizer) keeps its code in the bootstrap bucket
  // and declares no asset parameters, so only its image digests are compared.
  const cdkEnvironment = (change: (stacks: ReturnType<typeof healthyStacks>) => void = () => undefined) => {
    const stacks = healthyStacks();
    for (const stack of Object.values(stacks)) {
      const parameters: Record<string, string> = { ...stack.parameters, BootstrapVersion: "/cdk-bootstrap/hnb659fds/version" };
      delete parameters.AssetHash;
      stack.parameters = parameters;
    }
    change(stacks);
    return doctorContext({ settings: { ...SETTINGS, engine: "cdk" }, services: doctorServices({ stackMap: stacks }) });
  };

  it("passes a cdk environment whose stacks carry BootstrapVersion and no asset parameters (F4)", async () => {
    const checks = await stackChecks(cdkEnvironment());
    expect(checks.filter((entry) => entry.status !== "ok")).toEqual([]);
    const release = checks.find((entry) => entry.name === "release 1.2.3")!;
    expect(release.detail).toContain("cdk: code packages are not compared (they live in the bootstrap bucket)");
    expect(checks.find((entry) => entry.name === "engine")!.detail).toBe("every stack was deployed with the cdk engine");
  });

  it("still compares a cdk stack's image digest, and never its code packages (F4)", async () => {
    const context = cdkEnvironment((stacks) => {
      stacks["rovara-cloud-staging-runtime"]!.parameters.WorkerImageUri = `x@sha256:${"9".repeat(64)}`;
      stacks["rovara-cloud-staging-control-plane"]!.parameters.AssetHash = "f".repeat(64);
    });
    const release = (await stackChecks(context)).find((entry) => entry.name === "release 1.2.3")!;
    expect(release.status).toBe("warn");
    expect(release.detail).toContain("rovara-cloud-staging-runtime WorkerImageUri");
    expect(release.detail).not.toContain("AssetHash");
    // On cdk the image digest is the only sign of a stale release, so the cause is not stated as fact.
    expect(release.detail).toContain("(the testing-only image flags set this, or the stack runs another release)");
  });

  it("names the upgrade a cdk environment can run: --source and admin credentials (carry-forward from ruling F20)", async () => {
    const context = cdkEnvironment((stacks) => {
      stacks["rovara-cloud-staging-runtime"]!.parameters.WorkerImageUri = `x@sha256:${"9".repeat(64)}`;
    });
    const release = (await stackChecks(context)).find((entry) => entry.name === "release 1.2.3")!;
    expect(release.fix).toBe("with admin credentials, rovara --env staging upgrade --to 1.2.3 --source <a clean checkout of tag v1.2.3>, without --worker-image or --slack-image");
  });

  it("warns, and does not fail, when the release manifest cannot be read", async () => {
    const release = (await stackChecks(doctorContext({ services: doctorServices({ releaseManifest: async () => undefined }) }))).find((entry) => entry.name === "release 1.2.3")!;
    expect(release.status).toBe("warn");
  });
});

describe("doctor: reporting (FR-051)", () => {
  it("counts results and prints each problem with its fix", () => {
    const report = doctorReport(SETTINGS, [
      { group: "stacks", name: "rovara-cloud-staging-slack", status: "fail", detail: "does not exist", fix: "rovara --env staging upgrade deploys it again" },
      { group: "alerts", name: "subscription", status: "warn", detail: "not confirmed yet" },
      { group: "models", name: "orchestrator", status: "ok", detail: "answers" },
      { group: "slack", name: "bound channel", status: "skip", detail: "no channel recorded" },
    ]);
    expect(report).toMatchObject({ env: "staging", failed: 1, warned: 1, passed: 1 });
    const text = reportText(report);
    expect(text).toContain("FAIL  stacks      rovara-cloud-staging-slack: does not exist\n      fix: rovara --env staging upgrade deploys it again");
    expect(text).toContain("warn  alerts      subscription: not confirmed yet");
    expect(text).toContain("skip  slack       bound channel: no channel recorded");
    expect(text.trimEnd().split("\n").at(-1)).toBe("1 failed, 1 warning, 1 passed, 1 skipped");
  });

  it("turns a check group that throws into one failed check, without the error's code prefix", async () => {
    const checks = await guarded("github", async () => { throw new Error("GitHub app lookup failed with HTTP 502"); });
    expect(checks).toEqual([{ group: "github", name: "github checks", status: "fail", detail: "could not run the github checks: GitHub app lookup failed with HTTP 502", fix: "check this computer's network access to github.com, then run rovara doctor again" }]);
  });
});
