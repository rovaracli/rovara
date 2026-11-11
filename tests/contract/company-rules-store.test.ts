// Company rules (G-04): the parts under the routes. The rule list's checks and canonical form, the diff, the file's writer and reader (Rovara Code's format), the store's rows (versions immutable, one waiting proposal, the head moving one
// number at a time), the Cloud source of the CompanyInstructionsSource port, and the operator's seed (the owner-approved 14 rules). The routes, the approval guards and the file sync have their own files.
import { afterEach, describe, expect, it } from "vitest";
import { COMPANY_RULES_APP_LIMITS, COMPANY_RULE_LIMITS, CompanyRulesStateSchema, STANDING_INSTRUCTIONS_WORDING, type CompanyRule } from "@agentx/contracts";
import * as web from "../../packages/contracts/src/web.js";
import { diffRules, diffWithSides, normalizeRules, readNumberedDraft, readRulesFile, renderRulesFile, rulesDigest } from "../../packages/broker/src/company-rules/rules.js";
import { companyRulesSourceOver } from "../../packages/broker/src/company-rules/source.js";
import { seedCompanyRules } from "../../packages/broker/src/company-rules/seed.js";
import { dynamoCompanyRulesStore, type ProposalRecord, type VersionRecord } from "../../packages/broker/src/company-rules/store.js";
import { companyRulesPathProblem } from "../../packages/broker/src/company-rules/path.js";
import { connectedCompanyRulesPath } from "../../packages/broker/src/company-rules/connected-path.js";
import { readCompanyInstructions } from "../../packages/broker/src/instructions/company-source.js";
import { auditCompanyRules } from "../../packages/broker/src/audit/events.js";
import { parseSeedArgs, rulesOfDraft } from "../../scripts/seed-company-rules.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { STANDING_INSTRUCTIONS_DRAFT } from "../support/company-rules-draft.js";

const containing = (items: unknown[]): unknown => expect.arrayContaining(items);

const rule = (text: string, priority: CompanyRule["priority"] = "required"): CompanyRule => ({ text, priority });
const ADA = "a".repeat(64);
const BEN = "b".repeat(64);

describe("the app's limits are the contract's limits", () => {
  it("is one set of numbers", () => { expect(COMPANY_RULES_APP_LIMITS).toEqual(COMPANY_RULE_LIMITS); });
  it("the browser entry exports the standing instructions' wording, the very text the broker builds the block from", () => { expect(web.STANDING_INSTRUCTIONS_WORDING).toEqual(STANDING_INSTRUCTIONS_WORDING); });
});

describe("checking and ordering the rules", () => {
  it("folds each rule to one line, takes hidden characters out, and puts Required first, each group in the order given", () => {
    const rules = normalizeRules([rule("b  second\n line", "preferred"), rule("a​ first"), rule("c third", "preferred"), rule("d fourth")]);
    expect(rules).toEqual([rule("a first"), rule("d fourth"), rule("b second line", "preferred"), rule("c third", "preferred")]);
  });

  it("gives the same digest to the same rules, however the input was written, and another to a changed priority or word", () => {
    const one = rulesDigest(normalizeRules([rule("x"), rule("y", "preferred")]));
    expect(rulesDigest(normalizeRules([rule("y", "preferred"), rule("x")]))).toBe(one);
    expect(rulesDigest(normalizeRules([rule(" x "), rule("y\n", "preferred")]))).toBe(one);
    expect(rulesDigest(normalizeRules([rule("x"), rule("y", "required")]))).not.toBe(one);
    expect(rulesDigest(normalizeRules([rule("x"), rule("z", "preferred")]))).not.toBe(one);
  });

  it("refuses an empty rule, a rule of hidden characters only, and says which", () => {
    expect(() => normalizeRules([rule("fine"), rule("   ")])).toThrow(/Rule 2 is empty/);
    expect(() => normalizeRules([rule("​‍")])).toThrow(/Rule 1 is empty/);
  });

  it("refuses a rule that looks like it holds a secret, never handing back a redacted copy", () => {
    const fake = ["gh", "p_", "a".repeat(36)].join("");
    expect(() => normalizeRules([rule(`Use the token ${fake} for the build`)])).toThrow(/looks like it holds a secret/);
  });

  it("enforces every limit on every call: 30 rules, 600 characters each, 12,000 in all (counted on the folded text, in code points)", () => {
    const thirty = Array.from({ length: 30 }, (_, index) => rule(`rule ${String(index)}`));
    expect(normalizeRules(thirty)).toHaveLength(30);
    expect(() => normalizeRules([...thirty, rule("one more")])).toThrow(/31 rules, at most 30/);
    expect(normalizeRules([rule("x".repeat(600))])).toHaveLength(1);
    expect(() => normalizeRules([rule("x".repeat(601))])).toThrow(/601 characters, at most 600/);
    // 600 code points of an astral character are 600 characters, not 1,200.
    expect(normalizeRules([rule("\u{1F600}".repeat(600))])).toHaveLength(1);
    const twenty = Array.from({ length: 21 }, () => rule("y".repeat(580)));
    expect(() => normalizeRules(twenty)).toThrow(/characters in all, at most 12000/);
    // White space is folded before it is counted: 700 characters with a long run of spaces fit.
    expect(normalizeRules([rule(`${"a".repeat(300)}${" ".repeat(400)}${"b".repeat(200)}`)])).toHaveLength(1);
  });
});

