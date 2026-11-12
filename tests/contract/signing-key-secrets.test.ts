// 0.5.15 signing-key lane: the callback signing key and the erasure hash key come from Secrets Manager (packages/broker/src/aws/signing-key-secrets.ts).
// Keys here are random at run time (never real-looking fixtures).
import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import {
  PREVIOUS_KEY_WINDOW_MS, callbackKeySource, callbackVerificationKeys, erasureKeySource, previousKeyOf, readCallbackKeyRing, type SigningSecretReader,
} from "../../packages/broker/src/aws/signing-key-secrets.js";
import { ensureErasureHashKey, SecretAlreadyExistsError, type SecretValueStore } from "../../packages/cli/src/deploy/signing-key.js";
import { askAliasHashKey, aliasHashesOf, scrubWithAliasHashes } from "../../packages/broker/src/agent-sessions/ask-erased-aliases.js";
import { verifyCapability } from "../../packages/broker/src/aws/broker/admin-and-helpers.js";
import { issueProjectSetupCapability, verifyProjectSetupCapability } from "../../packages/broker/src/aws/project-setup-capability.js";
import { verifyCancelCallbackCapability } from "../../packages/broker/src/aws/cancel-callback-capability.js";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import { deriveCancelCallbackKey } from "@rovara-code/contracts";
import type { AwsBrokerDependencies } from "../../packages/broker/src/aws/broker/definitions.js";

const newKey = (): string => randomBytes(48).toString("base64url");
const awsError = (name: string): Error => Object.assign(new Error(name), { name });

/** A fake Secrets Manager holding versions per secret: AWSCURRENT and (after a put) AWSPREVIOUS, the way PutSecretValue moves the labels. */
function fakeSecretsManager() {
  const secrets = new Map<string, { current: { value: string; createdAt: Date }; previous?: { value: string; createdAt: Date } }>();
  const calls: Array<{ id: string; stage: string }> = [];
  const reader: SigningSecretReader = {
    async send(command: GetSecretValueCommand) {
      const id = command.input.SecretId!;
      const stage = command.input.VersionStage ?? "AWSCURRENT";
      calls.push({ id, stage });
      const secret = secrets.get(id);
      const version = stage === "AWSPREVIOUS" ? secret?.previous : secret?.current;
      if (version === undefined) throw awsError("ResourceNotFoundException");
      return { SecretString: version.value, CreatedDate: version.createdAt };
    },
  };
  return {
    reader, calls,
    put(id: string, value: string, createdAt: Date) {
      const existing = secrets.get(id);
      secrets.set(id, { current: { value, createdAt }, ...(existing === undefined ? {} : { previous: existing.current }) });
    },
    /** The same store as the CLI sees it (create only, never overwrite), for the migration. */
    asValueStore(createdAt: Date): SecretValueStore {
      return {
        get: async (name) => secrets.get(name)?.current.value,
        create: async (name, value) => {
          if (secrets.has(name)) throw new SecretAlreadyExistsError(name);
          secrets.set(name, { current: { value, createdAt } });
        },
      };
    },
  };
}

const CALLBACK = "agentx/staging/callback-signing-key";
const ERASURE = "agentx/staging/erasure-hash-key";
const NAMED = { AGENTX_ENV: "staging" };

function workerToken(key: string, expiresAt: number): string {
  const body = Buffer.from(JSON.stringify({ workspaceId: "w", operationId: "o", fence: 1, actions: ["result"], expiresAt })).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}
function cancelToken(key: string, expiresAt: number): string {
  const body = Buffer.from(JSON.stringify({
    version: 1, purpose: "cancel-result", workspaceId: crypto.randomUUID(), operationId: crypto.randomUUID(), targetOperationId: crypto.randomUUID(), fence: 1, actions: ["result"], expiresAt,
  })).toString("base64url");
  return `cancel-v1.${body}.${createHmac("sha256", deriveCancelCallbackKey(key)).update(`cancel-v1.${body}`).digest("base64url")}`;
}

