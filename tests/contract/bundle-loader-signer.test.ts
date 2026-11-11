// N2/N3: the KMS signer's request shape and the ECR image loader, both with fakes (no AWS call, no skopeo run).
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BatchGetImageCommand, GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr";
import { BundleSignatureSchema, sha256OfBytes, verifyBundleSignature } from "@agentx/cloud-contracts";
import { kmsBundleSigner } from "../../scripts/release/bundle.js";
import { loadBundleImages } from "../../packages/cli/src/upgrade/bundle/load-images.js";
import { verifyBundle } from "../../packages/cli/src/upgrade/bundle/verify.js";
import { builtBundle, type BuiltBundle } from "../support/bundle-fixture.js";

describe("the KMS bundle signer", () => {
  it("signs the SHA-256 digest (bundle.json can exceed KMS's raw limit) and its signature verifies as ECDSA-SHA256 over the message", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const message = Buffer.alloc(9_000, 7);
    const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
    class GetPublicKeyCommand { constructor(readonly input: Record<string, unknown>) {} }
    class SignCommand { constructor(readonly input: Record<string, unknown>) {} }
    const client = { async send(command: unknown) {
      if (command instanceof GetPublicKeyCommand) { sent.push({ name: "GetPublicKey", input: command.input }); return { PublicKey: publicKey.export({ type: "spki", format: "der" }) }; }
      const input = (command as SignCommand).input; sent.push({ name: "Sign", input });
      return { Signature: sign("sha256", message, { key: privateKey, dsaEncoding: "der" }) };
    } };
    const signer = await kmsBundleSigner({ client, keyId: "alias/rovara-release", commands: { GetPublicKeyCommand, SignCommand } });
    const signature = await signer.sign(message);
    const sign_ = sent.find((entry) => entry.name === "Sign")!.input;
    expect(sign_).toMatchObject({ KeyId: "alias/rovara-release", MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" });
    expect(Buffer.from(sign_.Message as Uint8Array).toString("hex")).toBe(createHash("sha256").update(message).digest("hex"));
    const check = verifyBundleSignature({ manifestBytes: message, trustedKeys: [signer.publicKeyPem], signature: BundleSignatureSchema.parse({
      schemaVersion: 1, algorithm: "ecdsa-p256-sha256", keyId: createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex"), bundleSha256: sha256OfBytes(message), signature: signature.toString("base64") }) });
    expect(check.ok).toBe(true);
  });

  it("refuses a KMS key that is not ECDSA P-256", async () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    class C { constructor(readonly input: unknown) {} }
    await expect(kmsBundleSigner({ client: { send: async () => ({ PublicKey: publicKey.export({ type: "spki", format: "der" }) }) }, keyId: "k", commands: { GetPublicKeyCommand: C, SignCommand: C } })).rejects.toThrow(/ECDSA P-256/);
  });
});

describe("bundle signing keys", () => {
  it("accepts only an ECDSA P-256 public key: not another curve, not a private key", async () => {
    const { parseBundlePublicKey } = await import("@rovara-code/contracts");
    const p256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    expect(parseBundlePublicKey(p256.publicKey.export({ type: "spki", format: "pem" }).toString()).keyId).toMatch(/^[a-f0-9]{64}$/);
    expect(() => parseBundlePublicKey(generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey.export({ type: "spki", format: "pem" }).toString())).toThrow(/P-256/);
    expect(() => parseBundlePublicKey(p256.privateKey.export({ type: "pkcs8", format: "pem" }).toString())).toThrow(/PEM PUBLIC KEY/);
  });

  it("a bundle never verifies against the private half given as a trusted key", async () => {
    const bundle = await builtBundle(); made.push(bundle);
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const signed = await builtBundle({ key: { publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), signer: { publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), sign: async (message) => sign("sha256", message, { key: pair.privateKey, dsaEncoding: "der" }) } } });
    made.push(signed);
    await expect(verifyBundle({ dir: signed.dir, trustedKeys: [pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()] })).rejects.toThrow(/does not trust/);
    await verifyBundle({ dir: signed.dir, trustedKeys: [signed.key.publicKeyPem] });
  });
});

const made: BuiltBundle[] = [];
afterEach(async () => { await Promise.all(made.splice(0).map((bundle) => bundle.cleanup())); });

describe("loading bundle images into the install's ECR", () => {
  const PASSWORD = "pw-secret-value";
  async function setup(present: (repository: string, digest: string) => boolean, endpoint = "https://123456789012.dkr.ecr.us-east-1.amazonaws.com") {
    const bundle = await builtBundle(); made.push(bundle);
    const verified = await verifyBundle({ dir: bundle.dir, trustedKeys: [bundle.key.publicKeyPem] });
    const runs: Array<{ command: string; args: string[]; display: string }> = [];
    const loaded = new Set<string>();
    const ecr = { async send(command: unknown) {
      if (command instanceof GetAuthorizationTokenCommand) return { authorizationData: [{ authorizationToken: Buffer.from(`AWS:${PASSWORD}`).toString("base64"), proxyEndpoint: endpoint }] };
      if (command instanceof BatchGetImageCommand) {
        const { repositoryName, imageIds } = command.input as { repositoryName: string; imageIds: Array<{ imageDigest: string }> };
        const digest = imageIds[0]!.imageDigest;
        return { images: present(repositoryName, digest) || loaded.has(`${repositoryName}@${digest}`) ? [{}] : [] };
      }
      throw new Error("unexpected");
    } };
    const runner = { async run(command: string, args: string[], options: { display: string; redact?: (text: string) => string }) {
      runs.push({ command, args, display: options.display });
      const target = args[args.length - 1]!; const repo = /ecr\.us-east-1\.amazonaws\.com\/(.+):/.exec(target)![1]!;
      const image = verified.manifest.images.find((entry) => repo.endsWith(`/${entry.name}`))!;
      loaded.add(`${repo}@${/@(sha256:.+)$/.exec(image.sourceRef)![1]}`);
      return { stdout: "" };
    } };
    return { verified, ecr, runner, runs };
  }

  it("copies every image to rovara-bundle/<env>/<name>, keeps the credential out of the displayed command, and checks each digest afterwards", async () => {
    const h = await setup(() => false);
    await loadBundleImages({ bundle: h.verified, env: "ent", account: "123456789012", region: "us-east-1", ecr: h.ecr, runner: h.runner });
    expect(h.runs).toHaveLength(3);
    for (const run of h.runs) {
      expect(run.command).toBe("skopeo");
      // The credential is never on the command line (review M2): skopeo reads it from a private file that is gone afterwards.
      expect(run.args.join(" ")).not.toContain(PASSWORD);
      expect(run.args).toContain("--dest-authfile");
      expect(run.args).not.toContain("--dest-creds");
      expect(run.args).toEqual(expect.arrayContaining(["--all", "--preserve-digests"]));
      expect(run.display).not.toContain(PASSWORD);
      expect(run.args.some((arg) => arg.startsWith("docker://123456789012.dkr.ecr.us-east-1.amazonaws.com/rovara-bundle/ent/"))).toBe(true);
    }
  });

  it("writes the credential file readable by the owner only, and removes it", async () => {
    const h = await setup(() => false);
    let seen: { mode: number; text: string; dir: number } | undefined;
    const spying = { async run(command: string, args: string[], options: { display: string }) {
      const file = args[args.indexOf("--dest-authfile") + 1]!;
      if (seen === undefined) seen = { mode: statSync(file).mode & 0o777, text: readFileSync(file, "utf8"), dir: statSync(dirname(file)).mode & 0o777 };
      authFiles.push(file);
      return h.runner.run(command, args, options);
    } };
    const authFiles: string[] = [];
    await loadBundleImages({ bundle: h.verified, env: "ent", account: "123456789012", region: "us-east-1", ecr: h.ecr, runner: spying });
    expect(seen!.mode).toBe(0o600);
    expect(seen!.dir).toBe(0o700);
    expect(JSON.parse(seen!.text)).toEqual({ auths: { "123456789012.dkr.ecr.us-east-1.amazonaws.com": { auth: Buffer.from(`AWS:${PASSWORD}`).toString("base64") } } });
    expect(existsSync(authFiles[0]!)).toBe(false);
  });

  it("refuses a registry name that only starts like an ECR host", async () => {
    const h = await setup(() => false, "https://123456789012.dkr.ecr.us-east-1.amazonaws.com.example.net");
    await expect(loadBundleImages({ bundle: h.verified, env: "ent", account: "123456789012", region: "us-east-1", ecr: h.ecr, runner: h.runner })).rejects.toThrow(/other than this install/);
    expect(h.runs).toEqual([]);
  });

  it("skips an image the registry already holds by digest", async () => {
    const h = await setup((repository) => repository.endsWith("/litellm"));
    await loadBundleImages({ bundle: h.verified, env: "ent", account: "123456789012", region: "us-east-1", ecr: h.ecr, runner: h.runner });
    expect(h.runs).toHaveLength(2);
  });

  it("fails if, after the copy, the registry does not hold the digest the manifest names", async () => {
    const h = await setup(() => false);
    const lying = { async run() { return { stdout: "" }; } };
    await expect(loadBundleImages({ bundle: h.verified, env: "ent", account: "123456789012", region: "us-east-1", ecr: h.ecr, runner: lying })).rejects.toThrow(/does not hold sha256:/);
  });

  it("refuses a registry of another account in the same region", async () => {
    const h = await setup(() => false, "https://999999999999.dkr.ecr.us-east-1.amazonaws.com");
    await expect(loadBundleImages({ bundle: h.verified, env: "ent", account: "123456789012", region: "us-east-1", ecr: h.ecr, runner: h.runner })).rejects.toThrow(/other than this install/);
    expect(h.runs).toEqual([]);
  });

  it("refuses a registry that is not this install's own account and region, before any copy", async () => {
    const h = await setup(() => false, "https://999999999999.dkr.ecr.eu-west-1.amazonaws.com");
    await expect(loadBundleImages({ bundle: h.verified, env: "ent", account: "123456789012", region: "us-east-1", ecr: h.ecr, runner: h.runner })).rejects.toThrow(/other than this install/);
    expect(h.runs).toEqual([]);
  });
});