describe("the diff", () => {
  const A = normalizeRules([rule("one"), rule("two"), rule("three", "preferred")]);
  it("says same, changed, added and removed in the order of the new list, with counts", () => {
    const B = normalizeRules([rule("one"), rule("two, reworded"), rule("three", "preferred"), rule("four", "preferred")]);
    const diff = diffRules(A, B);
    expect(diff.summary).toEqual({ added: 1, removed: 0, changed: 1, unchanged: 2 });
    expect(diff.entries.map((entry) => entry.kind)).toEqual(["same", "changed", "same", "added"]);
    expect(diff.entries[1]).toEqual({ kind: "changed", before: rule("two"), after: rule("two, reworded") });
  });
  it("a removed rule is shown at its old place, and a rule whose priority changed is a change", () => {
    const diff = diffRules(A, normalizeRules([rule("one"), rule("three")]));
    expect(diff.summary).toEqual({ added: 0, removed: 1, changed: 1, unchanged: 1 });
    expect(diff.entries.map((entry) => entry.kind)).toEqual(["same", "removed", "changed"]);
    expect(diffRules([], A).summary).toEqual({ added: 3, removed: 0, changed: 0, unchanged: 0 });
    expect(diffRules(A, A).summary).toEqual({ added: 0, removed: 0, changed: 0, unchanged: 3 });
  });
});

describe("which side changed", () => {
  const ancestor = normalizeRules([rule("a"), rule("b"), rule("c", "preferred")]);
  it("marks each difference by the side that made it against the last point they agreed on, and the whole as one side or both", () => {
    // Rovara added d; the repository removed b.
    const current = normalizeRules([rule("a"), rule("b"), rule("c", "preferred"), rule("d", "preferred")]);
    const file = normalizeRules([rule("a"), rule("c", "preferred")]);
    const both = diffWithSides(current, file, ancestor);
    expect(both.changedSide).toBe("both");
    expect(both.diff.entries.filter((entry) => entry.kind !== "same").map((entry) => [entry.kind, (entry as { side?: string }).side])).toEqual([["removed", "repo"], ["removed", "rovara"]]);
    // Only the repository moved.
    expect(diffWithSides(ancestor, file, ancestor).changedSide).toBe("repo");
    // Only Rovara moved (the file still holds the ancestor): Rovara added d, so the file lacks it.
    expect(diffWithSides(current, ancestor, ancestor)).toMatchObject({ changedSide: "rovara", diff: { entries: containing([{ kind: "removed", before: rule("d", "preferred"), side: "rovara" }]) } });
    // A reworded rule: the side that did not hold the old words made it.
    const reworded = diffWithSides(normalizeRules([rule("a, better"), rule("b"), rule("c", "preferred")]), ancestor, ancestor);
    expect(reworded.diff.entries[0]).toMatchObject({ kind: "changed", side: "rovara" });
    expect(diffWithSides(ancestor, normalizeRules([rule("a, theirs"), rule("b"), rule("c", "preferred")]), ancestor).diff.entries[0]).toMatchObject({ kind: "changed", side: "repo" });
    // Nothing in common to compare with: both. Nothing different: none.
    expect(diffWithSides(ancestor, file, undefined).changedSide).toBe("both");
    expect(diffWithSides(ancestor, ancestor, ancestor).changedSide).toBeNull();
  });
});

