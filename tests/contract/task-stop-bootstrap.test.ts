import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { expect, it } from "vitest";
import { orgMetaKey, orgSettingsKey, projectAiKey } from "@agentx/cloud-contracts";
import { agentGuardrailsKey, agentKey, orgScoped, builtinSettingsKey, ROVARA_CODE_AGENT_ID, BUILTIN_AGENT_IDS, orgProjectCatalogKey, DEFAULT_AGENT_GUARDRAILS } from "@rovara-code/contracts";
import * as taskStopBootstrap from "../../packages/broker/src/org/task-stop-bootstrap.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const orgId = "org_aaaaaaaaaaaaaaaaaaaa";
const who = "a".repeat(64);
const now = Date.parse("2026-10-29T22:00:00Z");
const policyKey = orgSettingsKey(orgId, "TASK_STOP_POLICY");
const seedKey = { pk: `ORG#${orgId}#TASK_STOP_SEED`, sk: "V1#bootstrap" };
function putItem(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  const put = entry.Put;
  if (typeof put !== "object" || put === null || !("Item" in put)) return undefined;
  const item = put.Item;
  return typeof item === "object" && item !== null ? Object.fromEntries(Object.entries(item)) : undefined;
}
function historicalBuiltin(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([field]) => !["orgId", "agentId", "revision", "stopKind", "seedProvenance"].includes(field)));
}
function fixture(pin = false) {
  const db = new FakeDynamoDb();
  const store = new OrgStore({ documentClient: db, tableName: "state", now: () => now, newOrgId: () => orgId, rovaraCodeV2ForNewOrgs: pin });
  return { db, store };
}
async function realLegacyAgent(f: ReturnType<typeof fixture>, agentId: string, extra: Record<string, unknown> = {}) {
 if (f.db.get(agentKey(orgId, agentId, "META")) === undefined) f.db.delete({ pk: orgScoped(orgId, "AGENT_DIRECTORY"), sk: agentId });
 const agents = new AgentStore({ documentClient: f.db, tableName: "state", now: () => now, newId: () => agentId });
 await agents.create({ orgId, name: agentId, owner: { kind: "member", developerId: who }, createdBy: who });
 const row = { ...f.db.get(agentKey(orgId, agentId, "META"))!, ...extra };delete row.revision;delete row.stopKind;f.db.set(row);return row;
}
for (const creation of ["ensureOrg", "createOrgWithOwner"] as const) {
  for (const pin of [false, true]) {
    it(`${creation} atomically bootstraps audited estimate-mode policy with version pin ${pin}`, async () => {
      const f = fixture(pin);
      if (creation === "ensureOrg") await f.store.ensureOrg(orgId, "Company");
      else await f.store.createOrgWithOwner({ name: "Company", developerId: who });
      expect(f.db.get(policyKey.pk, policyKey.sk)).toMatchObject({ orgId, entityType: "ORG_TASK_STOP_POLICY", revision: 1,
        policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } }, enrollment: { state: "disabled", version: 1 } });
      expect(f.db.get(agentGuardrailsKey(orgId).pk, "META")).toMatchObject({ entityType: "AGENT_GUARDRAILS", guardrails: { maxPerRunCeilingUsd: 100 } });
      expect(f.db.get(seedKey.pk, seedKey.sk)).toMatchObject({ orgId, entityType: "TASK_STOP_SEED", source: "bootstrap", version: 1 });
      const transaction = f.db.transactions().find(items => items.some(item => putItem(item)?.sk === "TASK_STOP_POLICY"));
      expect(transaction).toBeDefined();
      expect(transaction?.some(item => putItem(item)?.pk === orgMetaKey(orgId).pk && putItem(item)?.sk === "META")).toBe(true);
      const events = transaction?.flatMap(item => putItem(item)?.event === undefined ? [] : [putItem(item)?.event]);
      const seeded = events?.find(event => typeof event === "object" && event !== null && "action" in event && event.action === "spending.policy_seeded");
      expect(seeded).toMatchObject({ action: "spending.policy_seeded", actor: { kind: "system", id: "rovara" }, facts: { mode: "rovara_estimate", source: "bootstrap" } });
      expect(JSON.stringify(f.db.get(policyKey.pk, policyKey.sk))).not.toContain('"defaultStopMicrousd":10000000');
    });
  }
}
it("replaying ensureOrg never overwrites an admin policy or emits another seed", async () => {
  const f = fixture(); await f.store.ensureOrg(orgId, "Company");
  f.db.set({ ...policyKey, orgId, entityType: "ORG_TASK_STOP_POLICY", revision: 7, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 1234567 } } });
  const before = f.db.get(policyKey.pk, policyKey.sk);
  await f.store.ensureOrg(orgId, "New name");
  expect(f.db.get(policyKey.pk, policyKey.sk)).toEqual(before);
  expect(f.db.get(seedKey.pk, seedKey.sk)).toBeDefined();
});
it("a bootstrap transaction failure leaves no org or membership without its policy/audit", async () => {
  const f = fixture();
  f.db.set({ ...policyKey, orgId, revision: 2, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 1 } } });
  await expect(f.store.createOrgWithOwner({ name: "Company", developerId: who })).rejects.toThrow();
  expect(f.db.get(orgMetaKey(orgId).pk, "META")).toBeUndefined();
  expect(f.db.get(seedKey.pk, seedKey.sk)).toBeUndefined();
  expect(f.db.get(policyKey.pk, policyKey.sk)?.revision).toBe(2);
});

