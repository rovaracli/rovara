// Company rules (G-04, owner decision 85): the operator's seed. It loads a rule list the owner approved OUT OF BAND (staging's first version: the 14 rules of `standing-instructions-draft.md`, approved by the owner on 2026-11-11) as an
// APPROVED version 1, with its audit event, in one transaction. It is the only way a version is made without a second admin, so it is deliberately narrow: only for a company with NO version and nothing waiting (the transaction
// is conditional on that), only version 1, never an overwrite, and the version says `source: "seed"` so the page shows "Rovara setup" and the history never passes it off as an admin's decision. The operator must say WHAT approved it
// (`approvalRef`, e.g. "owner decision 85, 2026-11-11"): it is the version's note and nothing is claimed that the operator did not say. Running it again is refused (a version exists, or a proposal waits) and changes nothing. The script `scripts/seed-company-rules.ts` calls this; it is not an API route.
import { COMPANY_RULES_NOTE_MAX, OrgIdSchema, agentXError, redactText, type OrgId } from "@agentx/contracts";
import { auditCompanyRules, auditOccurrence } from "../audit/events.js";
import { foldedRuleText } from "../instructions/standing-block.js";
import { normalizeRules, rulesDigest, type Rule } from "./rules.js";
import type { CompanyRulesStore, VersionRecord } from "./store.js";

export type SeedResult = { status: "seeded"; version: VersionRecord } | { status: "already_has_versions" } | { status: "proposal_waiting" } | { status: "would_seed"; version: VersionRecord };

/** `apply: false` (the default of the script) checks everything and writes nothing. Throws CONFIG_INVALID for rules that fail the checks (limits, empty, secret-like). */
export async function seedCompanyRules(deps: { store: CompanyRulesStore; now(): number }, input: { orgId: OrgId; rules: readonly Rule[]; apply: boolean; /** What approved these rules, as the operator words it (1 to 300 characters; becomes the version's note). Required to write. */ approvalRef?: string | undefined }): Promise<SeedResult> {
  if (!OrgIdSchema.safeParse(input.orgId).success) throw agentXError("CONFIG_INVALID", "That is not a company id.");
  const rules = normalizeRules(input.rules);
  const approvalRef = foldedRuleText(input.approvalRef ?? "");
  if (input.apply && (approvalRef === "" || Array.from(approvalRef).length > COMPANY_RULES_NOTE_MAX || redactText(approvalRef) !== approvalRef)) throw agentXError("CONFIG_INVALID", `Say what approved these rules (1 to ${String(COMPANY_RULES_NOTE_MAX)} characters, no secrets).`);
  const head = await deps.store.head(input.orgId);
  if (head.latestVersion > 0) return { status: "already_has_versions" };
  if (head.pendingProposalId !== undefined) return { status: "proposal_waiting" };
  const at = new Date(deps.now()).toISOString();
  const version: VersionRecord = {
    version: 1, digest: rulesDigest(rules), rules, source: "seed", approvalMode: "seed", proposedBy: { kind: "seed" }, approvedBy: { kind: "seed" }, proposalId: "seed", baseVersion: 0, proposedAt: at, approvedAt: at, ...(approvalRef === "" ? {} : { note: approvalRef }),
  };
  if (!input.apply) return { status: "would_seed", version };
  const event = auditCompanyRules({
    orgId: input.orgId, action: "company_rules.approved", actor: { kind: "system", id: "rovara" }, occurredAt: at, occurrence: auditOccurrence("seed", "approved"),
    facts: { proposalId: "seed", version: 1, baseVersion: 0, ruleCount: rules.length, digest: version.digest, source: "seed", approvalMode: "seed" },
  });
  if (await deps.store.seedVersion({ orgId: input.orgId, version, events: [event] }) === "conflict") return { status: "already_has_versions" };
  return { status: "seeded", version };
}
