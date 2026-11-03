// Test services slice 1, H4: the catalog flavor is chosen INSIDE `agentx upgrade`, in the build it runs from the clone (packages/cli/src/deploy: prepareDeployment -> buildSource). `staging` only for env "staging" in the
// staging account (the STS caller of the upgrade's own AWS client); every other case, a step that is skipped and a step that throws, is the release flavor and trusts no staging-only key.
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CATALOG_STAGING_ACCOUNT_ID, parseBundlePublicKey } from "@agentx/contracts";
import { trustedKeyPemsFor } from "@agentx/contracts/testing";
import { FLAVOR_FILE, STAGING_KEYS_FILE, STAGING_KEY_DATA_FILE, setCatalogFlavor } from "../../packages/contracts/tools/catalog-flavor.js";
import { CATALOG_FLAVOR_TOOL, CATALOG_STAGING_BUILD_ACCOUNT, buildSource, catalogFlavorFor, type CommandRunner } from "../../packages/cli/src/deploy/cdk-engine.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const STAGING_PEM = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "pem" }).toString();
const KEY_ID = parseBundlePublicKey(STAGING_PEM).keyId;

/** A throwaway checkout holding the two generated files (as committed: release and empty) and the staging key data. */
async function checkout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "upgrade-flavor-"));
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

/** A runner that does what the commands do to the checkout: the flavor tool rewrites the two files for real; npm does nothing; a command listed in `fail` throws. */
function runnerFor(root: string, fail: Array<"staging" | "release" | "build"> = []) {
  const calls: string[] = [];
  const built: Array<{ flavor: string; keys: boolean }> = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push(`${command} ${args.join(" ")}`);
      if (args.includes(CATALOG_FLAVOR_TOOL)) {
        const flavor = args.at(-1) as "release" | "staging";
        if (fail.includes(flavor)) throw new Error(`the ${flavor} step failed`);
        await setCatalogFlavor(root, flavor);
      }
      if (args[0] === "run" && args[1] === "build") {
        if (fail.includes("build")) throw new Error("the build failed");
        built.push({ flavor: await flavorOf(root), keys: await keysIn(root) });
      }
      return { stdout: "" };
    },
  };
  return { runner, calls, built };
}

describe("which flavor an upgrade builds", () => {
  it("staging only for env staging in the staging account; release for another account, for prod in the staging account, and whenever the account is unknown", () => {
    expect(CATALOG_STAGING_BUILD_ACCOUNT).toBe(CATALOG_STAGING_ACCOUNT_ID);
    expect(catalogFlavorFor({ env: "staging", account: "944937319445" })).toBe("staging");
    for (const [env, account] of [["staging", "111122223333"], ["prod", "944937319445"], ["production", "944937319445"], ["Staging", "944937319445"], ["staging", undefined], ["staging", ""], ["", "944937319445"]] as const) {
      expect(catalogFlavorFor({ env, account }), `${env}/${String(account)}`).toBe("release");
    }
  });
});

