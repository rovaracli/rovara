import { describe, expect, it } from "vitest";
import { dynamoGroupMappingStore, decideSignIn, evaluateGroupMapping, groupsOfClaim } from "../../packages/broker/src/developer/group-mapping.js";
import { editionPolicy } from "../../packages/contracts/src/edition.js";
import {
  GROUP_CLAIM_MAX_GROUPS, GROUP_MAPPING_MESSAGES, GROUP_MAPPING_REFUSALS, GroupMappingConfigSchema, MAPPED_ORG_ROLE_PRECEDENCE, MappableOrgRoleSchema, groupMappingKey,
  type GroupMappingConfig,
} from "../../packages/contracts/src/sso.js";
import { OrgRoleSchema } from "../../packages/contracts/src/org.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as const;
const PERSON = "a".repeat(64);
const enterprise = editionPolicy("enterprise");
const publicPolicy = editionPolicy("public");

const config = (overrides: Partial<GroupMappingConfig> = {}): GroupMappingConfig => ({
  claim: "groups", version: 1, updatedAt: "2026-10-30T00:00:00.000Z", updatedBy: PERSON,
  rules: [
    { id: "eng-admins", group: "rovara-admins", orgRole: "admin", projectRoles: [] },
    { id: "eng", group: "engineering", orgRole: "member", projectRoles: [{ project: "payments", role: "contributor" }] },
    { id: "payments-leads", group: "payments-leads", orgRole: "member", projectRoles: [{ project: "payments", role: "maintainer" }, { project: "ledger", role: "viewer" }] },
  ],
  ...overrides,
});
const evaluate = (claims: Record<string, unknown>, cfg: unknown = config(), policy = enterprise) => evaluateGroupMapping({ policy, config: cfg, claims });

