// Live interaction part 2, task T0: the contracts (redirect, ask, ErrorRef, diagnosis proposals, switches), the edition rows and the audit builders.
import { describe, expect, it } from "vitest";
import {
  ASK_LIMITS, ASK_RATE, AUDIT_FACT_KEYS, AskBodySchema, AskRecordSchema, AuditEventInputSchema, BROKER_SETTINGS, DIAGNOSIS_PROPOSALS_MAX, DIAGNOSIS_RATE, ERROR_REF_KINDS, ErrorRefSchema,
  LIVE_INTERACTION_FLAGS, OWNER_REDIRECT_FEATURE, OwnerRedirectInvocationSchema, REDIRECT_RATE, RedirectBodySchema, RedirectRecordSchema, askAuditMode, askStoresText, diagnosisPathDenied, diagnosisPrefillAllowed, DIAGNOSIS_PREFILL_ALLOW,
  editionPolicy, errorRefKey, errorRefOf, liveInteractionFlagOn, parseDiagnosisProposals, requireFeature,
} from "../../packages/contracts/src/index.js";
import {
  auditDiagnosisBundlePrepared, auditDiagnosisProposalRaised, auditDiagnosisProposed, auditDiagnosisStarted, auditDiagnosisSupportEscalated, auditSessionRedirected, auditTaskAsked, auditOccurrence,
} from "../../packages/broker/src/audit/events.js";

const REQUEST = "6f1c2a52-7d8e-4f55-9a1b-0c3d4e5f6a7b";
const TASK = "0b1f6c1e-3c7d-4a3e-8c55-1a2b3c4d5e6f";
const SESSION = "ses_abcdefghij0123456789";
const MESSAGE = "msg_abcdefghij0123456789";
const AT = "2026-10-31T10:00:00.000Z";
const ORG = "org_abcdefghij0123456789";
const base = { orgId: ORG, actor: { kind: "member" as const, id: "dev_1" }, occurredAt: AT, occurrence: "occ-1" };

describe("switches", () => {
  it("has three distinct two-letter codes that do not collide with an existing broker setting (fx is the autofix switch); `ak` is the one registered, and `rd` and `fd` are not yet", () => {
    const codes = Object.values(LIVE_INTERACTION_FLAGS).map((spec) => spec.code);
    expect(new Set(codes).size).toBe(3);
    // Live interaction A3 registered the Ask switch as `liveAsk` (stack parameter LiveAskEnabled), the same code and variable; the other two are not registered yet.
    expect(BROKER_SETTINGS.liveAsk).toEqual(LIVE_INTERACTION_FLAGS.ask);
    const others = Object.entries(BROKER_SETTINGS).filter(([name]) => name !== "liveAsk").map(([, spec]) => spec);
    const taken = new Set<string>(others.map((spec) => spec.code));
    for (const code of codes) expect(taken.has(code), code).toBe(false);
    const variables = new Set<string>(others.map((spec) => spec.variable));
    for (const spec of Object.values(LIVE_INTERACTION_FLAGS)) expect(variables.has(spec.variable), spec.variable).toBe(false);
    const registered = Object.values(BROKER_SETTINGS).map((spec) => spec.code);
    for (const key of ["redirect", "fix"] as const) expect(registered.includes(LIVE_INTERACTION_FLAGS[key].code), key).toBe(false);
  });

  it("the Ask switch is off unless set (the stack parameter default "0" is pinned in live-ask-switch.test.ts): only exactly 1 turns it on", () => {
    expect(LIVE_INTERACTION_FLAGS.ask).toEqual({ code: "ak", variable: "LIVE_ASK_ENABLED" });
    expect(liveInteractionFlagOn(undefined)).toBe(false);
    expect(liveInteractionFlagOn("0")).toBe(false);
    expect(liveInteractionFlagOn("1")).toBe(true);
  });

  it("is on only for exactly 1", () => {
    expect(liveInteractionFlagOn("1")).toBe(true);
    for (const value of [undefined, "", "0", "true", " 1", "1 ", "01", "yes"]) expect(liveInteractionFlagOn(value), String(value)).toBe(false);
  });
});