for (const existing of [false, true]) it(`upgrading an existing company records one audited outcome without overwriting policy: existing=${existing}`, async () => {
  const f = fixture();
  f.db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG", name: "Existing company" });
  if (existing) f.db.set({ ...policyKey, orgId, entityType: "ORG_TASK_STOP_POLICY", revision: 7,
    policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 1234567 } }, enrollment: { state: "disabled", version: 1 } });
  const original = f.db.get(policyKey.pk, policyKey.sk);
  const fn: unknown = Reflect.get(taskStopBootstrap, "bootstrapTaskStopPolicy"); expect(typeof fn).toBe("function");
  if (typeof fn !== "function") throw new Error("existing-company upgrade adapter missing");
  const invoke = fn as (deps: unknown, orgId: string) => Promise<unknown>;
  const deps = { documentClient: f.db, tableName: "state", now: () => now };
  expect(await invoke(deps, orgId)).toMatchObject({ outcome: existing ? "preserved" : "created" });
  const saved = f.db.get(policyKey.pk, policyKey.sk);
  if (existing) expect(saved).toEqual(original);
  else expect(saved).toMatchObject({ policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } }, enrollment: { state: "disabled" }, seedProvenance: { source: "upgrade", reviewRequired: true } });
  const upgradeKey = { pk: seedKey.pk, sk: "V1#upgrade" }, receipt = f.db.get(upgradeKey.pk, upgradeKey.sk);
  expect(receipt).toMatchObject({ source: "upgrade", outcome: existing ? "preserved" : "created", version: 1 });
  const count = f.db.transactions().length;
  expect(await invoke(deps, orgId)).toMatchObject({ outcome: existing ? "preserved" : "created" });
  expect(f.db.get(policyKey.pk, policyKey.sk)).toEqual(saved); expect(f.db.get(upgradeKey.pk, upgradeKey.sk)).toEqual(receipt);
  expect(f.db.transactions()).toHaveLength(count);
  const txn = f.db.transactions().find(items => items.some(item => putItem(item)?.sk === "V1#upgrade"));
  expect(txn?.some(item => typeof putItem(item)?.event === "object")).toBe(true);
});

for (const missing of ["occurrenceId", "sourceDigest", "completedAt", "policyRevision", "auditOccurrence"] as const) it(`upgrade replay refuses a receipt missing ${missing}`, async () => {
  const f = fixture();
  f.db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG" });
  const deps = { documentClient: f.db, tableName: "state", now: () => now };
  await taskStopBootstrap.bootstrapTaskStopPolicy(deps, orgId);
  const key = { pk: seedKey.pk, sk: "V1#upgrade" }, receipt = f.db.get(key.pk, key.sk)!;
  const damaged = { ...receipt }; delete damaged[missing]; f.db.set(damaged);
  const count = f.db.transactions().length;
  await expect(taskStopBootstrap.bootstrapTaskStopPolicy(deps, orgId)).rejects.toThrow();
  expect(f.db.transactions()).toHaveLength(count);
});

for (const race of ["policy", "ceiling", "closed"] as const) it(`upgrade rolls back atomically when native ${race} changes at commit`, async () => {
  const f = fixture(); const orgKey = orgMetaKey(orgId), guardKey = agentGuardrailsKey(orgId);
  f.db.set({ ...orgKey, orgId, entityType: "ORG" });
  const send = f.db.send.bind(f.db); let raced = false;
  f.db.send = async command => {
    if (!raced && command instanceof TransactWriteCommand) {
      raced = true;
      if (race === "policy") f.db.set({ ...policyKey, orgId, entityType: "ORG_TASK_STOP_POLICY", revision: 9, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 314159 } } });
      if (race === "ceiling") f.db.set({ ...guardKey, orgId, entityType: "AGENT_GUARDRAILS", revision: 9, guardrails: { maxPerRunCeilingUsd: 42 } });
      if (race === "closed") f.db.set({ ...orgKey, orgId, entityType: "ORG", closedAt: new Date(now).toISOString() });
    }
    return send(command);
  };
  await expect(taskStopBootstrap.bootstrapTaskStopPolicy({ documentClient: f.db, tableName: "state", now: () => now }, orgId)).rejects.toThrow();
  expect(raced).toBe(true);
  expect(f.db.get(seedKey.pk, "V1#upgrade")).toBeUndefined();
  expect(f.db.get(policyKey.pk, policyKey.sk)).toEqual(race === "policy" ? expect.objectContaining({ revision: 9 }) : undefined);
  expect(f.db.get(guardKey.pk, guardKey.sk)).toEqual(race === "ceiling" ? expect.objectContaining({ revision: 9 }) : undefined);
});

for (const source of ["bootstrap", "upgrade"] as const) it(`new ${source} ceiling carries explicit seed review provenance`, async () => {
  const f = fixture();
  if (source === "bootstrap") await f.store.ensureOrg(orgId, "Company");
  else {
    f.db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG" });
    await taskStopBootstrap.bootstrapTaskStopPolicy({ documentClient: f.db, tableName: "state", now: () => now }, orgId);
  }
  const key = agentGuardrailsKey(orgId);
  expect(f.db.get(key.pk, key.sk)).toMatchObject({ seedProvenance: { source, reviewRequired: true, seededAt: new Date(now).toISOString(), occurrence: `task-stop-${source}-v1#${orgId}` } });
});

for (const invalid of ["missing_enrollment", "bad_enrollment", "competing_ceiling"] as const) it(`upgrade refuses ambiguous existing configuration: ${invalid}`, async () => {
  const f = fixture(); await f.store.ensureOrg(orgId, "Company");
  // Exercise the distinct upgrade occurrence against existing bootstrap/admin rows.
  const key = invalid === "competing_ceiling" ? agentGuardrailsKey(orgId) : policyKey;
  const original = f.db.get(key.pk, key.sk)!;
  const changed = { ...original };
  if (invalid === "missing_enrollment") delete changed.enrollment;
  if (invalid === "bad_enrollment") changed.enrollment = { version: 1, state: "maybe" };
  if (invalid === "competing_ceiling") changed.ceilingMicrousd = 1;
  f.db.set(changed);
  const count = f.db.transactions().length;
  await expect(taskStopBootstrap.bootstrapTaskStopPolicy({ documentClient: f.db, tableName: "state", now: () => now }, orgId)).rejects.toThrow();
  expect(f.db.transactions()).toHaveLength(count);
  expect(f.db.get(seedKey.pk, "V1#upgrade")).toBeUndefined(); expect(f.db.get(key.pk, key.sk)).toEqual(changed);
});