describe("group mapping evaluation", () => {
  it("grants the org role of a mapped group and the project roles of every mapped group, strongest wins", () => {
    const result = evaluate({ groups: ["engineering", "payments-leads", "unrelated"] });
    expect(result).toEqual({ ok: true, access: { orgRole: "member", projectRoles: [{ project: "ledger", role: "viewer" }, { project: "payments", role: "maintainer" }], matchedRuleIds: ["eng", "payments-leads"] } });
  });

  it("picks the strongest org role when a person is in several mapped groups", () => {
    expect(evaluate({ groups: ["engineering", "rovara-admins"] })).toMatchObject({ ok: true, access: { orgRole: "admin" } });
  });

  it("refuses a person in no mapped group", () => {
    expect(evaluate({ groups: ["marketing"] })).toEqual({ ok: false, reason: "no_group" });
    expect(evaluate({ groups: [] })).toEqual({ ok: false, reason: "no_group" });
  });

  it("matches a group exactly and case-sensitively, never by prefix or substring", () => {
    for (const group of ["Engineering", "engineering ", "engineering-extra", "engineer", " engineering", "rovara-admins\n"]) expect(evaluate({ groups: [group] })).toEqual({ ok: false, reason: "no_group" });
  });

  it("refuses when the claim is missing, or empty of meaning", () => {
    expect(evaluate({})).toEqual({ ok: false, reason: "claim_missing" });
    expect(evaluate({ groups: null })).toEqual({ ok: false, reason: "claim_missing" });
    expect(evaluate({ groups: undefined })).toEqual({ ok: false, reason: "claim_missing" });
    expect(evaluate({ roles: ["engineering"] })).toEqual({ ok: false, reason: "claim_missing" });
  });

  it("never reads a claim that merely inherits a name from the object prototype", () => {
    const claims = Object.create({ groups: ["rovara-admins"] }) as Record<string, unknown>;
    expect(evaluate(claims)).toEqual({ ok: false, reason: "claim_missing" });
  });

  it("refuses a claim of the wrong shape, an entry that is not a short string, and one with too many groups", () => {
    for (const groups of [42, true, { 0: "engineering" }, [1, "engineering"], ["engineering", null], ["engineering", ""], ["x".repeat(257)]]) {
      expect(evaluate({ groups })).toEqual({ ok: false, reason: "claim_invalid" });
    }
    const many = Array.from({ length: GROUP_CLAIM_MAX_GROUPS + 1 }, (_, index) => `g${String(index)}`);
    expect(evaluate({ groups: [...many.slice(0, GROUP_CLAIM_MAX_GROUPS - 1), "engineering"] })).toMatchObject({ ok: true });
    expect(evaluate({ groups: [...many, "engineering"] })).toEqual({ ok: false, reason: "claim_invalid" });
  });

  it("reads a single string as one group, and never splits it on spaces or commas", () => {
    expect(groupsOfClaim({ groups: "engineering" }, "groups")).toEqual({ ok: true, groups: ["engineering"] });
    expect(groupsOfClaim({ groups: "engineering rovara-admins" }, "groups")).toEqual({ ok: true, groups: ["engineering rovara-admins"] });
    expect(evaluate({ groups: "engineering,rovara-admins" })).toEqual({ ok: false, reason: "no_group" });
    expect(evaluate({ groups: "rovara-admins" })).toMatchObject({ ok: true, access: { orgRole: "admin" } });
  });

  it("uses the claim the config names", () => {
    expect(evaluate({ groups: ["rovara-admins"], memberOf: ["engineering"] }, config({ claim: "memberOf" }))).toMatchObject({ ok: true, access: { orgRole: "member" } });
  });

  it("refuses when no mapping is saved, and when the saved one does not parse", () => {
    expect(evaluateGroupMapping({ policy: enterprise, config: undefined, claims: { groups: ["engineering"] } })).toEqual({ ok: false, reason: "not_configured" });
    expect(evaluate({ groups: ["engineering"] }, null)).toEqual({ ok: false, reason: "not_configured" });
    expect(evaluate({ groups: ["engineering"] }, { claim: "groups" })).toEqual({ ok: false, reason: "config_invalid" });
    expect(evaluate({ groups: ["engineering"] }, "nonsense")).toEqual({ ok: false, reason: "config_invalid" });
  });

  it("never grants owner, even from a stored record that was changed to say so", () => {
    const tampered = config({ rules: [{ id: "x", group: "engineering", orgRole: "owner" as never, projectRoles: [] }] });
    expect(evaluate({ groups: ["engineering"] }, tampered)).toEqual({ ok: false, reason: "config_invalid" });
    expect(GroupMappingConfigSchema.safeParse(tampered).success).toBe(false);
    expect(MappableOrgRoleSchema.options).not.toContain("owner");
  });

  it("refuses the mapping on the Public edition, whatever it holds", () => {
    expect(evaluate({ groups: ["rovara-admins"] }, config(), publicPolicy)).toEqual({ ok: false, reason: "edition_off" });
  });

  it("ranks every mappable org role, so a role added later must be placed on purpose", () => {
    expect([...MAPPED_ORG_ROLE_PRECEDENCE].sort()).toEqual([...MappableOrgRoleSchema.options].sort());
    expect(MappableOrgRoleSchema.options).toEqual(OrgRoleSchema.options.filter((role) => role !== "owner"));
  });

  it("refuses a config with a repeated rule id or a group mapped twice, or no rules", () => {
    const rules = config().rules;
    expect(GroupMappingConfigSchema.safeParse(config({ rules: [rules[0]!, { ...rules[1]!, id: rules[0]!.id }] })).success).toBe(false);
    expect(GroupMappingConfigSchema.safeParse(config({ rules: [rules[0]!, { ...rules[1]!, group: rules[0]!.group }] })).success).toBe(false);
    expect(GroupMappingConfigSchema.safeParse(config({ rules: [] })).success).toBe(false);
    expect(GroupMappingConfigSchema.safeParse(config({ claim: "has space" })).success).toBe(false);
  });

  it("gives a fixed sentence for every refusal, and none echoes what the sign-in said", () => {
    for (const reason of GROUP_MAPPING_REFUSALS) expect(GROUP_MAPPING_MESSAGES[reason]).toMatch(/^[A-Z][^<>{}]*\.$/);
    const decision = decideSignIn({ policy: enterprise, config: config(), claims: { groups: ["<script>evil</script>"] }, currentRole: undefined });
    expect(decision).toMatchObject({ allow: false, reason: "no_group", message: GROUP_MAPPING_MESSAGES.no_group });
    expect(JSON.stringify(decision)).not.toContain("evil");
  });
});

