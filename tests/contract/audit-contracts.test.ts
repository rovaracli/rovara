import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@rovara/audit-verifier";
import {
  AUDIT_ACTIONS,
  AUDIT_BACKSTOP_SEAL_AGE_MINUTES,
  AUDIT_DETAILS_SHRED_AFTER_CLOSE_DAYS,
  AUDIT_DETAIL_FIELDS_MAX,
  AUDIT_DETAIL_FIELD_MAX_CHARS,
  AUDIT_DETAIL_PARTS_MAX,
  AUDIT_ERROR_MESSAGES,
  AUDIT_EXPORT_MAX_RECORDS,
  AUDIT_EXPORT_URL_SECONDS,
  AUDIT_FACT_KEYS,
  AUDIT_FACT_MAX_CHARS,
  AUDIT_FILTER_SCAN_MAX,
  AUDIT_FLUSH_DEADLINE_MS,
  AUDIT_GOVERNANCE_RETENTION_DAYS,
  AUDIT_INTAKE_MAX_RECEIVES,
  AUDIT_LIMITS_COPY,
  AUDIT_MAX_FACTS,
  AUDIT_MAX_RECORDS_PER_ORG_EPOCH,
  AUDIT_MAX_RELATED,
  AUDIT_PENDING_FAIL_AFTER_DAYS,
  AUDIT_PENDING_SHARDS,
  AUDIT_PENDING_TTL_DAYS,
  AUDIT_RETENTION_DAYS_DEFAULT,
  AUDIT_RETENTION_DAYS_MIN_COMPLIANCE,
  AUDIT_SDK_REQUEST_TIMEOUT_MS,
  AUDIT_SEAL_INTERVAL_MINUTES,
  AUDIT_TARGET_KINDS,
  AUDIT_TRANSIENT_COPY_DAYS,
  AUDIT_TSA_ENDPOINTS,
  AUDIT_TSA_SPACING_MS,
  AUDIT_TSA_TIMEOUT_MS,
  AUDIT_VERSION_SWEEP_KEYS_PER_RUN,
  AgentXErrorCodeSchema,
  AuditActorSchema,
  AuditDetailPartSchema,
  AuditEventIdSchema,
  AuditEventInputSchema,
  AuditProofSchema,
  AuditTargetSchema,
  auditEventId,
  auditOperatorId,
  errorStatus,
  type AuditAction,
} from "../../packages/contracts/src/index.js";
import { AUDIT_LIMITS_COPY as VERIFIER_LIMITS_COPY } from "../../packages/audit-verifier/src/index.js";

const ORG = "org_0123456789abcdefghij";
const NOW = "2026-10-20T12:00:00.000Z";
const SESSION_REF = "a".repeat(64);

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: auditEventId("approval.decided", "apr_1", "approved"),
    orgId: ORG,
    action: "approval.decided",
    actor: { kind: "member", id: "dev_1" },
    target: { kind: "approval", id: "apr_1" },
    occurredAt: NOW,
    related: ["task_1"],
    facts: { kind: "write", decision: "approved", subjectKind: "write", class: "less_safe" },
    ...overrides,
  };
}

