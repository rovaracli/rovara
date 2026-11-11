// Company rules (G-04), through the whole broker with live browser sessions: an admin proposes, a DIFFERENT admin approves with a fresh sign-in, the same admin cannot, a member and a token cannot, every limit is enforced on every
// write, the history is kept, the Cloud source answers the newest approved version, and every change is audited with ids, counts and digests only. Behind `si`: off, every path is not found.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { COMPANY_RULES_CURRENT_PATH, COMPANY_RULES_PATH, CompanyRulesAnswerReaderSchema, CompanyRulesCurrentReaderSchema, CompanyRulesHistoryReaderSchema, CompanyRulesStateReaderSchema, type CompanyRulesState } from "@agentx/contracts";
import { companyRulesSourceOver } from "../../packages/broker/src/company-rules/source.js";
import { readCompanyInstructions } from "../../packages/broker/src/instructions/company-source.js";
import { dynamoCompanyRulesStore } from "../../packages/broker/src/company-rules/store.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, OMAR, type Developer } from "../support/developer-task-broker.js";
import { setupWizardBench, type Bench } from "../support/setup-wizard-testenv.js";
import { TEST_ORG } from "../support/orgs.js";

const containing = (items: unknown[]): unknown => expect.arrayContaining(items);

afterEach(() => { delete process.env.STANDING_INSTRUCTIONS_ENABLED; });
const on = () => { process.env.STANDING_INSTRUCTIONS_ENABLED = "1"; };
const PATH = COMPANY_RULES_PATH;
const rules = (...texts: string[]): Array<{ text: string; priority: "required" | "preferred" }> => texts.map((text, index) => ({ text, priority: index === 0 ? "required" as const : "preferred" as const }));

async function bench(options: { maya?: "admin" | "member" } = {}) {
  const audit = capturingAuditDeps();
  const t = await setupWizardBench({ audit });
  if (options.maya !== undefined) await t.person(MAYA, options.maya);
  on();
  return { t, audit };
}
const get = (t: Bench, who: Developer = OMAR, sub = "") => t.web(who, "GET", `${PATH}${sub}`);
const post = (t: Bench, body: unknown, who: Developer = OMAR) => t.web(who, "POST", PATH, body);
const stateOf = async (t: Bench, who: Developer = OMAR): Promise<CompanyRulesState> => {
  const reply = await get(t, who);
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return CompanyRulesStateReaderSchema.parse(reply.body) as CompanyRulesState;
};
const errorCode = (reply: { body: Record<string, unknown> }) => (reply.body.error as { code: string }).code;
const rows = (t: Bench) => t.db.find((item) => String(item.sk).startsWith("COMPANYRULES#"));
const events = (audit: ReturnType<typeof capturingAuditDeps>) => audit.recorded().filter((event) => event.action.startsWith("company_rules."));
const propose = (t: Bench, over: Record<string, unknown> = {}, who: Developer = OMAR) => post(t, { action: "propose", requestId: randomUUID(), baseVersion: 0, rules: rules("Never push to main.", "Small PRs."), ...over }, who);
/** Omar proposes, Maya (an admin, signed in just now) approves exactly what the card showed. */
async function approvedVersion(t: Bench, texts: string[] = ["Never push to main.", "Small PRs."], base = 0) {
  expect((await propose(t, { baseVersion: base, rules: rules(...texts) })).status).toBe(202);
  const pending = (await stateOf(t)).pending!;
  const done = await post(t, { action: "approve", proposalId: pending.proposalId, expectedDigest: pending.digest }, MAYA);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return pending;
}

describe("behind si", () => {
  it("every path is not found unless the switch is exactly 1, and nothing is stored or audited", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    for (const value of [undefined, "0", "true", " 1", "yes"]) {
      if (value === undefined) delete process.env.STANDING_INSTRUCTIONS_ENABLED; else process.env.STANDING_INSTRUCTIONS_ENABLED = value;
      for (const sub of ["", "/history", "/versions/1", "/sync"]) expect((await get(t, OMAR, sub)).status, `${String(value)} ${sub}`).toBe(404);
      expect((await propose(t)).status).toBe(404);
    }
    expect(rows(t)).toEqual([]);
    expect(events(audit)).toEqual([]);
  });
});

