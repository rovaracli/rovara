// Test services slice 1 follow-up (c): `prepareDeployment` (what `agentx upgrade --source <clone>` runs before it deploys) DRIVEN end to end with fakes, to prove the catalog flavor wiring by what happens to a real
// throwaway checkout, not by reading the source text (upgrade-catalog-flavor.test.ts reads it too). The fakes: the identity port (the STS caller), the parameter store with a bootstrap record, and a command runner that
//   - answers the git checks as a clean checkout at the release tag,
//   - does what `npx tsx packages/contracts/tools/catalog-flavor.ts <flavor>` does to the checkout (the tool's own function rewrites the two generated files),
//   - records, at `npm run build` and at `cdk synth`, which flavor and which staging key the tree holds, and
//   - writes a minimal cloud assembly for the synth.
// What stays unproven here (a real cdk synth, a real npm build, a real deploy) is staging's.
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CATALOG_STAGING_ACCOUNT_ID, parseBundlePublicKey } from "@agentx/contracts";
import { FLAVOR_FILE, STAGING_KEYS_FILE, STAGING_KEY_DATA_FILE, setCatalogFlavor } from "../../packages/contracts/tools/catalog-flavor.js";
import { CATALOG_FLAVOR_TOOL, CDK_CONSTRUCT_IDS, cdkDiff, type CommandRunner } from "../../packages/cli/src/deploy/cdk-engine.js";
import { writeTeamRecordRecord } from "../../packages/cli/src/deploy/team-record-switch.js";
import { prepareDeployment } from "../../packages/cli/src/deploy/commands.js";
import { fakeRelease } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const REGION = "us-west-2";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const STAGING_PEM = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "pem" }).toString();
const KEY_ID = parseBundlePublicKey(STAGING_PEM).keyId;

/** A throwaway checkout: the two generated files as committed (release flavor, no staging key) and the staging key data. */
async function checkout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "prepare-flavor-"));
  roots.push(root);
  for (const file of [FLAVOR_FILE, STAGING_KEYS_FILE]) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await cp(new URL(`../../${file}`, import.meta.url), join(root, file));
  }
  await mkdir(join(root, "environments/service-catalog"), { recursive: true });
  await writeFile(join(root, STAGING_KEY_DATA_FILE), JSON.stringify([{ keyId: KEY_ID, algorithm: "ECDSA_SHA_256", publicKey: STAGING_PEM }]));
  return root;
}
const flavorOf = async (root: string): Promise<string> => /"(release|staging)";/u.exec(await readFile(join(root, FLAVOR_FILE), "utf8"))![1]!;
const keysIn = async (root: string): Promise<boolean> => (await readFile(join(root, STAGING_KEYS_FILE), "utf8")).includes(KEY_ID);

type Step = "staging" | "release" | "synth";
function harness(root: string, fail: Step[] = []) {
  const calls: string[] = [];
  const seen: Array<{ at: "build" | "synth"; flavor: string; key: boolean }> = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "git") return { stdout: args[0] === "status" ? "" : "v1.2.3\n" };
      if (args.includes(CATALOG_FLAVOR_TOOL)) {
        const flavor = args.at(-1) as "release" | "staging";
        if (fail.includes(flavor)) throw new Error(`the ${flavor} step failed`);
        await setCatalogFlavor(root, flavor);
      }
      if (args[0] === "run" && args[1] === "build") seen.push({ at: "build", flavor: await flavorOf(root), key: await keysIn(root) });
      const out = args.indexOf("-o");
      if (args.includes("synth") && out >= 0) {
        seen.push({ at: "synth", flavor: await flavorOf(root), key: await keysIn(root) });
        if (fail.includes("synth")) throw new Error("the synth failed");
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
  return { runner, calls, seen };
}

