// Lessons (area 14): the cases both copies answer. Inputs follow Cloud's own lesson suites (tests/unit/lessons/*, builders from lesson-helpers.ts): the tier a
// lesson gets (what needs a person), whether an approved lesson may load, when a trial is stable, the value that ranks lessons, the correction and polarity
// words that make a capture, the repository lessons file both ways, and the trust and audience folds. The approval policy is each engine's own
// `DEFAULT_APPROVAL_POLICY` (helper `policy`).
import { draft, lessonRecord } from "../../../unit/lessons/lesson-helpers.js";
import type { DecisionCase } from "./decision.js";

const DAY = 86_400_000;
const valid = [{ index: 0, result: "valid", at: 1 }];
const tier = (label: string, over: Record<string, unknown>, context: Record<string, unknown> = {}): DecisionCase => ({ fn: "classifyTier", label, args: [{ ...draft(), citationChecks: valid, ...over }, context] });
const approved = (label: string, over: Record<string, unknown>): DecisionCase => ({ fn: "approvedForUse", label, args: (kit) => [lessonRecord(over), kit.helpers.policy] });
const FILE = [
  "# Lessons",
  "",
  "<!-- rovara:lessons v1 -->",
  "## Retries use withRetry",
  "<!-- rovara:lesson les_aaaa1111 -->",
  "HTTP retries in the api service use withRetry from src/retry/index.ts.",
  "",
  "## A person's own note",
  "Keep this one.",
].join("\n");

export const LESSONS_CASES: readonly DecisionCase[] = [
  tier("cited-fact", {}),
  tier("convention", { type: "convention" }),
  tier("never-verified", { citationChecks: undefined }),
  tier("stale-citation", { citationChecks: [{ index: 0, result: "stale", at: 1 }] }),
  tier("no-repo", { scope: {} }),
  tier("two-repos", { scope: { repos: ["api", "web"] } }),
  tier("system-trust", { provenance: { ...draft().provenance, minTrust: "system" } }),
  tier("contradiction", {}, { contradiction: true }),
  tier("escalation-words", { body: "Always run the deploy with sudo and disable the security checks." }),
  approved("tier0-auto", {}),
  approved("tier1-unapproved", { tier: 1, approvals: [] }),
  approved("tier1-one-approval", { tier: 1, approvals: [{ approvalId: "a1", by: "ann", at: 1, mode: "person" }] }),
  approved("retired", { status: "retired" }),
  { fn: "trialIsStable", label: "young", args: [lessonRecord({ trial: { state: "trial", startedAt: 1_800_000_000_000 }, counters: { loaded: 5, helpful: 1, harmful: 0, citationStale: 0 } } as never), 1_800_000_000_000 + 3 * DAY] },
  { fn: "trialIsStable", label: "old-and-loaded", args: [lessonRecord({ trial: { state: "trial", startedAt: 1_800_000_000_000 }, counters: { loaded: 5, helpful: 1, harmful: 0, citationStale: 0 } } as never), 1_800_000_000_000 + 20 * DAY] },
  { fn: "trialIsStable", label: "old-but-harmful", args: [lessonRecord({ trial: { state: "trial", startedAt: 1_800_000_000_000 }, counters: { loaded: 5, helpful: 0, harmful: 1, citationStale: 0 } } as never), 1_800_000_000_000 + 20 * DAY] },
  { fn: "trialIsStable", label: "no-trial", args: [lessonRecord(), 1_800_000_000_000 + 20 * DAY] },
  { fn: "lessonValue", label: "fresh", args: [lessonRecord()] },
  { fn: "lessonValue", label: "harmful", args: [lessonRecord({ counters: { loaded: 5, helpful: 0, harmful: 3, citationStale: 0 } })] },
  { fn: "lessonValue", label: "preference", args: [lessonRecord({ type: "preference" })] },
  { fn: "wilsonLower", label: "0-of-0", args: [0, 0] },
  { fn: "wilsonLower", label: "3-of-10", args: [3, 10] },
  { fn: "wilsonLower", label: "40-of-50", args: [40, 50] },
  ...["Please use withRetry instead of raw fetch.", "No, that's wrong: the config lives in config/app.ts.", "Thanks, looks good!", "Don't add a new dependency for this."].map((text, index): DecisionCase => ({ fn: "looksLikeCorrection", label: `text-${String(index)}`, args: [text] })),
  ...["Always validate input.", "Never log tokens.", "The cache is in Redis."].map((text, index): DecisionCase => ({ fn: "polarity", label: `text-${String(index)}`, args: [text] })),
  { fn: "oppositePolarity", label: "always-never", args: ["Always log the request id.", "Never log the request id."] },
  { fn: "oppositePolarity", label: "same", args: ["Always log the request id.", "Always log the trace id."] },
  { fn: "hasEscalationWords", label: "skip-tests", args: ["You can skip the tests here.", "then push"] },
  { fn: "hasEscalationWords", label: "tokens", args: ["Store the api key in the config."] },
  { fn: "hasEscalationWords", label: "plain", args: ["Use withRetry for HTTP calls."] },
  { fn: "namesAPerson", label: "names-ann", args: ["Ask Ann Smith before changing billing.", ["Ann Smith", "Bob"]] },
  { fn: "namesAPerson", label: "no-name", args: ["Ask the billing owner first.", ["Ann Smith", "Bob"]] },
  { fn: "cleanLessonLine", label: "markup", args: ["  <script>x</script> **Use** `withRetry` <!-- hidden -->  "] },
  { fn: "parseLessonsFile", label: "rovara-and-person", args: [FILE] },
  { fn: "parseLessonsFile", label: "empty", args: [""] },
  { fn: "renderLesson", label: "plain", args: [lessonRecord(), "api"] },
  { fn: "renderLesson", label: "other-repo", args: [lessonRecord(), "web"] },
  { fn: "minTrust", label: "mixed", args: [["member", "rovara", "system"]] },
  { fn: "narrowestAudience", label: "project-and-restricted", args: [[{ kind: "project" }, { kind: "restricted", acl: { source: "slack", scope: "slack:T/C", principals: ["U1"], capturedAt: "x", liveCheck: "none" } }]] },
];