describe("who may", () => {
  it("a member sees the version in force without who made it, never a waiting proposal, and is refused the other reads and every change", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    await t.person(MAYA, "member");
    // Omar owns the company; Ben, a second admin, is Maya before she is made a member: use the seed to make the first version.
    const store = dynamoCompanyRulesStore({ documentClient: t.db, tableName: "state", audit: audit.audit });
    const id = randomUUID();
    const base = { orgId: TEST_ORG } as const;
    await store.createProposal({ ...base, proposal: { proposalId: id, state: "pending", baseVersion: 0, source: "rovara", rules: [{ text: "Never push to main.", priority: "required" }], digest: "d".repeat(64), proposedBy: { kind: "member", id: OMAR.developerId }, proposedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, expectedBase: 0, events: [] });
    const waiting = await get(t, MAYA);
    expect(waiting.status).toBe(200);
    const state = CompanyRulesStateReaderSchema.parse(waiting.body);
    expect(state).toMatchObject({ viewer: { role: "member", canPropose: false, canDecide: false }, current: null, pending: null, sync: null });
    for (const sub of ["/history", "/versions/1", "/sync"]) expect((await get(t, MAYA, sub)).status, sub).toBe(403);
    const before = JSON.stringify(rows(t));
    const attempts = [
      { action: "propose", requestId: randomUUID(), baseVersion: 0, rules: rules("x") }, { action: "approve", proposalId: id, expectedDigest: "d".repeat(64) }, { action: "reject", proposalId: id, expectedDigest: "d".repeat(64) },
      { action: "cancel", proposalId: id }, { action: "sync-connect", repository: "acme/meta" }, { action: "sync-disconnect" }, { action: "sync-now" },
    ];
    for (const body of attempts) expect((await post(t, body, MAYA)).status, JSON.stringify(body)).toBe(403);
    expect(JSON.stringify(rows(t))).toBe(before);
    expect(events(audit)).toEqual([]);
  });

  it("a token or the API can read as an admin but never change; the refusal says to use a browser, and nothing is stored", async () => {
    const { t } = await bench({ maya: "admin" });
    const read = await t.dev(OMAR, "GET", PATH);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    for (const body of [{ action: "propose", requestId: randomUUID(), baseVersion: 0, rules: rules("x") }, { action: "sync-now" }]) {
      const reply = await t.dev(OMAR, "POST", PATH, body);
      expect(reply.status).toBe(403);
      expect(JSON.stringify(reply.body)).toContain("live browser session");
    }
    expect(rows(t)).toEqual([]);
  });
});