/** The upgrade's own call, with the STS account the identity port returns. */
function prepare(root: string, runner: CommandRunner, input: { env: string; account: string }) {
  const store = new MemoryParameterStore();
  store.values.set("/cdk-bootstrap/hnb659fds/version", "21");
  return prepareDeployment({
    env: input.env, region: REGION, account: input.account, identityMode: "cognito", engine: "cdk", source: root, release: fakeRelease("1.2.3"), stderr: { write: () => undefined },
    deps: { identity: { get: async () => ({ account: input.account, arn: `arn:aws:sts::${input.account}:assumed-role/Admin/upgrade` }) }, store, secrets: { get: async () => undefined, create: async () => undefined }, commandRunner: runner },
  });
}

describe("agentx upgrade: prepareDeployment and the catalog flavor, driven end to end", () => {
  it("env staging in the staging account: the tree is switched to the staging flavor BEFORE the build, built and synthesized as staging with the staging key, and cleanup puts the checkout back to release", async () => {
    const root = await checkout();
    const { runner, calls, seen } = harness(root);
    const prepared = await prepare(root, runner, { env: "staging", account: CATALOG_STAGING_ACCOUNT_ID });
    expect(calls.findIndex((call) => call.endsWith(`${CATALOG_FLAVOR_TOOL} staging`))).toBeGreaterThan(calls.indexOf("npm ci") - 1);
    expect(calls.findIndex((call) => call.endsWith(`${CATALOG_FLAVOR_TOOL} staging`))).toBeLessThan(calls.indexOf("npm run build"));
    expect(seen).toEqual([{ at: "build", flavor: "staging", key: true }, { at: "synth", flavor: "staging", key: true }]);
    // QA6-10: the synth carries the release being deployed.
    expect(calls.find((call) => call.includes(" synth "))).toContain("-c agentxReleaseVersion=1.2.3");
    // The deploy uses the compiled output; until cleanup the tree is still the staging one.
    expect(await flavorOf(root)).toBe("staging");
    await prepared.cleanup();
    expect(await flavorOf(root)).toBe("release");
    expect(await keysIn(root)).toBe(false);
  });
  it("env staging in ANOTHER account: a release build and synth, the flavor tool never runs, and no staging key is in the tree", async () => {
    const root = await checkout();
    const { runner, calls, seen } = harness(root);
    const prepared = await prepare(root, runner, { env: "staging", account: "111122223333" });
    expect(calls.some((call) => call.includes(CATALOG_FLAVOR_TOOL))).toBe(false);
    expect(seen).toEqual([{ at: "build", flavor: "release", key: false }, { at: "synth", flavor: "release", key: false }]);
    await prepared.cleanup();
    expect(await flavorOf(root)).toBe("release");
  });
  it("env prod in the staging account: a release build and synth", async () => {
    const root = await checkout();
    const { runner, calls, seen } = harness(root);
    const prepared = await prepare(root, runner, { env: "prod", account: CATALOG_STAGING_ACCOUNT_ID });
    expect(calls.some((call) => call.includes(CATALOG_FLAVOR_TOOL))).toBe(false);
    expect(seen.map((entry) => entry.flavor)).toEqual(["release", "release"]);
    await prepared.cleanup();
  });
  it("the switch to staging fails: the tree goes back to release and the build and synth are release (the upgrade is not blocked, and trusts no staging key)", async () => {
    const root = await checkout();
    const { runner, seen } = harness(root, ["staging"]);
    const prepared = await prepare(root, runner, { env: "staging", account: CATALOG_STAGING_ACCOUNT_ID });
    expect(seen).toEqual([{ at: "build", flavor: "release", key: false }, { at: "synth", flavor: "release", key: false }]);
    await prepared.cleanup();
    expect(await flavorOf(root)).toBe("release");
  });
  it("the switch fails and so does the way back: nothing is built or synthesized and the upgrade stops", async () => {
    const root = await checkout();
    const { runner, calls, seen } = harness(root, ["staging", "release"]);
    await expect(prepare(root, runner, { env: "staging", account: CATALOG_STAGING_ACCOUNT_ID })).rejects.toThrow(/release step failed/u);
    expect(calls).not.toContain("npm run build");
    expect(seen).toEqual([]);
  });
  it("the synth fails after a staging build: prepareDeployment puts the checkout back to release before it throws (cleanup is never returned)", async () => {
    const root = await checkout();
    const { runner } = harness(root, ["synth"]);
    await expect(prepare(root, runner, { env: "staging", account: CATALOG_STAGING_ACCOUNT_ID })).rejects.toThrow(/synth failed/u);
    expect(await flavorOf(root)).toBe("release");
    expect(await keysIn(root)).toBe(false);
  });
  it("answers that name another account than the credentials' are refused before anything is built or switched", async () => {
    const root = await checkout();
    const { runner, calls } = harness(root);
    const store = new MemoryParameterStore();
    await expect(prepareDeployment({
      env: "staging", region: REGION, account: CATALOG_STAGING_ACCOUNT_ID, identityMode: "cognito", engine: "cdk", source: root, release: fakeRelease("1.2.3"), stderr: { write: () => undefined },
      deps: { identity: { get: async () => ({ account: "111122223333", arn: "arn:aws:sts::111122223333:assumed-role/Admin/x" }) }, store, secrets: { get: async () => undefined, create: async () => undefined }, commandRunner: runner },
    })).rejects.toThrow(/belong to account 111122223333/u);
    expect(calls).toEqual([]);
    expect(await flavorOf(root)).toBe("release");
  });
});

