import { describe, expect, it } from "vitest";
import { dynamoGroupMappingStore, decideSignIn, evaluateGroupMapping, groupsOfClaim, readMappingForSignIn } from "../../packages/broker/src/developer/group-mapping.js";
import { ENTERPRISE_SESSION_MAX_SECONDS, editionPolicy } from "../../packages/cloud-contracts/src/edition.js";
import { BREAK_GLASS_FRESH_AUTH_SECONDS, BREAK_GLASS_SESSION_MAX_SECONDS, GROUP_CLAIM_MAX_GROUPS, GROUP_CLAIM_NAMES, GROUP_MAPPING_MESSAGES, GROUP_MAPPING_REFUSALS, GroupMappingConfigSchema, MAPPED_ORG_ROLE_PRECEDENCE, MappableOrgRoleSchema, groupMappingKey, type GroupMappingConfig } from "../../packages/cloud-contracts/src/sso.js";
import { OrgRoleSchema } from "../../packages/cloud-contracts/src/org.js";
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
    const decision = decideSignIn({ ...base, claims: { groups: ["<script>evil</script>"] }, currentRole: undefined });
    expect(decision).toMatchObject({ allow: false, reason: "no_group", message: GROUP_MAPPING_MESSAGES.no_group });
    expect(JSON.stringify(decision)).not.toContain("evil");
  });
});

const OWNER_A = "c".repeat(64);
const OWNER_B = "d".repeat(64);
const NOW = 1_000_000;
const base = { policy: enterprise, config: config(), claims: { groups: ["rovara-admins"] } as Record<string, unknown>, currentRole: "member" as const, personId: PERSON, breakGlass: [{ personId: OWNER_A }], now: NOW };

describe("what a sign-in comes to", () => {
  it("lets a mapped person in with the mapped role, for at most the Enterprise session length", () => {
    expect(decideSignIn(base)).toMatchObject({ allow: true, orgRole: "admin", source: "mapping", sessionMaxSeconds: ENTERPRISE_SESSION_MAX_SECONDS });
    expect(ENTERPRISE_SESSION_MAX_SECONDS).toBe(8 * 60 * 60);
  });

  it("takes access away when the person has left the mapped group, even if they were an admin", () => {
    expect(decideSignIn({ ...base, claims: { groups: ["marketing"] }, currentRole: "admin" })).toMatchObject({ allow: false, reason: "no_group" });
  });

  it("refuses an owner who matches no mapped group while the mapping is fine: that is deprovisioning, not a broken mapping", () => {
    for (const personId of [OWNER_A, PERSON]) {
      expect(decideSignIn({ ...base, personId, currentRole: "owner", claims: { groups: ["marketing"] } })).toMatchObject({ allow: false, reason: "no_group" });
    }
  });

  it("lets an owner who does match in, and keeps them an owner whatever role the mapping gives", () => {
    expect(decideSignIn({ ...base, currentRole: "owner", claims: { groups: ["engineering"] } })).toMatchObject({ allow: true, orgRole: "owner", source: "mapping" });
  });

  it("lets a NAMED owner in through a broken mapping, as break-glass: audited, alerted, one hour, fresh sign-in", () => {
    for (const config of [undefined, { claim: "groups" }, "nonsense"]) {
      const decision = decideSignIn({ ...base, config, personId: OWNER_A, currentRole: "owner" });
      expect(decision).toEqual({
        allow: true, orgRole: "owner", source: "break-glass", projectRoles: [], matchedRuleIds: [], auditEvent: "sso.break_glass_used", alert: true,
        sessionMaxSeconds: BREAK_GLASS_SESSION_MAX_SECONDS, freshAuthWithinSeconds: BREAK_GLASS_FRESH_AUTH_SECONDS,
      });
    }
    // A token with no groups claim is a person in no groups (Entra ID and Okta leave an empty claim out), NOT a broken mapping: even a listed owner is refused.
    for (const claims of [{}, { groups: null }, { roles: ["x"] }]) {
      expect(decideSignIn({ ...base, claims, personId: OWNER_A, currentRole: "owner" })).toMatchObject({ allow: false, reason: "no_group" });
    }
    // A malformed claim is one person's token, not the mapping either.
    expect(decideSignIn({ ...base, claims: { groups: [1] }, personId: OWNER_A, currentRole: "owner" })).toMatchObject({ allow: false, reason: "claim_invalid" });
    expect(BREAK_GLASS_SESSION_MAX_SECONDS).toBe(3_600);
    expect(BREAK_GLASS_FRESH_AUTH_SECONDS).toBe(300);
  });

  it("refuses an owner who is not named, a named person who is not an owner, and an expired entry, when the mapping is broken", () => {
    expect(decideSignIn({ ...base, config: undefined, personId: OWNER_B, currentRole: "owner" })).toMatchObject({ allow: false, reason: "not_configured" });
    expect(decideSignIn({ ...base, config: undefined, personId: OWNER_A, currentRole: "admin" })).toMatchObject({ allow: false });
    expect(decideSignIn({ ...base, config: undefined, personId: OWNER_A, currentRole: "owner", breakGlass: [{ personId: OWNER_A, expiresAt: NOW }] })).toMatchObject({ allow: false });
    expect(decideSignIn({ ...base, config: undefined, personId: OWNER_A, currentRole: "owner", breakGlass: [{ personId: OWNER_A, expiresAt: NOW + 1 }] })).toMatchObject({ source: "break-glass" });
  });

  it("refuses a break-glass list of more than two, or one that does not parse", () => {
    const three = [OWNER_A, OWNER_B, PERSON].map((personId) => ({ personId }));
    expect(decideSignIn({ ...base, config: undefined, personId: OWNER_A, currentRole: "owner", breakGlass: three })).toMatchObject({ allow: false });
    expect(decideSignIn({ ...base, config: undefined, personId: OWNER_A, currentRole: "owner", breakGlass: [{ personId: "short" }] })).toMatchObject({ allow: false });
  });

  it("refuses everyone on the Public edition first, owners and named owners included", () => {
    for (const personId of [OWNER_A, PERSON]) {
      expect(decideSignIn({ ...base, policy: publicPolicy, personId, currentRole: "owner", config: undefined })).toMatchObject({ allow: false, reason: "edition_off" });
      expect(decideSignIn({ ...base, policy: publicPolicy, personId, currentRole: "owner" })).toMatchObject({ allow: false, reason: "edition_off" });
    }
  });

  it("does not let a mapping make an owner of someone who is not one", () => {
    const decision = decideSignIn({ ...base, claims: { groups: ["rovara-admins", "engineering"] } });
    expect(decision).toMatchObject({ allow: true });
    expect((decision as { orgRole: string }).orgRole).not.toBe("owner");
  });
});