describe("audit constants and errors", () => {
  it("pins every constant to the plan's value", () => {
    expect(AUDIT_SEAL_INTERVAL_MINUTES).toBe(15);
    expect(AUDIT_RETENTION_DAYS_DEFAULT).toBe(1096);
    expect(AUDIT_RETENTION_DAYS_MIN_COMPLIANCE).toBe(365);
    expect(AUDIT_GOVERNANCE_RETENTION_DAYS).toBe(1);
    expect(AUDIT_MAX_RELATED).toBe(8);
    expect(AUDIT_MAX_FACTS).toBe(12);
    expect(AUDIT_FACT_MAX_CHARS).toBe(128);
    expect(AUDIT_DETAIL_PARTS_MAX).toBe(4);
    expect(AUDIT_DETAIL_FIELDS_MAX).toBe(10);
    expect(AUDIT_DETAIL_FIELD_MAX_CHARS).toBe(500);
    expect(AUDIT_FLUSH_DEADLINE_MS).toBe(1500);
    expect(AUDIT_SDK_REQUEST_TIMEOUT_MS).toBe(800);
    expect(AUDIT_PENDING_SHARDS).toBe(10);
    expect(AUDIT_PENDING_TTL_DAYS).toBe(14);
    expect(AUDIT_PENDING_FAIL_AFTER_DAYS).toBe(13);
    expect(AUDIT_INTAKE_MAX_RECEIVES).toBe(5);
    expect(AUDIT_MAX_RECORDS_PER_ORG_EPOCH).toBe(10000);
    expect(AUDIT_BACKSTOP_SEAL_AGE_MINUTES).toBe(60);
    expect(AUDIT_VERSION_SWEEP_KEYS_PER_RUN).toBe(200);
    expect(AUDIT_TSA_TIMEOUT_MS).toBe(10000);
    expect(AUDIT_TSA_SPACING_MS).toBe(15000);
    expect(AUDIT_TSA_ENDPOINTS).toEqual({ digicert: "http://timestamp.digicert.com", sectigo: "http://timestamp.sectigo.com" });
    expect(AUDIT_EXPORT_MAX_RECORDS).toBe(200000);
    expect(AUDIT_EXPORT_URL_SECONDS).toBe(900);
    expect(AUDIT_FILTER_SCAN_MAX).toBe(20000);
    expect(AUDIT_DETAILS_SHRED_AFTER_CLOSE_DAYS).toBe(30);
    expect(AUDIT_TRANSIENT_COPY_DAYS).toBe(35);
  });

  it("adds the four error codes with their statuses and exact messages", () => {
    const codes = AgentXErrorCodeSchema.options;
    for (const code of ["AUDIT_RANGE_INVALID", "AUDIT_REASON_REQUIRED", "AUDIT_UNAVAILABLE", "AUDIT_FILTER_TOO_WIDE"] as const) {
      expect(codes).toContain(code);
    }
    expect(errorStatus("AUDIT_RANGE_INVALID")).toBe(400);
    expect(errorStatus("AUDIT_REASON_REQUIRED")).toBe(400);
    expect(errorStatus("AUDIT_FILTER_TOO_WIDE")).toBe(400);
    expect(errorStatus("AUDIT_UNAVAILABLE")).toBe(503);
    expect(AUDIT_ERROR_MESSAGES).toEqual({
      AUDIT_RANGE_INVALID: "Choose a range of at most 200,000 records, with from before to.",
      AUDIT_REASON_REQUIRED: "Say why you are reading this company's audit log (1 to 300 characters).",
      AUDIT_UNAVAILABLE: "Rovara couldn't record this read, so it didn't read anything. Try again in a minute.",
      AUDIT_FILTER_TOO_WIDE: "That filter covers too many records. Narrow the time range to under 20,000 records.",
    });
  });

  it("re-exports the verifier's limits copy", () => {
    expect(AUDIT_LIMITS_COPY).toBe(VERIFIER_LIMITS_COPY);
  });
});

