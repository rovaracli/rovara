// A SavedEnvDeps for tests of the wiring (routes, triggers, panel): the memory store, a fake registry and fake sessions, with the registry's own rules.
import { savedEnvRepositoryName, type SavedEnvManifest } from "../../packages/contracts/src/index.js";
import type { RegistryImage, RegistryPort, SavedEnvDeps, SavedEnvImageRecord, SavedEnvState } from "../../packages/broker/src/test-env/saved-env.js";
import { expectedRepositoryPolicy, type RepositoryDescription, type SavedEnvSessionConfig, type SavedEnvSessionPorts } from "../../packages/broker/src/test-env/saved-env-session.js";
import { memorySavedEnvStore } from "./memory-saved-env-store.js";

export const DAY = 86_400_000;
export const T0 = Date.parse("2026-11-02T12:00:00Z");
export const KMS = "arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555";
export const APPROVED = { revision: 4, digest: "a".repeat(64) };
export const KEY = "c".repeat(64);
export const COMMIT = "f".repeat(40);
export const iso = (ms: number): string => new Date(ms).toISOString();
export const dig = (n: number): string => `sha256:${String(n).repeat(64)}`;

export const manifestOf = (over: Partial<SavedEnvManifest> = {}): SavedEnvManifest => ({
  schemaVersion: 1, environmentKey: KEY, testEnvRevision: 4, commits: [{ repositoryId: "svc", sha: COMMIT }], proveReportDigest: "b".repeat(64), imageDigest: dig(1), builtAt: iso(T0), ...over,
});
export const imageOf = (digest: string, over: Partial<SavedEnvImageRecord> = {}): SavedEnvImageRecord => ({ approved: APPROVED, digest, tag: `k-${digest.slice(7, 12)}`, manifest: manifestOf({ imageDigest: digest }), recordedAt: iso(T0), status: "ready", ...over });

export interface WorldOptions {
  ids?: { orgId: string; projectId: string };
  enabled?: boolean; approved?: typeof APPROVED | undefined; key?: string | undefined; heads?: Map<string, string> | undefined; now?: number; images?: RegistryImage[];
  description?: RepositoryDescription | "absent"; registry?: Partial<RegistryPort>; keep?: number; proveHolds?: boolean;
}

export function savedEnvWorld(over: WorldOptions = {}) {
  const ids = over.ids ?? { orgId: "org-1", projectId: "proj-1" };
  const store = memorySavedEnvStore();
  const clock = { now: over.now ?? T0 };
  const config: SavedEnvSessionConfig = { enabled: over.enabled ?? true, env: "test", scope: { partition: "aws", region: "us-west-2", account: "111122223333" }, kmsKeyArn: KMS };
  const assumed: Array<{ roleArn: string; policy: string }> = [];
  const state = { approved: "approved" in over ? over.approved : APPROVED, key: "key" in over ? over.key : KEY, heads: "heads" in over ? over.heads : new Map([["svc", COMMIT]]) as Map<string, string> | undefined };
  const good = (): RepositoryDescription => ({ encryptionType: "KMS", kmsKey: KMS, imageTagMutability: "IMMUTABLE", policyText: JSON.stringify(expectedRepositoryPolicy(config)) });
  const ports: SavedEnvSessionPorts = {
    async assume(request) { assumed.push(request); return { credentials: { accessKeyId: "id", secretAccessKey: "s", sessionToken: "t" }, expiresAtMs: clock.now + 900_000 }; },
    async authorizationToken() { return { password: "p".repeat(30), registry: "111122223333.dkr.ecr.us-west-2.amazonaws.com", expiresAtMs: clock.now + 3_600_000 }; },
    async inspectRepository() { return over.description ?? good(); },
    async readApproved() { return state.approved; },
    async proveHolds() { return over.proveHolds ?? true; },
    now: () => clock.now,
  };
  const calls = { deleted: [] as string[][], repoDeleted: 0, scans: [] as string[] };
  const registry: RegistryPort = {
    async listImages() { return over.images ?? []; },
    async batchDelete(_c, _r, digests) { calls.deleted.push(digests); },
    async deleteRepository() { calls.repoDeleted += 1; return "deleted" as const; },
    async startScan(_c, _r, digest) { calls.scans.push(digest); },
    ...over.registry,
  };
  let counter = 0;
  const deps: SavedEnvDeps = {
    store, session: { config, ports }, registry,
    approved: async () => state.approved,
    currentKey: async () => state.key,
    defaultHeads: async () => state.heads,
    keep: async () => over.keep ?? 3,
    now: () => clock.now,
    random: () => { counter += 1; return `${String(counter).padStart(2, "0")}`.repeat(24); },
  };
  const repository = savedEnvRepositoryName({ env: "test", orgId: ids.orgId, projectId: ids.projectId });
  const seed = (change: Partial<SavedEnvState>): void => { store.rows.set(`${ids.orgId}#${ids.projectId}`, { orgId: ids.orgId, projectId: ids.projectId, version: 1, enabled: true, images: [], health: "never_proved", ...change }); };
  const row = (): SavedEnvState | undefined => store.rows.get(`${ids.orgId}#${ids.projectId}`);
  return { deps, store, clock, assumed, calls, ids, repository, seed, row, state };
}
