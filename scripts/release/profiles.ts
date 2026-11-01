// The Enterprise settings the release synthesises besides its own (Public, placeholder) templates, so that the release's package list holds every code package an Enterprise install's
// stacks use and the synthesis kit knows the code of every Lambda function an Enterprise install can have. A profile only has to be VALID and to switch on every optional resource the
// settings can add: the templates it produces are not shipped (an install's templates are built at its own approval, from its own settings); only the code packages are.
import { generateKeyPairSync } from "node:crypto";
import { SYNTH_CONTEXT_KEYS } from "@agentx/contracts";

export interface ReleaseProfile {
  name: string;
  /** CDK context besides the environment, region and synthesizer, which the release sets itself. All values are text, as an install's recorded settings are. */
  context: Readonly<Record<string, string>>;
}

/** A public key made when it is asked for (never kept in the repository, no private half is kept): the signing-keys setting only has to hold a valid key. */
function sampleSigningKeys(): string {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return JSON.stringify([publicKey.export({ type: "spki", format: "pem" }).toString()]);
}

/** Every setting the recorded settings can hold, set to a valid value: the widest Enterprise stack set. */
function everythingOn(): Record<string, string> {
  return {
    rovaraEdition: "enterprise",
    rovaraEnterpriseEgressCidrs: "10.99.0.0/16",
    rovaraEnterpriseInternetEgress: "nat",
    rovaraEnterpriseAllowPublicRanges: "false",
    agentxEgressAllowDomains: "packages.example.internal",
    agentxAuditTsa: "custom",
    agentxAuditTsaUrls: "https://tsa.example.internal/tsr",
    agentxAuditTsaRootsParameter: "/agentx/release-profile/tsa-roots",
    agentxAuditLockMode: "COMPLIANCE",
    agentxAuditRetentionDays: "1100",
    agentxAuditReplicaLockConfirmed: "true",
    agentxAuditReplicaBucketArn: "arn:aws:s3:::example-audit-replica-bucket",
    rovaraOperatorAccess: "enabled",
    rovaraOperatorPrincipalArn: "arn:aws:iam::210987654321:role/example-operators",
    rovaraOperatorExternalId: "release-profile-external-id-0001",
    rovaraOperatorLogGroups: "/example/customer/app-logs",
    rovaraBundleSigningKeys: sampleSigningKeys(),
    rovaraBundleApproverArns: "arn:aws:iam::123456789012:role/example-approvers",
    rovaraPrivateMcpCidrs: "192.168.0.0/16",
    rovaraMcpHostCertificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000",
    rovaraMcpHostName: "mcp.example.internal",
    rovaraMcpHostedZoneId: "Z0123456789ABCDEFGHIJ",
    agentxReservedConcurrency: "true",
    agentxRovaraOrgId: "o-abcdef1234",
    // (Text, as every recorded setting is. The infrastructure reads this key as an object today, so a text value has no effect on the templates; see the report.)
    evidenceRetentionDays: JSON.stringify({ "evidence-short": 30, "evidence-std": 90 }),
  };
}

/**
 * The Enterprise profiles of a release: every optional setting on (the widest set of stacks and functions), and the same with the customer's own OIDC identity provider (no identity
 * stack). Built when asked for, because the signing-keys sample is made at that time.
 */
export function enterpriseReleaseProfiles(): ReleaseProfile[] {
  const widest = everythingOn();
  return [
    { name: "enterprise-all-settings", context: widest },
    { name: "enterprise-oidc", context: { ...widest, agentxIdentity: "oidc" } },
  ];
}

/** The settings keys a release's Enterprise profiles do not set (a test requires this to be empty: a new setting must be exercised by a profile). */
export function settingsKeysNotExercised(profiles: readonly ReleaseProfile[]): string[] {
  const exercised = new Set(profiles.flatMap((profile) => Object.keys(profile.context)));
  return SYNTH_CONTEXT_KEYS.filter((key) => !exercised.has(key));
}
