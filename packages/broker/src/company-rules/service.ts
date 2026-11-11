// Company rules (G-04, decisions 57 and 85): who may do what. Every change to the rules is a PROPOSAL that waits (at most one at a time); a version exists only when a person other than the proposer approves it.
//   - PROPOSING needs a live company owner or admin. It changes nothing that runs. A repeat of the same request id is the same proposal (nothing is written twice); the same id with other content is IDEMPOTENCY_CONFLICT.
//   - APPROVING needs a live company owner or admin, signed in within the last 10 minutes (the stored session, never the request), who is not the proposer. The decision is the shared second-person one (`decideSecondPersonApproval`):
//     a different eligible admin, or, for a company whose only eligible person is its only owner, the sole-owner exception after the 24 hour cool-off, and only with the person's acknowledgement. The evidence the decision rested
//     on (both people's live authority and the company's membership generation) is fenced into the SAME transaction as the new version and its audit event, so a person added, removed or demoted in between stops it.
//     A proposal that came back from the company's repository has no person as its proposer: any live admin may approve it (the repository's own review was the first look); it is a version made by "admin_review".
//   - REJECTING is the approver's refusal (a different admin; a repository proposal: any admin). CANCELLING is the proposer withdrawing their own. Neither needs a recent sign-in: a safety action stays easy.
//   - A version is immutable and never rewritten; the head moves one number at a time. The approver pins the proposal's digest, so what they saw is what is approved.
// Nothing here reads a host or writes a file: the repository side is `sync.ts`. Rule text is data: it is folded, screened for secrets and held to the limits on the way in (`rules.ts`) and is never run.
import { COMPANY_RULES_NOTE_MAX, COMPANY_RULES_PROPOSAL_TTL_MS, OrgIdSchema, agentXError, redactText, type AuditEventInput, type OrgId } from "@agentx/contracts";
import { auditCompanyRules, auditOccurrence, type CompanyRulesAuditAction } from "../audit/events.js";
import { foldedRuleText } from "../instructions/standing-block.js";
import { decideSecondPersonApproval } from "../org/second-person-approval.js";
import { readCompanyAdminActorConditions, readSecondPersonApprovalEvidence, type SecondPersonEvidenceDependencies } from "../org/second-person-evidence.js";
import type { TransactItem } from "../audit/outbox.js";
import { diffSummary, normalizeRules, rulesDigest, sameRules, type Rule } from "./rules.js";
import type { Actor, ApprovalMode, CompanyRulesStore, ProposalRecord, VersionRecord } from "./store.js";

export interface CompanyRulesCaller { orgId: OrgId; developerId: string }

export interface CompanyRulesDeps {
  store: CompanyRulesStore;
  now(): number;
  /** A live company owner or admin (`requireLiveCompanyAdmin`), or it throws FORBIDDEN. */
  requireAdmin(caller: CompanyRulesCaller): Promise<void>;
  /** A sign-in within the last 10 minutes by the same person, read from the stored session, or it throws REAUTH_REQUIRED (`requireFreshSignIn`). */
  requireFreshSignIn(caller: CompanyRulesCaller): Promise<void>;
  evidence: SecondPersonEvidenceDependencies;
}

const stale = (message: string) => agentXError("CHANGE_STALE", message);
export const COMPANY_RULES_WORDS = {
  moved: "The company rules changed since you opened them. Reload and make your change again.",
  waiting: "A change to the company rules is already waiting for a decision. Decide or withdraw it first.",
  nothing: "Nothing changed: these are the company rules already in force.",
  expired: "That proposal expired. Make the change again.",
  decided: "That proposal was already decided.",
  digest: "That proposal is not the one you looked at. Reload and check it again.",
  own: "You proposed this change, so a different admin has to decide it. You can withdraw it instead.",
  notYours: "Only the person who proposed a change can withdraw it.",
  notFound: "No such proposal.",
  acknowledge: "Acknowledge that you are approving your own change as the company's only owner.",
} as const;

