import { AwsError, AwsJsonClient, type CredentialSource, type WireTransport } from "./aws.js";
import type { KmsLike } from "./product-seal.js";

/**
 * KMS's JSON protocol for the two calls product-key sealing makes (product-seal.ts kmsProductKeyService): GenerateDataKey and
 * Decrypt, both with an encryption context. Node built-ins only (the image holds no node_modules), like aws.ts's other clients.
 * A KMS refusal is thrown with the service's error code as its `name` (InvalidCiphertextException, IncorrectKeyException, ...),
 * so the seal can tell "this record is not ours" from an outage. Blobs travel base64 both ways; nothing here is logged.
 */
export interface KmsClientOptions { region: string; credentials: CredentialSource; transport?: WireTransport; endpoint?: string; now?: () => number }

export class KmsRefused extends Error { constructor(code: string) { super("kms request refused"); this.name = code; } }

const blob = (value: unknown): Uint8Array | undefined => typeof value === "string" && value.length <= 16_384 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value) ? new Uint8Array(Buffer.from(value, "base64")) : undefined;

export function awsKms(options: KmsClientOptions): KmsLike {
  const client = new AwsJsonClient({ region: options.region, service: "kms", targetPrefix: "TrentService", contentType: "application/x-amz-json-1.1", credentials: options.credentials, ...(options.transport === undefined ? {} : { transport: options.transport }), ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }), ...(options.now === undefined ? {} : { now: options.now }) });
  const call = async (operation: string, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try { return await client.call(operation, input); }
    catch (error) { if (error instanceof AwsError) throw new KmsRefused(error.code); throw error; }
  };
  return {
    async generateDataKey(input) {
      const answer = await call("GenerateDataKey", { KeyId: input.KeyId, KeySpec: input.KeySpec, EncryptionContext: { ...input.EncryptionContext } });
      const plaintext = blob(answer.Plaintext); const wrapped = blob(answer.CiphertextBlob);
      return { ...(plaintext === undefined ? {} : { Plaintext: plaintext }), ...(wrapped === undefined ? {} : { CiphertextBlob: wrapped }) };
    },
    async decrypt(input) {
      const answer = await call("Decrypt", { KeyId: input.KeyId, CiphertextBlob: Buffer.from(input.CiphertextBlob).toString("base64"), EncryptionContext: { ...input.EncryptionContext } });
      const plaintext = blob(answer.Plaintext);
      return plaintext === undefined ? {} : { Plaintext: plaintext };
    },
  };
}
