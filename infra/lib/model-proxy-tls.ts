// MODEL-PROXY-TLS (decision 110): the model proxy's internal load balancer serves HTTPS under a DNS name the install owns, so every caller reaches it with https://<name>.
// Design and costs: docs/architecture/model-proxy-tls.md.
//
// The settings arrive as CDK context (`-c name=value`), read once in infra/lib/app.ts, because three stacks need them at synth: the foundation (the DNS firewall must let the
// name resolve), the control plane (certificate, private zone, listeners, URLs) and the Slack orchestrator (its security group rules), and the access stack grants the deploy
// role exactly what building them needs.
//
//   rovaraModelProxyTlsName            the proxy's DNS name, for example model-proxy.staging.rovara.dev. Unset: today's plain-http proxy, unchanged.
//   rovaraModelProxyTlsZoneId          the PUBLIC Route 53 hosted zone (in this account) that holds the name's parent domain: CloudFormation requests a public ACM certificate for
//                                      the name and writes its DNS validation record there. Free; ACM renews it by itself while the record stays.
//   rovaraModelProxyTlsCertificateArn  instead of the zone: an ISSUED ACM certificate in this region that covers the name (a company whose DNS is not in this account).
//   rovaraModelProxyLegacyHttp         `keep`: also keep the old plain-http listeners (4000, 4001) for ONE release, so tasks that started before the upgrade finish. Unset or `off`: none.
//
// The name resolves inside the VPC only: a private hosted zone of exactly that name (so nothing else of the domain is shadowed) holds an alias record to the load balancer.
// Every wrong value stops the synth, naming its setting.
/** ACM refuses a first domain name longer than 64 characters. */
const DNS_NAME_MAX_ACM = 64;

export const MODEL_PROXY_TLS_CONTEXT_KEYS = {
  name: "rovaraModelProxyTlsName",
  zoneId: "rovaraModelProxyTlsZoneId",
  certificateArn: "rovaraModelProxyTlsCertificateArn",
  legacyHttp: "rovaraModelProxyLegacyHttp",
} as const;

/** The HTTPS inference listener: the standard port, so the URL is `https://<name>` with no port. */
export const MODEL_PROXY_TLS_PORT = 443;
/** The HTTPS management listener (every path), reachable only from the model access function's group. A new port, so the old 4001 can run beside it for one release. */
export const MODEL_PROXY_TLS_MANAGEMENT_PORT = 8443;
/**
 * The listeners' TLS policy: TLS 1.3 and 1.2 only, with the restricted (forward-secret, AEAD-only) TLS 1.2 ciphers. Node's TLS client (the worker, the orchestrator, the model access function) and
 * LiteLLM-compatible clients negotiate TLS 1.3 with it.
 */
export const MODEL_PROXY_TLS_POLICY = "ELBSecurityPolicy-TLS13-1-2-Res-2021-06";

export interface ModelProxyTls {
  /** The proxy's DNS name, lower case. */
  name: string;
  /** The public hosted zone CloudFormation validates a new certificate in. Exactly one of this and `certificateArn`. */
  zoneId?: string;
  /** An issued certificate the company brought. Exactly one of this and `zoneId`. */
  certificateArn?: string;
  /** Keep the old plain-http listeners (and their security group rules) for one release. */
  legacyHttp: boolean;
}

const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const AWS_OWN_NAME = /(?:^|\.)amazonaws\.com(?:\.cn)?$/u;
const HOSTED_ZONE_ID = /^Z[0-9A-Z]{4,31}$/u;
const ACM_CERTIFICATE_ARN = /^arn:aws(?:-[a-z]+)*:acm:([a-z]{2}(?:-[a-z]+)+-\d):\d{12}:certificate\/[0-9A-Za-z-]{1,128}$/u;

const isSet = (value: unknown): boolean => value !== undefined && value !== "";

/**
 * The install's model proxy TLS settings, or undefined when the name is not set (and nothing else is). `region` is the install's region: a brought certificate must be in it,
 * because a load balancer only takes a certificate from its own region.
 */