// UX-4b re-check fix 4: the Team record recorded as on, with its storage options, reaches every cdk command prepareDeployment makes (the declared-parameter synth and the deployer), and the diff.
describe("the Team record's options reach the synth, the deploy and the diff", () => {
  const CONTEXT = ["-c agentxTeamRecord=enabled", "-c agentxTeamRecordLake=false"];
  it("passes them to the synth and the deploy when the install records them, and never otherwise", async () => {
    const root = await checkout();
    const { runner, calls } = harness(root);
    const store = new MemoryParameterStore();
    store.values.set("/cdk-bootstrap/hnb659fds/version", "21");
    await writeTeamRecordRecord(store, "prod", { enabled: true, // An older record may still hold the retired embeddingModelId: it reads, and is never passed to the synth.
      options: { lake: "false", embeddingModelId: "amazon.titan-embed-text-v2:0" } as never });
    const prepared = await prepareDeployment({
      env: "prod", region: REGION, account: "111122223333", identityMode: "cognito", engine: "cdk", source: root, release: fakeRelease("1.2.3"), stderr: { write: () => undefined },
      deps: { identity: { get: async () => ({ account: "111122223333", arn: "arn:aws:sts::111122223333:assumed-role/Admin/upgrade" }) }, store, secrets: { get: async () => undefined, create: async () => undefined }, commandRunner: runner, stackOutputs: async () => ({}) },
    });
    for (const context of CONTEXT) expect(calls.find((call) => call.includes(" synth "))).toContain(context);
    expect(calls.find((call) => call.includes(" synth "))).not.toContain("EmbeddingModelId");
    await prepared.deployer.deploy({ part: "control-plane", stackName: "agentx-prod-control-plane", parameters: {} } as never).catch(() => undefined);
    const deploy = calls.find((call) => call.includes(" deploy "));
    expect(deploy).toBeDefined();
    for (const context of CONTEXT) expect(deploy).toContain(context);
    await prepared.cleanup();
    // Not recorded: nothing about the record is passed.
    const otherRoot = await checkout();
    const other = harness(otherRoot);
    const plain = await prepare(otherRoot, other.runner, { env: "prod", account: "111122223333" });
    expect(other.calls.find((call) => call.includes(" synth "))).not.toContain("agentxTeamRecord");
    await plain.cleanup();
  });

  it("passes them to the diff", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = { async run(command, args) { calls.push(`${command} ${args.join(" ")}`);return { stdout: "There were no differences" }; } };
    await cdkDiff({ runner, source: "/src", env: "prod", region: REGION, identityMode: "cognito", teamRecord: { lake: "false", embeddingModelId: "amazon.titan-embed-text-v2:0" } as never, request: { part: "control-plane", stackName: "agentx-prod-control-plane", parameters: {} } as never });
    for (const context of CONTEXT) expect(calls[0]).toContain(context);
  });
});
