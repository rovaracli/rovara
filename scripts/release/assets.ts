// The pure bookkeeping of a stack's code assets, shared by the release builder and the synthesis kit (which must not import the builder: that has a command line of its own).
import type { AssetMetadataEntry } from "@aws-cdk/cloud-assembly-schema";

export interface PackageAccumulator {
  assetId: string;
  directory: string;
  parts: string[];
  bucketParameter: string;
  keyParameter: string;
  hashParameter: string;
}

/** The shape of a CDK FileAssetMetadataEntry/ContainerImageAssetMetadataEntry this function needs. */
export interface ReleaseAssetLike {
  packaging: string;
  id: string;
  s3BucketParameter: string;
  s3KeyParameter: string;
  artifactHashParameter: string;
}

/**
 * Folds one stack's asset into the running per-assetId accumulator (mutates `packagesById`). Only
 * zip-packaged Lambda code assets are supported; anything else (a Docker image asset, or a plain
 * "file"-packaged asset) is an error naming it, because images are published separately and this
 * release has no other asset kind today. The legacy synthesizer names a parameter from the asset id
 * alone, so the same asset id must produce the same parameter names in every stack that uses it;
 * that is checked here rather than assumed.
 */
export function accumulateAsset(
  packagesById: Map<string, PackageAccumulator>,
  asset: ReleaseAssetLike | AssetMetadataEntry,
  part: string,
  directory: string,
): void {
  if (asset.packaging !== "zip") {
    throw new Error(
      `unsupported asset packaging ${JSON.stringify(asset.packaging)} for asset ${asset.id} in the ${part} template; only zip-packaged Lambda code assets are supported here, images are published separately`,
    );
  }
  const existing = packagesById.get(asset.id);
  if (existing === undefined) {
    packagesById.set(asset.id, {
      assetId: asset.id,
      directory,
      parts: [part],
      bucketParameter: asset.s3BucketParameter,
      keyParameter: asset.s3KeyParameter,
      hashParameter: asset.artifactHashParameter,
    });
  } else if (
    existing.bucketParameter !== asset.s3BucketParameter ||
    existing.keyParameter !== asset.s3KeyParameter ||
    existing.hashParameter !== asset.artifactHashParameter
  ) {
    throw new Error(`asset ${asset.id} has different parameter names across stacks, which the legacy synthesizer should never produce`);
  } else {
    existing.parts.push(part);
  }
}

/**
 * Code packages are shared across regions: an asset's id is a hash of its content, and Lambda code
 * doesn't depend on region, so every region's synth is expected to accumulate the very same set of
 * asset ids, each with the same parameter names. Returns true when `candidate` (a later region)
 * disagrees with `baseline` (the first region synthesized) in either respect.
 */
export function assetSignatureMismatch(
  baseline: ReadonlyMap<string, PackageAccumulator>,
  candidate: ReadonlyMap<string, PackageAccumulator>,
): boolean {
  if (baseline.size !== candidate.size) return true;
  for (const [assetId, expected] of baseline) {
    const actual = candidate.get(assetId);
    if (
      actual === undefined ||
      actual.bucketParameter !== expected.bucketParameter ||
      actual.keyParameter !== expected.keyParameter ||
      actual.hashParameter !== expected.hashParameter
    ) {
      return true;
    }
  }
  return false;
}