it("upgrade preserves an administrator ceiling and records the actual seed outcome", async () => {
  const f = fixture(); f.db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG" });
  const key = agentGuardrailsKey(orgId), admin = { ...key, orgId, entityType: "AGENT_GUARDRAILS", revision: 7,
    guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: 37.25 }, updatedBy: who, updatedAt: new Date(now - 1000).toISOString() };
  f.db.set(admin);
  await taskStopBootstrap.bootstrapTaskStopPolicy({ documentClient: f.db, tableName: "state", now: () => now }, orgId);
  expect(f.db.get(key.pk, key.sk)).toEqual(admin);
  const txn = f.db.transactions().find(items => items.some(item => putItem(item)?.sk === "V1#upgrade"));
  const event = txn?.map(putItem).map(item => item?.event).find(event => typeof event === "object" && event !== null && "action" in event && event.action === "spending.policy_seeded");
  expect(event).toMatchObject({ actor: { kind: "system", id: "rovara" }, facts: { source: "upgrade", mode: "rovara_estimate", outcome: "created", ceilingMicrousd: 37250000 } });
  expect(f.db.get(policyKey.pk, policyKey.sk)).toMatchObject({ enrollment: { state: "disabled" } });
});

for (const explicit of [false, true]) it(`legacy agent upgrade records explicit stop kind without inventing money: explicit=${explicit}`, async () => {
  const f = fixture(), agentId = "agt_aaaaaaaaaaaaaaaaaaaa", key = agentKey(orgId, agentId, "META");
  f.db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG" });
  const original = await realLegacyAgent(f, agentId, { monthlyBudgetUsd: 50, ...(explicit ? { maxPerRunUsd: 0.123456 } : {}) });
  f.db.set(original);
  const fn: unknown = Reflect.get(taskStopBootstrap, "upgradeTaskStopInheritance"); expect(typeof fn).toBe("function");
  if (typeof fn !== "function") throw new Error("legacy resource upgrade missing");
  const invoke = fn as (deps: unknown, input: unknown) => Promise<unknown>;
  const deps = { documentClient: f.db, tableName: "state", now: () => now }, input = { orgId, kind: "agent", agentId };
  expect(await invoke(deps, input)).toMatchObject({ outcome: "updated" });
  const saved = f.db.get(key.pk, key.sk);
  expect(saved).toMatchObject({ ...original, stopKind: explicit ? "limited" : "inherit", seedProvenance: { source: "upgrade", reviewRequired: true } });
  if (!explicit) expect(saved).not.toHaveProperty("maxPerRunUsd");
  const count = f.db.transactions().length;
  expect(await invoke(deps, input)).toMatchObject({ outcome: "preserved" });
  expect(f.db.get(key.pk, key.sk)).toEqual(saved); expect(f.db.transactions()).toHaveLength(count);
});

for (const invalid of ["missing", "wrong_identity", "null_limit", "negative_limit", "contradiction", "closed"] as const) it(`legacy inheritance refuses ${invalid} without writes`, async () => {
  const f = fixture(), agentId = "agt_aaaaaaaaaaaaaaaaaaaa", key = agentKey(orgId, agentId, "META");
  f.db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG", ...(invalid === "closed" ? { closingAt: new Date(now).toISOString() } : {}) });
  if (invalid !== "missing") f.db.set({ ...key, orgId, entityType: "AGENT", agentId: invalid === "wrong_identity" ? "agt_bbbbbbbbbbbbbbbbbbbb" : agentId, status: "active", revision: 4,
    ...(invalid === "null_limit" ? { maxPerRunUsd: null } : invalid === "negative_limit" ? { maxPerRunUsd: -1 } : invalid === "contradiction" ? { stopKind: "limited" } : {}) });
  const original = f.db.get(key.pk, key.sk), count = f.db.transactions().length;
  await expect(taskStopBootstrap.upgradeTaskStopInheritance({ documentClient: f.db, tableName: "state", now: () => now }, { orgId, kind: "agent", agentId })).rejects.toThrow();
  expect(f.db.get(key.pk, key.sk)).toEqual(original); expect(f.db.transactions()).toHaveLength(count);
});
for (const race of ["limit", "closed"] as const) it(`legacy inheritance refuses native ${race} race and preserves its winner`, async () => {
  const f = fixture(), agentId = "agt_aaaaaaaaaaaaaaaaaaaa", key = agentKey(orgId, agentId, "META"), orgKey = orgMetaKey(orgId);
  f.db.set({ ...orgKey, orgId, entityType: "ORG" });
  const original = await realLegacyAgent(f, agentId, { monthlyBudgetUsd: 50 });
  f.db.set(original); const send = f.db.send.bind(f.db); let raced = false;
  f.db.send = async command => {
    if (!raced && command instanceof TransactWriteCommand) {
      raced = true;
      if (race === "limit") f.db.set({ ...original, maxPerRunUsd: 0.5 });
      else f.db.set({ ...orgKey, orgId, entityType: "ORG", closingAt: new Date(now).toISOString() });
    }
    return send(command);
  };
  await expect(taskStopBootstrap.upgradeTaskStopInheritance({ documentClient: f.db, tableName: "state", now: () => now }, { orgId, kind: "agent", agentId })).rejects.toThrow();
  expect(raced).toBe(true); expect(f.db.get(key.pk, key.sk)).toEqual(race === "limit" ? { ...original, maxPerRunUsd: 0.5 } : original);
});

