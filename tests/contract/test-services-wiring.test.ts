// Test services, slice 1 wiring: the broker's signed service image catalog reaches the places that pin dependencies (the task plan, the setup draft's proposal), only with the switch `tx` on. With it off the dependencies the
// broker is built with are exactly what they were (golden).
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CATALOG_FILE, CATALOG_SIGNATURE_FILE, CATALOG_SIGNATURE_ALGORITHM, catalogSigningMessage, parseBundlePublicKey, sha256HexOf } from "@agentx/contracts";
import { brokerDependencies } from "../../packages/broker/src/aws/broker/dependency-wiring.js";
import { SHIPPED_CATALOG_FOLDER, catalogSigningPublicKeys, releaseServiceCatalogSource, shippedCatalogDirectory } from "../../packages/broker/src/test-env/shipped-catalog.js";
import { pinnedCatalog, testSigner } from "../support/catalog-pinning.js";
import { setupWizardBench } from "../support/setup-wizard-testenv.js";

const roots: string[] = [];
afterEach(async () => { delete process.env.TEST_SERVICES_ENABLED; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function shipped() {
  const root = await mkdtemp(join(tmpdir(), "rovara-catalog-"));
  roots.push(root);
  await mkdir(join(root, SHIPPED_CATALOG_FOLDER));
  const signer = testSigner();
  const catalogBytes = Buffer.from(`${JSON.stringify(pinnedCatalog(), null, 2)}\n`, "utf8");
  const signature = { schemaVersion: 1, algorithm: CATALOG_SIGNATURE_ALGORITHM, keyId: parseBundlePublicKey(signer.publicKeyPem).keyId, catalogSha256: sha256HexOf(catalogBytes), signature: (await signer.sign(catalogSigningMessage(catalogBytes))).toString("base64") };
  await writeFile(join(root, SHIPPED_CATALOG_FOLDER, CATALOG_FILE), catalogBytes);
  await writeFile(join(root, SHIPPED_CATALOG_FOLDER, CATALOG_SIGNATURE_FILE), JSON.stringify(signature));
  return { root, signer };
}

describe("the release's catalog source", () => {
  it("is nothing while tx is off, and reads nothing", () => {
    expect(releaseServiceCatalogSource({})).toBeUndefined();
    expect(releaseServiceCatalogSource({ TEST_SERVICES_ENABLED: "true" })).toBeUndefined();
  });

  it("loads the shipped, signed catalog with tx on and the release's key", async () => {
    const { root, signer } = await shipped();
    const source = releaseServiceCatalogSource({ TEST_SERVICES_ENABLED: "1", LAMBDA_TASK_ROOT: root }, () => [signer.publicKeyPem]);
    expect((await source!())?.pinned).toBe(true);
  });

  it("is nothing for a catalog the release's key did not sign, with no key, or with no files (fail closed)", async () => {
    const { root, signer } = await shipped();
    const env = { TEST_SERVICES_ENABLED: "1", LAMBDA_TASK_ROOT: root };
    expect(await releaseServiceCatalogSource(env, () => [testSigner().publicKeyPem])!()).toBeUndefined();
    expect(await releaseServiceCatalogSource(env, () => [])!()).toBeUndefined();
    expect(await releaseServiceCatalogSource({ ...env, LAMBDA_TASK_ROOT: join(root, "nowhere") }, () => [signer.publicKeyPem])!()).toBeUndefined();
  });

  it("has no key until the release lane plugs it into catalogSigningPublicKeys", () => {
    expect(catalogSigningPublicKeys()).toEqual([]);
    expect(shippedCatalogDirectory({ LAMBDA_TASK_ROOT: "/var/task" })).toBe("/var/task/service-catalog");
  });
});

describe("the dependencies the broker is built with", () => {
  it("has no catalog with tx off (golden), a catalog source with tx on, and keeps one a test supplies", async () => {
    const t = await setupWizardBench();
    const off = brokerDependencies(t.brokerInput as never);
    expect("serviceCatalog" in off).toBe(false);
    process.env.TEST_SERVICES_ENABLED = "1";
    const on = brokerDependencies(t.brokerInput as never);
    expect(typeof on.serviceCatalog).toBe("function");
    const supplied = async () => undefined;
    expect(brokerDependencies({ ...(t.brokerInput as object), serviceCatalog: supplied } as never).serviceCatalog).toBe(supplied);
  });
});

describe("the one-line hunks in the hot files", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  it("the task plan gets the catalog, and the route dependencies carry it", () => {
    expect(read("packages/broker/src/aws/broker/task-operations.ts")).toContain("now: Date.now, serviceCatalog: dependencies.serviceCatalog }");
    expect(read("packages/broker/src/aws/broker/handler.ts")).toContain("{ serviceCatalog: dependencies.serviceCatalog }");
    expect(read("packages/broker/src/aws/broker/dependency-wiring.ts")).toContain("rest.serviceCatalog ?? releaseServiceCatalogSource()");
  });
});