const memberOf = (caller: CompanyRulesCaller): Actor => ({ kind: "member", id: caller.developerId });
const iso = (ms: number): string => new Date(ms).toISOString();
const isMember = (actor: Actor, developerId: string): boolean => actor.kind === "member" && actor.id === developerId;

/** The audit actor of what a person or Rovara did: members are themselves; the repository, the seed and the system are Rovara acting (the repository's login stays out of the ledger). */
function auditActor(actor: Actor): AuditEventInput["actor"] {
  return actor.kind === "member" ? { kind: "member", id: actor.id } : { kind: "system", id: "rovara" };
}
function event(orgId: OrgId, action: CompanyRulesAuditAction, actor: Actor, at: string, occurrenceParts: string[], facts: Record<string, string | number | boolean | undefined>): AuditEventInput {
  return auditCompanyRules({ orgId, action, actor: auditActor(actor), occurredAt: at, occurrence: auditOccurrence(...occurrenceParts), facts });
}
export const proposedEvent = (orgId: OrgId, proposal: ProposalRecord, action: "company_rules.proposed" | "company_rules.repo_proposed" = "company_rules.proposed"): AuditEventInput =>
  event(orgId, action, proposal.proposedBy, proposal.proposedAt, [proposal.proposalId, action], action === "company_rules.proposed"
    ? { proposalId: proposal.proposalId, baseVersion: proposal.baseVersion, ruleCount: proposal.rules.length, digest: proposal.digest, source: proposal.source }
    : { proposalId: proposal.proposalId, baseVersion: proposal.baseVersion, ruleCount: proposal.rules.length, digest: proposal.digest, revision: proposal.repoRevision });
const decidedEvent = (orgId: OrgId, proposal: ProposalRecord, outcome: "rejected" | "cancelled" | "expired", actor: Actor, at: string): AuditEventInput =>
  event(orgId, `company_rules.${outcome}`, actor, at, [proposal.proposalId, outcome], { proposalId: proposal.proposalId, source: proposal.source, digest: proposal.digest });

export const proposalExpired = (proposal: ProposalRecord, nowMs: number): boolean => Date.parse(proposal.expiresAt) <= nowMs;

/** The note a proposer may add: plain text, folded to one line, at most 300 characters, and never something that looks like a secret. */
function noteOf(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const folded = foldedRuleText(note);
  if (folded === "") return undefined;
  if (Array.from(folded).length > COMPANY_RULES_NOTE_MAX) throw agentXError("CONFIG_INVALID", `The note is longer than ${String(COMPANY_RULES_NOTE_MAX)} characters.`);
  if (redactText(folded) !== folded) throw agentXError("CONFIG_INVALID", "The note looks like it holds a secret. Take it out.");
  return folded;
}

const validCaller = (caller: CompanyRulesCaller): void => {
  if (!OrgIdSchema.safeParse(caller.orgId).success || !/^[a-f0-9]{64}$/u.test(caller.developerId)) throw agentXError("FORBIDDEN", "Live company owner or admin access is required.");
};

export type ProposeResult = { proposal: ProposalRecord; replay: boolean };

