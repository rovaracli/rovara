// BA-3: the release's package list holds every code package any Enterprise stack uses. A build made at approval may use no package the signed bundle does not list (review I3), so a
// package missing from the list would make an Enterprise upgrade refuse, in a customer's account, long after the release was cut. These tests synthesise Enterprise installs with their
// OWN settings (not the release's profiles) and fail when a stack asks for code the release does not carry.
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENVIRONMENT_PLACEHOLDER, STACK_PARTS, environmentStackName } from "@rovara-code/contracts";
import { SYNTH_CONTEXT_KEYS } from "@agentx/cloud-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SUPPORTED_REGIONS } from "../../infra/lib/production-foundation.js";
import { RELEASE_SYNTH_ROOT, buildRelease, synthReleaseProfile } from "../../scripts/release/build.js";
import { enterpriseReleaseProfiles, settingsKeysNotExercised } from "../../scripts/release/profiles.js";
import { ReleaseManifestSchema, type ReleaseManifest } from "../../scripts/release/manifest.js";

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Written out here on purpose: if the release's own profiles lost a setting, these must still catch the package that setting adds. */
const PRINCIPAL = "arn:aws:iam::210987654321:role/test-operators";
const BASE = { rovaraEdition: "enterprise", rovaraEnterpriseEgressCidrs: "10.99.0.0/16", agentxAuditTsa: "off" } as const;
const OPERATOR = { rovaraOperatorAccess: "enabled", rovaraOperatorPrincipalArn: PRINCIPAL, rovaraOperatorExternalId: "independent-test-external-id-1", rovaraBundleApproverArns: "arn:aws:iam::123456789012:role/test-approvers" } as const;
const PRIVATE_MCP = { rovaraPrivateMcpCidrs: "192.168.0.0/16", rovaraMcpHostCertificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/11111111-1111-1111-1111-111111111111", rovaraMcpHostName: "mcp.test.internal", rovaraMcpHostedZoneId: "Z0123456789ABCDEFGHIJ" } as const;
const signingKeys = (): string => JSON.stringify([generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "pem" }).toString()]);
const MATRIX: ReadonlyArray<{ name: string; context: () => Record<string, string> }> = [
  { name: "nothing optional", context: () => ({ ...BASE }) },
  { name: "operator access", context: () => ({ ...BASE, ...OPERATOR }) },
  { name: "operator access with signing keys, log groups, oidc identity", context: () => ({ ...BASE, ...OPERATOR, rovaraBundleSigningKeys: signingKeys(), rovaraOperatorLogGroups: "/test/customer/logs", agentxIdentity: "oidc" }) },
  { name: "private MCP host", context: () => ({ ...BASE, ...PRIVATE_MCP }) },
  { name: "custom timestamp authority, replica, own domains, no reserved concurrency", context: () => ({ ...BASE, agentxAuditTsa: "custom", agentxAuditTsaUrls: "https://tsa.test.internal/tsr", agentxAuditTsaRootsParameter: "/agentx/test/roots", agentxAuditReplicaBucketArn: "arn:aws:s3:::test-audit-replica", agentxAuditReplicaLockConfirmed: "true", agentxEgressAllowDomains: "a.test.internal", agentxReservedConcurrency: "false" }) },
];

let root: string;
let releaseDir: string;
let manifest: ReleaseManifest;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "release-ent-packages-"));
  releaseDir = join(root, "release");
  await buildRelease({ version: "1.2.3", out: releaseDir, gitCommit: "b".repeat(40) });
  manifest = ReleaseManifestSchema.parse(JSON.parse(await readFile(join(releaseDir, "release.json"), "utf8")));
}, 900_000);
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("the release's package lists", () => {
  it("carry the Enterprise-only code in enterprisePackages, none of it twice, every file as released", async () => {
    const publicIds = new Set(manifest.packages.map((pkg) => pkg.assetId));
    const enterprise = manifest.enterprisePackages ?? [];
    expect(enterprise.length, "the access stack's deployer function is Enterprise-only code").toBeGreaterThan(0);
    for (const pkg of enterprise) {
      expect(publicIds.has(pkg.assetId), `${pkg.assetId} is in both lists`).toBe(false);
      expect(sha(await readFile(join(releaseDir, pkg.file)))).toBe(pkg.sha256);
      expect(pkg.keyParameterValue).toBe(`packages/||${pkg.assetId}.zip`);
    }
    expect(new Set(enterprise.map((pkg) => pkg.assetId)).size).toBe(enterprise.length);
    // A Public install deploys the first list only: nothing in it is asked for by the access stack's placeholder template.
    for (const pkg of manifest.packages) expect(pkg.parts).not.toContain("access");
  });

  it("exercise every setting the recorded settings can hold (a new setting needs a profile that sets it)", () => {
    expect(settingsKeysNotExercised(enterpriseReleaseProfiles())).toEqual([]);
    expect(SYNTH_CONTEXT_KEYS.length).toBeGreaterThan(20);
  });

  for (const entry of MATRIX) {
    it(`hold every package an Enterprise install with ${entry.name} uses`, async () => {
      await mkdir(RELEASE_SYNTH_ROOT, { recursive: true });
      const synthDir = await mkdtemp(join(RELEASE_SYNTH_ROOT, "run-"));
      try {
        const [region] = SUPPORTED_REGIONS;
        const { assembly, functions } = synthReleaseProfile({ context: { ...entry.context(), agentxEnv: ENVIRONMENT_PLACEHOLDER, agentxRegion: region! }, outdir: synthDir });
        const listed = new Set([...manifest.packages, ...(manifest.enterprisePackages ?? [])].map((pkg) => pkg.assetId));
        const used = new Set<string>();
        for (const stack of assembly.stacks) for (const asset of stack.assets) used.add(asset.id);
        expect(used.size, "the profile has stacks with code").toBeGreaterThan(0);
        expect([...used].filter((id) => !listed.has(id)), "code an Enterprise stack uses that no release list names").toEqual([]);
        // The functions found in the construct tree are the code the stacks hold: nothing is run from anywhere else.
        expect(new Set(functions.map((fn) => fn.assetId))).toEqual(used);
        // Each part the settings produce is one the build knows.
        for (const stack of assembly.stacks) expect(STACK_PARTS.some((part) => stack.stackName === environmentStackName(ENVIRONMENT_PLACEHOLDER, part)), stack.stackName).toBe(true);
      } finally {
        await rm(synthDir, { recursive: true, force: true });
      }
    }, 300_000);
  }
});