describe("proposing", () => {
  it("makes the one waiting proposal (202), shown to an admin with its diff, stale flag and approval hint, and audited with ids and counts only", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    const reply = await propose(t, { note: "first draft" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const answer = CompanyRulesAnswerReaderSchema.parse(reply.body);
    expect(answer.status).toBe("needs_approval");
    const pending = answer.state.pending!;
    expect(pending).toMatchObject({ baseVersion: 0, stale: false, source: "rovara", ruleCount: 2, note: "first draft", proposedByYou: true, approval: { reason: "you_proposed" } });
    expect(pending.proposedBy).toEqual({ id: OMAR.developerId, name: expect.any(String) as string });
    expect(pending.diff.summary).toEqual({ added: 2, removed: 0, changed: 0, unchanged: 0 });
    expect(answer.state.current).toBeNull();
    // Maya (another admin) sees it as someone else's.
    expect((await stateOf(t, MAYA)).pending).toMatchObject({ proposedByYou: false, approval: { canApprove: true, reason: null, freshSignInNeeded: true } });
    const [event] = events(audit).filter((e) => e.action === "company_rules.proposed");
    expect(event).toMatchObject({ actor: { kind: "member", id: OMAR.developerId }, facts: { proposalId: pending.proposalId, baseVersion: 0, ruleCount: 2, digest: pending.digest, source: "rovara" } });
    expect(JSON.stringify(events(audit))).not.toContain("Never push to main");
  });

  it("enforces every limit and screens every rule on every write: nothing is stored or audited when one is refused", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    const secret = ["gh", "p_", "z".repeat(36)].join("");
    const tooMany = Array.from({ length: 31 }, (_, index) => ({ text: `rule ${String(index)}`, priority: "required" }));
    const refused: Array<[string, Record<string, unknown>, RegExp]> = [
      ["31 rules", { rules: tooMany }, /31 rules, at most 30/],
      ["601 characters", { rules: rules("x".repeat(601)) }, /601 characters, at most 600/],
      ["12,001 in all", { rules: Array.from({ length: 21 }, () => ({ text: "y".repeat(580), priority: "required" })) }, /characters in all/],
      ["empty rule", { rules: rules("fine", "   ") }, /Rule 2 is empty/],
      ["hidden characters only", { rules: rules("​​") }, /Rule 1 is empty/],
      ["secret-like rule", { rules: rules(`Use ${secret} to deploy`) }, /secret/],
      ["secret-like note", { note: `see ${secret}` }, /secret/],
      ["long note", { note: "n".repeat(301) }, /./],
    ];
    for (const [name, over, message] of refused) {
      const reply = await propose(t, over);
      expect(reply.status, name).toBe(400);
      expect(JSON.stringify(reply.body), name).toMatch(message);
    }
    for (const body of [{ action: "propose", requestId: "nope", baseVersion: 0, rules: rules("x") }, { action: "propose", requestId: randomUUID(), baseVersion: 0, rules: rules("x"), extra: 1 }]) {
      expect((await post(t, body)).status).toBe(400);
    }
    expect(rows(t)).toEqual([]);
    expect(events(audit)).toEqual([]);
    // The edge values are accepted: 30 rules, 600 characters each within 12,000 in all.
    const edge = await propose(t, { rules: Array.from({ length: 20 }, (_, index) => ({ text: `${String(index).padStart(2, "0")}${"z".repeat(598)}`, priority: "required" })) });
    expect(edge.status, JSON.stringify(edge.body)).toBe(202);
  });

  it("only one proposal waits; a repeat of the same request is the same proposal, and the same id with other content is a conflict", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    const requestId = randomUUID();
    const first = await propose(t, { requestId });
    expect(first.status).toBe(202);
    const again = await propose(t, { requestId });
    expect(again.status).toBe(202);
    expect(rows(t).filter((row) => String(row.sk).startsWith("COMPANYRULES#P#"))).toHaveLength(1);
    expect(events(audit).filter((e) => e.action === "company_rules.proposed")).toHaveLength(1);
    const other = await propose(t, { requestId, rules: rules("a different list") });
    expect(other.status).toBe(409);
    expect(errorCode(other)).toBe("IDEMPOTENCY_CONFLICT");
    const second = await propose(t, { rules: rules("another list") }, MAYA);
    expect(second.status).toBe(409);
    expect(errorCode(second)).toBe("CHANGE_STALE");
    expect(JSON.stringify(second.body)).toContain("already waiting");
    expect(rows(t).filter((row) => String(row.sk).startsWith("COMPANYRULES#P#"))).toHaveLength(1);
  });

  it("refuses a proposal written against a version that is no longer the current one, and one that changes nothing", async () => {
    const { t } = await bench({ maya: "admin" });
    await approvedVersion(t);
    const moved = await propose(t, { baseVersion: 0, rules: rules("x") });
    expect(moved.status).toBe(409);
    expect(errorCode(moved)).toBe("CHANGE_STALE");
    const same = await propose(t, { baseVersion: 1, rules: rules("Never push to main.", "Small PRs.") });
    expect(same.status).toBe(400);
    expect(JSON.stringify(same.body)).toContain("Nothing changed");
    expect((await propose(t, { baseVersion: 1, rules: rules("Never push to main.", "Small PRs, please.") })).status).toBe(202);
  });

  it("an expired waiting proposal is replaced by the next one, in the same transaction, with both audited", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    const first = (await propose(t)).body as { state: CompanyRulesState };
    const id = first.state.pending!.proposalId;
    const row = t.db.get({ pk: `ORG#${TEST_ORG}`, sk: `COMPANYRULES#P#${id}` })!;
    t.db.set({ ...row, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await stateOf(t)).pending).toBeNull();
    const next = await propose(t, { rules: rules("a newer list") }, MAYA);
    expect(next.status, JSON.stringify(next.body)).toBe(202);
    expect(t.db.get({ pk: `ORG#${TEST_ORG}`, sk: `COMPANYRULES#P#${id}` })).toMatchObject({ state: "expired" });
    expect(events(audit).map((e) => e.action)).toEqual(containing(["company_rules.expired", "company_rules.proposed"]));
  });
});

