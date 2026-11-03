// Test services slice 1: a worker image enters a release by digest, built by Docker from whatever tree was checked out, so the tree check of scripts/release/build.ts does not cover it. The worker Dockerfile labels every image with
// the flavor it was built with (CATALOG_FLAVOR build argument, default release), and every path that takes a worker image into a release, a bundle or a production deploy refuses any image whose label is not "release":
//   scripts/release/build.ts (--worker-image), scripts/release/bundle.ts (the worker image), scripts/release-production.ts (--worker-image, a reused deployed image, a freshly built one).
// An unlabelled image (built before this) is refused too: only an image that says release is accepted.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const CATALOG_FLAVOR_LABEL = "ai.rovara.catalog-flavor";
/** The labels of the image at `reference` (a digest reference). */
export type ImageLabelReader = (reference: string) => Promise<Readonly<Record<string, string>>>;

/** Throws unless the image carries `ai.rovara.catalog-flavor=release`. The sentence names the image and what it carries, never its labels. */
export async function assertReleaseFlavorImage(name: string, reference: string, readLabels: ImageLabelReader): Promise<void> {
  let flavor: string | undefined;
  try {
    flavor = (await readLabels(reference))[CATALOG_FLAVOR_LABEL];
  } catch {
    throw new Error(`the ${name} image ${reference} could not be inspected, so its catalog flavor is unknown; a release takes only an image labelled ${CATALOG_FLAVOR_LABEL}=release`);
  }
  if (flavor !== "release") {
    throw new Error(`the ${name} image ${reference} is not a release-flavor image (${CATALOG_FLAVOR_LABEL}=${flavor === undefined ? "missing" : JSON.stringify(flavor).slice(0, 40)}); rebuild it without CATALOG_FLAVOR=staging`);
  }
}

const execFileAsync = promisify(execFile);
/** Reads the labels with skopeo (linux/arm64, the platform of the workers), using the operator's registry login. */
export const skopeoLabelReader: ImageLabelReader = async (reference) => {
  const { stdout } = await execFileAsync("skopeo", ["inspect", "--config", "--override-os", "linux", "--override-arch", "arm64", `docker://${reference}`], { maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
  const labels = (JSON.parse(stdout) as { config?: { Labels?: Record<string, unknown> | null } }).config?.Labels ?? {};
  return Object.fromEntries(Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
};