describe("the file", () => {
  it("is written in the format Rovara Code reads and reads back as exactly the same rules", () => {
    const rules = normalizeRules([rule("Never push to main."), rule("- starts like a bullet"), rule("# starts like a heading"), rule("small PRs", "preferred")]);
    const text = renderRulesFile(rules, 7);
    expect(text).toContain("## Required");
    expect(text).toContain("## Preferred");
    expect(text).toContain("version 7");
    const back = readRulesFile(text);
    expect(back).toEqual({ ok: true, rules });
    expect(rulesDigest((back as { rules: CompanyRule[] }).rules)).toBe(rulesDigest(rules));
  });

  it("reads Code's grammar: a bullet with no heading is Required, an indented line continues it, any other heading is a title", () => {
    expect(readRulesFile("# Title\n- plain\n- long rule\n  keeps going\n## Preferred:\n* soft\n")).toEqual({ ok: true, rules: [rule("plain"), rule("long rule keeps going"), rule("soft", "preferred")] });
    expect(readRulesFile("")).toEqual({ ok: true, rules: [] });
  });

  it("refuses a line it cannot place, a file that is too big, and a file over the limits, never dropping a rule", () => {
    expect(readRulesFile("- fine\n1. numbered is not a bullet\n")).toEqual({ ok: false, problem: "file_unreadable" });
    expect(readRulesFile("- x\n".repeat(20_000))).toEqual({ ok: false, problem: "file_too_large" });
    expect(readRulesFile(Array.from({ length: 31 }, (_, index) => `- rule ${String(index)}`).join("\n"))).toEqual({ ok: false, problem: "over_limits" });
  });

  it("only a plain Markdown path is a company rules file", () => {
    for (const ok of [".rovara/company-rules.md", "docs/rules.md", "COMPANY.MD", "a/b/c.md"]) expect(companyRulesPathProblem(ok), ok).toBeUndefined();
    for (const bad of ["", "/abs.md", "../x.md", "a//b.md", "a/./b.md", ".github/rules.md", ".git/x.md", ".hidden.md", "rules.txt", "a b.md", "a\\b.md", "x".repeat(200) + ".md", "AGENTS.md", "docs/CLAUDE.md", ".rovara/lessons.md", "README.md", ".github/copilot-instructions.md", ".rovara/rules/company.md", ".rovara/sub/x.md", "runbooks/deploy.md", "docs/runbooks/deploy.md", "docs/Runbook/x.md"]) expect(companyRulesPathProblem(bad), bad).toBeDefined();
  });
});

describe("the connected path for the merge guard", () => {
  afterEach(() => { delete process.env.STANDING_INSTRUCTIONS_ENABLED; });
  const row = { pk: `ORG#${TEST_ORG}`, sk: "COMPANYRULES#SYNC", revision: 1, repositoryName: "acme/meta", repositoryUrl: "https://github.com/acme/meta.git", repositoryId: 5, path: "docs/our-rules.md", branch: "main", connectedBy: ADA, connectedAt: at, fileState: "match" };
  it("is the company's connected path while si is on, nothing while it is off or nothing is connected, and unreadable (fail closed) when the link cannot be read", async () => {
    const db = new FakeDynamoDb();
    const table = { documentClient: db, tableName: "state" };
    process.env.STANDING_INSTRUCTIONS_ENABLED = "1";
    expect(await connectedCompanyRulesPath(table, TEST_ORG)).toEqual({ ok: true });
    db.set(row);
    expect(await connectedCompanyRulesPath(table, TEST_ORG)).toEqual({ ok: true, path: "docs/our-rules.md" });
    expect(await connectedCompanyRulesPath({ documentClient: { send: () => Promise.reject(new Error("down")) }, tableName: "state" }, TEST_ORG)).toEqual({ ok: false });
    delete process.env.STANDING_INSTRUCTIONS_ENABLED;
    expect(await connectedCompanyRulesPath(table, TEST_ORG)).toEqual({ ok: true });
  });
});

