// Company rules (G-04): what the page is shown (`contracts/src/app-company-rules.ts`), built from the store's records. Pure: names are looked up by the caller and passed in. A member sees the version in force and nothing else;
// an owner or admin also sees who proposed and approved, the waiting proposal with its diff, the history and the file link. Everything a person or a host wrote (a rule, a note, a login, a repository name) is data for the page
// to show as plain text.
import {
  COMPANY_RULES_APP_LIMITS, COMPANY_RULES_SYNC_PROBLEM_TEXT, type CompanyRulesHistory, type CompanyRulesPerson, type CompanyRulesProposal, type CompanyRulesState, type CompanyRulesSync, type CompanyRulesVersion,
} from "@agentx/contracts";
import { diffRules, diffSummary, diffWithSides, type Rule } from "./rules.js";
import { proposalExpired } from "./service.js";
import type { Actor, Head, ProposalRecord, SyncRecord, VersionRecord } from "./store.js";

export type Names = ReadonlyMap<string, string>;

/** The member ids a view will name, so the caller can look their display names up once. */
export function actorIds(...actors: ReadonlyArray<Actor | undefined>): string[] {
  return [...new Set(actors.flatMap((actor) => (actor?.kind === "member" ? [actor.id] : [])))];
}

export function personOf(actor: Actor, names: Names): CompanyRulesPerson {
  switch (actor.kind) {
    case "member": return { id: actor.id, name: names.get(actor.id) ?? "Unknown" };
    case "repo": return { id: null, name: "Company repository", ...(actor.login === undefined ? {} : { login: actor.login }) };
    case "seed": return { id: null, name: "Rovara setup" };
    case "system": return { id: null, name: "Rovara" };
  }
}

export function versionView(version: VersionRecord, admin: boolean, names: Names): CompanyRulesVersion {
  return {
    version: version.version, digest: version.digest, rules: version.rules.map((rule) => ({ text: rule.text, priority: rule.priority })), ruleCount: version.rules.length, approvedAt: version.approvedAt,
    ...(admin ? { approvedBy: personOf(version.approvedBy, names), proposedBy: personOf(version.proposedBy, names), source: version.source, approvalMode: version.approvalMode, baseVersion: version.baseVersion, note: version.note ?? null, adoptedBy: version.adoptedBy === undefined ? null : personOf(version.adoptedBy, names) } : {}),
  };
}

export type Hint = CompanyRulesProposal["approval"];

export function proposalView(proposal: ProposalRecord, input: { current: readonly Rule[]; head: Head; developerId: string; names: Names; hint: Hint }): CompanyRulesProposal {
  return {
    proposalId: proposal.proposalId, state: "pending", baseVersion: proposal.baseVersion, stale: input.head.latestVersion !== proposal.baseVersion, source: proposal.source,
    rules: proposal.rules.map((rule) => ({ text: rule.text, priority: rule.priority })), ruleCount: proposal.rules.length, digest: proposal.digest, note: proposal.note ?? null,
    proposedBy: personOf(proposal.proposedBy, input.names), adoptedBy: proposal.adoptedBy === undefined ? null : personOf(proposal.adoptedBy, input.names),
    proposedByYou: [proposal.proposedBy, proposal.adoptedBy].some((who) => who?.kind === "member" && who.id === input.developerId),
    proposedAt: proposal.proposedAt, expiresAt: proposal.expiresAt, diff: diffRules(input.current, proposal.rules), approval: input.hint,
  };
}

/** The status line of the file link. */
function syncStatus(sync: SyncRecord): NonNullable<CompanyRulesState["sync"]>["status"] {
  if (sync.fileState === "never_checked") return "never_checked";
  if (sync.problem !== undefined && sync.fileState === "unreadable") return sync.problem === "file_unreadable" ? "file_unreadable" : "problem";
  if (sync.problem !== undefined) return "problem";
  if (sync.fileState === "match") return "in_sync";
  if (sync.fileState === "missing") return sync.writeBack !== undefined && (sync.writeBack.state === "open" || sync.writeBack.state === "waiting") ? "waiting_for_pull_request" : "file_missing";
  if (sync.writeBack !== undefined && (sync.writeBack.state === "open" || sync.writeBack.state === "waiting")) return "waiting_for_pull_request";
  return "file_differs";
}

