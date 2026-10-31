import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cdkAppArguments, cdkDiff, CDK_CONSTRUCT_IDS, type CommandRunner } from "../../packages/cli/src/deploy/cdk-engine.js";
import { DeployAnswersSchema, prepareDeployment } from "../../packages/cli/src/deploy/commands.js";
import { adoptOrphanedEditionRecord, editionBackupName, editionRecordName, readRecordedEdition, resolveDeployEdition, settleEditionRecord } from "../../packages/cli/src/deploy/edition.js";
import { collectEdition, type InitFlags } from "../../packages/cli/src/init/answers.js";
import { initDeployAnswers } from "../../packages/cli/src/init/deploy-steps.js";
import { InitAnswersSchema } from "../../packages/cli/src/init/install-state.js";
import { fakeRelease, sampleAnswers } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

// Enterprise foundations E2, CLI side: `rovara init` chooses the edition, `rovara deploy` and `rovara upgrade` carry the recorded one, and nobody changes it.

const ACCOUNT = "123456789012";
const REGION = "us-east-1";
const caller = { account: ACCOUNT, arn: `arn:aws:sts::${ACCOUNT}:assumed-role/Admin/alice` };

async function thrown<T>(run: () => Promise<T>): Promise<{ code?: string; message: string } | undefined> {
  try { await run(); } catch (error) { return error as { code?: string; message: string }; }
  return undefined;
}

describe("cdk context", () => {
  const base = { env: "staging", region: REGION, identityMode: "cognito" as const };

  it("passes rovaraEdition and rovaraNewInstall, and nothing when they are not asked for", () => {
    expect(cdkAppArguments({ ...base, edition: "enterprise", newInstall: true })).toEqual(["--app", "node infra/dist/bin/agentx.js", "-c", "agentxEnv=staging", "-c", "agentxRegion=us-east-1", "-c", "rovaraEdition=enterprise", "-c", "rovaraNewInstall=true"]);
    expect(cdkAppArguments({ ...base, edition: "public", cloud: true })).toContain("rovaraEdition=public");
    const none = cdkAppArguments(base).join(" ");
    expect(none).not.toContain("rovaraEdition");
    expect(none).not.toContain("rovaraNewInstall");
    expect(cdkAppArguments({ ...base, newInstall: false }).join(" ")).not.toContain("rovaraNewInstall");
  });

  it("gives the diff the same edition as the deploy", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = { async run(_c, args) { calls.push(args); return { stdout: "" }; } };
    await cdkDiff({ runner, source: "/src", ...base, edition: "enterprise", request: { part: "slack", stackName: "agentx-staging-slack", parameters: {}, terminationProtection: false } });
    expect(calls[0]).toContain("rovaraEdition=enterprise");
  });
});

describe("resolveDeployEdition", () => {
  const store = (record?: string) => { const s = new MemoryParameterStore(); if (record !== undefined) s.values.set(editionRecordName("staging"), record); return s; };
  const resolve = (input: { record?: string; requested?: "enterprise" | "public"; engine?: "cdk" | "templates"; cloud?: boolean }) =>
    resolveDeployEdition({ store: store(input.record), env: "staging", engine: input.engine ?? "cdk", cloud: input.cloud ?? false, requested: input.requested });

  it("an install with no record and no request has no edition (today's behaviour)", async () => {
    expect(await resolve({})).toBeUndefined();
  });

  it("a redeploy that names no edition keeps the recorded one, so the stamp is never dropped", async () => {
    expect(await resolve({ record: "enterprise" })).toBe("enterprise");
  });

  it("the same edition again is fine; a different one is refused", async () => {
    expect(await resolve({ record: "enterprise", requested: "enterprise" })).toBe("enterprise");
    expect((await thrown(() => resolve({ record: "enterprise", requested: "public", cloud: true })))?.message).toContain("cannot change");
    expect((await thrown(() => resolve({ record: "public", requested: "enterprise" })))?.message).toContain("cannot change");
  });

  it("an install with no record may choose an edition on a planned change", async () => {
    expect(await resolve({ requested: "enterprise" })).toBe("enterprise");
  });

  it("an unreadable record is refused, never read as no record", async () => {
    for (const value of ["", "Enterprise", "private", "{}"]) {
      expect((await thrown(() => resolve({ record: value })))?.code, JSON.stringify(value)).toBe("CONFIG_INVALID");
    }
    expect(await thrown(() => readRecordedEdition({ ...new MemoryParameterStore(), get: async () => { throw new Error("AccessDenied"); } } as never, "staging"))).toBeDefined();
  });

  it("refuses Enterprise inside the hosted cloud and Public outside it", async () => {
    expect((await thrown(() => resolve({ requested: "enterprise", cloud: true })))?.code).toBe("CONFIG_INVALID");
    expect((await thrown(() => resolve({ requested: "public" })))?.code).toBe("CONFIG_INVALID");
  });

  it("refuses an edition on the prebuilt templates, which cannot carry one (a recorded Enterprise install included)", async () => {
    expect((await thrown(() => resolve({ requested: "enterprise", engine: "templates" })))?.message).toContain("synthesized from source");
    expect((await thrown(() => resolve({ record: "enterprise", engine: "templates" })))?.message).toContain("synthesized from source");
    expect(await resolve({ engine: "templates" })).toBeUndefined();
  });
});