export function parseModelProxyTlsContext(input: { get: (key: string) => unknown; env: string | undefined; region: string }): ModelProxyTls | undefined {
  const keys = MODEL_PROXY_TLS_CONTEXT_KEYS;
  const name = input.get(keys.name);
  const zoneId = input.get(keys.zoneId);
  const certificateArn = input.get(keys.certificateArn);
  const legacyHttp = input.get(keys.legacyHttp);
  if (!isSet(name)) {
    const stray = [keys.zoneId, keys.certificateArn, keys.legacyHttp].filter((key) => isSet(input.get(key)));
    if (stray.length > 0) throw new Error(`${stray.join(", ")} ${stray.length === 1 ? "needs" : "need"} ${keys.name}: set the model proxy's DNS name too, or leave them all out`);
    return undefined;
  }
  if (input.env === undefined) throw new Error(`${keys.name} is for a named environment (agentxEnv): the deployment that predates environments has no model proxy`);
  if (typeof name !== "string" || name.length > DNS_NAME_MAX_ACM || !DNS_NAME.test(name) || AWS_OWN_NAME.test(name)) {
    throw new Error(`${keys.name} must be a lower-case DNS name of your own of at most ${DNS_NAME_MAX_ACM} characters, such as model-proxy.example.com (not an amazonaws.com name, a wildcard or an address)`);
  }
  if (isSet(zoneId) === isSet(certificateArn)) throw new Error(`${keys.name} needs exactly one of ${keys.zoneId} (a public hosted zone in this account; the certificate is made for you) and ${keys.certificateArn} (an issued certificate you bring)`);
  if (isSet(zoneId) && (typeof zoneId !== "string" || !HOSTED_ZONE_ID.test(zoneId))) throw new Error(`${keys.zoneId} must be a Route 53 hosted zone id such as Z0123456789ABCDEFGHIJ`);
  if (isSet(certificateArn)) {
    const match = typeof certificateArn === "string" ? ACM_CERTIFICATE_ARN.exec(certificateArn) : null;
    if (match === null) throw new Error(`${keys.certificateArn} must be the ARN of an ACM certificate (arn:aws:acm:<region>:<account>:certificate/<id>)`);
    if (match[1] !== input.region) throw new Error(`${keys.certificateArn} must be a certificate in ${input.region}, the install's region: a load balancer takes certificates from its own region only`);
  }
  if (isSet(legacyHttp) && legacyHttp !== "keep" && legacyHttp !== "off") throw new Error(`${keys.legacyHttp} must be keep (one release with the old plain-http listeners beside HTTPS) or off`);
  return {
    name,
    ...(isSet(zoneId) ? { zoneId: zoneId as string } : {}),
    ...(isSet(certificateArn) ? { certificateArn: certificateArn as string } : {}),
    legacyHttp: legacyHttp === "keep",
  };
}

/** `https://<name>`: what workers, the broker and the orchestrator are given. */
export const modelProxyTlsUrl = (tls: Pick<ModelProxyTls, "name">): string => `https://${tls.name}`;
/** `https://<name>:8443`: what the model access function is given. */
export const modelProxyTlsManagementUrl = (tls: Pick<ModelProxyTls, "name">): string => `https://${tls.name}:${MODEL_PROXY_TLS_MANAGEMENT_PORT}`;

