// The synthesis kit's stand-in for `aws-cdk-lib/aws-lambda-nodejs` (the kit is bundled with this module in its place).
//
// The real NodejsFunction runs esbuild over the function's SOURCE at synth time. A build made at approval has no source and no node_modules, and its Lambda code must be the signed
// release's code, byte for byte. So here a function takes its code from a map the release wrote into the kit: construct path -> id of a code package the release carries. The package
// is never built, only named: the template refers to it by the same asset parameters the release's own templates use, and the kit copies the signed zip to its output.
//
// No fallback: a function the map does not name stops the synth. Nothing here reads a source file or starts esbuild.
import { FileAssetPackaging, Stack } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import type { Construct } from "constructs";

const registry = new Map<string, string>();

/** Sets the map from function (its construct path, for example "AgentXControlPlane/Broker") to the id of its code package. Replaces any earlier map. */
export function registerPrebuiltCode(entries: ReadonlyArray<{ path: string; assetId: string }>): void {
  registry.clear();
  for (const entry of entries) {
    if (registry.has(entry.path)) throw new Error(`the code map names ${entry.path} twice`);
    registry.set(entry.path, entry.assetId);
  }
}

/** The code package of the function at `path`. A function the map does not name is an error, never a build from source. */
export function prebuiltAssetIdFor(path: string): string {
  const assetId = registry.get(path);
  if (assetId === undefined) throw new Error(`the synthesis kit carries no prebuilt code for the function ${path}; the release that made this kit did not know it, and a kit never builds code from source`);
  return assetId;
}

/** Code that is a package the release already holds: named by its id, with nothing on disk to read. The legacy synthesizer turns the id into the same asset parameters as a built asset. */
class PrebuiltCode extends lambda.Code {
  public readonly isInline = false;
  public constructor(private readonly assetId: string) {
    super();
  }
  public bind(scope: Construct): lambda.CodeConfig {
    const location = Stack.of(scope).synthesizer.addFileAsset({ fileName: `asset.${this.assetId}`, packaging: FileAssetPackaging.ZIP_DIRECTORY, sourceHash: this.assetId, deployTime: true });
    return { s3Location: { bucketName: location.bucketName, objectKey: location.objectKey } };
  }
}

/** The runtimes NodejsFunction needs no connection-reuse variable for (AWS SDK v3): Node 18 and later. An older one is refused, not approximated. */
const SUPPORTED_RUNTIME = /^nodejs(\d+)\.x$/;

const SOURCE_BUNDLER_ONLY = ["entry", "bundling", "projectRoot", "depsLockFilePath", "handler", "code"] as const;

export class NodejsFunction extends lambda.Function {
  public constructor(scope: Construct, id: string, props: NodejsFunctionProps = {}) {
    const { handler, code } = props;
    // The real class adds AWS_NODEJS_CONNECTION_REUSE_ENABLED when this is set; the stand-in would drop it and the two would differ silently, so a function that sets it is refused (no infrastructure sets it today).
    if (props.awsSdkConnectionReuse !== undefined) throw new Error(`the function ${id} sets awsSdkConnectionReuse; the synthesis kit's stand-in does not model it, so the kit and a build from source would differ`);
    // What only the source bundler uses is dropped; every other property is the function's own.
    const rest: Record<string, unknown> = { ...props };
    for (const key of SOURCE_BUNDLER_ONLY) delete rest[key];
    const runtime = props.runtime;
    const major = runtime === undefined ? undefined : SUPPORTED_RUNTIME.exec(runtime.name)?.[1];
    if (runtime === undefined || major === undefined || Number(major) < 18) throw new Error(`the function ${id} needs a Node.js runtime of 18 or later, given explicitly`);
    if (code !== undefined) {
      // Code the caller supplied is not bundled by the real class either.
      if (handler === undefined) throw new Error(`the function ${id} gives code and no handler`);
      super(scope, id, { ...(rest as lambda.FunctionOptions), runtime, code, handler });
      return;
    }
    const path = scope.node.path === "" ? id : `${scope.node.path}/${id}`;
    const wanted = handler ?? "handler";
    super(scope, id, { ...(rest as lambda.FunctionOptions), runtime, code: new PrebuiltCode(prebuiltAssetIdFor(path)), handler: wanted.includes(".") ? wanted : `index.${wanted}` });
  }
}