describe("the event catalog", () => {
  it("lists the actions exactly, in order", () => {
    expect([...AUDIT_ACTIONS]).toEqual([
      "approval.decided", "approval.expired", "approval.requested", "approval.rerouted", "write.executed", "spend_request.created", "spend_request.decided",
      "spend_request.expired", "spend_request.escalated", "spend_request.rerouted", "spend_request.resume_dropped", "budget.changed", "spend_policy.changed", "pull_request.opened",
  "pull_request.merged",
  "pull_request.merge_requested",
  "member.joined",
  "member.role_changed",
  "member.removed",
  "member.left",
  "member.renamed",
  "org.closed",
  "org.renamed",
  "org.invite_created",
  "org.invite_revoked",
  "project.archived",
  "project.restored",
  "project.working_branch_changed",
  "project.allowed_domains_proposed",
  "project.allowed_domains_rejected",
  "project.allowed_domains_cancelled",
  "project.allowed_domains_changed",
  "project_member.changed",
  "project_member.removed",
  "slack_channel.proposed",
  "slack_channel.cancelled",
  "slack_channel.rejected",
  "slack_channel.bound",
  "slack_channel.unbound",
  "slack_team.connected",
  "slack_team.disconnected",
  "identity.linked",
  "identity.unlinked",
  "agent.owner_changed",
  "chain.owner_changed",
  "session.owner_changed",
  "session.stopped",
  "session.retried",
  "session.shared",
  "session.linked",
  "session.unlinked",
  "connection.saved",
  "connection.removed",
  "project_connector.changed",
  "guardrails.changed",
  "local_agents.policy_changed",
  "code_settings.changed",
      "comment_trigger_opt_out.applied", "comment_trigger_opt_out.lapsed", "egress_domain.decided", "agent.published",
      "agent.rolled_back", "builtin.adopted", "chain.published", "chain.rolled_back", "trigger.enabled",
      "trigger.disabled", "github.connected", "github.disconnected", "github.installation_changed", "model_source.saved",
      "model_source.removed", "model_source.order_changed", "audit.read",
      "audit.exported", "audit.staff_read", "audit.subject_erased", "audit.org_shred_scheduled",
      // "How we work" playbook (H1)
      "project.models_changed", "project.checks_changed", "project.e2e_policy_changed", "project.model_selection_changed", "project.roster_changed",
      "process.published", "process.rolled_back", "playbook.default_process_changed", "company.change_applied_to_project",
      // v1.2 learning loop (B7)
      "rule.suggested", "rule.accepted", "rule.not_applied", "rule.dismissed", "rule.withdrawn", "rule.rolled_back", "rule.correction_remembered", "project.learning_changed",
      // the company's master suggestions switch
      "rule.suggestions_set",
    ]);
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  it("lists all target kinds including the opaque invite target", () => {
    expect([...AUDIT_TARGET_KINDS]).toEqual([
      "approval", "spend_request", "task", "pull_request", "org", "invite", "member", "project", "agent", "chain", "session", "trigger",
      "connection", "connector", "guardrails", "repository", "domain", "github_installation", "budget", "audit",
      "spend_policy", "model_source",
      "process",
    ]);
  });

  it("has a facts entry for every action, with only non-personal keys", () => {
    expect(Object.keys(AUDIT_FACT_KEYS).sort()).toEqual([...AUDIT_ACTIONS].sort());
    const personal = /email|name|login|repo|domain|reason|ticket|secret|token|password|url/i;
    for (const action of AUDIT_ACTIONS) {
      const keys = AUDIT_FACT_KEYS[action];
      expect(Array.isArray(keys), action).toBe(true);
      expect(new Set(keys).size, action).toBe(keys.length);
      expect(keys.length, action).toBeLessThanOrEqual(AUDIT_MAX_FACTS);
      for (const key of keys) expect(key, `${action}.${key}`).not.toMatch(personal);
    }
  });

  const PLAYBOOK_FACTS = {
    "project.models_changed": { target: { kind: "project", name: "web" }, keys: ["revision", "approvedCount", "defaultChanged"], sample: { revision: 3, approvedCount: 2, defaultChanged: true } },
    "project.checks_changed": { target: { kind: "project", name: "web" }, keys: ["revision", "requiredCount", "optionalCount"], sample: { revision: 3, requiredCount: 2, optionalCount: 1 } },
    "project.e2e_policy_changed": { target: { kind: "project", name: "web" }, keys: ["revision", "screenshots", "traces", "video", "downloads"], sample: { revision: 3, screenshots: true, traces: false, video: false, downloads: true } },
    "project.model_selection_changed": { target: { kind: "project", name: "web" }, keys: ["surface", "cleared"], sample: { surface: "slack", cleared: false } },
    "project.roster_changed": { target: { kind: "project", name: "web" }, keys: ["added", "removed"], sample: { added: 2, removed: 1 } },
    "process.published": { target: { kind: "process", id: "agt_1" }, keys: ["version", "safety", "selfConfirmedSoleOwner"], sample: { version: 2, safety: "safe", selfConfirmedSoleOwner: false } },
    "process.rolled_back": { target: { kind: "process", id: "agt_1" }, keys: ["fromVersion", "toVersion", "safety"], sample: { fromVersion: 3, toVersion: 2, safety: "safe" } },
    "playbook.default_process_changed": { target: { kind: "project", name: "web" }, keys: ["revision", "processKind"], sample: { revision: 4, processKind: "builtin" } },
    "company.change_applied_to_project": { target: { kind: "project", name: "web" }, keys: ["changeRevision", "settingCount"], sample: { changeRevision: 5, settingCount: 2 } },
    // v1.2 learning loop (B7, design 8): ids, counts, flags and fixed words; never a correction's or a rule's text.
    "rule.suggested": { target: { kind: "project", name: "web" }, keys: ["suggestionId", "stage", "sourceCount", "sourceKinds", "lessSafe", "fromOnePerson"], sample: { suggestionId: "sug_1", stage: "build", sourceCount: 2, sourceKinds: "comment,send_back", lessSafe: false, fromOnePerson: false } },
    "rule.accepted": { target: { kind: "project", name: "web" }, keys: ["suggestionId", "ruleId", "stage", "processAgentId", "outcome", "processVersion", "approvalId", "edited", "lessSafe"], sample: { suggestionId: "sug_1", ruleId: "rul_1", stage: "build", processAgentId: "agt_1", outcome: "published", processVersion: 4, edited: true, lessSafe: false } },
    "rule.not_applied": { target: { kind: "project", name: "web" }, keys: ["suggestionId", "ruleId", "approvalOutcome"], sample: { suggestionId: "sug_1", ruleId: "rul_1", approvalOutcome: "declined" } },
    "rule.dismissed": { target: { kind: "project", name: "web" }, keys: ["suggestionId", "stage", "dismissKind"], sample: { suggestionId: "sug_1", stage: "build", dismissKind: "wrong" } },
    "rule.withdrawn": { target: { kind: "project", name: "web" }, keys: ["suggestionId", "stage", "cause"], sample: { suggestionId: "sug_1", stage: "build", cause: "forgotten" } },
    "rule.rolled_back": { target: { kind: "project", name: "web" }, keys: ["ruleId", "processAgentId", "processVersion"], sample: { ruleId: "rul_1", processAgentId: "agt_1", processVersion: 5 } },
    "rule.correction_remembered": { target: { kind: "project", name: "web" }, keys: ["correctionId", "stage", "standing", "op"], sample: { correctionId: "cor_1", stage: "build", standing: "member", op: "remember" } },
    "project.learning_changed": { target: { kind: "project", name: "web" }, keys: ["revision", "enabled", "selfConfirmedSoleOwner"], sample: { revision: 2, enabled: true, selfConfirmedSoleOwner: false } },
    "rule.suggestions_set": { target: { kind: "org", id: "org_aaaaaaaaaaaaaaaaaaaa" }, keys: ["setting", "previous", "source"], sample: { setting: "on", previous: "off", source: "company" } },
  } as const;

  // I10: the learning events hold no text.
  it("I10: no rule.* or project.learning_changed fact can hold text, and a text-like fact is refused", () => {
    const learning = AUDIT_ACTIONS.filter((action) => action.startsWith("rule.") || action === "project.learning_changed");
    expect(learning).toHaveLength(9);
    const textLike = /text|note|body|wording|comment|message|content|title|label/i;
    for (const action of learning) {
      for (const key of AUDIT_FACT_KEYS[action]) expect(key, `${action}.${key}`).not.toMatch(textLike);
      for (const key of ["text", "proposedText", "dismissNote", "note", "comment"]) {
        const spec = PLAYBOOK_FACTS[action as keyof typeof PLAYBOOK_FACTS];
        expect(AuditEventInputSchema.safeParse(event({ action, target: spec.target, facts: { ...spec.sample, [key]: "Use the shared retry helper." } })).success, `${action}.${key}`).toBe(false);
      }
    }
  });

  for (const [action, spec] of Object.entries(PLAYBOOK_FACTS)) {
    it(`${action} has exactly its fixed fact keys, takes them, and refuses an unknown one`, () => {
      expect(AUDIT_FACT_KEYS[action as AuditAction]).toEqual(spec.keys);
      const base = { action, target: spec.target };
      expect(AuditEventInputSchema.safeParse(event({ ...base, facts: spec.sample })).success).toBe(true);
      expect(AuditEventInputSchema.safeParse(event({ ...base, facts: { ...spec.sample, projectName: "web" } })).success).toBe(false);
      expect(AuditEventInputSchema.safeParse(event({ ...base, facts: { kind: "x" } })).success).toBe(false);
    });
  }

  it("takes a process target by id", () => {
    expect(AuditTargetSchema.safeParse({ kind: "process", id: "agt_1" }).success).toBe(true);
  });

  it("gives the facts the plan names", () => {
    expect(AUDIT_FACT_KEYS["approval.decided"]).toEqual(["kind", "decision", "subjectKind", "class"]);
    expect(AUDIT_FACT_KEYS["approval.expired"]).toEqual(["kind", "subjectKind"]);
    expect(AUDIT_FACT_KEYS["approval.requested"]).toEqual(["kind", "subjectKind", "class", "connectorType", "tool", "argumentsHash"]);
    expect(AUDIT_FACT_KEYS["approval.rerouted"]).toEqual(["kind", "mode"]);
    expect(AUDIT_FACT_KEYS["spend_request.rerouted"]).toEqual(["kind", "mode"]);
    expect(AUDIT_FACT_KEYS["spend_request.resume_dropped"]).toEqual(["kind", "cause"]);
    expect(AUDIT_FACT_KEYS["write.executed"]).toEqual(["connectorType", "tool", "status", "argumentsHash"]);
    for (const action of ["spend_request.created", "spend_request.expired", "spend_request.escalated"] as const) {
      expect(AUDIT_FACT_KEYS[action]).toEqual(["kind", "scopeKind", "amountCents", "newLimitCents", "decision"]);
    }
    // A decision also says what it applied, apart from what was asked (final review, money I-2).
    expect(AUDIT_FACT_KEYS["spend_request.decided"]).toEqual(["kind", "scopeKind", "amountCents", "newLimitCents", "decision", "approvedAmountCents", "appliedLimitCents", "topUpMonth"]);
    expect(AUDIT_FACT_KEYS["budget.changed"]).toEqual(["scopeKind", "field", "fromCents", "toCents"]);
    expect(AUDIT_FACT_KEYS["spend_policy.changed"]).toEqual(["field", "from", "to"]);
    expect(AUDIT_FACT_KEYS["trigger.disabled"]).toEqual(["cause", "source", "type", "targetKind"]);
    expect(AUDIT_FACT_KEYS["audit.read"]).toEqual(["fromSeq", "toSeq", "count", "via"]);
  });
});

describe("the event schema", () => {
  it("accepts a valid event and one with no facts, related ids or details", () => {
    expect(AuditEventInputSchema.safeParse(event()).success).toBe(true);
    const bare = event();
    delete bare.facts;
    delete bare.related;
    expect(AuditEventInputSchema.safeParse(bare).success).toBe(true);
  });

  it("refuses a facts key that is not on the action's list", () => {
    expect(AuditEventInputSchema.safeParse(event({ facts: { kind: "write", repository: "web" } })).success).toBe(false);
    // A key that is valid for another action is still refused here.
    expect(AuditEventInputSchema.safeParse(event({ facts: { fromSeq: 1 } })).success).toBe(false);
  });

  it("refuses a 129-character fact and accepts 128", () => {
    expect(AuditEventInputSchema.safeParse(event({ facts: { kind: "x".repeat(128) } })).success).toBe(true);
    expect(AuditEventInputSchema.safeParse(event({ facts: { kind: "x".repeat(129) } })).success).toBe(false);
  });

  it("refuses a non-ASCII or non-printable fact", () => {
    expect(AuditEventInputSchema.safeParse(event({ facts: { kind: "café" } })).success).toBe(false);
    expect(AuditEventInputSchema.safeParse(event({ facts: { kind: "line\nbreak" } })).success).toBe(false);
  });

  it("refuses a float, an unsafe integer and NaN, and accepts integers and booleans", () => {
    const budget = { action: "budget.changed", target: { kind: "budget", id: "bud_1" } };
    expect(AuditEventInputSchema.safeParse(event({ ...budget, facts: { fromCents: 1.5 } })).success).toBe(false);
    expect(AuditEventInputSchema.safeParse(event({ ...budget, facts: { fromCents: 2 ** 53 } })).success).toBe(false);
    expect(AuditEventInputSchema.safeParse(event({ ...budget, facts: { fromCents: Number.NaN } })).success).toBe(false);
    expect(AuditEventInputSchema.safeParse(event({ ...budget, facts: { fromCents: 50000, toCents: 80000, scopeKind: "org" } })).success).toBe(true);
    expect(AuditEventInputSchema.safeParse(event({ action: "audit.exported", target: { kind: "audit", id: "exp_1" }, facts: { withDetails: true, fromSeq: 1 } })).success).toBe(true);
  });

  it("refuses an email-shaped value under any key", () => {
    expect(AuditEventInputSchema.safeParse(event({ facts: { kind: "ann@example.com" } })).success).toBe(false);
    expect(AuditEventInputSchema.safeParse(event({ facts: { decision: "sent to a@b.co today" } })).success).toBe(false);
  });

  it("refuses a ninth related id and accepts eight", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `id_${i}`);
    expect(AuditEventInputSchema.safeParse(event({ related: ids(8) })).success).toBe(true);
    expect(AuditEventInputSchema.safeParse(event({ related: ids(9) })).success).toBe(false);
  });

  it("refuses more facts than the cap", () => {
    const facts = Object.fromEntries(Array.from({ length: AUDIT_MAX_FACTS + 1 }, (_, i) => [`k${i}`, i]));
    expect(AuditEventInputSchema.safeParse(event({ facts })).success).toBe(false);
  });

  it("refuses an unknown action, a bad event id, a bad org id, an unknown field and a non-ISO time", () => {
    expect(AuditEventInputSchema.safeParse(event({ action: "approval.maybe" })).success).toBe(false);
    expect(AuditEventInputSchema.safeParse(event({ eventId: "aev_" + "a".repeat(39) })).success).toBe(false);
    expect(AuditEventInputSchema.safeParse(event({ eventId: "aev_" + "A".repeat(40) })).success).toBe(false);
    expect(AuditEventInputSchema.safeParse(event({ eventId: "aev_" + "a".repeat(40) })).success).toBe(true);
    expect(AuditEventInputSchema.safeParse(event({ orgId: "org_short" })).success).toBe(false);
    expect(AuditEventInputSchema.safeParse(event({ extra: 1 })).success).toBe(false);
    expect(AuditEventInputSchema.safeParse(event({ occurredAt: "yesterday" })).success).toBe(false);
  });

  it("takes a proof and details, within their limits", () => {
    const proof = { kind: "fresh_sign_in", method: "email_code", authTime: NOW, sessionRef: SESSION_REF };
    const part = { subject: "org", fields: { projectName: "web" } };
    expect(AuditEventInputSchema.safeParse(event({ proof, details: [part] })).success).toBe(true);
    expect(AuditEventInputSchema.safeParse(event({ details: Array.from({ length: 5 }, () => part) })).success).toBe(false);
    expect(AuditEventInputSchema.safeParse(event({ details: Array.from({ length: 4 }, () => part) })).success).toBe(true);
  });

  it("keeps personal details out of facts but accepts them in details", () => {
    const withDetails = event({ details: [{ subject: "dev_1", fields: { email: "ann@example.com" } }] });
    expect(AuditEventInputSchema.safeParse(withDetails).success).toBe(true);
  });
});