/** A deploy-role statement (the same shape as access-policies' PolicyStatementJson). */
export interface TlsDeployStatement {
  Sid: string;
  Effect: "Allow";
  Action: string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

/**
 * What the deploy (CloudFormation service) role needs to build the TLS pieces, and nothing else in Certificate Manager or Route 53. It goes in a managed policy of its own on that
 * role (infra/lib/access.ts), only when the TLS name is set, so the role's inline policy (capped at 10,240 characters) does not grow.
 *  - a new certificate (`zoneId`): RequestCertificate for the one name, tagged as this environment's; then only certificates carrying this environment's tag; the validation
 *    record (`_<hash>.<name>`, CNAME) in the public zone, and that zone's reads;
 *  - a brought certificate: DescribeCertificate on that one certificate;
 *  - the private zone: CreateHostedZone and AssociateVPCWithHostedZone take no zone ARN (the zone does not exist yet), so they are on "*". The zone's life after that (read, tag,
 *    delete, comment, disassociate) is on any hosted zone ARN, because Route 53 has no tag conditions for zones. AWS refuses DeleteHostedZone for a zone that holds any record
 *    besides its SOA and NS, so the reach is: empty zones in this account. Records: the alias record only, A, the exact name, in any zone (the private zone's id is not known first).
 */
export function modelProxyTlsDeployStatements(scope: { env: string; partition: string; region: string; account: string }, tls: ModelProxyTls): TlsDeployStatement[] {
  const zones = `arn:${scope.partition}:route53:::hostedzone/*`;
  const statements: TlsDeployStatement[] = [];
  if (tls.zoneId !== undefined) {
    const certificates = `arn:${scope.partition}:acm:${scope.region}:${scope.account}:certificate/*`;
    const publicZone = `arn:${scope.partition}:route53:::hostedzone/${tls.zoneId}`;
    statements.push(
      {
        Sid: "ModelProxyTlsCertificateRequest", Effect: "Allow", Action: ["acm:RequestCertificate"], Resource: "*",
        Condition: {
          StringEquals: { "aws:RequestedRegion": scope.region, "aws:RequestTag/agentx:env": scope.env },
          "ForAllValues:StringEquals": { "acm:DomainNames": [tls.name] },
          Null: { "acm:DomainNames": "false" },
        },
      },
      { Sid: "ModelProxyTlsCertificateTag", Effect: "Allow", Action: ["acm:AddTagsToCertificate"], Resource: certificates, Condition: { StringEquals: { "aws:RequestTag/agentx:env": scope.env, "aws:ResourceTag/agentx:env": scope.env } } },
      {
        Sid: "ModelProxyTlsCertificates", Effect: "Allow", Action: ["acm:DescribeCertificate", "acm:DeleteCertificate", "acm:RemoveTagsFromCertificate", "acm:ListTagsForCertificate"], Resource: certificates,
        Condition: { StringEquals: { "aws:ResourceTag/agentx:env": scope.env } },
      },
      {
        Sid: "ModelProxyTlsValidationRecord", Effect: "Allow", Action: ["route53:ChangeResourceRecordSets"], Resource: publicZone,
        Condition: {
          "ForAllValues:StringLike": { "route53:ChangeResourceRecordSetsNormalizedRecordNames": [`_*.${tls.name}`] },
          "ForAllValues:StringEquals": { "route53:ChangeResourceRecordSetsRecordTypes": ["CNAME"] },
          Null: { "route53:ChangeResourceRecordSetsNormalizedRecordNames": "false", "route53:ChangeResourceRecordSetsRecordTypes": "false" },
        },
      },
      { Sid: "ModelProxyTlsPublicZoneReads", Effect: "Allow", Action: ["route53:GetHostedZone", "route53:ListResourceRecordSets"], Resource: publicZone },
    );
  } else if (tls.certificateArn !== undefined) {
    statements.push({ Sid: "ModelProxyTlsBroughtCertificate", Effect: "Allow", Action: ["acm:DescribeCertificate"], Resource: tls.certificateArn });
  }
  statements.push(
    { Sid: "ModelProxyTlsPrivateZoneCreate", Effect: "Allow", Action: ["route53:CreateHostedZone", "route53:AssociateVPCWithHostedZone"], Resource: "*" },
    {
      Sid: "ModelProxyTlsPrivateZones", Effect: "Allow", Resource: zones,
      Action: ["route53:GetHostedZone", "route53:DeleteHostedZone", "route53:ListResourceRecordSets", "route53:ChangeTagsForResource", "route53:ListTagsForResource", "route53:UpdateHostedZoneComment", "route53:DisassociateVPCFromHostedZone"],
    },
    {
      Sid: "ModelProxyTlsAliasRecord", Effect: "Allow", Action: ["route53:ChangeResourceRecordSets"], Resource: zones,
      Condition: {
        "ForAllValues:StringEquals": { "route53:ChangeResourceRecordSetsNormalizedRecordNames": [tls.name], "route53:ChangeResourceRecordSetsRecordTypes": ["A"] },
        Null: { "route53:ChangeResourceRecordSetsNormalizedRecordNames": "false", "route53:ChangeResourceRecordSetsRecordTypes": "false" },
      },
    },
    { Sid: "ModelProxyTlsZoneList", Effect: "Allow", Action: ["route53:ListHostedZones", "route53:ListHostedZonesByName"], Resource: "*" },
    { Sid: "ModelProxyTlsChanges", Effect: "Allow", Action: ["route53:GetChange"], Resource: `arn:${scope.partition}:route53:::change/*` },
  );
  return statements;
}
