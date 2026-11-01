// A tiny synthesis kit for tests: a real Node module, run by the real runner, that builds the same shape of output the release's kit does. Its templates depend on the
// context it is given (so a different setting is a different hash) and on nothing else (so the same inputs are the same hash).
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SynthKitManifestSchema } from "@agentx/contracts";

/** The asset id and bytes of the one package the test release signs (tests/support/bundle-fixture.ts writes the same). */
export const FAKE_ASSET = createHash("sha256").update("asset").digest("hex");
export const FAKE_PACKAGE_BYTES = "zip-bytes";
/** A second signed package, present only when the release is made with `extraPackage`. */
export const SECOND_ASSET = createHash("sha256").update("second").digest("hex");
export const SECOND_PACKAGE_BYTES = "second";
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
  /** Write every template with its keys in the opposite order (the formatting a kit chose must not change the hash). */
  reverseKeys?: boolean;
  /** A second package, declared before the first (the order a kit listed them in must not change the hash). */
  twoPackages?: boolean;
  /** Write the control-plane template as something that is not a template. */
  badTemplate?: "array" | "no-resources";
  /** Extra fields written into kit.json (a kit must not be able to bring settings of its own). */
  kitJsonExtra?: Record<string, unknown>;
  /** Try to reach a TCP port on localhost, a Unix socket, the instance metadata address and a name server, and record what happened in the foundation template. */
  probe?: { tcpPort: number; unixSocket: string };
  /** Print this many bytes before doing anything else. */
  printBytes?: number;
  /** Never finish. */
  hang?: boolean;
  /** Write package bytes other than the signed release's for the same asset id. */
  otherPackageBytes?: boolean;
  /** Declare a package the signed release does not list. */
  unsignedPackage?: boolean;
  nodeMajor?: number;
}