for (const explicit of [false, true]) it(`project inheritance upgrade preserves numeric settings: explicit=${explicit}`, async () => {
  const f = fixture(), project = "payments", key = projectAiKey(orgId, project);
  f.db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG" });
  f.db.set({ ...orgProjectCatalogKey(orgId, project), orgId, entityType: "PROJECT_CATALOG", name: project, latestRevision: 2 });
  const original = { ...key, orgId, entityType: "PROJECT_AI", project, revision: 3, monthlyBudgetUsd: 50,
    ...(explicit ? { taskStopPolicy: { schemaVersion: 1, stopMicrousd: 123456 } } : {}) }; f.db.set(original);
  const fn: unknown = Reflect.get(taskStopBootstrap, "upgradeTaskStopProjectInheritance"); expect(typeof fn).toBe("function");
  if (typeof fn !== "function") throw new Error("project inheritance upgrade missing");
  const invoke = fn as (deps: unknown, input: unknown) => Promise<unknown>, deps = { documentClient: f.db, tableName: "state", now: () => now }, input = { orgId, project };
  expect(await invoke(deps, input)).toMatchObject({ outcome: explicit ? "preserved" : "updated" });
  const saved = f.db.get(key.pk, key.sk);
  expect(saved).toMatchObject(original);
  if (explicit) expect(saved).toEqual(original);
  else expect(saved).toMatchObject({ taskStopPolicy: { schemaVersion: 2, kind: "inherit" }, seedProvenance: { source: "upgrade", reviewRequired: true } });
  const count = f.db.transactions().length;
  expect(await invoke(deps, input)).toMatchObject({ outcome: "preserved" }); expect(f.db.transactions()).toHaveLength(count);
});

for (const failure of ["missing_catalog", "corrupt_policy", "catalog_commit", "policy_commit"] as const) it(`project inheritance refuses ${failure} without replacing authority`, async () => {
  const f = fixture(), project = "payments", key = projectAiKey(orgId, project), catalogKey = orgProjectCatalogKey(orgId, project);
  f.db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG" });
  const catalog = { ...catalogKey, orgId, entityType: "PROJECT_CATALOG", name: project, latestRevision: 2 };
  const original = { ...key, orgId, entityType: "PROJECT_AI", project, revision: 3, monthlyBudgetUsd: 50 };
  if (failure !== "missing_catalog") f.db.set(catalog);
  f.db.set({ ...original, ...(failure === "corrupt_policy" ? { taskStopPolicy: null } : {}) });
  const send = f.db.send.bind(f.db); let raced = false;
  f.db.send = async command => {
    if (!raced && failure.endsWith("_commit") && command instanceof TransactWriteCommand) {
      raced = true;
      if (failure === "catalog_commit") f.db.set({ ...catalog, latestRevision: 3 });
      else f.db.set({ ...original, taskStopPolicy: { schemaVersion: 1, stopMicrousd: 123456 } });
    }
    return send(command);
  };
  await expect(taskStopBootstrap.upgradeTaskStopProjectInheritance({ documentClient: f.db, tableName: "state", now: () => now }, { orgId, project })).rejects.toThrow();
  expect(raced).toBe(failure.endsWith("_commit"));
  const saved = f.db.get(key.pk, key.sk);
  expect(saved).toEqual({ ...original, ...(failure === "corrupt_policy" ? { taskStopPolicy: null } : failure === "policy_commit" ? { taskStopPolicy: { schemaVersion: 1, stopMicrousd: 123456 } } : {}) });
  if (saved !== undefined) expect(saved).not.toHaveProperty("seedProvenance");
});

for (const explicit of [false, true]) it(`built-in inheritance upgrade preserves the real org bootstrap pin: explicit=${explicit}`, async () => {
  const f = fixture(true); await f.store.createOrgWithOwner({ name: "Company", developerId: who });
  const key = builtinSettingsKey(orgId, ROVARA_CODE_AGENT_ID), before = historicalBuiltin(f.db.get(key.pk, key.sk)!);
  const original = { ...before, ...(explicit ? { maxPerRunUsd: 0.123456 } : {}) }; f.db.set(original);
  const deps = { documentClient: f.db, tableName: "state", now: () => now }, input = { orgId, kind: "agent" as const, agentId: ROVARA_CODE_AGENT_ID };
  expect(await taskStopBootstrap.upgradeTaskStopInheritance(deps, input)).toMatchObject({ outcome: "updated" });
  const saved = f.db.get(key.pk, key.sk);
  expect(saved).toMatchObject({ ...original, orgId, agentId: ROVARA_CODE_AGENT_ID, revision: 1, stopKind: explicit ? "limited" : "inherit" });
  if (!explicit) expect(saved).not.toHaveProperty("maxPerRunUsd");
  const count = f.db.transactions().length;
  expect(await taskStopBootstrap.upgradeTaskStopInheritance(deps, input)).toMatchObject({ outcome: "preserved" });
  expect(f.db.get(key.pk, key.sk)).toEqual(saved); expect(f.db.transactions()).toHaveLength(count);
});

