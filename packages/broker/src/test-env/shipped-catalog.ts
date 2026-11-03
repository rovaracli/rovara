// Test services, slice 1 wiring: the signed service image catalog this release ships, as the broker reads it. `releaseServiceCatalogSource` is the one place the broker's dependency wiring asks for it; with the switch
// `tx` off it returns nothing and reads nothing, so today's flow is untouched.
//
// The keys are the CONTRACT's (catalog-trust.ts): compiled in, two lists that are empty until the owner names the keys, and the staging-only one counts only in the staging account on a staging build. The account comes from this
// Lambda's own ARN (lambda-identity.ts), never from a setting. With empty lists no catalog verifies, no dependency can be pinned, and every run with dependencies is refused in fixed words (fail closed).
// The release puts `catalog.json` and `catalog.sig.json` beside the broker's code (the Lambda asset's `service-catalog/` folder). A missing file is a refusal, not a crash.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CATALOG_FILE, CATALOG_SIGNATURE_FILE } from "@agentx/contracts";
import { serviceCatalogSourceOf, type ServiceCatalogSource } from "./dependency-plan.js";
import { lambdaAccountId } from "./lambda-identity.js";
import { testServicesEnabled } from "./test-services-switch.js";

export const SHIPPED_CATALOG_FOLDER = "service-catalog";

/** The directory of the shipped catalog: beside the broker's code in a Lambda, or the working directory in a test. */
export const shippedCatalogDirectory = (env: NodeJS.ProcessEnv = process.env): string => join(env["LAMBDA_TASK_ROOT"] ?? process.cwd(), SHIPPED_CATALOG_FOLDER);

/** The signed catalog the release ships, or undefined while `tx` is off. Reads the two files once, on first use. `testOnlyTrustedKeys` is a test seam (see `serviceCatalogSourceOf`). */
export function releaseServiceCatalogSource(env: NodeJS.ProcessEnv = process.env, testOnlyTrustedKeys?: readonly string[]): ServiceCatalogSource | undefined {
  if (!testServicesEnabled(env)) return undefined;
  const directory = shippedCatalogDirectory(env);
  return serviceCatalogSourceOf({
    read: async () => ({ catalogBytes: await readFile(join(directory, CATALOG_FILE)), signatureBytes: await readFile(join(directory, CATALOG_SIGNATURE_FILE)) }),
    trust: () => ({ runningAccountId: lambdaAccountId() }),
    onRefused: (reason) => console.log(JSON.stringify({ component: "broker", event: "test_services.catalog_refused", reason })),
    ...(testOnlyTrustedKeys === undefined ? {} : { testOnlyTrustedKeys }),
  });
}
