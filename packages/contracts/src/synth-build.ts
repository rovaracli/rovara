// Enterprise upgrades are built AT APPROVAL (owner decision, 2026-10-31, option A).
//
// When the customer approves a signed release bundle, `bundle approve` runs the release's own pinned CDK app (the "synthesis kit" the signed bundle carries) with the
// install's OWN settings, which the customer's administrators recorded in the install (`/agentx/<env>/synth-settings`). It never reads a setting from the bundle, the
// command line or the Rovara operator. What the kit produced is written to `approved/<id>/built/`, and the approval record pins the hash of the result and the
// hash of every setting it was built from. The deployer installs only those bytes and checks them again; nothing is built when the install runs.
import { z } from "zod";
import { BundlePath, sha256OfBytes } from "./bundle.js";
import { canonicalJson } from "./canonical-json.js";
import { environmentSettingsPrefix } from "./environments.js";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** The recorded settings an Enterprise install is built from. Written by the customer's administrators only (the operator role has no Parameter Store access). */
export const synthSettingsParameter = (env: string): string => `${environmentSettingsPrefix(env)}synth-settings`;
/** The edition record the foundation stack keeps (`/agentx/<env>/edition`); the deployer reads it to tell an Enterprise install from any other. */
export const editionRecordParameter = (env: string): string => `${environmentSettingsPrefix(env)}edition`;
/** The backup of that record, written before the record is taken out of the way during a deploy; while it exists it counts as the record. */
export const editionBackupParameter = (env: string): string => `${environmentSettingsPrefix(env)}edition-backup`;

/**
 * The CDK context an install may be built with, and nothing else. Every other key is refused: a bundle, a command line and an operator cannot add one. The edition, the environment,
 * the region, the identity mode and the synthesizer are not here on purpose: they come from the install itself (see `fixedSynthContext`). Values are text: a switch is "true" or "false".
 */
export const SYNTH_CONTEXT_KEYS = [
  "rovaraEnterpriseEgressCidrs",
  "rovaraEnterpriseInternetEgress",
  "rovaraEnterpriseAllowPublicRanges",
  "agentxEgressAllowDomains",
  "agentxAuditTsa",
  "agentxAuditTsaUrls",
  "agentxAuditTsaRootsParameter",
  "agentxAuditLockMode",
  "agentxAuditRetentionDays",
  "agentxAuditReplicaLockConfirmed",
  "agentxAuditReplicaBucketArn",
  "rovaraOperatorAccess",
  "rovaraOperatorPrincipalArn",
  "rovaraOperatorExternalId",
  "rovaraOperatorLogGroups",
  "rovaraBundleSigningKeys",
  "rovaraBundleApproverArns",
  "rovaraPrivateMcpCidrs",
  "rovaraMcpHostCertificateArn",
  "rovaraMcpHostName",
  "rovaraMcpHostedZoneId",
  "agentxReservedConcurrency",
  "agentxRovaraOrgId",
  "evidenceRetentionDays",
] as const;
export type SynthContextKey = (typeof SYNTH_CONTEXT_KEYS)[number];
/** The context every build takes from the install itself, never from the recorded settings (see `fixedSynthContext`). */
export const SYNTH_FIXED_KEYS = ["agentxEnv", "agentxRegion", "agentxSynthesizer", "rovaraEdition", "agentxIdentity"] as const;
/**
 * Context keys the infrastructure code reads that a build made at approval deliberately does not take, each with the reason. A test scans `infra/` for every context key it reads and fails
 * unless the key is in `SYNTH_CONTEXT_KEYS`, `SYNTH_FIXED_KEYS` or here, so a key added to the infrastructure later cannot be left out of the build unnoticed (review I1).
 */