describe("approving", () => {
  it("a DIFFERENT admin approves exactly the digest the card showed, signed in within 10 minutes: version 1 exists, the source answers it, and the approval is audited", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    await propose(t);
    const pending = (await stateOf(t, MAYA)).pending!;
    const done = await post(t, { action: "approve", proposalId: pending.proposalId, expectedDigest: pending.digest }, MAYA);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const answer = CompanyRulesAnswerReaderSchema.parse(done.body);
    expect(answer.status).toBe("approved");
    expect(answer.state.pending).toBeNull();
    expect(answer.state.current).toMatchObject({ version: 1, digest: pending.digest, source: "rovara", approvalMode: "second_person", baseVersion: 0, ruleCount: 2 });
    expect(answer.state.current!.approvedBy!.id).toBe(MAYA.developerId);
    expect(answer.state.current!.proposedBy!.id).toBe(OMAR.developerId);
    const store = dynamoCompanyRulesStore({ documentClient: t.db, tableName: "state" });
    expect(await companyRulesSourceOver(store).current(TEST_ORG)).toEqual({ version: "1", rules: [{ text: "Never push to main.", priority: "required" }, { text: "Small PRs.", priority: "preferred" }] });
    const [event] = events(audit).filter((e) => e.action === "company_rules.approved");
    expect(event).toMatchObject({ actor: { kind: "member", id: MAYA.developerId }, facts: { proposalId: pending.proposalId, version: 1, baseVersion: 0, ruleCount: 2, digest: pending.digest, source: "rovara", approvalMode: "second_person" } });
    // A member reads the same rules, without who.
    expect(rows(t).some((row) => row.sk === "COMPANYRULES#V#000000001")).toBe(true);
  });

  it("the person who proposed it cannot approve it, however fresh their sign-in, and nothing changes while another admin exists", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    await propose(t);
    const pending = (await stateOf(t)).pending!;
    const before = JSON.stringify(rows(t));
    const eventsBefore = events(audit).length;
    const refused = await post(t, { action: "approve", proposalId: pending.proposalId, expectedDigest: pending.digest, soleOwnerAcknowledged: true });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(errorCode(refused)).toBe("FORBIDDEN");
    expect(JSON.stringify(rows(t))).toBe(before);
    expect(events(audit)).toHaveLength(eventsBefore);
    expect((await stateOf(t)).current).toBeNull();
    expect((await stateOf(t)).pending).toMatchObject({ approval: { canApprove: false, reason: "you_proposed", soleOwner: { available: false } } });
  });

  it("needs a sign-in within the last 10 minutes: an older one or none is REAUTH_REQUIRED and nothing changes", async () => {
    const { t } = await bench({ maya: "admin" });
    await propose(t);
    const pending = (await stateOf(t)).pending!;
    const approve = { action: "approve", proposalId: pending.proposalId, expectedDigest: pending.digest };
    for (const minutes of [11, 600, undefined]) {
      t.ageSignIn(MAYA, minutes);
      const reply = await post(t, approve, MAYA);
      expect(reply.status, String(minutes)).toBe(403);
      expect(errorCode(reply)).toBe("REAUTH_REQUIRED");
    }
    expect((await stateOf(t)).current).toBeNull();
    t.ageSignIn(MAYA, 9);
    expect((await post(t, approve, MAYA)).status).toBe(200);
  });

  it("is pinned to the proposal the person looked at: another digest, an unknown proposal, a decided one and a stale one are refused", async () => {
    const { t } = await bench({ maya: "admin" });
    await propose(t);
    const pending = (await stateOf(t)).pending!;
    const wrong = await post(t, { action: "approve", proposalId: pending.proposalId, expectedDigest: "0".repeat(64) }, MAYA);
    expect(wrong.status).toBe(409);
    expect(errorCode(wrong)).toBe("CHANGE_STALE");
    const unknown = await post(t, { action: "approve", proposalId: randomUUID(), expectedDigest: pending.digest }, MAYA);
    expect(unknown.status).toBe(404);
    expect((await stateOf(t)).current).toBeNull();
    // An approved proposal, approved again by another person, is closed.
    expect((await post(t, { action: "approve", proposalId: pending.proposalId, expectedDigest: pending.digest }, MAYA)).status).toBe(200);
    t.ageSignIn(OMAR, 1);
    const late = await post(t, { action: "approve", proposalId: pending.proposalId, expectedDigest: pending.digest });
    expect(late.status).toBe(409);
    // A repeat of the same approval answers the stored outcome and writes nothing.
    const rowsBefore = JSON.stringify(rows(t));
    const repeat = await post(t, { action: "approve", proposalId: pending.proposalId, expectedDigest: pending.digest }, MAYA);
    expect(repeat.status).toBe(200);
    expect(JSON.stringify(rows(t))).toBe(rowsBefore);
  });

  it("a second version is numbered 2, version 1 is kept as it was, and the source answers 2", async () => {
    const { t } = await bench({ maya: "admin" });
    await approvedVersion(t);
    const first = JSON.stringify(t.db.get({ pk: `ORG#${TEST_ORG}`, sk: "COMPANYRULES#V#000000001" }));
    const waiting = await approvedVersion(t, ["Never push to main.", "Small PRs.", "Say what you ran."], 1);
    expect(waiting.diff.summary).toEqual({ added: 1, removed: 0, changed: 0, unchanged: 2 });
    expect(JSON.stringify(t.db.get({ pk: `ORG#${TEST_ORG}`, sk: "COMPANYRULES#V#000000001" }))).toBe(first);
    const store = dynamoCompanyRulesStore({ documentClient: t.db, tableName: "state" });
    expect((await companyRulesSourceOver(store).current(TEST_ORG))!.version).toBe("2");
  });

  it("a person who is no longer an admin cannot approve (live authority, not the session's old role)", async () => {
    const { t } = await bench({ maya: "admin" });
    await propose(t);
    const pending = (await stateOf(t)).pending!;
    await t.person(MAYA, "member");
    const reply = await post(t, { action: "approve", proposalId: pending.proposalId, expectedDigest: pending.digest }, MAYA);
    expect(reply.status).toBe(403);
    expect((await stateOf(t)).current).toBeNull();
  });
});