describe("the owner-approved draft", () => {
  it("reads as 14 rules, 7 Required and 7 Preferred, none of which trips the secret check, and within the limits", () => {
    const rules = readNumberedDraft(STANDING_INSTRUCTIONS_DRAFT);
    expect(rules).toHaveLength(14);
    expect(rules.filter((entry) => entry.priority === "required")).toHaveLength(7);
    expect(rules.filter((entry) => entry.priority === "preferred")).toHaveLength(7);
    expect(rulesOfDraft(STANDING_INSTRUCTIONS_DRAFT)).toEqual(rules);
    expect(rules[0]!.text.startsWith("Never put secrets, passwords, API keys, tokens or personal data in code")).toBe(true);
  });
});

// ---- the store

function bench() {
  const db = new FakeDynamoDb();
  const audit = capturingAuditDeps({ db });
  const store = dynamoCompanyRulesStore({ documentClient: db, tableName: "state", audit: audit.audit });
  return { db, audit, store };
}
const at = "2026-11-11T05:00:00.000Z";
const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const event = (action: "company_rules.proposed" | "company_rules.approved" | "company_rules.rejected", proposalId: string) =>
  auditCompanyRules({ orgId: TEST_ORG, action, actor: { kind: "member", id: ADA }, occurredAt: at, occurrence: JSON.stringify([proposalId, action]), facts: action === "company_rules.rejected" ? { proposalId, source: "rovara", digest: "d".repeat(64) } : { proposalId, baseVersion: 0, ruleCount: 1, digest: "d".repeat(64), source: "rovara", ...(action === "company_rules.approved" ? { version: 1, approvalMode: "second_person" } : {}) } });
const proposalOf = (id: string, base: number, rules = normalizeRules([rule("a rule")])): ProposalRecord => ({ proposalId: id, state: "pending", baseVersion: base, source: "rovara", rules, digest: rulesDigest(rules), proposedBy: { kind: "member", id: ADA }, proposedAt: at, expiresAt: "2026-11-18T05:00:00.000Z" });
const versionOf = (proposal: ProposalRecord): VersionRecord => ({ version: proposal.baseVersion + 1, digest: proposal.digest, rules: proposal.rules, source: "rovara", approvalMode: "second_person", proposedBy: proposal.proposedBy, approvedBy: { kind: "member", id: BEN }, proposalId: proposal.proposalId, baseVersion: proposal.baseVersion, proposedAt: at, approvedAt: at });