for (const invalid of ["org", "agent", "revision", "pin"] as const) it(`built-in inheritance refuses corrupt ${invalid}`, async () => {
  const f = fixture(true); await f.store.createOrgWithOwner({ name: "Company", developerId: who });
  const key = builtinSettingsKey(orgId, ROVARA_CODE_AGENT_ID), original = f.db.get(key.pk, key.sk)!;
  const changed = { ...original, ...(invalid === "org" ? { orgId: "org_bbbbbbbbbbbbbbbbbbbb" } : invalid === "agent" ? { agentId: "rovara-triage" } : invalid === "revision" ? { revision: null } : { pinnedVersion: 99999 }) }; f.db.set(changed);
  const count = f.db.transactions().length;
  await expect(taskStopBootstrap.upgradeTaskStopInheritance({ documentClient: f.db, tableName: "state", now: () => now }, { orgId, kind: "agent", agentId: ROVARA_CODE_AGENT_ID })).rejects.toThrow();
  expect(f.db.transactions()).toHaveLength(count); expect(f.db.get(key.pk, key.sk)).toEqual(changed);
});
for (const race of ["pin", "identity"] as const) it(`built-in inheritance fences ${race} at the native write`, async () => {
  const f = fixture(true); await f.store.createOrgWithOwner({ name: "Company", developerId: who });
  const key = builtinSettingsKey(orgId, ROVARA_CODE_AGENT_ID), original = historicalBuiltin(f.db.get(key.pk, key.sk)!); f.db.set(original);
  const winner = { ...original, ...(race === "pin" ? { pinnedVersion: 1 } : { orgId: "org_bbbbbbbbbbbbbbbbbbbb" }) }, send = f.db.send.bind(f.db); let raced = false;
  f.db.send = async command => { if (!raced && command instanceof TransactWriteCommand) { raced = true; f.db.set(winner); } return send(command); };
  await expect(taskStopBootstrap.upgradeTaskStopInheritance({ documentClient: f.db, tableName: "state", now: () => now }, { orgId, kind: "agent", agentId: ROVARA_CODE_AGENT_ID })).rejects.toThrow();
  expect(raced).toBe(true); expect(f.db.get(key.pk, key.sk)).toEqual(winner); expect(f.db.get(key.pk, key.sk)).not.toHaveProperty("seedProvenance");
});

for (const creation of ["ensureOrg", "createOrgWithOwner"] as const) for (const pin of [false, true]) it(`${creation} seeds registered built-in inheritance atomically without duplicate pin writes: pin=${pin}`, async () => {
  const f = fixture(pin);
  if (creation === "ensureOrg") await f.store.ensureOrg(orgId, "Company");
  else await f.store.createOrgWithOwner({ name: "Company", developerId: who });
  const txn = f.db.transactions().find(items => items.some(item => putItem(item)?.sk === "TASK_STOP_POLICY"));
  for (const agentId of BUILTIN_AGENT_IDS) {
    const key = builtinSettingsKey(orgId, agentId), item = f.db.get(key.pk, key.sk);
    expect(item).toMatchObject({ entityType: "BUILTIN_AGENT_SETTINGS", orgId, agentId, revision: 1, stopKind: "inherit", seedProvenance: { source: "bootstrap", reviewRequired: true } });
    expect(item).not.toHaveProperty("maxPerRunUsd");
    expect(txn?.filter(entry => putItem(entry)?.pk === key.pk && putItem(entry)?.sk === key.sk)).toHaveLength(1);
  }
  const codeKey = builtinSettingsKey(orgId, ROVARA_CODE_AGENT_ID), code = f.db.get(codeKey.pk, codeKey.sk);
  if (creation === "createOrgWithOwner" && pin) expect(code).toMatchObject({ pinnedVersion: 2, updatedBy: who });
  else expect(code).not.toHaveProperty("pinnedVersion");
});

it("an existing company's registered built-in with no settings upgrades to explicit inheritance without pinning or money", async () => {
  const f = fixture(); f.db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG" });
  const deps = { documentClient: f.db, tableName: "state", now: () => now }, input = { orgId, kind: "agent" as const, agentId: ROVARA_CODE_AGENT_ID };
  expect(await taskStopBootstrap.upgradeTaskStopInheritance(deps, input)).toMatchObject({ outcome: "updated" });
  const key = builtinSettingsKey(orgId, ROVARA_CODE_AGENT_ID), saved = f.db.get(key.pk, key.sk);
  expect(saved).toMatchObject({ entityType: "BUILTIN_AGENT_SETTINGS", orgId, agentId: ROVARA_CODE_AGENT_ID, revision: 1, stopKind: "inherit", seedProvenance: { source: "upgrade", reviewRequired: true } });
  expect(saved).not.toHaveProperty("maxPerRunUsd"); expect(saved).not.toHaveProperty("pinnedVersion");
  const count = f.db.transactions().length;
  expect(await taskStopBootstrap.upgradeTaskStopInheritance(deps, input)).toMatchObject({ outcome: "preserved" }); expect(f.db.transactions()).toHaveLength(count);
});

it("absent built-in inheritance cannot overwrite concurrently created administrator settings", async () => {
  const f = fixture(); f.db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG" });
  const key = builtinSettingsKey(orgId, ROVARA_CODE_AGENT_ID), winner = { ...key, entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 1, maxPerRunUsd: 0.5, updatedBy: who }, send = f.db.send.bind(f.db); let raced = false;
  f.db.send = async command => { if (!raced && command instanceof TransactWriteCommand) { raced = true; f.db.set(winner); } return send(command); };
  const deps = { documentClient: f.db, tableName: "state", now: () => now }, input = { orgId, kind: "agent" as const, agentId: ROVARA_CODE_AGENT_ID };
  await expect(taskStopBootstrap.upgradeTaskStopInheritance(deps, input)).rejects.toThrow();
  expect(raced).toBe(true); expect(f.db.get(key.pk, key.sk)).toEqual(winner);
  expect(await taskStopBootstrap.upgradeTaskStopInheritance(deps, input)).toMatchObject({ outcome: "updated" });
  expect(f.db.get(key.pk, key.sk)).toMatchObject({ ...winner, stopKind: "limited", revision: 1 });
});

