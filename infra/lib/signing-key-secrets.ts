// 0.5.15 signing-key lane: a named environment's functions read the callback signing key and the erasure hash key from Secrets Manager
// (packages/broker/src/aws/signing-key-secrets.ts), never from a Lambda variable. (The named template no longer declares the NoEcho CallbackSigningKey parameter,
// and the CLI no longer passes it: both went in 0.5.15, so an upgrade of a 0.5.14 stack, which still holds the parameter, drops it. Only the legacy install's frozen template keeps it.) The secrets are created by the deploy (packages/cli/src/deploy/signing-key.ts),
// outside every stack: the callback signing key existed before this lane under the same name, and a stack that created it would fail on the name. CloudFormation
// never holds either value, so no update can regenerate or overwrite one and no stack deletion can delete one. This grants each function GetSecretValue on
// exactly the secret(s) it needs, by name (Secrets Manager appends "-" and six characters to a secret's name in its ARN), and nothing else.
import { ArnFormat, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { callbackSigningKeySecretName, erasureHashKeySecretName } from "@agentx/cloud-contracts";

export type SigningKeyKind = "callback" | "erasure";

/** The ARN pattern of one of the environment's two key secrets. */
export function signingKeySecretArn(scope: Construct, env: string, kind: SigningKeyKind): string {
  const name = kind === "callback" ? callbackSigningKeySecretName(env) : erasureHashKeySecretName(env);
  return Stack.of(scope).formatArn({ service: "secretsmanager", resource: "secret", resourceName: `${name}-??????`, arnFormat: ArnFormat.COLON_RESOURCE_NAME });
}

/** Lets the function read exactly these key secrets (GetSecretValue only; any version, so the previous callback key verifies during a rotation). */
export function grantSigningKeySecrets(fn: { addToRolePolicy(statement: iam.PolicyStatement): unknown }, scope: Construct, env: string, kinds: readonly SigningKeyKind[], sid?: string): void {
  fn.addToRolePolicy(new iam.PolicyStatement({
    ...(sid === undefined ? {} : { sid }),
    actions: ["secretsmanager:GetSecretValue"],
    resources: kinds.map((kind) => signingKeySecretArn(scope, env, kind)),
  }));
}