describe("the store", () => {
  it("holds at most one waiting proposal, and writes the audit event in the same transaction as the proposal", async () => {
    const { store, audit, db } = bench();
    const first = proposalOf(ID1, 0);
    expect(await store.createProposal({ orgId: TEST_ORG, proposal: first, expectedBase: 0, events: [event("company_rules.proposed", ID1)] })).toBe("ok");
    expect(await store.createProposal({ orgId: TEST_ORG, proposal: proposalOf(ID2, 0), expectedBase: 0, events: [event("company_rules.proposed", ID2)] })).toBe("conflict");
    expect((await store.head(TEST_ORG)).pendingProposalId).toBe(ID1);
    expect(await store.proposal(TEST_ORG, ID2)).toBeUndefined();
    expect(audit.recordedBy("company_rules.proposed").map((e) => e.facts?.proposalId)).toEqual([ID1]);
    // A refused transaction leaves no audit item behind either.
    expect(db.find((item) => String(item.sk).includes(ID2))).toEqual([]);
  });

  it("approving writes version base + 1, immutable, moves the head, clears the waiting proposal, and audits, all or nothing", async () => {
    const { store, audit } = bench();
    const proposal = proposalOf(ID1, 0);
    await store.createProposal({ orgId: TEST_ORG, proposal, expectedBase: 0, events: [event("company_rules.proposed", ID1)] });
    const done = await store.decideProposal({ orgId: TEST_ORG, proposal, outcome: "approved", decidedBy: { kind: "member", id: BEN }, decidedAt: at, version: versionOf(proposal), events: [event("company_rules.approved", ID1)] });
    expect(done).toBe("ok");
    expect(await store.head(TEST_ORG)).toMatchObject({ latestVersion: 1, latestDigest: proposal.digest });
    expect((await store.head(TEST_ORG)).pendingProposalId).toBeUndefined();
    expect(await store.version(TEST_ORG, 1)).toMatchObject({ version: 1, digest: proposal.digest, approvedBy: { kind: "member", id: BEN } });
    expect(await store.proposal(TEST_ORG, ID1)).toMatchObject({ state: "approved", version: 1 });
    expect(audit.recordedBy("company_rules.approved")).toHaveLength(1);
    // The same proposal cannot be approved twice, and the version is not written again.
    expect(await store.decideProposal({ orgId: TEST_ORG, proposal, outcome: "approved", decidedBy: { kind: "member", id: BEN }, decidedAt: at, version: versionOf(proposal), events: [event("company_rules.approved", ID1)] })).toBe("conflict");
    expect(audit.recordedBy("company_rules.approved")).toHaveLength(1);
  });

  it("the history is immutable: a version row is never overwritten, and a version that skips a number is refused", async () => {
    const { store, db } = bench();
    const p1 = proposalOf(ID1, 0);
    await store.createProposal({ orgId: TEST_ORG, proposal: p1, expectedBase: 0, events: [event("company_rules.proposed", ID1)] });
    await store.decideProposal({ orgId: TEST_ORG, proposal: p1, outcome: "approved", decidedBy: { kind: "member", id: BEN }, decidedAt: at, version: versionOf(p1), events: [event("company_rules.approved", ID1)] });
    const before = JSON.stringify(db.get({ pk: `ORG#${TEST_ORG}`, sk: "COMPANYRULES#V#000000001" }));
    // A proposal written against base 0 again cannot become a second version 1 (the head is at 1), and a skipping version is refused before any write.
    const stale = proposalOf(ID2, 0, normalizeRules([rule("other")]));
    expect(await store.createProposal({ orgId: TEST_ORG, proposal: stale, expectedBase: 0, events: [event("company_rules.proposed", ID2)] })).toBe("conflict");
    const p2 = proposalOf(ID2, 1, normalizeRules([rule("other")]));
    await store.createProposal({ orgId: TEST_ORG, proposal: p2, expectedBase: 1, events: [event("company_rules.proposed", ID2)] });
    expect(await store.decideProposal({ orgId: TEST_ORG, proposal: p2, outcome: "approved", decidedBy: { kind: "member", id: BEN }, decidedAt: at, version: { ...versionOf(p2), version: 5 }, events: [event("company_rules.approved", ID2)] })).toBe("conflict");
    expect(JSON.stringify(db.get({ pk: `ORG#${TEST_ORG}`, sk: "COMPANYRULES#V#000000001" }))).toBe(before);
    expect((await store.head(TEST_ORG)).latestVersion).toBe(1);
    // No function of the store updates or deletes a version row.
    expect(Object.keys(store)).not.toContain("deleteVersion");
    expect(Object.keys(store)).not.toContain("updateVersion");
  });

  it("a proposal against a base that is no longer the head is refused, and a rejection frees the slot without a version", async () => {
    const { store } = bench();
    const p1 = proposalOf(ID1, 0);
    await store.createProposal({ orgId: TEST_ORG, proposal: p1, expectedBase: 0, events: [event("company_rules.proposed", ID1)] });
    expect(await store.decideProposal({ orgId: TEST_ORG, proposal: p1, outcome: "rejected", decidedBy: { kind: "member", id: BEN }, decidedAt: at, events: [event("company_rules.rejected", ID1)] })).toBe("ok");
    expect((await store.head(TEST_ORG)).latestVersion).toBe(0);
    expect((await store.head(TEST_ORG)).pendingProposalId).toBeUndefined();
    expect(await store.version(TEST_ORG, 1)).toBeUndefined();
    expect((await store.decided(TEST_ORG, 20)).map((p) => [p.proposalId, p.state])).toEqual([[ID1, "rejected"]]);
    expect(await store.createProposal({ orgId: TEST_ORG, proposal: proposalOf(ID2, 3), expectedBase: 3, events: [event("company_rules.proposed", ID2)] })).toBe("conflict");
  });

  it("refuses every write when there is no audit ledger, and a row that does not read is no version", async () => {
    const db = new FakeDynamoDb();
    const store = dynamoCompanyRulesStore({ documentClient: db, tableName: "state" });
    await expect(store.createProposal({ orgId: TEST_ORG, proposal: proposalOf(ID1, 0), expectedBase: 0, events: [event("company_rules.proposed", ID1)] })).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(db.find((item) => String(item.sk).startsWith("COMPANYRULES#"))).toEqual([]);
    db.set({ pk: `ORG#${TEST_ORG}`, sk: "COMPANYRULES#V#000000001", rules: "not a list", version: 1 });
    expect(await store.version(TEST_ORG, 1)).toBeUndefined();
  });

  it("lists versions newest first and pages below a version", async () => {
    const { store } = bench();
      for (let n = 0; n < 4; n += 1) {
      const id = `00000000-0000-4000-8000-00000000000${String(n)}`;
      const proposal = proposalOf(id, n, normalizeRules([rule(`r${String(n)}`)]));
      await store.createProposal({ orgId: TEST_ORG, proposal, expectedBase: n, events: [event("company_rules.proposed", id)] });
      await store.decideProposal({ orgId: TEST_ORG, proposal, outcome: "approved", decidedBy: { kind: "member", id: BEN }, decidedAt: at, version: versionOf(proposal), events: [event("company_rules.approved", id)] });
    }
    expect((await store.versions(TEST_ORG, { limit: 2 })).map((v) => v.version)).toEqual([4, 3]);
    expect((await store.versions(TEST_ORG, { before: 3, limit: 5 })).map((v) => v.version)).toEqual([2, 1]);
  });
});