export function syncSummaryView(sync: SyncRecord | undefined): CompanyRulesState["sync"] {
  if (sync === undefined) return null;
  return { connected: true, repository: sync.repositoryName, path: sync.path, branch: sync.branch, status: syncStatus(sync), lastCheckedAt: sync.lastCheckedAt ?? null };
}

/** The file link's diff (Rovara's version in force against the file) with the side each difference came from. */
function sidesOf(sync: SyncRecord, current: VersionRecord | undefined): Pick<Extract<CompanyRulesSync, { connected: true }>, "diff" | "changedSide"> {
  if (sync.fileRules === undefined) return { diff: null, changedSide: null };
  const { diff, changedSide } = diffWithSides(current?.rules ?? [], sync.fileRules, sync.syncedRules);
  return { diff, changedSide };
}

export function syncView(sync: SyncRecord | undefined, input: { current: VersionRecord | undefined; pendingFromRepo: boolean; names: Names }): CompanyRulesSync {
  if (sync === undefined) return { connected: false };
  const fileRules = sync.fileRules?.map((rule) => ({ text: rule.text, priority: rule.priority })) ?? null;
  return {
    connected: true, repository: { name: sync.repositoryName, url: sync.repositoryUrl }, path: sync.path, branch: sync.branch,
    connectedBy: personOf({ kind: "member", id: sync.connectedBy }, input.names), connectedAt: sync.connectedAt,
    lastCheckedAt: sync.lastCheckedAt ?? null, lastCheckedRevision: sync.lastCheckedRevision ?? null, fileState: sync.fileState,
    problem: sync.problem === undefined ? null : { code: sync.problem, text: COMPANY_RULES_SYNC_PROBLEM_TEXT[sync.problem] },
    fileRules, ...sidesOf(sync, input.current),
    pendingFromRepo: input.pendingFromRepo,
    writeBack: sync.writeBack === undefined ? null : {
      version: sync.writeBack.version, state: sync.writeBack.state,
      pullRequest: sync.writeBack.number === undefined ? null : { number: sync.writeBack.number, url: sync.writeBack.url ?? "" }, updatedAt: sync.writeBack.updatedAt,
    },
  };
}

export function historyView(input: { versions: readonly VersionRecord[]; before: (version: number) => readonly Rule[] | undefined; decided: readonly ProposalRecord[]; names: Names; limit: number; hasMoreBelow: boolean }): CompanyRulesHistory {
  const entries = input.versions.map((version) => ({
    version: version.version, approvedAt: version.approvedAt, approvedBy: personOf(version.approvedBy, input.names), proposedBy: personOf(version.proposedBy, input.names),
    source: version.source, approvalMode: version.approvalMode, ruleCount: version.rules.length, summary: diffSummary(input.before(version.version) ?? [], version.rules), note: version.note ?? null,
    adoptedBy: version.adoptedBy === undefined ? null : personOf(version.adoptedBy, input.names),
  }));
  const last = input.versions[input.versions.length - 1];
  return {
    entries,
    decided: input.decided.flatMap((proposal) => (proposal.state === "rejected" || proposal.state === "cancelled" || proposal.state === "expired") && proposal.decidedAt !== undefined ? [{
      proposalId: proposal.proposalId, state: proposal.state, source: proposal.source, proposedBy: personOf(proposal.proposedBy, input.names), proposedAt: proposal.proposedAt, decidedAt: proposal.decidedAt,
      decidedBy: proposal.decidedBy === undefined ? null : personOf(proposal.decidedBy, input.names), note: proposal.note ?? null,
      adoptedBy: proposal.adoptedBy === undefined ? null : personOf(proposal.adoptedBy, input.names),
    }] : []),
    nextBefore: input.hasMoreBelow && last !== undefined && entries.length >= input.limit ? last.version : null,
  };
}

export const limitsView = (): CompanyRulesState["limits"] => ({ ...COMPANY_RULES_APP_LIMITS });

/** A waiting proposal that has not expired, or undefined (an expired one is not shown: the next proposal replaces it). */
export const livePending = (proposal: ProposalRecord | undefined, nowMs: number): ProposalRecord | undefined => (proposal !== undefined && proposal.state === "pending" && !proposalExpired(proposal, nowMs) ? proposal : undefined);