describe("the event parts", () => {
  it("validates actors by kind", () => {
    expect(AuditActorSchema.safeParse({ kind: "member", id: "dev_1" }).success).toBe(true);
    expect(AuditActorSchema.safeParse({ kind: "system", id: "rovara" }).success).toBe(true);
    expect(AuditActorSchema.safeParse({ kind: "github", id: "583231" }).success).toBe(true);
    expect(AuditActorSchema.safeParse({ kind: "operator", id: `op_${"0123456789abcdef".repeat(2).slice(0, 24)}` }).success).toBe(true);
    expect(AuditActorSchema.safeParse({ kind: "operator", id: "ann@example.com" }).success).toBe(false);
    expect(AuditActorSchema.safeParse({ kind: "operator", id: "op_short" }).success).toBe(false);
    expect(AuditActorSchema.safeParse({ kind: "system", id: "someone" }).success).toBe(false);
    expect(AuditActorSchema.safeParse({ kind: "github", id: "octocat" }).success).toBe(false);
    expect(AuditActorSchema.safeParse({ kind: "robot", id: "x" }).success).toBe(false);
    expect(AuditActorSchema.safeParse({ kind: "member", id: "" }).success).toBe(false);
  });

  it("derives the operator id from the issuer and subject", () => {
    const expected = `op_${createHash("sha256").update("https://issuer.example\nsubject-1").digest("hex").slice(0, 24)}`;
    expect(auditOperatorId("https://issuer.example", "subject-1")).toBe(expected);
    expect(auditOperatorId("https://issuer.example", "subject-2")).not.toBe(expected);
    expect(AuditActorSchema.safeParse({ kind: "operator", id: expected }).success).toBe(true);
  });

  it("takes a target by id or by name, never both, with bounded sizes and a known kind", () => {
    expect(AuditTargetSchema.safeParse({ kind: "approval", id: "apr_1" }).success).toBe(true);
    expect(AuditTargetSchema.safeParse({ kind: "spend_policy", id: "org_1" }).success).toBe(true);
    expect(AuditTargetSchema.safeParse({ kind: "project", name: "web" }).success).toBe(true);
    expect(AuditTargetSchema.safeParse({ kind: "project", name: "n".repeat(200) }).success).toBe(true);
    expect(AuditTargetSchema.safeParse({ kind: "project", name: "n".repeat(201) }).success).toBe(false);
    expect(AuditTargetSchema.safeParse({ kind: "project", id: "i".repeat(101) }).success).toBe(false);
    expect(AuditTargetSchema.safeParse({ kind: "project", id: "p", name: "web" }).success).toBe(false);
    expect(AuditTargetSchema.safeParse({ kind: "project" }).success).toBe(false);
    expect(AuditTargetSchema.safeParse({ kind: "gateway", id: "g" }).success).toBe(false);
  });

  it("takes the three proof shapes", () => {
    expect(AuditProofSchema.safeParse({ kind: "fresh_sign_in", method: "email_code", authTime: NOW, sessionRef: SESSION_REF }).success).toBe(true);
    expect(AuditProofSchema.safeParse({ kind: "fresh_sign_in", method: "email_code", authTime: NOW, sessionRef: "short" }).success).toBe(false);
    expect(AuditProofSchema.safeParse({ kind: "fresh_sign_in", method: "email_code", authTime: NOW }).success).toBe(false);
    expect(AuditProofSchema.safeParse({ kind: "button", via: "slack" }).success).toBe(true);
    expect(AuditProofSchema.safeParse({ kind: "button", via: "email" }).success).toBe(false);
    expect(AuditProofSchema.safeParse({ kind: "none" }).success).toBe(true);
    expect(AuditProofSchema.safeParse({ kind: "none", via: "slack" }).success).toBe(false);
  });

  it("limits detail parts to ten fields of 500 characters", () => {
    const fields = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, "v"]));
    expect(AuditDetailPartSchema.safeParse({ subject: "org", fields: fields(10) }).success).toBe(true);
    expect(AuditDetailPartSchema.safeParse({ subject: "org", fields: fields(11) }).success).toBe(false);
    expect(AuditDetailPartSchema.safeParse({ subject: "dev_1", fields: { reason: "r".repeat(500) } }).success).toBe(true);
    expect(AuditDetailPartSchema.safeParse({ subject: "dev_1", fields: { reason: "r".repeat(501) } }).success).toBe(false);
    expect(AuditDetailPartSchema.safeParse({ subject: "", fields: {} }).success).toBe(false);
    expect(AuditDetailPartSchema.safeParse({ subject: "org", fields: { n: 1 } }).success).toBe(false);
  });
});