/** Makes the one waiting proposal. See the file header. `baseVersion` is the version the person edited from (0: none yet). */
export async function proposeRules(deps: CompanyRulesDeps, caller: CompanyRulesCaller, input: { requestId: string; baseVersion: number; rules: readonly { text: string; priority: "required" | "preferred" }[]; note?: string | undefined }): Promise<ProposeResult> {
  validCaller(caller);
  await deps.requireAdmin(caller);
  const rules = normalizeRules(input.rules);
  const note = noteOf(input.note);
  const digest = rulesDigest(rules);
  const earlier = await deps.store.proposal(caller.orgId, input.requestId);
  if (earlier !== undefined) {
    if (earlier.source === "rovara" && isMember(earlier.proposedBy, caller.developerId) && earlier.digest === digest && earlier.baseVersion === input.baseVersion && earlier.note === note) return { proposal: earlier, replay: true };
    throw agentXError("IDEMPOTENCY_CONFLICT", "This request id belongs to another change.");
  }
  const head = await deps.store.head(caller.orgId);
  if (head.latestVersion !== input.baseVersion) throw stale(COMPANY_RULES_WORDS.moved);
  // With no version yet, an empty list changes nothing (there are no rules to clear).
  if (head.latestVersion === 0 && rules.length === 0) throw agentXError("CONFIG_INVALID", COMPANY_RULES_WORDS.nothing);
  if (head.latestVersion > 0) {
    const current = await deps.store.version(caller.orgId, head.latestVersion);
    if (current === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "The company rules could not be read. Try again.");
    if (sameRules(current.rules, rules)) throw agentXError("CONFIG_INVALID", COMPANY_RULES_WORDS.nothing);
  }
  const now = deps.now();
  let replacing: ProposalRecord | undefined;
  if (head.pendingProposalId !== undefined) {
    const waiting = await deps.store.proposal(caller.orgId, head.pendingProposalId);
    if (waiting === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "The company rules could not be read. Try again.");
    if (waiting.state === "pending" && !proposalExpired(waiting, now)) throw stale(COMPANY_RULES_WORDS.waiting);
    if (waiting.state === "pending") replacing = waiting;
  }
  const at = iso(now);
  const proposal: ProposalRecord = { proposalId: input.requestId, state: "pending", baseVersion: input.baseVersion, source: "rovara", rules, digest, ...(note === undefined ? {} : { note }), proposedBy: memberOf(caller), proposedAt: at, expiresAt: iso(now + COMPANY_RULES_PROPOSAL_TTL_MS) };
  const events = [...(replacing === undefined ? [] : [decidedEvent(caller.orgId, replacing, "expired", { kind: "system" }, at)]), proposedEvent(caller.orgId, proposal)];
  if (await deps.store.createProposal({ orgId: caller.orgId, proposal, expectedBase: input.baseVersion, ...(replacing === undefined ? {} : { replacing }), events }) === "conflict") throw stale(COMPANY_RULES_WORDS.waiting);
  return { proposal, replay: false };
}

async function waitingProposal(deps: CompanyRulesDeps, orgId: OrgId, proposalId: string): Promise<ProposalRecord> {
  const proposal = await deps.store.proposal(orgId, proposalId);
  if (proposal === undefined) throw agentXError("NOT_FOUND", COMPANY_RULES_WORDS.notFound);
  return proposal;
}

/** What the approver's authority is for this proposal: the fence to commit with it, and the mode the version records. */
async function approvalAuthority(deps: CompanyRulesDeps, caller: CompanyRulesCaller, proposal: ProposalRecord, soleOwnerAcknowledged: boolean | undefined): Promise<{ conditions: TransactItem[]; mode: ApprovalMode }> {
  if (proposal.proposedBy.kind !== "member") return { conditions: await readCompanyAdminActorConditions(deps.evidence, { orgId: caller.orgId, actorId: caller.developerId }), mode: "admin_review" };
  const evidence = await readSecondPersonApprovalEvidence(deps.evidence, { orgId: caller.orgId, proposerId: proposal.proposedBy.id, approverId: caller.developerId });
  const decision = decideSecondPersonApproval(evidence.decisionInput);
  if (decision.mode === "sole_owner_exception" && soleOwnerAcknowledged !== true) throw agentXError("FORBIDDEN", COMPANY_RULES_WORDS.acknowledge);
  return { conditions: evidence.conditions, mode: decision.mode };
}

export type ApproveResult = { version: VersionRecord; replay: boolean };