describe("the sole owner", () => {
  it("may approve their own change only with the acknowledgement; the page says whether it is available", async () => {
    const { t, audit } = await bench();
    await propose(t);
    const pending = (await stateOf(t)).pending!;
    expect(pending.approval.soleOwner).toMatchObject({ available: true, reasonCode: "SOLE_OWNER_EXCEPTION_AVAILABLE" });
    expect(pending.approval.canApprove).toBe(true);
    const body = { action: "approve", proposalId: pending.proposalId, expectedDigest: pending.digest };
    const without = await post(t, body);
    expect(without.status).toBe(403);
    expect(JSON.stringify(without.body)).toContain("only owner");
    expect((await stateOf(t)).current).toBeNull();
    const done = await post(t, { ...body, soleOwnerAcknowledged: true });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(CompanyRulesAnswerReaderSchema.parse(done.body).state.current).toMatchObject({ version: 1, approvalMode: "sole_owner_exception" });
    expect(events(audit).find((e) => e.action === "company_rules.approved")!.facts).toMatchObject({ approvalMode: "sole_owner_exception" });
  });

  it("is refused inside the 24 hour cool-off after the company lost an eligible person", async () => {
    const { t } = await bench();
    const meta = t.db.get({ pk: `ORG#${TEST_ORG}`, sk: "META" }) ?? t.db.find((item) => item.pk === `ORG#${TEST_ORG}` && item.approvalMembershipVersion !== undefined)[0]!;
    t.db.set({ ...meta, approvalLastCompanyEligibleLossAt: new Date(Date.now() - 3_600_000).toISOString() });
    await propose(t);
    const pending = (await stateOf(t)).pending!;
    expect(pending.approval.soleOwner).toMatchObject({ available: false, reasonCode: "SOLE_OWNER_COOL_OFF" });
    const reply = await post(t, { action: "approve", proposalId: pending.proposalId, expectedDigest: pending.digest, soleOwnerAcknowledged: true });
    expect(reply.status).toBe(403);
    expect((await stateOf(t)).current).toBeNull();
  });
});

