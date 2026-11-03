// The signing side of a bundle, kept small on purpose: it is all the signing job's program needs from the release build (nothing here builds, exports or checks anything).
import { createHash } from "node:crypto";
import { BundleSignatureSchema, parseBundlePublicKey, sha256OfBytes, verifyBundleSignature, type BundleSignature } from "@agentx/contracts";

/** Signs bundle.json. `publicKeyPem` is the PUBLIC half the pipeline publishes and installers pin; the private half never leaves the signer (KMS). */
export interface BundleSigner {
  readonly publicKeyPem: string;
  sign(message: Buffer): Promise<Buffer>;
}

/** The release pipeline's signer: an AWS KMS asymmetric key (ECC_NIST_P256, ECDSA_SHA_256) named by id or ARN. The caller injects the KMS client. */
export interface KmsLike {
  send(command: unknown): Promise<unknown>;
}
export async function kmsBundleSigner(input: { client: KmsLike; keyId: string; commands: { GetPublicKeyCommand: new (input: { KeyId: string }) => unknown; SignCommand: new (input: { KeyId: string; Message: Uint8Array; MessageType: "DIGEST"; SigningAlgorithm: "ECDSA_SHA_256" }) => unknown } }): Promise<BundleSigner> {
  const { client, keyId, commands } = input;
  const publicKey = (await client.send(new commands.GetPublicKeyCommand({ KeyId: keyId }))) as { PublicKey?: Uint8Array };
  if (publicKey.PublicKey === undefined) throw new Error("KMS returned no public key for the signing key");
  const der = Buffer.from(publicKey.PublicKey);
  const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${(der.toString("base64").match(/.{1,64}/g) ?? []).join("\n")}\n-----END PUBLIC KEY-----\n`;
  parseBundlePublicKey(publicKeyPem);
  return {
    publicKeyPem,
    async sign(message) {
      // The digest is signed, not the message: bundle.json can exceed KMS's 4,096-byte raw message limit, and ECDSA over the SHA-256 digest verifies as ECDSA-SHA256 over the message.
      const response = (await client.send(new commands.SignCommand({ KeyId: keyId, Message: createHash("sha256").update(message).digest(), MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" }))) as { Signature?: Uint8Array };
      if (response.Signature === undefined) throw new Error("KMS returned no signature");
      return Buffer.from(response.Signature);
    },
  };
}


/** Signs exactly `manifestBytes` and checks the signature against the signer's own public key before returning it, so a mismatched key reference never produces a bundle nobody can verify. */
export async function signManifestBytes(signer: BundleSigner, manifestBytes: Buffer): Promise<BundleSignature> {
  const { keyId } = parseBundlePublicKey(signer.publicKeyPem);
  const signature = BundleSignatureSchema.parse({
    schemaVersion: 1, algorithm: "ecdsa-p256-sha256", keyId, bundleSha256: sha256OfBytes(manifestBytes), signature: (await signer.sign(manifestBytes)).toString("base64"),
  });
  const own = verifyBundleSignature({ manifestBytes, signature, trustedKeys: [signer.publicKeyPem] });
  if (!own.ok) throw new Error(`the signer's signature does not verify against its own public key: ${own.reason}`);
  return signature;
}