describe("the build the upgrade runs", () => {
  it("env staging in another account: the release flavor, the tool is not run, and the staging-only key is refused", async () => {
    const root = await checkout();
    const { runner, calls, built } = runnerFor(root);
    const result = await buildSource({ runner, source: root, flavor: catalogFlavorFor({ env: "staging", account: "111122223333" }) });
    expect(result.flavor).toBe("release");
    expect(calls).toEqual(["npm ci", "npm run build"]);
    expect(built).toEqual([{ flavor: "release", keys: false }]);
    // Even the key list of a staging tree is not honoured by a release flavor, in the staging account itself.
    expect(trustedKeyPemsFor({ runningAccountId: "944937319445" }, { real: [], stagingOnly: [{ keyId: KEY_ID, algorithm: "ECDSA_SHA_256", publicKey: STAGING_PEM }], flavor: "release" })).toEqual([]);
  });

  it("prod in the staging account: the release flavor", async () => {
    const root = await checkout();
    const { runner, calls, built } = runnerFor(root);
    await buildSource({ runner, source: root, flavor: catalogFlavorFor({ env: "prod", account: "944937319445" }) });
    expect(calls).toEqual(["npm ci", "npm run build"]);
    expect(built).toEqual([{ flavor: "release", keys: false }]);
  });

  it("env staging in the staging account: the tree is switched BEFORE the build, the build sees the staging flavor and the key, and restore puts the checkout back", async () => {
    const root = await checkout();
    const { runner, calls, built } = runnerFor(root);
    const result = await buildSource({ runner, source: root, flavor: catalogFlavorFor({ env: "staging", account: "944937319445" }) });
    expect(result.flavor).toBe("staging");
    expect(calls).toEqual(["npm ci", `npx tsx ${CATALOG_FLAVOR_TOOL} staging`, "npm run build"]);
    expect(built).toEqual([{ flavor: "staging", keys: true }]);
    expect(trustedKeyPemsFor({ runningAccountId: "944937319445" }, { real: [], stagingOnly: [{ keyId: KEY_ID, algorithm: "ECDSA_SHA_256", publicKey: STAGING_PEM }], flavor: "staging" })).toHaveLength(1);
    await result.restore();
    expect(await flavorOf(root)).toBe("release");
    expect(await keysIn(root)).toBe(false);
  });

  it("the switch throws: the tree goes back to release, the build is a release build, and no staging key is in it", async () => {
    const root = await checkout();
    const { runner, calls, built } = runnerFor(root, ["staging"]);
    const result = await buildSource({ runner, source: root, flavor: "staging" });
    expect(result.flavor).toBe("release");
    expect(calls).toEqual(["npm ci", `npx tsx ${CATALOG_FLAVOR_TOOL} staging`, `npx tsx ${CATALOG_FLAVOR_TOOL} release`, "npm run build"]);
    expect(built).toEqual([{ flavor: "release", keys: false }]);
    await result.restore();
    expect(calls.filter((call) => call.endsWith("release"))).toHaveLength(1);
  });

  it("the switch throws and so does the way back: nothing is built", async () => {
    const root = await checkout();
    const { runner, calls, built } = runnerFor(root, ["staging", "release"]);
    await expect(buildSource({ runner, source: root, flavor: "staging" })).rejects.toThrow(/release step failed/u);
    expect(calls).not.toContain("npm run build");
    expect(built).toEqual([]);
  });

  it("a build that fails after the switch puts the tree back to release before it throws", async () => {
    const root = await checkout();
    const { runner } = runnerFor(root, ["build"]);
    await expect(buildSource({ runner, source: root, flavor: "staging" })).rejects.toThrow(/build failed/u);
    expect(await flavorOf(root)).toBe("release");
    expect(await keysIn(root)).toBe(false);
  });

  it("with no flavor given the build is what it always was: npm ci, npm run build", async () => {
    const root = await checkout();
    const { runner, calls } = runnerFor(root);
    expect((await buildSource({ runner, source: root })).flavor).toBe("release");
    expect(calls).toEqual(["npm ci", "npm run build"]);
  });
});

describe("prepareDeployment passes the STS account of the upgrade's own client", () => {
  // prepareDeployment needs git tags, a bootstrapped parameter store, an edition record and a cdk synth before it reaches the build; those seams are covered by the cdk-engine and deploy tests. Here the wiring is read: the
  // flavor comes from the env and the account the upgrade's identity port returned (the same `caller` that is compared with the answers file), and cleanup puts the checkout back.
  it("is wired", async () => {
    const source = await readFile(new URL("../../packages/cli/src/deploy/commands.ts", import.meta.url), "utf8");
    expect(source).toContain("const caller = await identity.get();");
    expect(source).toContain("builtSource = await buildSource({ runner, source, flavor: catalogFlavorFor({ env: input.env, account: caller.account }) });");
    expect(source.indexOf("const caller = await identity.get();")).toBeLessThan(source.indexOf("catalogFlavorFor({ env: input.env"));
    expect(source).toContain("await builtSource?.restore()");
  });
});
