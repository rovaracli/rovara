// Test services, slice 1 wiring: the signed service image catalog this release ships, as the broker reads it. `releaseServiceCatalogSource` is the one place the broker's dependency wiring asks for it; with the switch
// `tx` off it returns nothing and reads nothing, so today's flow is untouched.
//
// Two things here are plug-in points for the release lane (s1-infra-catalog):
//   - `catalogSigningPublicKeys()`: the catalog-signing PUBLIC key(s) that ship with the release (PEM). It returns none until the key is committed; with none, no catalog verifies, no dependency can be pinned, and every run
//     with dependencies is refused in fixed words (fail closed). Put the key in this one function.
//   - `SHIPPED_CATALOG_DIRECTORY`: where the release puts `catalog.json` and `catalog.sig.json` beside the broker's code (the Lambda asset's `service-catalog/` folder). A missing file is a refusal, not a crash.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CATALOG_FILE, CATALOG_SIGNATURE_FILE } from "@agentx/contracts";
import { serviceCatalogSourceOf, type ServiceCatalogSource } from "./dependency-plan.js";
import { testServicesEnabled } from "./test-services-switch.js";

export const SHIPPED_CATALOG_FOLDER = "service-catalog";

/** The directory of the shipped catalog: beside the broker's code in a Lambda, or the working directory in a test. */
export const shippedCatalogDirectory = (env: NodeJS.ProcessEnv = process.env): string => join(env["LAMBDA_TASK_ROOT"] ?? process.cwd(), SHIPPED_CATALOG_FOLDER);

/** The catalog-signing public keys (PEM) this release trusts. PLUG-IN POINT: none until the release lane commits the key. */
export function catalogSigningPublicKeys(): readonly string[] {
  return [];
}

/** The signed catalog the release ships, or undefined while `tx` is off. Reads the two files once, on first use. */
export function releaseServiceCatalogSource(env: NodeJS.ProcessEnv = process.env, keys: () => readonly string[] = catalogSigningPublicKeys): ServiceCatalogSource | undefined {
  if (!testServicesEnabled(env)) return undefined;
  const directory = shippedCatalogDirectory(env);
  return serviceCatalogSourceOf({
    read: async () => ({ catalogBytes: await readFile(join(directory, CATALOG_FILE)), signatureBytes: await readFile(join(directory, CATALOG_SIGNATURE_FILE)) }),
    trustedKeys: keys(),
  });
}