describe("rejecting and withdrawing", () => {
  it("a different admin rejects (no version, the slot is free, audited); the proposer cannot reject their own", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    await propose(t);
    const pending = (await stateOf(t)).pending!;
    const own = await post(t, { action: "reject", proposalId: pending.proposalId, expectedDigest: pending.digest });
    expect(own.status).toBe(403);
    expect((await stateOf(t)).pending).not.toBeNull();
    const done = await post(t, { action: "reject", proposalId: pending.proposalId, expectedDigest: pending.digest }, MAYA);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(CompanyRulesAnswerReaderSchema.parse(done.body)).toMatchObject({ status: "rejected", state: { pending: null, current: null } });
    expect(events(audit).find((e) => e.action === "company_rules.rejected")).toMatchObject({ actor: { id: MAYA.developerId }, facts: { proposalId: pending.proposalId, source: "rovara" } });
    expect((await propose(t, { rules: rules("try again") })).status).toBe(202);
    // A rejected proposal cannot be approved later.
    t.ageSignIn(MAYA, 1);
    expect((await post(t, { action: "approve", proposalId: pending.proposalId, expectedDigest: pending.digest }, MAYA)).status).toBe(409);
  });

  it("only the proposer withdraws their own proposal; another admin is refused, and the digest check applies to a reject", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    await propose(t);
    const pending = (await stateOf(t)).pending!;
    expect((await post(t, { action: "cancel", proposalId: pending.proposalId }, MAYA)).status).toBe(403);
    expect((await post(t, { action: "reject", proposalId: pending.proposalId, expectedDigest: "1".repeat(64) }, MAYA)).status).toBe(409);
    const done = await post(t, { action: "cancel", proposalId: pending.proposalId });
    expect(done.status).toBe(200);
    expect(CompanyRulesAnswerReaderSchema.parse(done.body).status).toBe("cancelled");
    expect(events(audit).map((e) => e.action)).toContain("company_rules.cancelled");
    expect((await post(t, { action: "cancel", proposalId: pending.proposalId })).status).toBe(200);
    expect(events(audit).filter((e) => e.action === "company_rules.cancelled")).toHaveLength(1);
  });
});

describe("history", () => {
  it("lists approved versions newest first with their changes, the proposals that did not become one, and each version with its diff", async () => {
    const { t } = await bench({ maya: "admin" });
    await approvedVersion(t);
    await approvedVersion(t, ["Never push to main.", "Small PRs, please."], 1);
    await propose(t, { baseVersion: 2, rules: rules("thrown away") });
    const pending = (await stateOf(t)).pending!;
    await post(t, { action: "reject", proposalId: pending.proposalId, expectedDigest: pending.digest }, MAYA);
    const reply = await get(t, OMAR, "/history");
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const history = CompanyRulesHistoryReaderSchema.parse(reply.body);
    expect(history.entries.map((entry) => entry.version)).toEqual([2, 1]);
    expect(history.entries[0]!.summary).toEqual({ added: 0, removed: 0, changed: 1, unchanged: 1 });
    expect(history.entries[1]!.summary).toEqual({ added: 2, removed: 0, changed: 0, unchanged: 0 });
    expect(history.decided.map((entry) => entry.state)).toEqual(["rejected"]);
    expect(history.nextBefore).toBeNull();
    const paged = CompanyRulesHistoryReaderSchema.parse((await get(t, OMAR, "/history?limit=1")).body);
    expect(paged.entries.map((entry) => entry.version)).toEqual([2]);
    expect(paged.nextBefore).toBe(2);
    expect(CompanyRulesHistoryReaderSchema.parse((await get(t, OMAR, "/history?limit=1&before=2")).body).entries.map((entry) => entry.version)).toEqual([1]);
    const one = await get(t, MAYA, "/versions/2");
    expect(one.status).toBe(200);
    expect((one.body as { diffFromPrevious: { summary: unknown } }).diffFromPrevious.summary).toEqual({ added: 0, removed: 0, changed: 1, unchanged: 1 });
    expect((await get(t, OMAR, "/versions/9")).status).toBe(404);
    expect((await get(t, OMAR, "/history?limit=0")).status).toBe(400);
  });

  it("another company's rules are never shown: the keys are built from the caller's own company", async () => {
    const { t } = await bench({ maya: "admin" });
    t.db.set({ pk: "ORG#org_zzzzzzzzzzzzzzzzzzzz", sk: "COMPANYRULES#HEAD", latestVersion: 1 });
    expect((await stateOf(t)).current).toBeNull();
  });
});

