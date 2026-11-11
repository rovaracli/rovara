// A stateful fake ModelAccess (ruling R28: the broker's only view of the model proxy). Like LiteLLM, it knows an org or a member
// only after an upsert, and answers NOT_FOUND for one it was never told about, so a test that passes has synced first. The
// limit a spend reports is the last one upserted; what was spent is whatever the test sets. Every method is a vi.fn.
import { vi, type Mock } from "vitest";
// The package the broker imports, not its source: an error must be an instance of the class the broker tests for.
import { agentXError, type OrgId } from "@rovara-code/contracts";
import type { KeyAudit, MemberSpend, MintKeyInput, MintedKey, ModelAccess, SourceCheck, SpendFigures, UpsertSourceInput } from "../../packages/broker/src/model-proxy/access.js";
import { keyIdOf } from "../../packages/broker/src/org/budget.js";

export interface FakeModelAccess extends ModelAccess {
  upsertOrg: Mock<(orgId: OrgId, monthlyBudgetUsd: number) => Promise<void>>;
  upsertMember: Mock<(orgId: OrgId, developerId: string, monthlyBudgetUsd: number) => Promise<void>>;
  spend: Mock<(orgId: OrgId, developerId: string) => Promise<MemberSpend>>;
  orgSpend: Mock<(orgId: OrgId) => Promise<SpendFigures>>;
  keySpend: Mock<(keyIds: readonly string[]) => Promise<number>>;
  upsertSource: Mock<(input: UpsertSourceInput) => Promise<void>>;
  removeSource: Mock<(orgId: OrgId, sourceId: string) => Promise<void>>;
  checkSource: Mock<(orgId: OrgId, sourceId: string) => Promise<SourceCheck>>;
  listSources: Mock<() => Promise<Array<{ orgId: OrgId; sourceId: string; hosts?: string[] | undefined }>>>;
  auditKeys: Mock<() => Promise<KeyAudit>>;
  mintKey: Mock<(input: MintKeyInput) => Promise<MintedKey>>;
  revokeKey: Mock<(key: string) => Promise<void>>;
  blockKey: Mock<(keyId: string) => Promise<void>>;
  /** What the org has spent so far this month (its limit is what was last upserted). */
  setOrgSpent(orgId: OrgId, usd: number): void;
  setMemberSpent(orgId: OrgId, developerId: string, usd: number): void;
  /** What a minted key has spent, by the key itself. */
  setKeySpent(key: string, usd: number): void;
  /** The limits the proxy holds now, as the last upserts left them; members by developer id alone. */
  limits(): { orgs: Map<string, number>; members: Map<string, number> };
  /** The proxy loses its database: every org and member it was told about is unknown again, as after a restore or a replaced database. */
  forgetEverything(): void;
  /** From now on every call fails as an unreachable proxy does. */
  goDown(): void;
  /** The keys minted so far, in order. */
  mintedKeys(): string[];
}

export function fakeModelAccess(options: { key?: string; mintFailure?: Error } = {}): FakeModelAccess {
  const orgs = new Map<string, { limit: number; spent: number }>();
  const members = new Map<string, { limit: number; spent: number }>();
  const keySpends = new Map<string, number>();
  const minted: string[] = [];
  let down = false;
  const guard = () => { if (down) throw agentXError("MODEL_PROXY_UNAVAILABLE", "model proxy is unreachable"); };
  const unknown = (what: string) => agentXError("NOT_FOUND", `model proxy refused the request (404): ${what} does not exist`);
  const orgFigures = (orgId: string): SpendFigures => {
    const org = orgs.get(orgId);
    if (org === undefined) throw unknown("team");
    return { spentUsd: org.spent, limitUsd: org.limit };
  };
  // LiteLLM users are global by user_id: the org a member is spoken of under does not scope them, so one org's upsert can overwrite another's.
  const memberKey = (_orgId: string, developerId: string) => developerId;
  return {
    upsertOrg: vi.fn(async (orgId, monthlyBudgetUsd) => {
      guard();
      orgs.set(orgId, { limit: monthlyBudgetUsd, spent: orgs.get(orgId)?.spent ?? 0 });
    }),
    upsertMember: vi.fn(async (orgId, developerId, monthlyBudgetUsd) => {
      guard();
      members.set(memberKey(orgId, developerId), { limit: monthlyBudgetUsd, spent: members.get(memberKey(orgId, developerId))?.spent ?? 0 });
    }),
    spend: vi.fn(async (orgId, developerId) => {
      guard();
      const member = members.get(memberKey(orgId, developerId));
      if (member === undefined) throw unknown("user");
      return { member: { spentUsd: member.spent, limitUsd: member.limit }, org: orgFigures(orgId) };
    }),
    orgSpend: vi.fn(async (orgId) => {
      guard();
      return orgFigures(orgId);
    }),
    keySpend: vi.fn(async (keyIds) => {
      guard();
      return [...new Set(keyIds)].reduce((total, id) => total + (keySpends.get(id) ?? 0), 0);
    }),
    upsertSource: vi.fn(async () => { guard(); }),
    removeSource: vi.fn(async () => { guard(); }),
    checkSource: vi.fn(async () => { guard(); return { ok: true as const, health: "healthy" as const }; }),
    listSources: vi.fn(async () => { guard(); return []; }),
    auditKeys: vi.fn(async () => { guard(); return { checked: minted.length, blocked: 0, truncated: false }; }),
    mintKey: vi.fn(async (input) => {
      guard();
      if (options.mintFailure !== undefined) throw options.mintFailure;
      // LiteLLM mints for a team (and user) that exists.
      if (!orgs.has(input.orgId)) throw unknown("team");
      if (input.developerId !== undefined && !members.has(memberKey(input.orgId, input.developerId))) throw unknown("user");
      const key = options.key ?? `sk-fake-key-${String(minted.length + 1).padStart(4, "0")}`;
      minted.push(key);
      return { key, expiresAt: Date.parse("2026-10-19T13:00:00.000Z") };
    }),
    revokeKey: vi.fn(async () => { guard(); }),
    blockKey: vi.fn(async () => { guard(); }),
    setOrgSpent: (orgId, usd) => { orgs.set(orgId, { limit: orgs.get(orgId)?.limit ?? 0, spent: usd }); },
    setMemberSpent: (orgId, developerId, usd) => { members.set(memberKey(orgId, developerId), { limit: members.get(memberKey(orgId, developerId))?.limit ?? 0, spent: usd }); },
    setKeySpent: (key, usd) => { keySpends.set(keyIdOf(key), usd); },
    limits: () => ({ orgs: new Map([...orgs].map(([id, entry]) => [id, entry.limit])), members: new Map([...members].map(([id, entry]) => [id, entry.limit])) }),
    forgetEverything: () => { orgs.clear(); members.clear(); },
    goDown: () => { down = true; },
    mintedKeys: () => [...minted],
  };
}