describe("redirect payloads", () => {
  const good = { requestId: REQUEST, text: "Use the retry helper instead.", mode: "keep_plan" };

  it("accepts both modes and nothing else", () => {
    expect(RedirectBodySchema.safeParse(good).success).toBe(true);
    expect(RedirectBodySchema.safeParse({ ...good, mode: "change_plan" }).success).toBe(true);
    expect(RedirectBodySchema.safeParse({ ...good, mode: "discard_work" }).success).toBe(false);
  });

  it("refuses fields that would widen the agent: budget, tools, permissions, approvals, authority", () => {
    for (const extra of [{ budget: 100 }, { tools: ["bash"] }, { permissions: ["write"] }, { approve: true }, { authority: "owner_instruction" }, { maxRuns: 9 }]) {
      expect(RedirectBodySchema.safeParse({ ...good, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it("bounds the text and needs a uuid request id", () => {
    expect(RedirectBodySchema.safeParse({ ...good, text: "" }).success).toBe(false);
    expect(RedirectBodySchema.safeParse({ ...good, text: "x".repeat(2_000) }).success).toBe(true);
    expect(RedirectBodySchema.safeParse({ ...good, text: "x".repeat(2_001) }).success).toBe(false);
    expect(RedirectBodySchema.safeParse({ ...good, requestId: "not-a-uuid" }).success).toBe(false);
    expect(RedirectBodySchema.safeParse({ text: good.text, mode: good.mode }).success).toBe(false);
  });

  it("pins the rates the owner accepted: 5 per task per hour, 3 per step attempt", () => {
    expect(REDIRECT_RATE).toEqual({ perTaskPerHour: 5, perStepAttempt: 3, windowSeconds: 3_600 });
  });

  it("gives the worker a strict owner-redirect invocation with a server-made message id", () => {
    expect(OWNER_REDIRECT_FEATURE).toBe("task.ownerRedirect.v1");
    const sender = "person p_a1b2c3";
    expect(OwnerRedirectInvocationSchema.safeParse({ messageId: MESSAGE, sender, text: "go" }).success).toBe(true);
    expect(OwnerRedirectInvocationSchema.safeParse({ messageId: "msg_short", sender, text: "go" }).success).toBe(false);
    expect(OwnerRedirectInvocationSchema.safeParse({ messageId: MESSAGE, text: "go" }).success).toBe(false);
    expect(OwnerRedirectInvocationSchema.safeParse({ messageId: MESSAGE, sender: "Alice", text: "go" }).success).toBe(false);
    expect(OwnerRedirectInvocationSchema.safeParse({ messageId: MESSAGE, sender, text: "go", authority: "owner_instruction" }).success).toBe(false);
  });

  it("stores no instruction text on the REDIRECT# record", () => {
    const record = { requestId: REQUEST, messageId: MESSAGE, mode: "keep_plan", blockedRevision: 4, step: "IMPLEMENT", state: "stopping", createdAt: AT, ttl: 1_800_000_000 };
    expect(RedirectRecordSchema.safeParse(record).success).toBe(true);
    expect(RedirectRecordSchema.safeParse({ ...record, text: "do this" }).success).toBe(false);
    expect(RedirectRecordSchema.safeParse({ ...record, state: "done" }).success).toBe(false);
  });
});

describe("ask payloads and storage rules", () => {
  it("is strict and bounded", () => {
    expect(AskBodySchema.safeParse({ requestId: REQUEST, question: "why?" }).success).toBe(true);
    expect(AskBodySchema.safeParse({ requestId: REQUEST, question: "" }).success).toBe(false);
    expect(AskBodySchema.safeParse({ requestId: REQUEST, question: "x".repeat(1_001) }).success).toBe(false);
    expect(AskBodySchema.safeParse({ requestId: REQUEST, question: "why?", audience: "slack" }).success).toBe(false);
    expect(ASK_RATE).toEqual({ perPersonPerHour: 20, perTaskPerDay: 100 });
    expect(ASK_LIMITS).toEqual({ contextMaxBytes: 61_440, answerMaxOutputTokens: 1_200 });
  });

  it("stores question text on every Enterprise surface but only on the web in Public (Slack's terms)", () => {
    for (const audience of ["web", "slack", "linear"] as const) expect(askStoresText("enterprise", audience), `enterprise ${audience}`).toBe(true);
    expect(askStoresText("public", "web")).toBe(true);
    expect(askStoresText("public", "slack")).toBe(false);
    expect(askStoresText("public", "linear")).toBe(false);
    expect(askStoresText("other" as never, "web")).toBe(false);
  });

  it("audits every Ask in Enterprise and a daily count in Public", () => {
    expect(askAuditMode("enterprise")).toBe("each");
    expect(askAuditMode("public")).toBe("daily_count");
  });

  it("lets an ASK# record hold a hash with no text", () => {
    const record = { askId: "ask_abcdefghij0123456789", audience: "slack", questionSha256: "a".repeat(64), contextBytes: 10, answerBytes: 20, model: "m", createdAt: AT, ttl: 1_800_000_000 };
    expect(AskRecordSchema.safeParse(record).success).toBe(true);
    expect(AskRecordSchema.safeParse({ ...record, contextBytes: ASK_LIMITS.contextMaxBytes + 1 }).success).toBe(false);
    expect(AskRecordSchema.safeParse({ ...record, extra: 1 }).success).toBe(false);
  });
});

describe("ErrorRef", () => {
  const ok = { kind: "workflow_block" as const, code: "WORKFLOW_BLOCKED", subject: { taskId: TASK }, at: AT };

  it("builds a reference from fixed codes and ids", () => {
    const ref = errorRefOf(ok);
    expect(ref).toEqual({ kind: "workflow_block", code: "WORKFLOW_BLOCKED", subject: { taskId: TASK }, at: AT });
    expect(ErrorRefSchema.safeParse(ref).success).toBe(true);
    expect(errorRefOf({ ...ok, operationId: REQUEST })?.operationId).toBe(REQUEST);
  });

  it("builds one for every kind with a subject that kind may have", () => {
    const subjects: Record<(typeof ERROR_REF_KINDS)[number], Record<string, string>> = {
      workflow_block: { sessionId: SESSION }, operation_failed: { taskId: TASK }, setup_check: { project: "web" },
      connector_health: { connectorId: "github-main" }, model_access: { project: "web" }, intake_failure: { project: "web" },
    };
    for (const kind of ERROR_REF_KINDS) expect(errorRefOf({ kind, code: "SOME_CODE", subject: subjects[kind], at: AT }), kind).toBeDefined();
  });

  it("refuses free text as a code: lower case, spaces, punctuation, or too long", () => {
    for (const code of ["blocked", "The build failed: ENOENT /tmp/x", "Has Space", "A", "X".repeat(65), "CODE-WITH-DASH", "ERR\nOR"]) {
      expect(errorRefOf({ ...ok, code }), code).toBeUndefined();
    }
  });

  it("refuses a subject the kind cannot have, or more or fewer than one subject", () => {
    expect(errorRefOf({ ...ok, kind: "setup_check", subject: { taskId: TASK } })).toBeUndefined();
    expect(errorRefOf({ ...ok, kind: "connector_health", subject: { taskId: TASK } })).toBeUndefined();
    expect(errorRefOf({ ...ok, subject: { taskId: TASK, sessionId: SESSION } })).toBeUndefined();
    expect(errorRefOf({ ...ok, subject: {} })).toBeUndefined();
    expect(errorRefOf({ ...ok, subject: { taskId: undefined } })).toBeUndefined();
    expect(errorRefOf({ ...ok, subject: { somethingElse: "x" } })).toBeUndefined();
  });

  it("refuses ids and times of the wrong shape, and never throws", () => {
    expect(errorRefOf({ ...ok, subject: { taskId: "not-a-uuid" } })).toBeUndefined();
    expect(errorRefOf({ ...ok, at: "yesterday" })).toBeUndefined();
    expect(errorRefOf({ ...ok, operationId: "x" })).toBeUndefined();
    expect(errorRefOf({ ...ok, kind: "hacked" as never })).toBeUndefined();
    expect(errorRefOf({ ...ok, kind: "__proto__" as never })).toBeUndefined();
    expect(errorRefOf({ ...ok, kind: "constructor" as never })).toBeUndefined();
  });

  it("holds no field other than the five and rejects a stored ref with extras", () => {
    expect(ErrorRefSchema.safeParse({ ...ok, message: "build failed" }).success).toBe(false);
    expect(ErrorRefSchema.safeParse({ ...ok, subject: { taskId: TASK, extra: "x" } }).success).toBe(false);
  });

  it("keys the same error the same way whatever the time, and different errors differently", () => {
    const a = errorRefOf(ok)!;
    expect(errorRefKey(errorRefOf({ ...ok, at: "2026-10-31T11:00:00.000Z" })!)).toBe(errorRefKey(a));
    expect(errorRefKey(errorRefOf({ ...ok, code: "OTHER_CODE" })!)).not.toBe(errorRefKey(a));
    expect(errorRefKey(errorRefOf({ ...ok, subject: { taskId: "1b1f6c1e-3c7d-4a3e-8c55-1a2b3c4d5e6f" } })!)).not.toBe(errorRefKey(a));
    expect(errorRefKey(errorRefOf({ ...ok, operationId: REQUEST })!)).not.toBe(errorRefKey(a));
    expect(errorRefKey(errorRefOf({ ...ok, kind: "operation_failed" })!)).not.toBe(errorRefKey(a));
  });
});

describe("diagnosis proposals", () => {
  const settings = { kind: "settings_change", target: "code_settings", path: "mergeMethod", from: "squash", to: "merge", citations: ["docs/runbook.md#merge"] };

  it("keeps every kind of the closed set", () => {
    const { proposals, dropped } = parseDiagnosisProposals([
      { kind: "explain", text: "The model is not enabled." }, { kind: "retry_with_note", note: "Retry once the model is on." }, { kind: "redirect", text: "Use the helper.", mode: "keep_plan" },
      settings, { kind: "new_task", request: "Enable the model." }, { kind: "admin_steps", steps: ["Open the Bedrock console."] }, { kind: "contact_support" },
    ]);
    expect(dropped).toBe(0);
    expect(proposals.map((proposal) => proposal.kind)).toEqual(["explain", "retry_with_note", "redirect", "settings_change", "new_task", "admin_steps", "contact_support"]);
  });

  it("drops an unknown kind, an unknown field and a bad shape, and counts them", () => {
    const { proposals, dropped } = parseDiagnosisProposals([
      { kind: "run_command", command: "rm -rf /" }, { kind: "explain", text: "ok", apply: true }, { kind: "explain", text: "" }, "explain", null, { kind: "explain", text: "kept" },
      { ...settings, citations: [] }, { ...settings, from: { nested: true } },
    ]);
    expect(proposals).toEqual([{ kind: "explain", text: "kept" }]);
    expect(dropped).toBe(7);
  });

  // Every spelling the Opus review (I1) found to pass the old deny-list, plus the obvious ones: none may be prefilled, whatever the target or the value.
  const BYPASSES = [
    "tierZero", "tier_zero", "t0.auto", "approvals.tier0", "tier-0_approval", "Tier0Approval", "tier0ApprovalDefault", "autoApply",
    "signoffs", "quorum", "gates.merge.required", "howWeWork.planCheck.required", "requireTwoPeople", "approvalRules.minApprovals", "reviewers",
    "maintainers", "seats", "members[0].role", "roles.admin",
    "model.url", "model.host", "modelId", "bedrockRegion", "inference.profileArn", "modelEndpoint.baseUrl",
    "toolServers", "servers.x.command", "tools.allowed", "plugins", "mcpServers[0]", "mcp.servers", "stdioServers",
    "network.hosts", "outbound.domains", "proxy.url", "websites", "allowedWebsites", "egress.allowedDomains",
    "github.pat", "env.GITHUB_PAT", "env.SLACK_WEBHOOK", "auth.header", "keys.signing", "vault.ref", "secrets.GITHUB_TOKEN", "apiKey",
    "quota", "budget.monthlyUsd", "spendLimit", "maxPerRun",
  ];

  it("drops a settings change on any path that is not on its target's allow-list: every bypass spelling, on every target, with an allowed-looking value", () => {
    for (const target of ["code_settings", "setup_item", "playbook", "connector", "model_access"] as const) {
      for (const path of BYPASSES) {
        for (const to of ["merge", true, "https://evil.example.com", "ghp_notarealtoken"]) {
          expect(parseDiagnosisProposals([{ ...settings, target, path, to }]), `${target} ${path}`).toEqual({ proposals: [], dropped: 1 });
        }
      }
    }
    // Paths that are not on the list at all drop too, deny-listed or not.
    for (const path of ["workingBranch", "checks.lint.command", "env.X", "setupCommands", "a"]) expect(parseDiagnosisProposals([{ ...settings, path }]).proposals, path).toEqual([]);
    expect(diagnosisPathDenied("")).toBe(true);
  });

  it("refuses the connector and model_access targets outright, even for a path another target allows", () => {
    for (const target of ["connector", "model_access"] as const) {
      expect(parseDiagnosisProposals([{ ...settings, target, path: "mergeMethod" }]).proposals, target).toEqual([]);
      expect(parseDiagnosisProposals([{ ...settings, target, path: "url", to: "https://evil" }]).proposals, target).toEqual([]);
    }
    expect(Object.values(DIAGNOSIS_PREFILL_ALLOW.connector)).toEqual([]);
    expect(Object.values(DIAGNOSIS_PREFILL_ALLOW.model_access)).toEqual([]);
  });

  it("checks the value of an allowed path: an enum word, a boolean or a plain relative file path, never a secret or a URL", () => {
    const ok = (target: string, path: string, from: unknown, to: unknown) => parseDiagnosisProposals([{ ...settings, target, path, from, to }]).proposals.length === 1;
    expect(ok("code_settings", "mergeMethod", "squash", "merge")).toBe(true);
    expect(ok("code_settings", "mergeMethod", null, "squash")).toBe(true);
    expect(ok("code_settings", "mergeMethod", "squash", "rebase")).toBe(false);
    expect(ok("code_settings", "mergeMethod", "ghp_notarealtoken", "merge")).toBe(false);
    expect(ok("code_settings", "mergeMethod", "squash", true)).toBe(false);
    expect(ok("playbook", "e2e.traces", false, true)).toBe(true);
    expect(ok("playbook", "e2e.traces", false, "true")).toBe(false);
    expect(ok("setup_item", "devcontainer.configPath", ".devcontainer/devcontainer.json", ".devcontainer/other.json")).toBe(true);
    for (const bad of ["https://evil.example.com/x.json", "/etc/passwd", "../../x", ".devcontainer/../../x", "a b", `ghp_${"a".repeat(36)}?x=1`]) expect(ok("setup_item", "devcontainer.configPath", null, bad), bad).toBe(false);
    // Prototype names are not paths or targets.
    for (const path of ["__proto__", "constructor", "toString", "hasOwnProperty"]) expect(diagnosisPrefillAllowed("code_settings", path, null, "merge"), path).toBe(false);
    expect(diagnosisPrefillAllowed("__proto__", "mergeMethod", null, "merge")).toBe(false);
  });

  it("keeps the deny-list as a second check: it names the forbidden categories and passes the allow-listed paths", () => {
    for (const path of BYPASSES) expect(diagnosisPathDenied(path), path).toBe(true);
    for (const [target, paths] of Object.entries(DIAGNOSIS_PREFILL_ALLOW)) for (const path of Object.keys(paths)) expect(diagnosisPathDenied(path), `${target} ${path}`).toBe(false);
  });

  it("refuses a path that smuggles characters", () => {
    expect(parseDiagnosisProposals([{ ...settings, path: "merge method; drop" }]).proposals).toEqual([]);
    expect(parseDiagnosisProposals([{ ...settings, path: "a".repeat(201) }]).proposals).toEqual([]);
  });

  it("keeps at most the bound and drops the rest, counted", () => {
    const many = Array.from({ length: DIAGNOSIS_PROPOSALS_MAX + 3 }, (_, index) => ({ kind: "explain", text: `n${String(index)}` }));
    const { proposals, dropped } = parseDiagnosisProposals(many);
    expect(proposals).toHaveLength(DIAGNOSIS_PROPOSALS_MAX);
    expect(dropped).toBe(3);
  });

  it("answers nothing for input that is not a list", () => {
    expect(parseDiagnosisProposals({ kind: "explain", text: "x" })).toEqual({ proposals: [], dropped: 0 });
    expect(parseDiagnosisProposals(undefined)).toEqual({ proposals: [], dropped: 0 });
  });

  it("pins the diagnosis rates", () => {
    expect(DIAGNOSIS_RATE).toEqual({ lightPerPersonPerHour: 10, lightPerProjectPerDay: 50, deepPerPersonPerDay: 3 });
  });
});

describe("edition rows", () => {
  it("Public can escalate to staff and Enterprise prepares a bundle, never the other way", () => {
    expect(() => requireFeature(editionPolicy("public"), "diagnosisSupportEscalation")).not.toThrow();
    expect(() => requireFeature(editionPolicy("enterprise"), "diagnosisSupportEscalation")).toThrow();
    expect(() => requireFeature(editionPolicy("enterprise"), "diagnosisSupportBundle")).not.toThrow();
    expect(() => requireFeature(editionPolicy("public"), "diagnosisSupportBundle")).toThrow();
  });
});

describe("audit builders", () => {
  const events = () => [
    auditSessionRedirected({ ...base, sessionId: SESSION, taskId: TASK, messageId: MESSAGE, mode: "keep_plan", step: "IMPLEMENT", outcome: "restarted" }),
    auditTaskAsked({ ...base, scope: "each", sessionId: SESSION, askId: "ask_abcdefghij0123456789", audience: "web", contextBytes: 1234, model: "m-1" }),
    auditTaskAsked({ ...base, scope: "daily", projectName: "web", count: 7 }),
    auditDiagnosisStarted({ ...base, diagnosisId: "dgn_abcdefghij0123456789", errorKind: "workflow_block", errorCode: "WORKFLOW_BLOCKED", tier: "light" }),
    auditDiagnosisProposed({ ...base, diagnosisId: "dgn_abcdefghij0123456789", counts: { explain: 1, retryWithNote: 1, redirect: 0, settingsChange: 2, newTask: 0, adminSteps: 1, contactSupport: 0 }, dropped: 2 }),
    auditDiagnosisProposalRaised({ ...base, diagnosisId: "dgn_abcdefghij0123456789", proposalKind: "settings_change", approvalId: "apr_1" }),
    auditDiagnosisSupportEscalated({ ...base, diagnosisId: "dgn_abcdefghij0123456789", errorKind: "model_access" }),
    auditDiagnosisBundlePrepared({ ...base, diagnosisId: "dgn_abcdefghij0123456789", errorKind: "model_access" }),
  ];

  it("passes the event schema, and each fact key is one the action allows", () => {
    for (const event of events()) {
      expect(AuditEventInputSchema.safeParse(event).success, event.action).toBe(true);
      for (const key of Object.keys(event.facts ?? {})) expect(AUDIT_FACT_KEYS[event.action], `${event.action}.${key}`).toContain(key);
    }
  });

  it("carries no free text: the instruction, a question or an answer cannot be passed to a builder", () => {
    const text = JSON.stringify(events());
    expect(text).not.toMatch(/instruction|question|answer/i);
    const redirect = events()[0]!;
    expect(redirect.facts).toEqual({ mode: "keep_plan", step: "IMPLEMENT", outcome: "restarted" });
    expect(redirect.related).toEqual([TASK, MESSAGE]);
    expect(redirect.target).toEqual({ kind: "session", id: SESSION });
  });

  it("keeps the redirect event to ids and fixed words; the Ask event to an audience, sizes and the model; the daily count to a project and a number", () => {
    const [, each, daily] = events();
    expect(each!.facts).toEqual({ audience: "web", scope: "each", count: 1, contextBytes: 1234, model: "m-1" });
    expect(each!.related).toEqual(["ask_abcdefghij0123456789"]);
    expect(daily!.facts).toEqual({ audience: "all", scope: "daily", count: 7 });
    expect(daily!.target).toEqual({ kind: "project", name: "web" });
  });

  it("totals the proposals by kind and links a raised proposal to its ordinary approval", () => {
    const [, , , , proposed, raised] = events();
    expect(proposed!.facts).toMatchObject({ total: 5, dropped: 2, explain: 1, retryWithNote: 1, settingsChange: 2, adminSteps: 1 });
    expect(raised!.related).toEqual(["apr_1"]);
  });

  it("gives a retry of one occurrence the same id and another occurrence a different one", () => {
    const make = (occurrence: string, outcome: "restarted" | "left_blocked") => auditSessionRedirected({ ...base, occurrence, sessionId: SESSION, taskId: TASK, messageId: MESSAGE, mode: "keep_plan", step: "IMPLEMENT", outcome });
    expect(make("req-1", "restarted").eventId).toBe(make("req-1", "restarted").eventId);
    expect(make("req-1", "restarted").eventId).not.toBe(make("req-2", "restarted").eventId);
    expect(make("req-1", "restarted").eventId).not.toBe(make("req-1", "left_blocked").eventId);
    expect(auditOccurrence("web", "2026-10-31")).toBe(JSON.stringify(["web", "2026-10-31"]));
  });
});

describe("a prefill value that looks like a secret is refused on every target (fix round 2)", () => {
  // Built at run time, so no secret-shaped literal is in the source.
  const SECRETS = [
    `ghp_${"A1b2C3d4E5".repeat(4)}`, `AKIA${"ABCDEFGHIJKLMNOP"}`, `sk-ant-${"api03-A1b2C3d4E5f6G7h8".repeat(2)}`, `xoxb-${"1234567890"}-${"abcdefghijkl"}`, `github_pat_${"A1b2C3d4E5".repeat(6)}`,
    `-----BEGIN ${"PRIVATE"} KEY-----`, `https://user:${"hunter2hunter2"}@example.com/x`, `password=${"hunter2hunter2"}`, `Bearer ${"abcdefghijklmnopqrstuvwxyz012345"}`, `.env/${"AKIA"}${"ABCDEFGHIJKLMNOP"}`,
  ];
  const settings = { kind: "settings_change", target: "setup_item", path: "devcontainer.configPath", from: null, to: "x/y.json", citations: ["docs/x.md"] };

  it("drops a settings change whose `to` or `from` is a secret-shaped string, even on an allowed path that takes a file path", () => {
    expect(parseDiagnosisProposals([settings]).proposals).toHaveLength(1);
    for (const secret of SECRETS) {
      expect(parseDiagnosisProposals([{ ...settings, to: secret }]), `to ${secret.slice(0, 12)}`).toEqual({ proposals: [], dropped: 1 });
      expect(parseDiagnosisProposals([{ ...settings, from: secret }]), `from ${secret.slice(0, 12)}`).toEqual({ proposals: [], dropped: 1 });
      expect(diagnosisPrefillAllowed("setup_item", "devcontainer.configPath", null, secret), secret.slice(0, 12)).toBe(false);
    }
  });

  it("applies to every target and path, including the enum and boolean ones", () => {
    for (const secret of SECRETS) {
      for (const [target, path] of [["code_settings", "mergeMethod"], ["playbook", "e2e.traces"], ["setup_item", "devcontainer.configPath"], ["connector", "url"], ["model_access", "modelId"]] as const) {
        expect(diagnosisPrefillAllowed(target, path, secret, secret), `${target} ${secret.slice(0, 8)}`).toBe(false);
      }
    }
  });
});
