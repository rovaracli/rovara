// A tiny synthesis kit for tests: a real Node module, run by the real runner, that builds the same shape of output the release's kit does. Its templates depend on the
// context it is given (so a different setting is a different hash) and on nothing else (so the same inputs are the same hash).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SynthKitManifestSchema } from "@agentx/contracts";

export const FAKE_ASSET = "abcdef0123456789";
export interface FakeKitOptions {
  /** Appended to the control-plane template, to build a kit that differs (e.g. a malicious one). */
  extraResource?: string;
  /** Write these extra files into the output directory. */
  strayFile?: string;
  /** Leave the placeholder name in a template. */
  placeholder?: boolean;
  /** Put the kit's environment variable names and the context it saw into the foundation template. */
  recordInputs?: boolean;
  /** Try to read this path (outside the kit) and record the outcome. */
  readOutside?: string;
  /** Exit with an error. */
  fail?: boolean;
  /** Leak the output directory's path into the control-plane template (a kit that is not deterministic). */
  leakPath?: boolean;
  /** Declare no asset parameters in the control-plane template, though the kit declares a package for it. */
  omitParameters?: boolean;
  /** Ask for code (an asset parameter) that no package holds. */
  unknownAsset?: boolean;
  nodeMajor?: number;
}

export async function writeFakeKit(dir: string, options: FakeKitOptions = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  const manifest = SynthKitManifestSchema.parse({ schemaVersion: 1, format: "rovara-synth-kit", entry: "synth-kit/synth.mjs", nodeMajor: options.nodeMajor ?? Number(process.versions.node.split(".")[0]) });
  await writeFile(join(dir, "kit.json"), `${JSON.stringify(manifest)}\n`);
  const source = `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const [contextFile, out] = process.argv.slice(2);
${options.fail === true ? 'process.exit(3);' : ""}
const { context } = JSON.parse(readFileSync(contextFile, "utf8"));
const env = context.agentxEnv;
const asset = ${JSON.stringify(FAKE_ASSET)};
mkdirSync(out + "/templates", { recursive: true });
mkdirSync(out + "/packages", { recursive: true });
const metadata = ${options.recordInputs === true ? '{ Inputs: { context, environment: Object.keys(process.env).sort() } }' : "{}"};
let outside = "";
${options.readOutside === undefined ? "" : `try { readFileSync(${JSON.stringify(options.readOutside)}); outside = "read"; } catch { outside = "blocked"; }`}
const base = (part) => ({ Description: ${options.placeholder === true ? '"built for qqenv-placeholderqq"' : "env + \" \" + part"}, Resources: { Marker: { Type: "AWS::SSM::Parameter", Properties: { Name: "/" + env + "/" + part, Type: "String", Value: JSON.stringify({ edition: context.rovaraEdition, cidrs: context.rovaraEnterpriseEgressCidrs ?? null, tsa: context.agentxAuditTsa ?? null }) } } } });
for (const part of ["access", "foundation", "identity", "runtime", "control-plane", "slack"]) {
  if (part === "identity" && context.agentxIdentity === "oidc") continue;
  const template = base(part);
  if (part === "foundation") template.Metadata = { ...metadata, Outside: outside };
  if (part === "control-plane") {
    template.Parameters = ${options.omitParameters === true ? "{}" : '{ ["AssetParameters" + asset + "S3Bucket"]: { Type: "String" }, ["AssetParameters" + asset + "S3VersionKey"]: { Type: "String" }, ["AssetParameters" + asset + "ArtifactHash"]: { Type: "String" } }'};
    ${options.unknownAsset === true ? 'template.Parameters.AssetParameters0000S3Bucket = { Type: "String" };' : ""}
    ${options.extraResource === undefined ? "" : `template.Resources.Extra = { Type: ${JSON.stringify(options.extraResource)}, Properties: {} };`}
    ${options.leakPath === true ? "template.Description = out;" : ""}
  }
  writeFileSync(out + "/templates/" + part + ".template.json", JSON.stringify(template));
}
writeFileSync(out + "/packages/" + asset + ".zip", Buffer.from("zip-for-" + env));
writeFileSync(out + "/kit-output.json", JSON.stringify({ schemaVersion: 1, packages: [{ assetId: asset, parts: ["control-plane"], bucketParameter: "AssetParameters" + asset + "S3Bucket", keyParameter: "AssetParameters" + asset + "S3VersionKey", hashParameter: "AssetParameters" + asset + "ArtifactHash" }] }));
${options.strayFile === undefined ? "" : `writeFileSync(out + "/" + ${JSON.stringify(options.strayFile)}, "x");`}
`;
  await writeFile(join(dir, "synth.mjs"), source);
}