describe("the Cloud source of the company's rules", () => {
  async function approved(rules: CompanyRule[], count = 1) {
    const { store } = bench();
    for (let n = 0; n < count; n += 1) {
      const id = `00000000-0000-4000-8000-00000000000${String(n)}`;
      const proposal = proposalOf(id, n, n === count - 1 ? normalizeRules(rules) : normalizeRules([rule(`earlier ${String(n)}`)]));
      await store.createProposal({ orgId: TEST_ORG, proposal, expectedBase: n, events: [event("company_rules.proposed", id)] });
      await store.decideProposal({ orgId: TEST_ORG, proposal, outcome: "approved", decidedBy: { kind: "member", id: BEN }, decidedAt: at, version: versionOf(proposal), events: [event("company_rules.approved", id)] });
    }
    return store;
  }

  it("answers nothing for a company with no version, and the NEWEST approved version otherwise", async () => {
    const empty = bench().store;
    expect(await companyRulesSourceOver(empty).current(TEST_ORG)).toBeUndefined();
    const store = await approved([rule("latest rule"), rule("soft one", "preferred")], 3);
    expect(await companyRulesSourceOver(store).current(TEST_ORG)).toEqual({ version: "3", rules: [rule("latest rule"), rule("soft one", "preferred")] });
  });

  it("does not answer for a key that is not a company, and never a waiting proposal's rules", async () => {
    const { store } = bench();
    const waiting = proposalOf(ID1, 0, normalizeRules([rule("not approved yet")]));
    await store.createProposal({ orgId: TEST_ORG, proposal: waiting, expectedBase: 0, events: [event("company_rules.proposed", ID1)] });
    expect(await companyRulesSourceOver(store).current(TEST_ORG)).toBeUndefined();
    expect(await companyRulesSourceOver(store).current("not-an-org")).toBeUndefined();
  });

  it("a head whose version cannot be read fails closed instead of answering no rules", async () => {
    const { store, db } = bench();
    const proposal = proposalOf(ID1, 0);
    await store.createProposal({ orgId: TEST_ORG, proposal, expectedBase: 0, events: [event("company_rules.proposed", ID1)] });
    await store.decideProposal({ orgId: TEST_ORG, proposal, outcome: "approved", decidedBy: { kind: "member", id: BEN }, decidedAt: at, version: versionOf(proposal), events: [event("company_rules.approved", ID1)] });
    db.set({ pk: `ORG#${TEST_ORG}`, sk: "COMPANYRULES#V#000000001", version: 1, rules: "damaged" });
    const source = companyRulesSourceOver(store);
    await expect(source.current(TEST_ORG)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    // The port's reader turns it into a refused step, never a step with no rules.
    await expect(readCompanyInstructions(source, TEST_ORG)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("what it answers passes the port's own checks (the snapshot schema and the limits)", async () => {
    const store = await approved([rule("ok")]);
    const snapshot = await readCompanyInstructions(companyRulesSourceOver(store), TEST_ORG);
    expect(snapshot).toEqual({ version: "1", rules: [rule("ok")] });
  });
});

describe("the operator's seed", () => {
  const rules = () => readNumberedDraft(STANDING_INSTRUCTIONS_DRAFT);
  const REF = "owner decision 85, 2026-11-11";
  it("a dry run writes nothing; --apply writes version 1 as 'seed' with the operator's own approval note and its audit event; a second run changes nothing", async () => {
    const { store, audit, db } = bench();
    const deps = { store, now: () => Date.parse(at) };
    const dry = await seedCompanyRules(deps, { orgId: TEST_ORG, rules: rules(), apply: false });
    expect(dry.status).toBe("would_seed");
    expect(db.find((item) => String(item.sk).startsWith("COMPANYRULES#"))).toEqual([]);
    const done = await seedCompanyRules(deps, { orgId: TEST_ORG, rules: rules(), apply: true, approvalRef: REF });
    expect(done.status).toBe("seeded");
    expect(await store.version(TEST_ORG, 1)).toMatchObject({ source: "seed", approvalMode: "seed", approvedBy: { kind: "seed" }, proposalId: "seed", baseVersion: 0, note: REF });
    expect((await store.version(TEST_ORG, 1))!.rules).toHaveLength(14);
    expect(await companyRulesSourceOver(store).current(TEST_ORG)).toMatchObject({ version: "1" });
    const [seeded] = audit.recordedBy("company_rules.approved");
    expect(seeded).toMatchObject({ actor: { kind: "system" }, facts: { version: 1, ruleCount: 14, source: "seed", approvalMode: "seed" } });
    const again = await seedCompanyRules(deps, { orgId: TEST_ORG, rules: rules(), apply: true, approvalRef: REF });
    expect(again.status).toBe("already_has_versions");
    expect(audit.recordedBy("company_rules.approved")).toHaveLength(1);
  });

  it("writes nothing unless the operator says what approved the rules: no approval reference, an empty one, a long one or a secret-like one is refused, and no note is made up", async () => {
    const { store, db } = bench();
    const deps = { store, now: () => Date.parse(at) };
    const fake = ["gh", "p_", "q".repeat(36)].join("");
    for (const approvalRef of [undefined, "", "   ", "x".repeat(301), `approved with ${fake}`]) {
      await expect(seedCompanyRules(deps, { orgId: TEST_ORG, rules: rules(), apply: true, approvalRef }), String(approvalRef)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(db.find((item) => String(item.sk).startsWith("COMPANYRULES#"))).toEqual([]);
    expect(JSON.stringify(await seedCompanyRules(deps, { orgId: TEST_ORG, rules: rules(), apply: false }))).not.toContain("decision 85");
  });

  it("is refused, saying which, for a company that has a version or a waiting proposal; a company whose only proposal was cancelled can still be seeded; and for rules over the limits", async () => {
    const waiting = bench();
    await waiting.store.createProposal({ orgId: TEST_ORG, proposal: proposalOf(ID1, 0), expectedBase: 0, events: [event("company_rules.proposed", ID1)] });
    expect((await seedCompanyRules({ store: waiting.store, now: () => 1 }, { orgId: TEST_ORG, rules: rules(), apply: true, approvalRef: REF })).status).toBe("proposal_waiting");
    // The proposal is cancelled: the head now holds latestVersion 0 and nothing waits. That is not "already has versions".
    const proposal = proposalOf(ID1, 0);
    await waiting.store.decideProposal({ orgId: TEST_ORG, proposal, outcome: "cancelled", decidedBy: { kind: "member", id: ADA }, decidedAt: at, events: [] });
    expect(await waiting.store.head(TEST_ORG)).toMatchObject({ latestVersion: 0 });
    expect((await seedCompanyRules({ store: waiting.store, now: () => 1 }, { orgId: TEST_ORG, rules: rules(), apply: true, approvalRef: REF })).status).toBe("seeded");
    await expect(seedCompanyRules({ store: bench().store, now: () => 1 }, { orgId: TEST_ORG, rules: Array.from({ length: 31 }, (_, index) => rule(`r${String(index)}`)), apply: true, approvalRef: REF })).rejects.toThrow(/size budget/);
  });

  it("the store itself refuses a seed under a waiting proposal or over a version, whatever the caller checked", async () => {
    const waiting = bench();
    await waiting.store.createProposal({ orgId: TEST_ORG, proposal: proposalOf(ID1, 0), expectedBase: 0, events: [event("company_rules.proposed", ID1)] });
    const first = proposalOf(ID2, 0, normalizeRules([rule("seeded")]));
    const version = versionOf(first);
    expect(await waiting.store.seedVersion({ orgId: TEST_ORG, version: { ...version, proposalId: "seed", source: "seed", approvalMode: "seed" }, events: [] })).toBe("conflict");
    expect(await waiting.store.version(TEST_ORG, 1)).toBeUndefined();
    const taken = bench();
    const p = proposalOf(ID1, 0);
    await taken.store.createProposal({ orgId: TEST_ORG, proposal: p, expectedBase: 0, events: [event("company_rules.proposed", ID1)] });
    await taken.store.decideProposal({ orgId: TEST_ORG, proposal: p, outcome: "approved", decidedBy: { kind: "member", id: BEN }, decidedAt: at, version: versionOf(p), events: [event("company_rules.approved", ID1)] });
    expect(await taken.store.seedVersion({ orgId: TEST_ORG, version: { ...version, proposalId: "seed", source: "seed", approvalMode: "seed" }, events: [] })).toBe("conflict");
    expect((await taken.store.version(TEST_ORG, 1))!.rules).toEqual(p.rules);
  });

  it("reads its options strictly: --apply needs the approval reference and the same company id again", () => {
    const base = ["--state-table", "t", "--org", TEST_ORG, "--draft", "d.md"];
    expect(parseSeedArgs(base, {})).toMatchObject({ stateTable: "t", apply: false });
    expect(parseSeedArgs([...base, "--apply", "--approval-ref", "owner go", "--confirm-org", TEST_ORG], {})).toMatchObject({ apply: true, approvalRef: "owner go" });
    for (const bad of [["--org", TEST_ORG, "--draft", "d"], ["--state-table", "t", "--org", "nope", "--draft", "d"], [...base, "--apply", "--dry-run"], ["--bogus"], [...base, "--apply"],
      [...base, "--apply", "--approval-ref", "owner go"], [...base, "--apply", "--confirm-org", TEST_ORG], [...base, "--apply", "--approval-ref", "owner go", "--confirm-org", "org_aaaaaaaaaaaaaaaaaaaa"], [...base, "--apply", "--approval-ref", " ", "--confirm-org", TEST_ORG]]) {
      expect(() => parseSeedArgs(bad, {}), bad.join(" ")).toThrow();
    }
  });
});

describe("the history of proposals that did not become a version", () => {
  it("lists the latest ones newest first by when they ended, however many there have been and whatever their ids", async () => {
    const { store } = bench();
    const ids = Array.from({ length: 60 }, (_, n) => `${(0xffffff - n * 7919).toString(16).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`);
    for (const [n, id] of ids.entries()) {
      const proposal = proposalOf(id, 0, normalizeRules([rule(`rule ${String(n)}`)]));
      await store.createProposal({ orgId: TEST_ORG, proposal, expectedBase: 0, events: [event("company_rules.proposed", id)] });
      const decidedAt = new Date(Date.parse(at) + n * 60_000).toISOString();
      await store.decideProposal({ orgId: TEST_ORG, proposal, outcome: n % 2 === 0 ? "rejected" : "cancelled", decidedBy: { kind: "member", id: BEN }, decidedAt, events: [event("company_rules.rejected", id)] });
    }
    const latest = await store.decided(TEST_ORG, 20);
    expect(latest.map((p) => p.proposalId)).toEqual(ids.slice(-20).reverse());
    expect(latest.every((p) => p.state === "rejected" || p.state === "cancelled")).toBe(true);
    expect((await store.decided(TEST_ORG, 5)).map((p) => p.proposalId)).toEqual(ids.slice(-5).reverse());
  }, 60_000);
});

describe("the state's schema", () => {
  it("a member's state parses and holds no admin-only fields", () => {
    const state = { enabled: true, viewer: { role: "member", canPropose: false, canDecide: false }, limits: { ...COMPANY_RULES_APP_LIMITS }, current: { version: 1, digest: "a".repeat(64), rules: [rule("x")], ruleCount: 1, approvedAt: at }, pending: null, sync: null };
    expect(CompanyRulesStateSchema.safeParse(state).success).toBe(true);
    expect(CompanyRulesStateSchema.safeParse({ ...state, current: { ...state.current, approvedBy: { id: null, name: "x" } } }).success).toBe(true);
  });
});