export async function writeFakeKit(dir: string, options: FakeKitOptions = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  const manifest = SynthKitManifestSchema.parse({ schemaVersion: 1, format: "rovara-synth-kit", entry: "synth-kit/synth.mjs", nodeMajor: options.nodeMajor ?? Number(process.versions.node.split(".")[0]) });
  await writeFile(join(dir, "kit.json"), `${JSON.stringify({ ...manifest, ...(options.kitJsonExtra ?? {}) })}\n`);
  const source = `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const [contextFile, out] = process.argv.slice(2);
${options.fail === true ? 'process.exit(3);' : ""}
${options.printBytes === undefined ? "" : `process.stdout.write("x".repeat(${String(options.printBytes)}));`}
${options.hang === true ? "await new Promise(() => setInterval(() => undefined, 1000));" : ""}
const { context } = JSON.parse(readFileSync(contextFile, "utf8"));
const probe = {};
${options.probe === undefined ? "" : `
import net from "node:net";
import dns from "node:dns/promises";
const attempt = (opts) => new Promise((resolve) => { const s = net.connect(opts); const t = setTimeout(() => { s.destroy(); resolve("blocked"); }, 2500); s.on("connect", () => { clearTimeout(t); s.destroy(); resolve("connected"); }); s.on("error", () => { clearTimeout(t); resolve("blocked"); }); });
probe.tcp = await attempt({ host: "127.0.0.1", port: ${String(options.probe.tcpPort)} });
probe.unix = await attempt({ path: ${JSON.stringify(options.probe.unixSocket)} });
probe.imds = await attempt({ host: "169.254.169.254", port: 80 });
probe.fetch = await fetch("http://127.0.0.1:${String(options.probe.tcpPort)}/").then(() => "connected", () => "blocked");
probe.dns = await Promise.race([dns.lookup("example.com").then(() => "resolved", () => "blocked"), new Promise((r) => setTimeout(() => r("blocked"), 2500))]);
`}
const env = context.agentxEnv;
const asset = ${JSON.stringify(FAKE_ASSET)};
mkdirSync(out + "/templates", { recursive: true });
mkdirSync(out + "/packages", { recursive: true });
const metadata = ${options.recordInputs === true ? '{ Inputs: { context, environment: Object.keys(process.env).sort(), pwd: process.env.PWD ?? null, cwd: process.cwd() } }' : "{}"};
let outside = "";
${options.readOutside === undefined ? "" : `try { readFileSync(${JSON.stringify(options.readOutside)}); outside = "read"; } catch { outside = "blocked"; }`}
const base = (part) => ({ Description: ${options.placeholder === true ? '"built for qqenv-placeholderqq"' : "env + \" \" + part"}, Resources: { Marker: { Type: "AWS::SSM::Parameter", Properties: { Name: "/" + env + "/" + part, Type: "String", Value: JSON.stringify({ edition: context.rovaraEdition, cidrs: context.rovaraEnterpriseEgressCidrs ?? null, tsa: context.agentxAuditTsa ?? null }) } } } });
for (const part of ["access", "foundation", "identity", "runtime", "control-plane", "slack"]) {
  if (part === "identity" && context.agentxIdentity === "oidc") continue;
  const template = base(part);
  if (part === "foundation") template.Metadata = { ...metadata, Outside: outside, Probe: probe };
  if (part === "control-plane") {
    template.Parameters = ${options.omitParameters === true ? "{}" : '{ ["AssetParameters" + asset + "S3Bucket"]: { Type: "String" }, ["AssetParameters" + asset + "S3VersionKey"]: { Type: "String" }, ["AssetParameters" + asset + "ArtifactHash"]: { Type: "String" } }'};
    ${options.unknownAsset === true ? 'template.Parameters.AssetParameters0000S3Bucket = { Type: "String" };' : ""}
    ${options.extraResource === undefined ? "" : `template.Resources.Extra = { Type: ${JSON.stringify(options.extraResource)}, Properties: {} };`}
    ${options.leakPath === true ? "template.Description = out;" : ""}
  }
  ${options.twoPackages === true ? 'if (part === "control-plane") { for (const suffix of ["S3Bucket", "S3VersionKey", "ArtifactHash"]) template.Parameters["AssetParametersZ" + suffix] = { Type: "String" }; }' : ""}
  const reverse = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverse(v)])) : value);
  ${options.badTemplate === undefined ? "" : `if (part === "control-plane") { writeFileSync(out + "/templates/" + part + ".template.json", ${options.badTemplate === "array" ? '"[]"' : '"{\\"Parameters\\":{}}"'}); continue; }`}
  writeFileSync(out + "/templates/" + part + ".template.json", JSON.stringify(${options.reverseKeys === true ? "reverse(template)" : "template"}));
}
writeFileSync(out + "/packages/" + asset + ".zip", Buffer.from(${options.otherPackageBytes === true ? '"tampered-" + env' : JSON.stringify(FAKE_PACKAGE_BYTES)}));
${options.twoPackages === true ? `writeFileSync(out + "/packages/${SECOND_ASSET}.zip", Buffer.from(${options.unsignedPackage === true ? '"unsigned"' : JSON.stringify(SECOND_PACKAGE_BYTES)}));` : ""}
writeFileSync(out + "/kit-output.json", JSON.stringify({ schemaVersion: 1, packages: [${options.twoPackages === true ? `{ assetId: "${SECOND_ASSET}", parts: ["control-plane"], bucketParameter: "AssetParametersZS3Bucket", keyParameter: "AssetParametersZS3VersionKey", hashParameter: "AssetParametersZArtifactHash" }, ` : ""}{ assetId: asset, parts: ["control-plane"], bucketParameter: "AssetParameters" + asset + "S3Bucket", keyParameter: "AssetParameters" + asset + "S3VersionKey", hashParameter: "AssetParameters" + asset + "ArtifactHash" }] }));
${options.strayFile === undefined ? "" : `writeFileSync(out + "/" + ${JSON.stringify(options.strayFile)}, "x");`}
`;
  await writeFile(join(dir, "synth.mjs"), source);
}
