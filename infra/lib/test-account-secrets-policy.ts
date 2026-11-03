// The TestAccountSecretsRole's two policies (test services TS26; design test-services.md 6.2), as plain IAM JSON. The control plane puts them on the role, and the Secrets Manager fake in
// tests/support/fake-org-secrets.ts evaluates the same text, so a test proves what the role allows rather than what a test author hoped it allows.
//
// This is the connector secrets role's pattern (connector-secrets-policy.ts) with two differences. (1) The path is `agentx/<env>/org-test-accounts/<org>/*`, apart from the connector and hook paths, so a connector
// session cannot reach a test account's secret and this role cannot reach a connector's. (2) A session also carries a PURPOSE tag, and the purpose is part of every permission:
//   - `store`: the broker's own session. It may create a secret, put a new version, describe it and schedule its deletion. It can NEVER read a value (GetSecretValue is denied to it).
//   - `resolve`: the session the broker mints for the worker of one sealed round, narrowed again by a session policy to the one secret. It may read a value and do nothing else.
// So the broker, which holds the store session, cannot read a test account's secret even by a mistake, and a worker's session cannot write or delete one.
import { ORG_ID_TRUST_PATTERN, ORG_TAG_KEY, PRINCIPAL_ORG_TAG, type PolicyStatementJson } from "./connector-secrets-policy.js";

export { ORG_TAG_KEY, PRINCIPAL_ORG_TAG };
export const PURPOSE_TAG_KEY = "rovara:purpose";
export const USE_TAG_KEY = "rovara:use";
export const USE_TAG_VALUE = "test-account";
export const PURPOSES = ["store", "resolve"] as const;
/** The session's own purpose: the IAM policy variable the permissions below are written in terms of. */
export const PRINCIPAL_PURPOSE_TAG = "${aws:PrincipalTag/rovara:purpose}";

/** Trusts the broker function role only, and only for a session tagged with a well-formed org id and one of the two purposes, and no other tag. */
export function testAccountSecretsTrustPolicy(brokerRoleArn: string | Record<string, unknown>): { Version: "2012-10-17"; Statement: PolicyStatementJson[] } {
  return {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { AWS: brokerRoleArn },
      Action: ["sts:AssumeRole", "sts:TagSession"],
      Condition: {
        StringLike: { [`aws:RequestTag/${ORG_TAG_KEY}`]: ORG_ID_TRUST_PATTERN },
        StringEquals: { [`aws:RequestTag/${PURPOSE_TAG_KEY}`]: [...PURPOSES] },
        Null: { [`aws:RequestTag/${ORG_TAG_KEY}`]: "false", [`aws:RequestTag/${PURPOSE_TAG_KEY}`]: "false" },
        "ForAllValues:StringEquals": { "aws:TagKeys": [ORG_TAG_KEY, PURPOSE_TAG_KEY] },
      },
    }],
  };
}

/**
 * What a session may do, on `secret:agentx/<env>/org-test-accounts/<its org>/*` only. `secretArnPrefix` is everything in the ARN up to and including `secret:`.
 *
 * - Put, Describe, UpdateSecretVersionStage and Delete need the secret's own `rovara:org` tag to equal the session's org, its `rovara:use` tag to be `test-account`, and the session's purpose to be `store`.
 * - CreateSecret and TagResource need the request tags to equal the session's org and `test-account`, those two to be the only tag keys, and purpose `store`.
 * - GetSecretValue needs the same resource tags and purpose `resolve`.
 * - Denied whatever else says: UntagResource, DeleteSecret with ForceDeleteWithoutRecovery, any read by a session that is not `resolve`, and any write by a session that is not `store`.
 */
export function testAccountSecretsPolicyStatements(options: { secretArnPrefix: string; env: string }): PolicyStatementJson[] {
  const own = [`${options.secretArnPrefix}agentx/${options.env}/org-test-accounts/${PRINCIPAL_ORG_TAG}/*`];
  const ownResource = { [`aws:ResourceTag/${ORG_TAG_KEY}`]: PRINCIPAL_ORG_TAG, [`aws:ResourceTag/${USE_TAG_KEY}`]: USE_TAG_VALUE };
  const tagged = {
    StringEquals: { [`aws:RequestTag/${ORG_TAG_KEY}`]: PRINCIPAL_ORG_TAG, [`aws:RequestTag/${USE_TAG_KEY}`]: USE_TAG_VALUE, [`aws:PrincipalTag/${PURPOSE_TAG_KEY}`]: "store" },
    "ForAllValues:StringEquals": { "aws:TagKeys": [ORG_TAG_KEY, USE_TAG_KEY] },
  };
  return [
    { Sid: "StoreOwnOrgSecrets", Effect: "Allow", Action: ["secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret", "secretsmanager:DeleteSecret", "secretsmanager:UpdateSecretVersionStage"], Resource: own, Condition: { StringEquals: { ...ownResource, [`aws:PrincipalTag/${PURPOSE_TAG_KEY}`]: "store" } } },
    { Sid: "ResolveOwnOrgSecret", Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: own, Condition: { StringEquals: { ...ownResource, [`aws:PrincipalTag/${PURPOSE_TAG_KEY}`]: "resolve" } } },
    { Sid: "CreateOwnOrgSecrets", Effect: "Allow", Action: "secretsmanager:CreateSecret", Resource: own, Condition: tagged },
    { Sid: "TagOnlyWithCreate", Effect: "Allow", Action: "secretsmanager:TagResource", Resource: own, Condition: tagged },
    { Sid: "NeverUntag", Effect: "Deny", Action: "secretsmanager:UntagResource", Resource: "*" },
    { Sid: "NeverDeleteWithoutRecovery", Effect: "Deny", Action: "secretsmanager:DeleteSecret", Resource: "*", Condition: { Bool: { "secretsmanager:ForceDeleteWithoutRecovery": "true" } } },
    { Sid: "OnlyResolveReads", Effect: "Deny", Action: "secretsmanager:GetSecretValue", Resource: "*", Condition: { StringNotEquals: { [`aws:PrincipalTag/${PURPOSE_TAG_KEY}`]: "resolve" } } },
    {
      Sid: "OnlyStoreWrites",
      Effect: "Deny",
      Action: ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:DeleteSecret", "secretsmanager:TagResource", "secretsmanager:UpdateSecretVersionStage"],
      Resource: "*",
      Condition: { StringNotEquals: { [`aws:PrincipalTag/${PURPOSE_TAG_KEY}`]: "store" } },
    },
  ];
}