it("agent inheritance inventory advances bounded native directory pages without claiming enrollment readiness", async () => {
  const f = fixture(); f.db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG" });
  const ids = ["agt_aaaaaaaaaaaaaaaaaaaa", "agt_bbbbbbbbbbbbbbbbbbbb"];
  for (const agentId of ids) {
    f.db.set({ pk: orgScoped(orgId, "AGENT_DIRECTORY"), sk: agentId, entityType: "AGENT_DIRECTORY", agentId });
    await realLegacyAgent(f, agentId, { monthlyBudgetUsd: 50 });
  }
  const fn: unknown = Reflect.get(taskStopBootstrap, "upgradeTaskStopAgentInventoryPage"); expect(typeof fn).toBe("function");
  if (typeof fn !== "function") throw new Error("bounded inventory missing");
  const invoke = fn as (deps: unknown, input: unknown) => Promise<{ examined: number; updated: number; complete: boolean; cursor?: { pk: string; sk: string } }>;
  const deps = { documentClient: f.db, tableName: "state", now: () => now };
  const first = await invoke(deps, { orgId, limit: 1 });
  expect(first).toMatchObject({ examined: 1, updated: 1, complete: false, cursor: { pk: orgScoped(orgId, "AGENT_DIRECTORY"), sk: ids[0] } });
  expect(f.db.get(agentKey(orgId, ids[1]!, "META").pk, "META")).not.toHaveProperty("stopKind");
  const second = await invoke(deps, { orgId, limit: 1, cursor: first.cursor });
  expect(second).toMatchObject({ examined: 1, updated: 1, complete: true }); expect(second.cursor).toBeUndefined();
  expect(f.db.get(agentKey(orgId, ids[1]!, "META").pk, "META")).toMatchObject({ stopKind: "inherit", monthlyBudgetUsd: 50 });
  expect(f.db.get(policyKey.pk, policyKey.sk)).toBeUndefined();
});

it("a failed later inventory resource cannot return an advanced checkpoint and a repaired replay preserves earlier commits", async () => {
  const f = fixture(); f.db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG" });
  const ids = ["agt_aaaaaaaaaaaaaaaaaaaa", "agt_bbbbbbbbbbbbbbbbbbbb"];
  for (const agentId of ids) f.db.set({ pk: orgScoped(orgId, "AGENT_DIRECTORY"), sk: agentId, entityType: "AGENT_DIRECTORY", agentId });
  await realLegacyAgent(f, ids[0]!, { monthlyBudgetUsd: 50 });
  const deps = { documentClient: f.db, tableName: "state", now: () => now }, input = { orgId, limit: 2 };
  await expect(taskStopBootstrap.upgradeTaskStopAgentInventoryPage(deps, input)).rejects.toThrow();
  const first = f.db.get(agentKey(orgId, ids[0]!, "META").pk, "META"); expect(first).toMatchObject({ stopKind: "inherit", monthlyBudgetUsd: 50 });
  expect(f.db.get(agentKey(orgId, ids[1]!, "META").pk, "META")).toBeUndefined();
  await realLegacyAgent(f, ids[1]!, { monthlyBudgetUsd: 50 });
  expect(await taskStopBootstrap.upgradeTaskStopAgentInventoryPage(deps, input)).toMatchObject({ examined: 2, updated: 1, preserved: 1, complete: true });
  expect(f.db.get(agentKey(orgId, ids[0]!, "META").pk, "META")).toEqual(first);
});
for (const invalid of ["foreign", "builtin", "extra"] as const) it(`inventory refuses ${invalid} cursors before reads`, async () => {
  const f = fixture(); let reads = 0; const send = f.db.send.bind(f.db);
  f.db.send = async command => { reads += 1; return send(command); };
  const cursor = { pk: orgScoped(invalid === "foreign" ? "org_bbbbbbbbbbbbbbbbbbbb" : orgId, "AGENT_DIRECTORY"), sk: invalid === "builtin" ? ROVARA_CODE_AGENT_ID : "agt_aaaaaaaaaaaaaaaaaaaa", ...(invalid === "extra" ? { arbitrary: "no" } : {}) };
  await expect(taskStopBootstrap.upgradeTaskStopAgentInventoryPage({ documentClient: f.db, tableName: "state", now: () => now }, { orgId, limit: 1, cursor })).rejects.toThrow();
  expect(reads).toBe(0);
});

it("project inheritance inventory traverses bounded native catalog pages", async () => {
  const f = fixture(); f.db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG" });
  for (const project of ["alpha", "beta"]) {
    f.db.set({ ...orgProjectCatalogKey(orgId, project), orgId, entityType: "PROJECT_CATALOG", name: project, latestRevision: 1 });
    f.db.set({ ...projectAiKey(orgId, project), orgId, entityType: "PROJECT_AI", project, revision: 1, monthlyBudgetUsd: 50 });
  }
  const fn: unknown = Reflect.get(taskStopBootstrap, "upgradeTaskStopProjectInventoryPage"); expect(typeof fn).toBe("function");
  if (typeof fn !== "function") throw new Error("project inventory missing");
  const invoke = fn as (deps: unknown, input: unknown) => Promise<{ examined: number; updated: number; complete: boolean; cursor?: { pk: string; sk: string } }>, deps = { documentClient: f.db, tableName: "state", now: () => now };
  const first = await invoke(deps, { orgId, limit: 1 });
  expect(first).toMatchObject({ examined: 1, updated: 1, complete: false, cursor: orgProjectCatalogKey(orgId, "alpha") });
  expect(f.db.get(projectAiKey(orgId, "beta").pk, projectAiKey(orgId, "beta").sk)).not.toHaveProperty("taskStopPolicy");
  expect(await invoke(deps, { orgId, limit: 1, cursor: first.cursor })).toMatchObject({ examined: 1, updated: 1, complete: true });
  expect(f.db.get(projectAiKey(orgId, "beta").pk, projectAiKey(orgId, "beta").sk)).toMatchObject({ taskStopPolicy: { schemaVersion: 2, kind: "inherit" }, monthlyBudgetUsd: 50 });
  expect(f.db.get(policyKey.pk, policyKey.sk)).toBeUndefined();
});