describe("what a sign-in comes to", () => {
  it("lets a mapped person in with the mapped role", () => {
    expect(decideSignIn({ policy: enterprise, config: config(), claims: { groups: ["rovara-admins"] }, currentRole: "member" })).toMatchObject({ allow: true, orgRole: "admin", source: "mapping" });
  });

  it("takes access away when the person has left the mapped group, even if they were an admin", () => {
    expect(decideSignIn({ policy: enterprise, config: config(), claims: { groups: ["marketing"] }, currentRole: "admin" })).toMatchObject({ allow: false, reason: "no_group" });
  });

  it("lets an existing owner in as owner when the mapping is broken, missing or has no match (break-glass), and never changes that role", () => {
    for (const cfg of [undefined, { claim: "groups" }, config()]) {
      for (const claims of [{}, { groups: ["marketing"] }, { groups: ["rovara-admins"] }]) {
        expect(decideSignIn({ policy: enterprise, config: cfg, claims, currentRole: "owner" })).toMatchObject({ allow: true, orgRole: "owner", source: "owner" });
      }
    }
  });

  it("does not let a mapping make an owner of someone who is not one", () => {
    const decision = decideSignIn({ policy: enterprise, config: config(), claims: { groups: ["rovara-admins", "engineering"] }, currentRole: "member" });
    expect(decision).toMatchObject({ allow: true });
    expect((decision as { orgRole: string }).orgRole).not.toBe("owner");
  });
});

describe("the mapping store", () => {
  const setup = () => {
    const db = new FakeDynamoDb();
    return { db, store: dynamoGroupMappingStore({ documentClient: db, tableName: "state", policy: enterprise }) };
  };
  const body = () => { const { version: _version, ...rest } = config(); void _version; return rest; };

  it("saves a first mapping at version 1 and reads it back", async () => {
    const { store, db } = setup();
    expect(await store.get(ORG)).toBeUndefined();
    const saved = await store.put(ORG, body(), 0);
    expect(saved.version).toBe(1);
    expect(await store.get(ORG)).toEqual(saved);
    expect(db.get(groupMappingKey(ORG))).toMatchObject({ claim: "groups", version: 1 });
  });

  it("refuses a save from a stale read, so two admins cannot overwrite each other", async () => {
    const { store } = setup();
    await store.put(ORG, body(), 0);
    await expect(store.put(ORG, body(), 0)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const second = await store.put(ORG, { ...body(), claim: "memberOf" }, 1);
    expect(second.version).toBe(2);
    await expect(store.put(ORG, body(), 1)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await store.get(ORG))!.claim).toBe("memberOf");
  });

  it("refuses to save a mapping that grants owner or does not parse, and saves nothing", async () => {
    const { store, db } = setup();
    await expect(store.put(ORG, { ...body(), rules: [{ id: "x", group: "g", orgRole: "owner" as never, projectRoles: [] }] }, 0)).rejects.toBeDefined();
    await expect(store.put(ORG, { ...body(), claim: "bad claim" }, 0)).rejects.toBeDefined();
    await expect(store.put(ORG, body(), -1)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(db.get(groupMappingKey(ORG))).toBeUndefined();
  });

  it("refuses to read or save on the Public edition", async () => {
    const db = new FakeDynamoDb();
    const store = dynamoGroupMappingStore({ documentClient: db, tableName: "state", policy: publicPolicy });
    await expect(store.get(ORG)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(store.put(ORG, body(), 0)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("throws on a stored record that does not parse, so the sign-in is refused and not followed", async () => {
    const { store, db } = setup();
    await store.put(ORG, body(), 0);
    const key = groupMappingKey(ORG);
    const item = db.get(key) as unknown as { rules: Array<{ orgRole: string }> };
    item.rules[0]!.orgRole = "owner";
    await expect(store.get(ORG)).rejects.toBeDefined();
  });

  it("keeps each org's mapping apart", async () => {
    const { store } = setup();
    await store.put(ORG, body(), 0);
    expect(await store.get("org_bbbbbbbbbbbbbbbbbbbb")).toBeUndefined();
  });
});