describe("the key loader (signing-key-secrets.ts)", () => {
  it("reads a named environment's two secrets by name, once each, and refuses (closed) without one", async () => {
    const sm = fakeSecretsManager();
    const key = newKey();
    sm.put(CALLBACK, key, new Date());
    const callback = callbackKeySource(NAMED, () => sm.reader);
    const erasure = erasureKeySource(NAMED, () => sm.reader);
    expect(await callback()).toEqual({ current: key });
    expect(await callback()).toEqual({ current: key });
    // The erasure secret does not exist yet: refused, with the error's name only, never a value.
    const refused = await erasure().catch((error: Error) => error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toBe("the erasure hash key could not be read (ResourceNotFoundException)");
    expect((refused as Error).message).not.toContain(key);
    // A failed read is not kept: once the secret exists, the next call reads it.
    sm.put(ERASURE, key, new Date());
    expect(await erasure()).toBe(key);
    expect(sm.calls.filter((call) => call.id === CALLBACK && call.stage === "AWSCURRENT")).toHaveLength(1);
    expect(sm.calls.every((call) => call.id === CALLBACK || call.id === ERASURE)).toBe(true);
  });

  it("refuses a short key and an environment with no key at all", async () => {
    const sm = fakeSecretsManager();
    sm.put(CALLBACK, "short", new Date());
    await expect(callbackKeySource(NAMED, () => sm.reader)()).rejects.toThrow(/missing or shorter than 32 bytes/);
    await expect(callbackKeySource({}, () => sm.reader)()).rejects.toThrow(/no signing key is configured/);
  });

  it("serves the legacy install's one variable for both kinds, with no read", async () => {
    const sm = fakeSecretsManager();
    const key = newKey();
    expect(await callbackKeySource({ CALLBACK_SIGNING_KEY: key }, () => sm.reader)()).toEqual({ current: key });
    expect(await erasureKeySource({ CALLBACK_SIGNING_KEY: key }, () => sm.reader)()).toBe(key);
    expect(sm.calls).toEqual([]);
  });
});

describe("migration: the erasure hash key starts as the callback signing key and keeps every stored hash", () => {
  it("is seeded once from the current key, never overwritten, and a hash made before the split still matches after it and after a rotation", async () => {
    const sm = fakeSecretsManager();
    const original = newKey();
    sm.put(CALLBACK, original, new Date("2026-11-01T00:00:00Z"));
    // Before 0.5.15: the broker hashed an erased person's aliases with askAliasHashKey(CALLBACK_SIGNING_KEY).
    const storedBefore = aliasHashesOf(askAliasHashKey(original), { names: ["Ada Lovelace"], handles: ["ada@example.test"] });

    expect(await ensureErasureHashKey(sm.asValueStore(new Date()), "staging", original)).toBe("created");
    // A later deploy (or a race) never overwrites it, whatever key it holds.
    expect(await ensureErasureHashKey(sm.asValueStore(new Date()), "staging", newKey())).toBe("kept");

    // After: the broker reads the erasure secret and hashes with it; the stored hashes still match and still scrub.
    const erasure = await erasureKeySource(NAMED, () => sm.reader)();
    expect(erasure).toBe(original);
    expect(aliasHashesOf(askAliasHashKey(erasure), { names: ["Ada Lovelace"], handles: ["ada@example.test"] })).toEqual(storedBefore);
    expect(scrubWithAliasHashes("ask Ada Lovelace", [{ tag: "t", ...storedBefore }], askAliasHashKey(erasure))).not.toContain("Lovelace");

    // Rotating the callback signing key leaves the erasure key, and so every stored hash, unchanged.
    sm.put(CALLBACK, newKey(), new Date());
    expect(await erasureKeySource(NAMED, () => sm.reader)()).toBe(original);
  });

  it("refuses to seed from a short key", async () => {
    await expect(ensureErasureHashKey(fakeSecretsManager().asValueStore(new Date()), "staging", "short")).rejects.toThrow(/too short/);
  });
});

describe("rotation: tokens signed with the previous key verify during the overlap and fail after it", () => {
  const rotated = async () => {
    const sm = fakeSecretsManager();
    const previous = newKey(), current = newKey();
    const rotatedAt = new Date("2026-11-11T00:00:00Z");
    sm.put(CALLBACK, previous, new Date("2026-10-01T00:00:00Z"));
    sm.put(CALLBACK, current, rotatedAt);
    return { ring: await readCallbackKeyRing(sm.reader, "staging"), previous, current, rotatedAt: rotatedAt.getTime() };
  };

  it("keeps the previous key only inside its window, and never issues with it", async () => {
    const { ring, previous, current, rotatedAt } = await rotated();
    expect(ring.current).toBe(current);
    expect(previousKeyOf(ring, rotatedAt + PREVIOUS_KEY_WINDOW_MS - 1)).toBe(previous);
    expect(previousKeyOf(ring, rotatedAt + PREVIOUS_KEY_WINDOW_MS)).toBeUndefined();
    expect(callbackVerificationKeys({ callbackSigningKey: ring.current, callbackPreviousKey: () => previousKeyOf(ring, rotatedAt + 1) })).toEqual([current, previous]);
  });

  it("has no previous key before the first rotation", async () => {
    const sm = fakeSecretsManager();
    sm.put(CALLBACK, newKey(), new Date());
    expect((await readCallbackKeyRing(sm.reader, "staging")).previous).toBeUndefined();
  });

  it("worker callbacks, setup, cancel and repository grant tokens", async () => {
    const { ring, previous, current, rotatedAt } = await rotated();
    let nowMs = rotatedAt + 60_000;
    const dependencies = { callbackSigningKey: ring.current, callbackPreviousKey: () => previousKeyOf(ring, nowMs) } as unknown as AwsBrokerDependencies;
    const later = Math.floor(Date.now() / 1000) + 3600;

    // During the overlap: both keys verify.
    expect(verifyCapability(dependencies, workerToken(previous, later), "result").operationId).toBe("o");
    expect(verifyCapability(dependencies, workerToken(current, later), "result").operationId).toBe("o");
    const setupClaims = { domain: "PROJECT_SETUP" as const, setupExecutionId: crypto.randomUUID(), subjectId: crypto.randomUUID(), transportCorrelationId: crypto.randomUUID(), operationId: crypto.randomUUID(), approvalRevision: 1, fence: 1, expiresAt: later, actions: ["result" as const] };
    const setupToken = issueProjectSetupCapability(previous, setupClaims);
    expect(verifyProjectSetupCapability(callbackVerificationKeys(dependencies), setupToken)).toBeDefined();
    const cancel = cancelToken(previous, later);
    expect(verifyCancelCallbackCapability(callbackVerificationKeys(dependencies), cancel, "result").purpose).toBe("cancel-result");
    const grantKey = (key: string) => createHmac("sha256", key).update("agentx:repository-grants:v3").digest();
    const resolve = async () => ({ kind: "token", token: "t" }) as never;
    const oldGrants = new RepositoryGrantService(grantKey(previous), resolve);
    const grant = oldGrants.issue({ ownerKey: "o", projectName: "p", workspaceId: "w", operationId: "o", repositories: [{ credentialRef: "c", repositoryUrl: "https://github.com/a/b", access: "read" }] as never });
    const newGrants = new RepositoryGrantService(grantKey(current), resolve, undefined, () => (previousKeyOf(ring, nowMs) === undefined ? undefined : grantKey(previous)));
    const verifyGrant = (service: RepositoryGrantService) => (service as unknown as { verify(grant: string): unknown }).verify(grant);
    expect(verifyGrant(newGrants)).toMatchObject({ ownerKey: "o" });

    // After the window: the previous key verifies nothing; the current still does.
    nowMs = rotatedAt + PREVIOUS_KEY_WINDOW_MS + 1;
    expect(() => verifyCapability(dependencies, workerToken(previous, later), "result")).toThrow(/invalid callback signature/);
    expect(verifyCapability(dependencies, workerToken(current, later), "result").operationId).toBe("o");
    expect(verifyProjectSetupCapability(callbackVerificationKeys(dependencies), setupToken)).toBeUndefined();
    expect(() => verifyCancelCallbackCapability(callbackVerificationKeys(dependencies), cancel, "result")).toThrow(/invalid cancel callback capability/);
    expect(() => verifyGrant(newGrants)).toThrow(/invalid repository grant signature/);
  });
});