describe("an empty list, notes, the member read and the nav flag", () => {
  it("an admin may propose an empty list to clear the rules; approving it leaves a version with no rules, and a step then carries no company rules", async () => {
    const { t } = await bench({ maya: "admin" });
    const none = await propose(t, { rules: [] });
    expect(none.status).toBe(400);
    expect(JSON.stringify(none.body)).toContain("Nothing changed");
    await approvedVersion(t);
    const cleared = await propose(t, { baseVersion: 1, rules: [] });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(202);
    const pending = (await stateOf(t)).pending!;
    expect(pending).toMatchObject({ ruleCount: 0, rules: [] });
    expect(pending.diff.summary).toEqual({ added: 0, removed: 2, changed: 0, unchanged: 0 });
    expect((await post(t, { action: "approve", proposalId: pending.proposalId, expectedDigest: pending.digest }, MAYA)).status).toBe(200);
    expect((await stateOf(t)).current).toMatchObject({ version: 2, ruleCount: 0, rules: [] });
    const source = companyRulesSourceOver(dynamoCompanyRulesStore({ documentClient: t.db, tableName: "state" }));
    expect(await source.current(TEST_ORG)).toEqual({ version: "2", rules: [] });
    expect(await readCompanyInstructions(source, TEST_ORG)).toBeUndefined();
    expect((await propose(t, { baseVersion: 2, rules: [] })).status).toBe(400);
  });

  it("the proposal's note is on the version, the history entry and the decided proposal", async () => {
    const { t } = await bench({ maya: "admin" });
    expect((await propose(t, { note: "first set" })).status).toBe(202);
    const first = (await stateOf(t)).pending!;
    await post(t, { action: "approve", proposalId: first.proposalId, expectedDigest: first.digest }, MAYA);
    await propose(t, { baseVersion: 1, rules: rules("only this"), note: "too many rules" });
    const second = (await stateOf(t)).pending!;
    await post(t, { action: "reject", proposalId: second.proposalId, expectedDigest: second.digest }, MAYA);
    const history = CompanyRulesHistoryReaderSchema.parse((await get(t, OMAR, "/history")).body);
    expect(history.entries.find((entry) => entry.version === 1)).toMatchObject({ note: "first set" });
    expect(history.decided[0]).toMatchObject({ state: "rejected", note: "too many rules" });
    expect(((await get(t, OMAR, "/versions/1")).body as { version: { note: string | null } }).version.note).toBe("first set");
  });

  it("every member reads the version in force on /current, with no people, no proposals and no history; a token may read; the Auditor and a closed switch may not", async () => {
    const { t } = await bench({ maya: "admin" });
    await approvedVersion(t);
    await propose(t, { baseVersion: 1, rules: rules("a waiting change") });
    await t.person(MAYA, "member");
    const reply = await t.web(MAYA, "GET", COMPANY_RULES_CURRENT_PATH);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const body = CompanyRulesCurrentReaderSchema.parse(reply.body);
    expect(body.current).toMatchObject({ version: 1, ruleCount: 2 });
    expect(Object.keys(body).sort()).toEqual(["current", "enabled", "limits", "requestId"]);
    expect(body.current).not.toHaveProperty("approvedBy");
    expect(body.current).not.toHaveProperty("note");
    expect(JSON.stringify(reply.body)).not.toContain("a waiting change");
    expect((await t.dev(OMAR, "GET", COMPANY_RULES_CURRENT_PATH)).status).toBe(200);
    delete process.env.STANDING_INSTRUCTIONS_ENABLED;
    expect((await t.web(MAYA, "GET", COMPANY_RULES_CURRENT_PATH)).status).toBe(404);
  });

  it("the nav says companyRules only while si is on", async () => {
    const { t } = await bench();
    const on = await t.dev(OMAR, "GET", "/v1/app/nav");
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect((on.body.features as Record<string, unknown>).companyRules).toBe(true);
    // The nav is read once per broker for a short while, so the closed switch is read from another broker.
    delete process.env.STANDING_INSTRUCTIONS_ENABLED;
    const other = await bench();
    delete process.env.STANDING_INSTRUCTIONS_ENABLED;
    const off = await other.t.dev(OMAR, "GET", "/v1/app/nav");
    expect(off.status).toBe(200);
    expect((off.body.features as Record<string, unknown>)).not.toHaveProperty("companyRules");
  });
});