export const SYNTH_EXCLUDED_KEYS: Readonly<Record<string, string>> = {
  rovaraNewInstall: "set only by `init` for a new install; an install being upgraded is not new",
  agentxCloud: "the hosted Rovara cloud; an Enterprise install is refused inside it",
  agentxDeploymentMode: "only ec2-ebs is accepted; there is nothing to choose",
  rovaraStdioMcpServers: "package-run MCP servers are switched off (owner decision 2026-10-31); asking for them stops the synth",
  agentxInstaller: "the Launch in AWS installer stack, which no release deploys",
  agentxEval: "the SWE-bench eval stack, which no release deploys",
  agentxWebAssetHosting: "a build always uses the bootstrap-free synthesizer, which forces the web assets onto the cell; cloudfront is refused with it",
  "agentx:autoRequalify": "Rovara's own scheduled runtime requalification, not an install setting",
  "agentx:autoRequalifyHourUtc": "Rovara's own scheduled runtime requalification, not an install setting",
  "agentx:autoRequalifySchedule": "Rovara's own scheduled runtime requalification, not an install setting",
  "agentx:e2eQualificationTransport": "Rovara's own qualification transport, not an install setting",
};

/** Settings whose value is never written to the approval record, the summary or a log: only its hash is. */
export const SYNTH_SENSITIVE_KEYS: readonly SynthContextKey[] = ["rovaraOperatorExternalId"];

/**
 * A setting holds no character a terminal could act on or that could make the text read as something else: C0 and C1 controls (U+009B is a CSI), line and paragraph separators, and the
 * bidirectional marks and overrides (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069).
 */
const hasUnsafeCharacter = (value: string): boolean => [...value].some((char) => {
  const code = char.charCodeAt(0);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || code === 0x061c || code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
});
const ContextValue = z.string().max(8_192).refine((value) => !hasUnsafeCharacter(value), "a setting holds no control or direction-changing character");
const contextShape = Object.fromEntries(SYNTH_CONTEXT_KEYS.map((key) => [key, ContextValue.optional()])) as Record<SynthContextKey, z.ZodOptional<typeof ContextValue>>;

export const SynthSettingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    edition: z.literal("enterprise"),
    env: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
    region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/),
    identityMode: z.enum(["cognito", "oidc"]),
    context: z.object(contextShape).strict(),
  })
  .strict();
export type SynthSettings = z.infer<typeof SynthSettingsSchema>;

/** The hash a build and an approval pin for a set of settings: canonical text, so the order the administrator wrote the keys in does not matter. */
export const synthSettingsSha256 = (settings: SynthSettings): string => sha256OfBytes(Buffer.from(canonicalJson(settings), "utf8"));

/** The settings as an approval record and a summary show them: a sensitive value is replaced by its hash. */
export function redactedSynthSettings(settings: SynthSettings): { edition: "enterprise"; env: string; region: string; identityMode: "cognito" | "oidc"; context: Record<string, string> } {
  const context: Record<string, string> = {};
  for (const key of SYNTH_CONTEXT_KEYS) {
    const value = settings.context[key];
    if (value === undefined) continue;
    context[key] = SYNTH_SENSITIVE_KEYS.includes(key) ? `sha256:${sha256OfBytes(Buffer.from(value, "utf8"))}` : value;
  }
  return { edition: settings.edition, env: settings.env, region: settings.region, identityMode: settings.identityMode, context };
}

/** The context every build gets from the install itself, never from the settings record's `context`, a bundle or a person. */
export function fixedSynthContext(settings: SynthSettings): Record<string, string> {
  return {
    agentxEnv: settings.env,
    agentxRegion: settings.region,
    // The deployer hands CloudFormation templates with the code locations as parameters, as the release's own templates have: no CDK bootstrap in the customer's account.
    agentxSynthesizer: "legacy",
    rovaraEdition: settings.edition,
    ...(settings.identityMode === "oidc" ? { agentxIdentity: "oidc" } : {}),
  };
}
/** The whole context a kit gets: the install's fixed values and its recorded settings. */
export function synthContext(settings: SynthSettings): Record<string, string> {
  const recorded: Record<string, string> = {};
  for (const key of SYNTH_CONTEXT_KEYS) {
    const value = settings.context[key];
    if (value !== undefined) recorded[key] = value;
  }
  return { ...recorded, ...fixedSynthContext(settings) };
}

// ---- the kit -------------------------------------------------------------------------------------------------------------------