it("project inheritance recognizes native legacy catalog and settings identity without invented org fields", async () => {
  const f = fixture(), project = "payments", catalogKey = orgProjectCatalogKey(orgId, project), key = projectAiKey(orgId, project);
  f.db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG" });
  // registerProjectFor and putRevised historically do not persist orgId.
  f.db.set({ ...catalogKey, entityType: "PROJECT_CATALOG", name: project, latestRevision: 2 });
  f.db.set({ ...key, entityType: "PROJECT_AI", project, revision: 3, monthlyBudgetUsd: 50 });
  expect(await taskStopBootstrap.upgradeTaskStopProjectInheritance({ documentClient: f.db, tableName: "state", now: () => now }, { orgId, project })).toMatchObject({ outcome: "updated" });
  expect(f.db.get(key.pk, key.sk)).toMatchObject({ orgId, project, monthlyBudgetUsd: 50, taskStopPolicy: { schemaVersion: 2, kind: "inherit" } });
  expect(f.db.get(catalogKey.pk, catalogKey.sk)).toMatchObject({ orgId, name: project, latestRevision: 2 });
});

it("legacy project identity migration preserves numeric policy and audits its project name", async () => {
  const f = fixture(), project = "payments", key = projectAiKey(orgId, project), catalogKey = orgProjectCatalogKey(orgId, project);
  f.db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG" });
  f.db.set({ ...catalogKey, entityType: "PROJECT_CATALOG", name: project, latestRevision: 2 });
  const policy = { schemaVersion: 1, stopMicrousd: 123456 };
  f.db.set({ ...key, entityType: "PROJECT_AI", project, revision: 3, monthlyBudgetUsd: 50, taskStopPolicy: policy });
  expect(await taskStopBootstrap.upgradeTaskStopProjectInheritance({ documentClient: f.db, tableName: "state", now: () => now }, { orgId, project })).toMatchObject({ outcome: "updated" });
  expect(f.db.get(key.pk, key.sk)).toMatchObject({ orgId, revision: 3, taskStopPolicy: policy, monthlyBudgetUsd: 50 });
  const txn = f.db.transactions().at(-1), event = txn?.map(putItem).map(item => item?.event).find(event => typeof event === "object" && event !== null && "action" in event && event.action === "spending.policy_seeded");
  expect(event).toMatchObject({ target: { kind: "project", name: project }, facts: { mode: "limited", source: "upgrade", outcome: "updated" } });
});

for (const target of ["catalog", "settings"] as const) for (const when of ["before", "commit"] as const) it(`project legacy identity refuses foreign ${target} org ${when}`, async () => {
  const f = fixture(), project = "payments", catalogKey = orgProjectCatalogKey(orgId, project), key = projectAiKey(orgId, project);
  f.db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG" });
  const catalog = { ...catalogKey, entityType: "PROJECT_CATALOG", name: project, latestRevision: 2 }, settings = { ...key, entityType: "PROJECT_AI", project, revision: 3, monthlyBudgetUsd: 50 };
  f.db.set(catalog); f.db.set(settings);
  const winner = { ...(target === "catalog" ? catalog : settings), orgId: "org_bbbbbbbbbbbbbbbbbbbb" }, send = f.db.send.bind(f.db); let raced = false;
  if (when === "before") f.db.set(winner);
  f.db.send = async command => { if (when === "commit" && !raced && command instanceof TransactWriteCommand) { raced = true; f.db.set(winner); } return send(command); };
  await expect(taskStopBootstrap.upgradeTaskStopProjectInheritance({ documentClient: f.db, tableName: "state", now: () => now }, { orgId, project })).rejects.toThrow();
  expect(raced).toBe(when === "commit");
  expect(f.db.get(catalogKey.pk, catalogKey.sk)).toEqual(target === "catalog" ? winner : catalog);
  expect(f.db.get(key.pk, key.sk)).toEqual(target === "settings" ? winner : settings);
});
it("project inventory replays its original page after a corrupt later settings row is repaired", async () => {
  const f = fixture(); f.db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG" });
  for (const project of ["alpha", "beta"]) f.db.set({ ...orgProjectCatalogKey(orgId, project), entityType: "PROJECT_CATALOG", name: project, latestRevision: 1 });
  const settings = (project: string) => ({ ...projectAiKey(orgId, project), entityType: "PROJECT_AI", project, revision: 1, monthlyBudgetUsd: 50 }); f.db.set(settings("alpha"));f.db.set({ ...settings("beta"), project: "other" });
  const deps = { documentClient: f.db, tableName: "state", now: () => now }, input = { orgId, limit: 2 };
  await expect(taskStopBootstrap.upgradeTaskStopProjectInventoryPage(deps, input)).rejects.toThrow();
  const key = projectAiKey(orgId, "alpha"), first = f.db.get(key.pk, key.sk); expect(first).toMatchObject({ orgId, taskStopPolicy: { schemaVersion: 2, kind: "inherit" } });
  f.db.set(settings("beta"));
  expect(await taskStopBootstrap.upgradeTaskStopProjectInventoryPage(deps, input)).toMatchObject({ examined: 2, updated: 1, preserved: 1, complete: true });
  expect(f.db.get(key.pk, key.sk)).toEqual(first);
});