describe("prepareDeployment synthesizes with the edition", () => {
  /** A runner for the cdk engine's source steps: clean checkout at the release tag, any build, and a synth that writes a minimal cloud assembly. */
  function sourceRunner(version: string) {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        if (command === "git" && args[0] === "status") return { stdout: "" };
        if (command === "git") return { stdout: `v${version}\n` };
        const out = args.indexOf("-o");
        if (args.includes("synth") && out >= 0) {
          const dir = args[out + 1]!;
          const artifacts: Record<string, unknown> = {};
          for (const [part, id] of Object.entries(CDK_CONSTRUCT_IDS)) {
            await writeFile(join(dir, `${id}.template.json`), JSON.stringify({ Parameters: {}, Resources: {} }));
            artifacts[id] = { type: "aws:cloudformation:stack", properties: { templateFile: `${id}.template.json`, stackName: `agentx-staging-${part}` } };
          }
          await writeFile(join(dir, "manifest.json"), JSON.stringify({ version: "54.0.0", artifacts }));
        }
        return { stdout: "" };
      },
    };
    return { runner, calls, synth: () => calls.find((call) => call.args.includes("synth"))!.args };
  }
  const storeWith = (record?: string) => {
    const store = new MemoryParameterStore();
    store.values.set("/cdk-bootstrap/hnb659fds/version", "21");
    if (record !== undefined) store.values.set(editionRecordName("staging"), record);
    return store;
  };
  const prepare = (store: MemoryParameterStore, runner: CommandRunner, extra: Record<string, unknown> = {}) => prepareDeployment({
    env: "staging", region: REGION, account: ACCOUNT, identityMode: "cognito", engine: "cdk", source: "/src", release: fakeRelease(), stderr: { write: () => undefined },
    deps: { identity: { get: async () => caller }, store, secrets: { get: async () => undefined, create: async () => undefined }, commandRunner: runner },
    ...extra,
  });

  it("an Enterprise install's redeploy names no edition and still synthesizes as Enterprise", async () => {
    const run = sourceRunner("1.2.3");
    const prepared = await prepare(storeWith("enterprise"), run.runner);
    await prepared.cleanup();
    expect(run.synth()).toContain("rovaraEdition=enterprise");
    expect(run.synth()).not.toContain("rovaraNewInstall=true");
  });

  it("a first install by rovara init carries the edition and the new-install mark", async () => {
    const run = sourceRunner("1.2.3");
    const prepared = await prepare(storeWith(), run.runner, { edition: "enterprise", newInstall: true });
    await prepared.cleanup();
    expect(run.synth()).toEqual(expect.arrayContaining(["rovaraEdition=enterprise", "rovaraNewInstall=true"]));
  });

  it("an install deployed before editions synthesizes exactly as before", async () => {
    const run = sourceRunner("1.2.3");
    const prepared = await prepare(storeWith(), run.runner);
    await prepared.cleanup();
    expect(run.synth().join(" ")).not.toContain("rovara");
  });

  it("hands the deploy the adoption of a retained edition record, for an Enterprise cdk install only (fix round 2, N-1)", async () => {
    const run = sourceRunner("1.2.3");
    const store = storeWith("enterprise");
    const prepared = await prepareDeployment({
      env: "staging", region: REGION, account: ACCOUNT, identityMode: "cognito", engine: "cdk", source: "/src", release: fakeRelease(), stderr: { write: () => undefined },
      deps: { identity: { get: async () => caller }, store, secrets: { get: async () => undefined, create: async () => undefined }, commandRunner: run.runner, foundationResources: async () => ["vpc-1"] },
    });
    expect(await prepared.adoptEditionRecord!()).toBe("adopted");
    expect(store.values.has(editionRecordName("staging"))).toBe(false);
    await prepared.cleanup();
    const plain = await prepare(storeWith(), sourceRunner("1.2.3").runner);
    expect(plain.adoptEditionRecord).toBeUndefined();
    await plain.cleanup();
  });

  it("refuses a changed edition before anything is built", async () => {
    const run = sourceRunner("1.2.3");
    const failure = await thrown(() => prepare(storeWith("enterprise"), run.runner, { edition: "public", cloud: true }));
    expect(failure?.message).toContain("cannot change");
    // Nothing was installed or built: only the read-only source checks ran.
    expect(run.calls.map((call) => call.command)).not.toContain("npm");
    expect(run.calls.some((call) => call.args.includes("synth"))).toBe(false);
  });
});

