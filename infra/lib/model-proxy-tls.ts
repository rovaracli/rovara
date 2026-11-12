// MODEL-PROXY-TLS (decision 110, amended by decision 127): the model proxy's internal load balancer serves HTTPS under a DNS name the install owns, so every caller reaches it with
// https://<name>. Design and costs: docs/architecture/model-proxy-tls.md.
//
// The settings arrive as CDK context (`-c name=value`), read once in infra/lib/app.ts, because three stacks need them at synth: the foundation (the DNS firewall must let the
// name resolve), the control plane (certificate, alias record, listeners, URLs) and the Slack orchestrator (its security group rules), and the access stack grants the deploy
// role exactly what building them needs.
//
//   rovaraModelProxyTlsName            the proxy's DNS name, for example model-proxy.staging.rovara.dev. Unset: today's plain-http proxy, unchanged.
//   rovaraModelProxyTlsZoneId          REQUIRED with the name: the install's existing PUBLIC Route 53 hosted zone (in this account) of the name's parent domain. The name's alias A
//                                      record to the internal load balancer goes there, and (without a brought certificate) the certificate's DNS validation record too.
//   rovaraModelProxyTlsCertificateArn  optional: an ISSUED ACM certificate in this region that covers the name, used instead of requesting one (free; ACM renews it by itself while
//                                      the validation record stays).
//   rovaraModelProxyLegacyHttp         `keep`: also keep the old plain-http listeners (4000, 4001) for ONE release, so workers launched before the upgrade finish. Unset or `off`: none.
//
// Decision 127 (amends 110): the alias record is PUBLIC, in the install's own zone, not in a private hosted zone. The internal load balancer's own name already resolves publicly to its
// private addresses, so the record reveals nothing new, and the deploy role needs no hosted zone creation or deletion. Every wrong value stops the synth, naming its setting.
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
  /** The public hosted zone the alias record (and a new certificate's validation record) goes in. */
  zoneId: string;
  /** An issued certificate the company brought; absent, one is requested and validated in `zoneId`. */
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
  if (!isSet(zoneId)) throw new Error(`${keys.name} needs ${keys.zoneId}: the public hosted zone in this account that the name's alias record goes in`);
  if (typeof zoneId !== "string" || !HOSTED_ZONE_ID.test(zoneId)) throw new Error(`${keys.zoneId} must be a Route 53 hosted zone id such as Z0123456789ABCDEFGHIJ`);
  if (isSet(certificateArn)) {
    const match = typeof certificateArn === "string" ? ACM_CERTIFICATE_ARN.exec(certificateArn) : null;
    if (match === null) throw new Error(`${keys.certificateArn} must be the ARN of an ACM certificate (arn:aws:acm:<region>:<account>:certificate/<id>)`);
    if (match[1] !== input.region) throw new Error(`${keys.certificateArn} must be a certificate in ${input.region}, the install's region: a load balancer takes certificates from its own region only`);
  }
  if (isSet(legacyHttp) && legacyHttp !== "keep" && legacyHttp !== "off") throw new Error(`${keys.legacyHttp} must be keep (one release with the old plain-http listeners beside HTTPS) or off`);
  return {
    name,
    zoneId,
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

/** The record actions CloudFormation sends for a record it creates, updates and deletes. */
const RECORD_ACTIONS = ["CREATE", "UPSERT", "DELETE"];

/**
 * What the deploy (CloudFormation service) role needs to build the TLS pieces, and nothing else in Certificate Manager or Route 53. It goes in a managed policy of its own on that
 * role (infra/lib/access.ts), only when the TLS name is set, so the role's inline policy (capped at 10,240 characters) does not grow. Every Route 53 grant is on the ONE public zone:
 *  - the alias A record named exactly `<name>`;
 *  - a new certificate (no brought ARN): RequestCertificate for the one name, tagged as this environment's; then only certificates carrying this environment's tag; the validation
 *    record (`_<hash>.<name>`, CNAME);
 *  - a brought certificate: DescribeCertificate on that one certificate.
 * Each record grant names the record (normalized: lower case, no trailing dot), its type and the change actions, and a request that leaves any of them out is refused (Null false).
 */
export function modelProxyTlsDeployStatements(scope: { env: string; partition: string; region: string; account: string }, tls: ModelProxyTls): TlsDeployStatement[] {
  const zone = `arn:${scope.partition}:route53:::hostedzone/${tls.zoneId}`;
  const recordGrant = (sid: string, names: string[], types: string[], like: boolean): TlsDeployStatement => ({
    Sid: sid, Effect: "Allow", Action: ["route53:ChangeResourceRecordSets"], Resource: zone,
    Condition: {
      // One object per operator: an exact name sits beside the types and actions, a wildcard name in a StringLike of its own.
      ...(like ? { "ForAllValues:StringLike": { "route53:ChangeResourceRecordSetsNormalizedRecordNames": names } } : {}),
      "ForAllValues:StringEquals": {
        ...(like ? {} : { "route53:ChangeResourceRecordSetsNormalizedRecordNames": names }),
        "route53:ChangeResourceRecordSetsRecordTypes": types, "route53:ChangeResourceRecordSetsActions": RECORD_ACTIONS,
      },
      Null: { "route53:ChangeResourceRecordSetsNormalizedRecordNames": "false", "route53:ChangeResourceRecordSetsRecordTypes": "false", "route53:ChangeResourceRecordSetsActions": "false" },
    },
  });
  const statements: TlsDeployStatement[] = [];
  if (tls.certificateArn === undefined) {
    const certificates = `arn:${scope.partition}:acm:${scope.region}:${scope.account}:certificate/*`;
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
      recordGrant("ModelProxyTlsValidationRecord", [`_*.${tls.name}`], ["CNAME"], true),
    );
  } else {
    statements.push({ Sid: "ModelProxyTlsBroughtCertificate", Effect: "Allow", Action: ["acm:DescribeCertificate"], Resource: tls.certificateArn });
  }
  statements.push(
    recordGrant("ModelProxyTlsAliasRecord", [tls.name], ["A"], false),
    { Sid: "ModelProxyTlsZoneReads", Effect: "Allow", Action: ["route53:GetHostedZone", "route53:ListResourceRecordSets"], Resource: zone },
    { Sid: "ModelProxyTlsZoneList", Effect: "Allow", Action: ["route53:ListHostedZones"], Resource: "*" },
    { Sid: "ModelProxyTlsChanges", Effect: "Allow", Action: ["route53:GetChange"], Resource: `arn:${scope.partition}:route53:::change/*` },
  );
  return statements;
}