export const SYNTH_KIT_MANIFEST_FILE = "synth-kit/kit.json";
/**
 * synth-kit/kit.json: the release's own pinned CDK app. `entry` is a Node ES module in the kit, run as `node <entry> <context.json> <out dir>`; it reads the context file (the
 * whole of its input), builds the app with it and writes the output tree described by `SynthOutputSchema`. It carries everything it needs: it is run inside an operating system
 * sandbox that denies the network and every socket (macOS sandbox-exec, Linux bubblewrap; where neither exists it is not run at all), with no credentials and a scrubbed environment, and a
 * kit that cannot build without something outside the signed bundle fails.
 */
export const SynthKitManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    format: z.literal("rovara-synth-kit"),
    entry: BundlePath,
    /** The Node major version the kit was built for; the runner refuses another. */
    nodeMajor: z.number().int().min(18).max(99),
    /** SHA-256 of the release.json this kit was made from, and that release's git commit: the kit is bound to ONE release (a bundle of another release refuses it, and so does approval). */
    releaseSha256: Sha256,
    gitCommit: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .strict()
  .superRefine((kit, context) => {
    if (!kit.entry.startsWith("synth-kit/") || !kit.entry.endsWith(".mjs")) context.addIssue({ code: "custom", message: "the kit's entry is a .mjs file under synth-kit/", path: ["entry"] });
  });
export type SynthKitManifest = z.infer<typeof SynthKitManifestSchema>;

/** The stack parts a build produces: the deployable ones and the access stack (compared with the deployed one, never deployed here). */
export const BUILT_PARTS = ["access", "foundation", "identity", "runtime", "control-plane", "slack"] as const;
export type BuiltPart = (typeof BUILT_PARTS)[number];

/** What a kit writes into its output directory besides the files themselves: `kit-output.json`. */
export const SYNTH_OUTPUT_FILE = "kit-output.json";
export const SynthOutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    packages: z
      .array(
        z.object({
          assetId: z.string().regex(/^[A-Za-z0-9]{8,128}$/),
          parts: z.array(z.enum(BUILT_PARTS)).min(1),
          bucketParameter: z.string().regex(/^[A-Za-z0-9]{1,255}$/),
          keyParameter: z.string().regex(/^[A-Za-z0-9]{1,255}$/),
          hashParameter: z.string().regex(/^[A-Za-z0-9]{1,255}$/),
        }).strict(),
      )
      .max(200),
  })
  .strict();
export type SynthOutput = z.infer<typeof SynthOutputSchema>;

/** The hash of the kit: the bundle's own (signed) entries for it, so a deployer holding only the signed manifest computes the same value the build recorded. */
export function synthKitSha256(files: ReadonlyArray<{ file: string; kind: string; sha256: string; bytes: number }>): string {
  const lines = files.filter((entry) => entry.kind === "synth-kit").map((entry) => `${entry.file} ${entry.sha256} ${String(entry.bytes)}`).sort();
  return sha256OfBytes(Buffer.from(lines.join("\n"), "utf8"));
}

// ---- the result ----------------------------------------------------------------------------------------------------------------

export const BUILT_DIR = "built";
export const BUILT_MANIFEST_FILE = `${BUILT_DIR}/manifest.json`;
export const builtTemplateFile = (part: BuiltPart): string => `${BUILT_DIR}/templates/${part}.template.json`;
export const builtPackageFile = (assetId: string): string => `${BUILT_DIR}/packages/${assetId}.zip`;

