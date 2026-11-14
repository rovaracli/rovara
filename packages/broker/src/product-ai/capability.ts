// TE-F1e fork F1 (9d recommends, 7a confirmed 2026-11-14; DEC 211: a company key, Cloud only): the model-egress capability. A narrow claim, signed with its OWN asymmetric KMS key (ECC_NIST_P256, SIGN_VERIFY;
// the key policy denies kms:Sign to everyone but the dispatcher, the InvokeSigningKey pattern), verified by the ProductModelEgress function with the PUBLIC key only. It is NOT the callback capability: that one is
// an HMAC over the callback signing key, and a function that could verify it could also mint every callback capability for every company. This one cannot be minted by its verifier.
//
// Claims: the operation (workspace, operation, fence), an expiry and a purpose. Nothing names a company, a project or a source: the function loads those from its own State records for the operation. One module,
// imported by the signer (the dispatcher) and the verifier (the function): never copied.
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";

/** The token's first part: its family and version. Part of the signed text, so a signature over anything else (an invoke token, say) never verifies as this. */
export const MODEL_EGRESS_CAPABILITY_PREFIX = "pme-v1";
export const MODEL_EGRESS_CAPABILITY_MAX_CHARS = 2048;
/** The longest a capability may live: a task run's whole lifetime, with room. A token claiming more is refused. */
export const MODEL_EGRESS_CAPABILITY_MAX_LIFETIME_SECONDS = 24 * 60 * 60;

/** `task`: a call on the per-call path (a test that needs a real model). `eval-hold` and `real-model-run`: a whole-run hold (forks F2, F3, F8). */
export const MODEL_EGRESS_PURPOSES = ["task", "eval-hold", "real-model-run"] as const;
export type ModelEgressPurpose = (typeof MODEL_EGRESS_PURPOSES)[number];

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
export const ModelEgressCapabilityClaimsSchema = z
  .object({
    v: z.literal(1),
    purpose: z.enum(MODEL_EGRESS_PURPOSES),
    workspaceId: UUID,
    operationId: UUID,
    fence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    /** Epoch seconds. */
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type ModelEgressCapabilityClaims = z.infer<typeof ModelEgressCapabilityClaimsSchema>;

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

/** A DER ECDSA-SHA256 signature over the message, as KMS Sign returns it (`MessageType: RAW`, `ECDSA_SHA_256`). */
export type ModelEgressSigner = (message: Uint8Array) => Promise<Uint8Array>;

/** The token for `claims`: `pme-v1.<claims as base64url JSON>.<signature as base64url>`, the signature over the first two parts. */
export async function signModelEgressCapability(claims: ModelEgressCapabilityClaims, sign: ModelEgressSigner): Promise<string> {
  const checked = ModelEgressCapabilityClaimsSchema.parse(claims);
  const payload = Buffer.from(JSON.stringify(checked), "utf8").toString("base64url");
  const signed = `${MODEL_EGRESS_CAPABILITY_PREFIX}.${payload}`;
  const signature = await sign(Buffer.from(signed, "ascii"));
  return `${signed}.${Buffer.from(signature).toString("base64url")}`;
}

/** The KMS public key (base64 DER SubjectPublicKeyInfo, as GetPublicKey returns it, or PEM). Only a P-256 EC key is accepted. */
export function modelEgressPublicKey(encoded: string | Uint8Array): KeyObject {
  const key = typeof encoded !== "string"
    ? createPublicKey({ key: Buffer.from(encoded), format: "der", type: "spki" })
    : encoded.trim().startsWith("-----BEGIN") ? createPublicKey(encoded.trim()) : createPublicKey({ key: Buffer.from(encoded.trim(), "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("the model egress public key must be a P-256 EC key");
  return key;
}

/**
 * The claims of a valid, unexpired token, or undefined: any failure (shape, signature, claims, expiry, a lifetime over the maximum) is the same undefined, so the caller answers the one `not_found`. The signature is
 * checked before the claims are decoded. `nowSeconds` is epoch seconds.
 */
export function verifyModelEgressCapability(token: unknown, publicKey: KeyObject, nowSeconds: number): ModelEgressCapabilityClaims | undefined {
  if (typeof token !== "string" || token.length > MODEL_EGRESS_CAPABILITY_MAX_CHARS) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== MODEL_EGRESS_CAPABILITY_PREFIX || !BASE64URL.test(parts[1] ?? "") || !BASE64URL.test(parts[2] ?? "")) return undefined;
  const [, payload, signature] = parts as [string, string, string];
  let signed: boolean;
  try {
    signed = verify("sha256", Buffer.from(`${MODEL_EGRESS_CAPABILITY_PREFIX}.${payload}`, "ascii"), { key: publicKey, dsaEncoding: "der" }, Buffer.from(signature, "base64url"));
  } catch {
    signed = false;
  }
  if (!signed) return undefined;
  let claims: ModelEgressCapabilityClaims;
  try {
    const parsed = ModelEgressCapabilityClaimsSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown);
    if (!parsed.success) return undefined;
    claims = parsed.data;
  } catch {
    return undefined;
  }
  if (!Number.isSafeInteger(nowSeconds) || claims.expiresAt <= nowSeconds || claims.expiresAt - nowSeconds > MODEL_EGRESS_CAPABILITY_MAX_LIFETIME_SECONDS) return undefined;
  return claims;
}