describe("auditEventId", () => {
  it("is aev_ plus 40 hex of the sha256 of the newline-joined parts", () => {
    const id = auditEventId("approval.decided", "apr_1", "approved");
    expect(id).toBe(`aev_${sha256Hex("approval.decided\napr_1\napproved").slice(0, 40)}`);
    expect(id).toMatch(/^aev_[0-9a-f]{40}$/);
    expect(auditEventId("approval.decided", "apr_1", "approved")).toBe(id);
  });

  it("throws on an empty occurrence", () => {
    expect(() => auditEventId("approval.decided", "")).toThrow(/occurrence/);
  });

  it("refuses a part with a newline, which could shift the boundary between parts", () => {
    expect(() => auditEventId("approval.decided", "a\nb", "c")).toThrow(/newline/);
    expect(() => auditEventId("approval.decided", "a", "b\nc")).toThrow(/newline/);
  });

  it("gives the same parts with different occurrences different ids", () => {
    expect(auditEventId("budget.changed", "req_1", "org")).not.toBe(auditEventId("budget.changed", "req_2", "org"));
  });

  it("separates the action from the occurrence and the parts from each other", () => {
    expect(auditEventId("approval.decided", "a", "bc")).not.toBe(auditEventId("approval.decided", "ab", "c"));
    expect(auditEventId("approval.decided", "x")).not.toBe(auditEventId("approval.expired", "x"));
  });

  it("accepts every action", () => {
    for (const action of AUDIT_ACTIONS as readonly AuditAction[]) {
      expect(AuditEventIdSchema.safeParse(auditEventId(action, "occurrence-1")).success).toBe(true);
    }
  });
});