/** Approves exactly the proposal (and digest) the person looked at: version `base + 1`. See the file header. */
export async function approveProposal(deps: CompanyRulesDeps, caller: CompanyRulesCaller, input: { proposalId: string; expectedDigest: string; soleOwnerAcknowledged?: boolean | undefined }): Promise<ApproveResult> {
  validCaller(caller);
  await deps.requireAdmin(caller);
  await deps.requireFreshSignIn(caller);
  const proposal = await waitingProposal(deps, caller.orgId, input.proposalId);
  if (proposal.digest !== input.expectedDigest) throw stale(COMPANY_RULES_WORDS.digest);
  if (proposal.state === "approved" && proposal.decidedBy !== undefined && isMember(proposal.decidedBy, caller.developerId) && proposal.version !== undefined) {
    const made = await deps.store.version(caller.orgId, proposal.version);
    if (made !== undefined) return { version: made, replay: true };
  }
  if (proposal.state !== "pending") throw stale(COMPANY_RULES_WORDS.decided);
  const now = deps.now();
  if (proposalExpired(proposal, now)) throw stale(COMPANY_RULES_WORDS.expired);
  const head = await deps.store.head(caller.orgId);
  if (head.latestVersion !== proposal.baseVersion || head.pendingProposalId !== proposal.proposalId) throw stale(COMPANY_RULES_WORDS.moved);
  const { conditions, mode } = await approvalAuthority(deps, caller, proposal, input.soleOwnerAcknowledged);
  const at = iso(now);
  const version: VersionRecord = {
    version: proposal.baseVersion + 1, digest: proposal.digest, rules: proposal.rules, source: proposal.source, approvalMode: mode, proposedBy: proposal.proposedBy, approvedBy: memberOf(caller),
    proposalId: proposal.proposalId, baseVersion: proposal.baseVersion, proposedAt: proposal.proposedAt, approvedAt: at, ...(proposal.note === undefined ? {} : { note: proposal.note }),
  };
  const approved = event(caller.orgId, "company_rules.approved", memberOf(caller), at, [proposal.proposalId, "approved"], {
    proposalId: proposal.proposalId, version: version.version, baseVersion: proposal.baseVersion, ruleCount: version.rules.length, digest: version.digest, source: proposal.source, approvalMode: mode,
  });
  const result = await deps.store.decideProposal({ orgId: caller.orgId, proposal, outcome: "approved", decidedBy: memberOf(caller), decidedAt: at, version, conditions, events: [approved] });
  if (result === "conflict") {
    // A lost race or a fence that moved. If the proposal is now approved by this same person, the first call won: that is the answer.
    const after = await deps.store.proposal(caller.orgId, proposal.proposalId);
    if (after?.state === "approved" && after.decidedBy !== undefined && isMember(after.decidedBy, caller.developerId) && after.version !== undefined) {
      const made = await deps.store.version(caller.orgId, after.version);
      if (made !== undefined) return { version: made, replay: true };
    }
    throw stale(COMPANY_RULES_WORDS.moved);
  }
  return { version, replay: false };
}

/** The approver's refusal. A different admin (a repository proposal: any admin). Ends the proposal; the rules in force do not change. */
export async function rejectProposal(deps: CompanyRulesDeps, caller: CompanyRulesCaller, input: { proposalId: string; expectedDigest: string }): Promise<{ proposal: ProposalRecord; replay: boolean }> {
  validCaller(caller);
  await deps.requireAdmin(caller);
  const proposal = await waitingProposal(deps, caller.orgId, input.proposalId);
  if (proposal.digest !== input.expectedDigest) throw stale(COMPANY_RULES_WORDS.digest);
  if (proposal.state === "rejected" && proposal.decidedBy !== undefined && isMember(proposal.decidedBy, caller.developerId)) return { proposal, replay: true };
  if (proposal.state !== "pending") throw stale(COMPANY_RULES_WORDS.decided);
  if (isMember(proposal.proposedBy, caller.developerId)) throw agentXError("FORBIDDEN", COMPANY_RULES_WORDS.own);
  const now = deps.now();
  if (proposalExpired(proposal, now)) throw stale(COMPANY_RULES_WORDS.expired);
  const conditions = await readCompanyAdminActorConditions(deps.evidence, { orgId: caller.orgId, actorId: caller.developerId });
  const at = iso(now);
  if (await deps.store.decideProposal({ orgId: caller.orgId, proposal, outcome: "rejected", decidedBy: memberOf(caller), decidedAt: at, conditions, events: [decidedEvent(caller.orgId, proposal, "rejected", memberOf(caller), at)] }) === "conflict") throw stale(COMPANY_RULES_WORDS.moved);
  return { proposal: { ...proposal, state: "rejected", decidedAt: at, decidedBy: memberOf(caller) }, replay: false };
}

