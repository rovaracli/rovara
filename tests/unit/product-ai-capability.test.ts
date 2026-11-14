// TE-F1e fork F1: the model-egress capability is signed by one key and verified with its public half only; every failure is the same undefined.
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MODEL_EGRESS_CAPABILITY_MAX_LIFETIME_SECONDS, modelEgressPublicKey, signModelEgressCapability, verifyModelEgressCapability, type ModelEgressCapabilityClaims } from "../../packages/broker/src/product-ai/capability.js";

const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const signer = (key = pair.privateKey) => async (message: Uint8Array) => cryptoSign("sha256", message, { key, dsaEncoding: "der" });
const NOW = 1_800_000_000;
const claims: ModelEgressCapabilityClaims = { v: 1, purpose: "task", workspaceId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222", fence: 3, expiresAt: NOW + 600 };

describe("model-egress capability", () => {
  it("verifies a token it signed and gives back exactly the claims", async () => {
    const token = await signModelEgressCapability(claims, signer());
    expect(token.startsWith("pme-v1.")).toBe(true);
    expect(verifyModelEgressCapability(token, pair.publicKey, NOW)).toEqual(claims);
  });

  it("refuses another key's signature, a changed claim, a changed prefix and junk, all as undefined", async () => {
    const token = await signModelEgressCapability(claims, signer());
    expect(verifyModelEgressCapability(await signModelEgressCapability(claims, signer(other.privateKey)), pair.publicKey, NOW)).toBeUndefined();
    const [prefix, payload, signature] = token.split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ ...claims, fence: 4 })).toString("base64url");
    expect(verifyModelEgressCapability(`${prefix}.${forged}.${signature}`, pair.publicKey, NOW)).toBeUndefined();
    expect(verifyModelEgressCapability(`pme-v2.${payload}.${signature}`, pair.publicKey, NOW)).toBeUndefined();
    for (const junk of [undefined, 7, "", "a.b", "pme-v1..", `${token}.x`, "x".repeat(3000), `${prefix}.${payload}.${signature}=`]) expect(verifyModelEgressCapability(junk, pair.publicKey, NOW)).toBeUndefined();
  });

  it("refuses an expired token, one expiring now, and one claiming more than the longest lifetime", async () => {
    expect(verifyModelEgressCapability(await signModelEgressCapability({ ...claims, expiresAt: NOW }, signer()), pair.publicKey, NOW)).toBeUndefined();
    expect(verifyModelEgressCapability(await signModelEgressCapability({ ...claims, expiresAt: NOW - 1 }, signer()), pair.publicKey, NOW)).toBeUndefined();
    expect(verifyModelEgressCapability(await signModelEgressCapability({ ...claims, expiresAt: NOW + MODEL_EGRESS_CAPABILITY_MAX_LIFETIME_SECONDS + 1 }, signer()), pair.publicKey, NOW)).toBeUndefined();
    expect(verifyModelEgressCapability(await signModelEgressCapability({ ...claims, expiresAt: NOW + MODEL_EGRESS_CAPABILITY_MAX_LIFETIME_SECONDS }, signer()), pair.publicKey, NOW)).toEqual({ ...claims, expiresAt: NOW + MODEL_EGRESS_CAPABILITY_MAX_LIFETIME_SECONDS });
  });

  it("carries no company, project or source, and refuses a token whose claims add one (strict claims)", async () => {
    const token = await signModelEgressCapability(claims, signer());
    const decoded = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(Object.keys(decoded).sort()).toEqual(["expiresAt", "fence", "operationId", "purpose", "v", "workspaceId"]);
    const payload = Buffer.from(JSON.stringify({ ...claims, orgId: "org_bbbbbbbbbbbbbbbbbbbb" })).toString("base64url");
    const signature = Buffer.from(await signer()(Buffer.from(`pme-v1.${payload}`, "ascii"))).toString("base64url");
    expect(verifyModelEgressCapability(`pme-v1.${payload}.${signature}`, pair.publicKey, NOW)).toBeUndefined();
    await expect(signModelEgressCapability({ ...claims, project: "web" } as never, signer())).rejects.toThrow();
  });

  it("accepts only a P-256 public key, as KMS GetPublicKey's DER or PEM", () => {
    const der = pair.publicKey.export({ format: "der", type: "spki" });
    expect(modelEgressPublicKey(new Uint8Array(der)).asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(modelEgressPublicKey(der.toString("base64")).asymmetricKeyType).toBe("ec");
    expect(modelEgressPublicKey(pair.publicKey.export({ format: "pem", type: "spki" }).toString()).asymmetricKeyType).toBe("ec");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => modelEgressPublicKey(rsa.publicKey.export({ format: "pem", type: "spki" }).toString())).toThrow(/P-256/u);
  });
});