describe("the group claim", () => {
  it("is one that carries groups, never a profile field a person can edit", () => {
    for (const claim of GROUP_CLAIM_NAMES) expect(GroupMappingConfigSchema.safeParse(config({ claim })).success, claim).toBe(true);
    expect(GroupMappingConfigSchema.safeParse(config({ claim: "https://login.example.com/groups" })).success).toBe(true);
    for (const claim of ["email", "name", "preferred_username", "sub", "nickname", "given_name", "https://login.example.com/email", "http://x.example.com/groups", "groupsx"]) {
      expect(GroupMappingConfigSchema.safeParse(config({ claim })).success, claim).toBe(false);
    }
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

  it("throws a fixed CONFIG_INVALID on a stored record that does not parse, with none of the parser's words, and the sign-in reads it as a broken mapping", async () => {
    const { store, db } = setup();
    await store.put(ORG, body(), 0);
    const key = groupMappingKey(ORG);
    const item = db.get(key) as unknown as { rules: Array<{ orgRole: string }> };
    item.rules[0]!.orgRole = "owner";
    const error = await store.get(ORG).catch((caught: unknown) => caught as { code: string; message: string });
    expect(error).toMatchObject({ code: "CONFIG_INVALID" });
    expect((error as { message: string }).message).toBe(`CONFIG_INVALID: ${GROUP_MAPPING_MESSAGES.config_invalid}`);
    const read = await readMappingForSignIn(store, ORG);
    expect(evaluateGroupMapping({ policy: enterprise, config: read, claims: { groups: ["rovara-admins"] } })).toEqual({ ok: false, reason: "config_invalid" });
  });

  it("keeps each org's mapping apart", async () => {
    const { store } = setup();
    await store.put(ORG, body(), 0);
    expect(await store.get("org_bbbbbbbbbbbbbbbbbbbb")).toBeUndefined();
  });
});