/** The proposer withdraws their own waiting proposal. */
export async function cancelProposal(deps: CompanyRulesDeps, caller: CompanyRulesCaller, input: { proposalId: string }): Promise<{ proposal: ProposalRecord; replay: boolean }> {
  validCaller(caller);
  await deps.requireAdmin(caller);
  const proposal = await waitingProposal(deps, caller.orgId, input.proposalId);
  if (!isMember(proposal.proposedBy, caller.developerId)) throw agentXError("FORBIDDEN", COMPANY_RULES_WORDS.notYours);
  if (proposal.state === "cancelled") return { proposal, replay: true };
  if (proposal.state !== "pending") throw stale(COMPANY_RULES_WORDS.decided);
  const conditions = await readCompanyAdminActorConditions(deps.evidence, { orgId: caller.orgId, actorId: caller.developerId });
  const at = iso(deps.now());
  if (await deps.store.decideProposal({ orgId: caller.orgId, proposal, outcome: "cancelled", decidedBy: memberOf(caller), decidedAt: at, conditions, events: [decidedEvent(caller.orgId, proposal, "cancelled", memberOf(caller), at)] }) === "conflict") throw stale(COMPANY_RULES_WORDS.moved);
  return { proposal: { ...proposal, state: "cancelled", decidedAt: at, decidedBy: memberOf(caller) }, replay: false };
}

/** What the page tells the person about approving the waiting proposal (the server decides again at approve). The sole-owner hint is read only for the proposer, whose own approval is the only case it matters for. */
export async function approvalHint(deps: CompanyRulesDeps, caller: CompanyRulesCaller, proposal: ProposalRecord, head: { latestVersion: number }): Promise<{ canApprove: boolean; reason: "you_proposed" | "stale" | "expired" | null; soleOwner: { available: boolean; availableAt: string | null; reasonCode: "SOLE_OWNER_COOL_OFF" | "SECOND_PERSON_REQUIRED" | "ELIGIBILITY_UNAVAILABLE" | "SOLE_OWNER_EXCEPTION_AVAILABLE" } | null }> {
  if (proposalExpired(proposal, deps.now())) return { canApprove: false, reason: "expired", soleOwner: null };
  if (head.latestVersion !== proposal.baseVersion) return { canApprove: false, reason: "stale", soleOwner: null };
  if (!isMember(proposal.proposedBy, caller.developerId)) return { canApprove: true, reason: null, soleOwner: null };
  let soleOwner: { available: boolean; availableAt: string | null; reasonCode: "SOLE_OWNER_COOL_OFF" | "SECOND_PERSON_REQUIRED" | "ELIGIBILITY_UNAVAILABLE" | "SOLE_OWNER_EXCEPTION_AVAILABLE" } = { available: false, availableAt: null, reasonCode: "ELIGIBILITY_UNAVAILABLE" };
  try {
    const evidence = await readSecondPersonApprovalEvidence(deps.evidence, { orgId: caller.orgId, proposerId: caller.developerId, approverId: caller.developerId });
    if (decideSecondPersonApproval(evidence.decisionInput).mode === "sole_owner_exception") soleOwner = { available: true, availableAt: null, reasonCode: "SOLE_OWNER_EXCEPTION_AVAILABLE" };
  } catch (error) {
    const meta = (error as { soleOwner?: { available?: unknown; availableAt?: unknown; reasonCode?: unknown } } | null)?.soleOwner;
    const code = meta?.reasonCode;
    if (code === "SOLE_OWNER_COOL_OFF" || code === "SECOND_PERSON_REQUIRED" || code === "ELIGIBILITY_UNAVAILABLE") soleOwner = { available: false, availableAt: typeof meta?.availableAt === "string" ? meta.availableAt : null, reasonCode: code };
  }
  return { canApprove: soleOwner.available, reason: "you_proposed", soleOwner };
}

/** Summary counts of a version against the one before it (`undefined`: the first, compared with nothing). */
export const versionSummary = (version: VersionRecord, previous: readonly Rule[] | undefined) => diffSummary(previous ?? [], version.rules);
