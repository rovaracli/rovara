// The ConnectorSecretsRole's two policies (Plan 3, ruling R62), as plain IAM JSON. The control plane puts them on the
// role, and the Secrets Manager fake in tests/support/fake-org-secrets.ts evaluates the same text, so a test proves
// what the role allows rather than what a test author hoped it allows.

export interface PolicyStatementJson {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Principal?: Record<string, unknown>;
  Action: string | string[];
  Resource?: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

export const ORG_TAG_KEY = "rovara:org";
/**
 * `org_` and exactly 20 more characters. IAM string conditions have no length operator, so the fixed-length pattern is
 * the length check, and `?` still accepts any character: the character set is pinned by OrgSecrets (OrgIdSchema).
 */
export const ORG_ID_TRUST_PATTERN = "org_????????????????????";
/** The session's own org: the IAM policy variable the permissions below are written in terms of. */
export const PRINCIPAL_ORG_TAG = "${aws:PrincipalTag/rovara:org}";

/** Trusts the broker function role only, and only for a session tagged with a well-formed org id and no other tag. */
export function connectorSecretsTrustPolicy(brokerRoleArn: string | Record<string, unknown>): { Version: "2012-10-17"; Statement: PolicyStatementJson[] } {
  return {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { AWS: brokerRoleArn },
      Action: ["sts:AssumeRole", "sts:TagSession"],
      Condition: {
        StringLike: { [`aws:RequestTag/${ORG_TAG_KEY}`]: ORG_ID_TRUST_PATTERN },
        Null: { [`aws:RequestTag/${ORG_TAG_KEY}`]: "false" },
        "ForAllValues:StringEquals": { "aws:TagKeys": [ORG_TAG_KEY] },
      },
    }],
  };
}

/**
 * What a session may do, on `secret:agentx/<env>/org-connectors/<its org>/*` and `.../org-hooks/<its org>/*` only.
 * `secretArnPrefix` is everything in the ARN up to and including `secret:`.
 *
 * - Get, Put, Describe and Delete need the secret's own `rovara:org` tag to equal the session's org.
 * - CreateSecret needs the request tag to equal the session's org and `rovara:org` to be the only tag key.
 * - TagResource is allowed under the same two conditions, because CreateSecret with tags also needs it. Rovara code
 *   never calls it by itself. It is not denied anywhere: a Deny conditioned on an existing resource tag could also
 *   fire during a tagged create, and the Allow already confines tagging to the session's own org path.
 * - UntagResource is denied unconditionally: a create never needs it.
 * - DeleteSecret is allowed (a removed connection's secret is scheduled for deletion), but denied with
 *   ForceDeleteWithoutRecovery: a broker bug must not be able to skip the recovery window the CLI promises (final review M2).
 */
export function connectorSecretsPolicyStatements(options: { secretArnPrefix: string; env: string }): PolicyStatementJson[] {
  const own = [
    `${options.secretArnPrefix}agentx/${options.env}/org-connectors/${PRINCIPAL_ORG_TAG}/*`,
    `${options.secretArnPrefix}agentx/${options.env}/org-hooks/${PRINCIPAL_ORG_TAG}/*`,
  ];
  const tagged = {
    StringEquals: { [`aws:RequestTag/${ORG_TAG_KEY}`]: PRINCIPAL_ORG_TAG },
    "ForAllValues:StringEquals": { "aws:TagKeys": [ORG_TAG_KEY] },
  };
  return [
    {
      Sid: "UseOwnOrgSecrets",
      Effect: "Allow",
      Action: ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret", "secretsmanager:DeleteSecret"],
      Resource: own,
      Condition: { StringEquals: { [`aws:ResourceTag/${ORG_TAG_KEY}`]: PRINCIPAL_ORG_TAG } },
    },
    { Sid: "CreateOwnOrgSecrets", Effect: "Allow", Action: "secretsmanager:CreateSecret", Resource: own, Condition: tagged },
    { Sid: "TagOnlyWithCreate", Effect: "Allow", Action: "secretsmanager:TagResource", Resource: own, Condition: tagged },
    { Sid: "NeverUntag", Effect: "Deny", Action: "secretsmanager:UntagResource", Resource: "*" },
    {
      Sid: "NeverDeleteWithoutRecovery",
      Effect: "Deny",
      Action: "secretsmanager:DeleteSecret",
      Resource: "*",
      Condition: { Bool: { "secretsmanager:ForceDeleteWithoutRecovery": "true" } },
    },
  ];
}
