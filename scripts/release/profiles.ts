// The Enterprise settings the release synthesises besides its own (Public, placeholder) templates, so that the release's package list holds every code package an Enterprise install's
// stacks use and the synthesis kit knows the code of every Lambda function an Enterprise install can have. A profile only has to be VALID and to switch on every optional resource the
// settings can add: the templates it produces are not shipped (an install's templates are built at its own approval, from its own settings); only the code packages are.
import { generateKeyPairSync } from "node:crypto";
import { SYNTH_CONTEXT_KEYS } from "@agentx/contracts";

// Limits of what the profiles cover (SK-4 minors 3 and 5, written down so a reader does not assume more):
//  - The code map is made with the release's placeholder environment. The task person proof function (infra/lib/task-person-proof.ts) is in every named environment, so it is in that map like any other
//    function; it was once only in `agentxlivetest123`, which a kit refused (that environment is a test one and is built from source).
//  - Every setting KEY is switched on, but not every VALUE: the other values of `agentxAuditTsa` and `rovaraEnterpriseInternetEgress` are not synthesised. Functions do not depend on those values
//    today (Lambda code does not depend on settings), and a function missing from the code map stops an approval with a plain message; but a customer would then wait for a new release. A new
//    function behind one of those values must add a profile for it here.
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

/**
 * A certificate-shaped sample for the controller's authority setting: it only has to start as a PEM certificate and be public text (the setting is recorded, not parsed, until package-run
 * servers are released). The body is made when asked for, so no certificate or key-shaped text is kept in the repository.
 */
function sampleControllerCa(): string {
  const body = Buffer.from("release profile sample authority: not a real certificate").toString("base64");
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
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
    // Package-run servers: the customer's own registry mirror (https), reached at its own private range, and the runner network inside the install's VPC (10.42.0.0/16). Public npm is the
    // other way to install and excludes the registry ranges, so the profile records it as off; the NAT gateway it would add is a host-stack input, not a recorded setting.
    rovaraMcpNpmRegistry: "https://registry.example.internal/npm/",
    rovaraMcpPublicNpm: "false",
    rovaraMcpRunnerSubnetCidrs: "10.42.240.0/26,10.42.240.64/26",
    rovaraMcpRunnerRoutes: "192.168.0.0/16=tgw-0123456789abcdef0",
    rovaraMcpRegistryCidrs: "192.168.40.0/24",
    rovaraMcpControllerTlsSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:example/mcp-controller-tls-AbCdEf",
    rovaraMcpControllerDnsNamespace: "runners.example.internal",
    rovaraMcpControllerCa: sampleControllerCa(),
    // Project package registries (N9): one CodeArtifact domain bound to the install's own org, with the repositories its projects may read.
    rovaraCodeArtifactDomains: "example-domain:123456789012:us-east-1:install:shared+tools",
    // N8: a company's own model endpoint (the broker's switch and its private ranges, and the model access function's secret-prefix grant). The range is outside the install's VPC.
    rovaraCustomModelEndpoints: "true",
    rovaraModelEndpointCidrs: "192.168.50.0/24",
    agentxReservedConcurrency: "true",
    agentxRovaraOrgId: "o-abcdef1234",
    // (Text, as every recorded setting is; the infrastructure parses it as JSON.)
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
