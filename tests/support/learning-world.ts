// Test support for the v1.2 learning loop (B1): a table, a clock, a project scope and seeding helpers.
import type { OrgId } from "@rovara-code/contracts";
import { orgProjectCatalogKey, projectLearningKey } from "@rovara-code/contracts";
import { FakeDynamoDb } from "./fake-dynamodb.js";
import { TEST_ORG } from "./orgs.js";

export const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
export const DAY_MS = 86_400_000;
export const PROJECT_CREATED = "2026-10-01T00:00:00.000Z";
/** 2026-10-30 10:00 UTC, which is the start of a 10-minute rate window. */
export const NOW_MS = Date.parse("2026-10-30T10:00:00.000Z");

export interface World { db: FakeDynamoDb; clock: { ms: number }; deps: { documentClient: FakeDynamoDb; tableName: string; now: () => number }; scope: { orgId: OrgId; project: string; projectCreatedAt: string } }

export function makeWorld(options: { orgId?: OrgId; project?: string; projectCreatedAt?: string; db?: FakeDynamoDb } = {}): World {
  const db = options.db ?? new FakeDynamoDb();
  const clock = { ms: NOW_MS };
  return {
    db, clock,
    deps: { documentClient: db, tableName: "state", now: () => clock.ms },
    scope: { orgId: options.orgId ?? TEST_ORG, project: options.project ?? "web", projectCreatedAt: options.projectCreatedAt ?? PROJECT_CREATED },
  };
}

export const iso = (ms: number) => new Date(ms).toISOString();
export const epochSeconds = (ms: number) => Math.floor(ms / 1000);

/** A project in an org's catalog (the walk enumerates it), with a META item. */
export function seedProject(db: FakeDynamoDb, orgId: OrgId, name: string): void {
  db.set({ ...orgProjectCatalogKey(orgId, name), entityType: "PROJECT_CATALOG", name, orgId, latestRevision: 1 });
}

/** A raw learning item, as a writer would have stored it. */
export function seedItem(db: FakeDynamoDb, orgId: OrgId, project: string, sk: string, fields: Record<string, unknown> = {}): void {
  db.set({ ...projectLearningKey(orgId, project, sk), orgId, ...fields });
}

export function seedCorrection(db: FakeDynamoDb, orgId: OrgId, project: string, n: number, fields: { createdAtMs?: number; expiresAtSeconds?: number; projectCreatedAt?: string; text?: string } = {}): string {
  const createdAtMs = fields.createdAtMs ?? NOW_MS - n * 1000;
  const id = `c${String(n).padStart(5, "0")}`;
  const sk = `CORRECTION#${iso(createdAtMs)}#${id}`;
  seedItem(db, orgId, project, sk, {
    entityType: "LEARNING_CORRECTION", id, stage: "build", source: "comment", sourceRef: { taskId: `t${n}` }, taskId: `t${n}`, signature: ["h"], author: "dev1", standing: "member",
    createdAt: iso(createdAtMs), projectCreatedAt: fields.projectCreatedAt ?? PROJECT_CREATED, indexExpiresAt: fields.expiresAtSeconds ?? epochSeconds(createdAtMs) + 180 * 86400,
    ...(fields.text === undefined ? { text: "Use the shared retry helper." } : { text: fields.text }),
  });
  return sk;
}