it("registered built-in inventory is bounded and resumes against the same registry", async () => {
  const f = fixture(); f.db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG" });
  const fn: unknown = Reflect.get(taskStopBootstrap, "upgradeTaskStopBuiltinInventoryPage"); expect(typeof fn).toBe("function");
  if (typeof fn !== "function") throw new Error("builtin inventory missing");
  const invoke = fn as (deps: unknown, input: unknown) => Promise<{ examined: number; updated: number; complete: boolean; cursor?: { agentId: string; registryDigest: string } }>;
  const deps = { documentClient: f.db, tableName: "state", now: () => now };
  const first = await invoke(deps, { orgId, limit: 1 });
  expect(first).toMatchObject({ examined: 1, updated: 1, complete: false, cursor: { agentId: BUILTIN_AGENT_IDS[1] } });
  expect(first.cursor?.registryDigest).toMatch(/^[a-f0-9]{64}$/);
  const secondKey = builtinSettingsKey(orgId, BUILTIN_AGENT_IDS[1]); expect(f.db.get(secondKey.pk, secondKey.sk)).toBeUndefined();
  expect(await invoke(deps, { orgId, limit: 6, cursor: first.cursor })).toMatchObject({ examined: BUILTIN_AGENT_IDS.length - 1, updated: BUILTIN_AGENT_IDS.length - 1, complete: true });
  for (const agentId of BUILTIN_AGENT_IDS) {
    const key = builtinSettingsKey(orgId, agentId); expect(f.db.get(key.pk, key.sk)).toMatchObject({ orgId, agentId, stopKind: "inherit" });
  }
  expect(f.db.get(policyKey.pk, policyKey.sk)).toBeUndefined();
});

for (const invalid of ["foreign_org", "stale_registry", "custom_agent"] as const) it(`built-in inventory refuses ${invalid} cursor before reads`, async () => {
  const f = fixture(); f.db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG" });
  const deps = { documentClient: f.db, tableName: "state", now: () => now };
  const first = await taskStopBootstrap.upgradeTaskStopBuiltinInventoryPage(deps, { orgId, limit: 1 }); expect(first.cursor).toBeDefined();
  const otherOrg = "org_bbbbbbbbbbbbbbbbbbbb"; f.db.set({ ...orgMetaKey(otherOrg), orgId: otherOrg, entityType: "ORG" });
  const cursor = { ...first.cursor!, ...(invalid === "stale_registry" ? { registryDigest: "0".repeat(64) } : invalid === "custom_agent" ? { agentId: "agt_aaaaaaaaaaaaaaaaaaaa" } : {}) };
  const send = f.db.send.bind(f.db); let reads = 0; f.db.send = async command => { reads += 1; return send(command); };
  await expect(taskStopBootstrap.upgradeTaskStopBuiltinInventoryPage(deps, { orgId: invalid === "foreign_org" ? otherOrg : orgId, limit: 1, cursor })).rejects.toThrow();
  expect(reads).toBe(0);
});
it("a repaired built-in inventory replay preserves earlier committed metadata", async () => {
  const f = fixture(); f.db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG" });
  const badKey = builtinSettingsKey(orgId, BUILTIN_AGENT_IDS[1]); f.db.set({ ...badKey, entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 999999 });
  const deps = { documentClient: f.db, tableName: "state", now: () => now }, input = { orgId, limit: 6 };
  await expect(taskStopBootstrap.upgradeTaskStopBuiltinInventoryPage(deps, input)).rejects.toThrow();
  const key = builtinSettingsKey(orgId, BUILTIN_AGENT_IDS[0]), first = f.db.get(key.pk, key.sk); expect(first).toMatchObject({ stopKind: "inherit" });
  f.db.set({ ...badKey, entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 1 });
  expect(await taskStopBootstrap.upgradeTaskStopBuiltinInventoryPage(deps, input)).toMatchObject({ examined: 6, updated: 5, preserved: 1, complete: true });
  expect(f.db.get(key.pk, key.sk)).toEqual(first);
});

it("real custom-agent creation writes an explicit spending revision and inheritance kind", async () => {
 const f = fixture(), agents = new AgentStore({ documentClient: f.db, tableName: "state", now: () => now });
 const agent = await agents.create({ orgId, name: "Real new agent", owner: { kind: "member", developerId: who }, createdBy: who });
 expect(f.db.get(agentKey(orgId, agent.agentId, "META"))).toMatchObject({ revision: 1, stopKind: "inherit" });
});
it("a real legacy custom agent without fixture revisions can be upgraded", async () => {
 const f = fixture();await f.store.ensureOrg(orgId, "Company");const agents = new AgentStore({ documentClient: f.db, tableName: "state", now: () => now });
 const agent = await agents.create({ orgId, name: "Actual legacy agent", owner: { kind: "member", developerId: who }, createdBy: who }), key = agentKey(orgId, agent.agentId, "META"), legacy = { ...f.db.get(key)! };
 delete legacy.revision;delete legacy.stopKind;f.db.set(legacy);
 await taskStopBootstrap.upgradeTaskStopInheritance({ documentClient: f.db, tableName: "state", now: () => now }, { orgId, kind: "agent", agentId: agent.agentId });
 expect(f.db.get(key)).toMatchObject({ revision: 1, stopKind: "inherit", name: agent.name });
});
it("company upgrade accepts every cent ceiling through 100 USD exactly", async () => {
 for (let cents = 1; cents <= 10000; cents += 1) {
  const f = fixture();await f.store.ensureOrg(orgId, "Company");
  f.db.set({ ...f.db.get(agentGuardrailsKey(orgId))!, orgId, entityType: "AGENT_GUARDRAILS", revision: 1, guardrails: { ...DEFAULT_AGENT_GUARDRAILS, maxPerRunCeilingUsd: cents / 100 } });
  await taskStopBootstrap.bootstrapTaskStopPolicy({ documentClient: f.db, tableName: "state", now: () => now }, orgId);
  const events = f.db.find(row => (row.event as { action?: string } | undefined)?.action === "spending.policy_seeded");
  expect(events.some(row => (row.event as { facts?: { ceilingMicrousd?: number; source?: string } } | undefined)?.facts?.ceilingMicrousd === cents * 10000), `cent=${cents}`).toBe(true);
 }
}, 60000);