describe("answers", () => {
  const flags = (extra: Partial<InitFlags>): InitFlags => ({ ...extra });

  it("rovara init: a new cdk install must choose; Enterprise is explicit; the hosted cloud is Public", () => {
    expect(() => collectEdition(flags({}), "cdk")).toThrow(/must choose its edition/);
    expect(collectEdition(flags({ edition: "enterprise" }), "cdk")).toBe("enterprise");
    expect(collectEdition(flags({ rovaraCloud: true }), "cdk")).toBeUndefined();
    expect(collectEdition(flags({ rovaraCloud: true, edition: "public" }), "cdk")).toBe("public");
  });

  it("rovara init refuses a wrong flag before any AWS call", () => {
    expect(() => collectEdition(flags({ edition: "Enterprise" }), "cdk")).toThrow(/enterprise" or "public/);
    expect(() => collectEdition(flags({ edition: "public" }), "cdk")).toThrow(/hosted cloud/);
    expect(() => collectEdition(flags({ edition: "enterprise", rovaraCloud: true }), "cdk")).toThrow(/cannot be combined/);
    expect(() => collectEdition(flags({ edition: "enterprise" }), "templates")).toThrow(/synthesized from source/);
  });

  it("the prebuilt templates install as they always did", () => {
    expect(collectEdition(flags({}), "templates")).toBeUndefined();
  });

  it("the edition travels in the saved answers and in the deploy answers file", () => {
    const answers = { ...sampleAnswers(), edition: "enterprise" as const };
    expect(InitAnswersSchema.parse(answers).edition).toBe("enterprise");
    expect(InitAnswersSchema.safeParse({ ...answers, edition: "private" }).success).toBe(false);
    const deploy = initDeployAnswers(InitAnswersSchema.parse(answers), { steps: {} } as never, []);
    expect(deploy.edition).toBe("enterprise");
    expect(initDeployAnswers(InitAnswersSchema.parse(sampleAnswers()), { steps: {} } as never, []).edition).toBeUndefined();
    const file = { env: "staging", region: REGION, account: ACCOUNT, models: answers.models, identity: { mode: "cognito" }, github: { appId: "1", privateKeySecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:x-AbCdEf" } };
    expect(DeployAnswersSchema.safeParse({ ...file, edition: "enterprise" }).success).toBe(true);
    expect(DeployAnswersSchema.safeParse({ ...file, edition: "other" }).success).toBe(false);
  });
});

describe("a retained edition record that its stack no longer owns (fix round 2, N-1)", () => {
  const withRecord = (value?: string) => { const store = new MemoryParameterStore(); if (value !== undefined) store.values.set(editionRecordName("staging"), value); return store; };
  const adopt = (store: MemoryParameterStore, resources: readonly string[] | undefined, edition: "enterprise" | "public" | "unset" = "enterprise") =>
    adoptOrphanedEditionRecord({ store, env: "staging", edition: edition === "unset" ? undefined : edition, foundationResources: async () => resources });

  it("is removed before the foundation deploys, so the deploy creates it again; one the stack owns is left alone", async () => {
    const orphan = withRecord("enterprise");
    expect(await adopt(orphan, ["vpc-1"])).toBe("adopted");
    expect(orphan.values.has(editionRecordName("staging"))).toBe(false);
    const orphanNoStack = withRecord("enterprise");
    expect(await adopt(orphanNoStack, undefined)).toBe("adopted");
    const owned = withRecord("enterprise");
    expect(await adopt(owned, ["vpc-1", editionRecordName("staging")])).toBe("owned");
    expect(owned.values.get(editionRecordName("staging"))).toBe("enterprise");
  });

  it("writes the backup before it removes the record; a completed deploy removes the backup, a failed one puts the record back", async () => {
    const store = withRecord("enterprise");
    const order: string[] = [];
    const original = store.delete.bind(store);
    store.delete = async (name) => { order.push(`delete ${name}`); await original(name); };
    const put = store.put.bind(store);
    store.put = async (name, value, options) => { order.push(`put ${name}`); await put(name, value, options); };
    await adopt(store, ["vpc-1"]);
    expect(order).toEqual([`put ${editionBackupName("staging")}`, `delete ${editionRecordName("staging")}`]);
    expect(store.values.get(editionBackupName("staging"))).toBe("enterprise");
    // The deploy failed or was interrupted before the stack created the record: put it back.
    await settleEditionRecord({ store, env: "staging", completed: false });
    expect(store.values.get(editionRecordName("staging"))).toBe("enterprise");
    expect(store.values.get(editionBackupName("staging"))).toBe("enterprise");
    // The deploy completed: the backup goes (only with the record back and saying the same).
    await settleEditionRecord({ store, env: "staging", completed: true });
    expect(store.values.has(editionBackupName("staging"))).toBe(false);
    const nothingBack = withRecord();
    nothingBack.values.set(editionBackupName("staging"), "enterprise");
    await settleEditionRecord({ store: nothingBack, env: "staging", completed: true });
    expect(nothingBack.values.has(editionBackupName("staging"))).toBe(true);
  });

  it("while the backup exists (the record out of the way) the install's edition is the backup's, and no other edition is accepted", async () => {
    const interrupted = withRecord();
    interrupted.values.set(editionBackupName("staging"), "enterprise");
    expect(await readRecordedEdition(interrupted, "staging")).toBe("enterprise");
    expect(await resolveDeployEdition({ store: interrupted, env: "staging", engine: "cdk", cloud: false })).toBe("enterprise");
    expect((await thrown(() => resolveDeployEdition({ store: interrupted, env: "staging", engine: "cdk", cloud: true, requested: "public" })))?.message).toContain("cannot change");
    // Record and backup that disagree, or a backup that is not an edition: refused.
    const disagree = withRecord("public");
    disagree.values.set(editionBackupName("staging"), "enterprise");
    expect((await thrown(() => readRecordedEdition(disagree, "staging")))?.message).toContain("disagree");
    const bad = withRecord();
    bad.values.set(editionBackupName("staging"), "garbage");
    expect((await thrown(() => readRecordedEdition(bad, "staging")))?.code).toBe("CONFIG_INVALID");
  });

  it("does nothing where there is no record or the deploy is not Enterprise", async () => {
    expect(await adopt(withRecord(), [])).toBe("none");
    const store = withRecord("enterprise");
    expect(await adopt(store, [], "unset")).toBe("none");
    expect(await adopt(store, [], "public")).toBe("none");
    expect(store.values.has(editionRecordName("staging"))).toBe(true);
  });

});