const BuiltFile = z.object({ file: BundlePath, sha256: Sha256, bytes: z.number().int().nonnegative() }).strict();
/** The manifest of what a build produced. Written by the approving command alone (never by the kit), canonical, with no time, path or host in it: the same inputs are the same bytes. */
export const BuiltManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    format: z.literal("rovara-approved-build"),
    bundleId: Sha256,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    gitCommit: z.string().regex(/^[a-f0-9]{40}$/),
    env: z.string(),
    region: z.string(),
    kitSha256: Sha256,
    settingsSha256: Sha256,
    templates: z.array(BuiltFile.extend({ part: z.enum(BUILT_PARTS) }).strict()).min(1).max(BUILT_PARTS.length),
    packages: z.array(BuiltFile.extend({ assetId: z.string(), parts: z.array(z.enum(BUILT_PARTS)).min(1), bucketParameter: z.string(), keyParameter: z.string(), hashParameter: z.string() }).strict()).max(200),
  })
  .strict()
  .superRefine((manifest, context) => {
    const parts = new Set<string>();
    for (const entry of manifest.templates) {
      if (parts.has(entry.part)) context.addIssue({ code: "custom", message: `template ${entry.part} is listed twice`, path: ["templates"] });
      parts.add(entry.part);
      if (entry.file !== builtTemplateFile(entry.part)) context.addIssue({ code: "custom", message: `template ${entry.part} is at an unexpected path`, path: ["templates"] });
    }
    const assets = new Set<string>();
    for (const entry of manifest.packages) {
      if (assets.has(entry.assetId)) context.addIssue({ code: "custom", message: `package ${entry.assetId} is listed twice`, path: ["packages"] });
      assets.add(entry.assetId);
      if (entry.file !== builtPackageFile(entry.assetId)) context.addIssue({ code: "custom", message: `package ${entry.assetId} is at an unexpected path`, path: ["packages"] });
    }
  });
export type BuiltManifest = z.infer<typeof BuiltManifestSchema>;

/** The pin an approval record holds for a build. */
export const ApprovalBuildSchema = z
  .object({
    /** SHA-256 of built/manifest.json: the hash of the result (it lists the hash of every template and package). */
    resultSha256: Sha256,
    kitSha256: Sha256,
    /** SHA-256 of the canonical recorded settings the build used; the deployer compares it with the install's recorded settings now. */
    settingsSha256: Sha256,
    /** Every setting, as shown to the approver (a sensitive value as its hash). */
    settings: z.object({ edition: z.literal("enterprise"), env: z.string(), region: z.string(), identityMode: z.enum(["cognito", "oidc"]), context: z.record(z.string(), z.string()) }).strict(),
  })
  .strict();
export type ApprovalBuild = z.infer<typeof ApprovalBuildSchema>;

// ---- comparing the access stack ------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A template with the places a stack's CODE LOCATION is written taken out, and the code itself kept as its hash. An install first deployed with the `cdk` engine got its Lambda
 * code from CDK's bootstrap bucket, a build made at approval gets it from template parameters; both name the same asset hash, so two templates that differ only in WHERE the same code
 * is read from compare equal, and two that differ in the code, or in anything else, do not.
 */
export function templateWithoutCodeLocations(template: unknown): string {
  if (!isObject(template)) throw new Error("not a template");
  const copy = JSON.parse(JSON.stringify(template)) as Json;
  if (isObject(copy.Parameters)) {
    for (const name of Object.keys(copy.Parameters)) if (name.startsWith("AssetParameters") || name === "BootstrapVersion") delete copy.Parameters[name];
    if (Object.keys(copy.Parameters).length === 0) delete copy.Parameters;
  }
  if (isObject(copy.Rules)) {
    delete copy.Rules.CheckBootstrapVersion;
    if (Object.keys(copy.Rules).length === 0) delete copy.Rules;
  }
  if (isObject(copy.Resources)) {
    for (const resource of Object.values(copy.Resources)) {
      if (!isObject(resource)) continue;
      if (isObject(resource.Metadata)) {
        for (const key of Object.keys(resource.Metadata)) if (key.startsWith("aws:asset:")) delete resource.Metadata[key];
        if (Object.keys(resource.Metadata).length === 0) delete resource.Metadata;
      }
      const properties = resource.Properties;
      if (resource.Type === "AWS::Lambda::Function" && isObject(properties) && isObject(properties.Code) && properties.Code.S3Key !== undefined) {
        const hash = /[a-f0-9]{64}/.exec(JSON.stringify(properties.Code.S3Key))?.[0];
        if (hash !== undefined) properties.Code = { asset: hash };
      }
    }
  }
  return canonicalJson(copy);
}

/** Whether a build's access template is the deployed access stack, apart from where its code is read from. Anything unreadable is "no". */
export function accessTemplatesAgree(built: string, deployed: string): boolean {
  try {
    return templateWithoutCodeLocations(JSON.parse(built)) === templateWithoutCodeLocations(JSON.parse(deployed));
  } catch {
    return false;
  }
}
