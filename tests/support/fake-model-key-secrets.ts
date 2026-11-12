// Convergence lane A3: an in-memory Secrets Manager that answers GetSecretValue by ARN the way the service does (ResourceNotFoundException, AccessDeniedException, DecryptionFailure,
// InvalidRequestException for a secret scheduled for deletion, binary secrets). Its error messages quote the ARN, as a real one can, so a test proves the adapter never passes them on.
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

export const fakeSecretArn = (name: string): string => `arn:aws:secretsmanager:us-west-2:123456789012:secret:agentx/test/${name}-AbCdEf`;

export interface FakeModelKeySecret {
  string?: string;
  binary?: Uint8Array;
  failure?: "AccessDeniedException" | "DecryptionFailure" | "InvalidRequestException" | "ThrottlingException";
}

export class FakeModelKeySecrets {
  readonly secrets = new Map<string, FakeModelKeySecret>();
  readonly reads: string[] = [];

  async send(command: GetSecretValueCommand): Promise<{ SecretString?: string; SecretBinary?: Uint8Array }> {
    await Promise.resolve();
    if (!(command instanceof GetSecretValueCommand)) throw new Error("the fake answers GetSecretValue only");
    const arn = command.input.SecretId!;
    this.reads.push(arn);
    const secret = this.secrets.get(arn);
    if (secret === undefined) throw Object.assign(new Error(`Secrets Manager can't find the specified secret ${arn}`), { name: "ResourceNotFoundException" });
    if (secret.failure !== undefined) throw Object.assign(new Error(`${secret.failure} on ${arn}`), { name: secret.failure });
    return { ...(secret.string === undefined ? {} : { SecretString: secret.string }), ...(secret.binary === undefined ? {} : { SecretBinary: secret.binary }) };
  }

  /** A store's install keys for `keys` (provider to raw key), each in its own secret. */
  hold(keys: Record<string, string>): Record<string, string> {
    const arns: Record<string, string> = {};
    for (const [provider, key] of Object.entries(keys)) {
      arns[provider] = fakeSecretArn(provider);
      this.secrets.set(arns[provider], { string: key });
    }
    return arns;
  }
}
