// Decision cards (Decisions D1): the projector. PURE: pending items in, cards out. A card is a projection of an item that exists today (a workflow gate, an approval, a spend request, a
// question, an autofix ask), never a new state machine. It reads no store and no clock, so the same items and locks always give the same cards. The rules it enforces on every card:
//   - the tier comes from `riskTierOf` alone (deterministic, never lowered, never below the kind's floor);
//   - low: Approve is one tap. medium: the card says the evidence must be opened first (the server enforces it, routes.ts). high: NO approve action, only "Open to decide";
//   - an approve is a POST to this server's own card route and every link is a same-origin relative path (an item with an unsafe open path is dropped, never shown);
//   - nothing is bulk: one card has at most one approve, and there is no field or route that approves several;
//   - a standing rule may have answered a card, never a high one (the rule is ignored and the card stays pending);
//   - a Full-path requirements and design pair is ONE card with two tabs that still records two approvals (owner Q1).
// Anything an item says in words (a title, a question, a path) is flattened to plain text and cut; fixed words come from this file.
import {
  DECISION_REJECT_REASONS, DecisionCardIdSchema, DecisionCardSchema, DecisionTabsSchema, decisionFriction,
  type CardAction, type DecisionCard, type DecisionKind, type DecisionRejectReason, type DecisionRisk, type DecisionTab, type DecisionTabId, type EvidenceChip,
} from "@agentx/contracts";
import { DECISION_SPEND_LOW_MAX_USD, riskTierOf, type DecisionLocks, type TierInputs, type TierResult } from "./risk-tier.js";
import { isSafeRelativePath, plainLine } from "./text.js";

const SUBJECT_ID = /^[A-Za-z0-9_-]{1,150}$/u;

/** What every pending item carries. */
export interface ItemBase {
  /** The item's own id (an approval id, a task id and document version, ...), `[A-Za-z0-9_-]{1,150}`. */
  subjectId: string;
  taskId?: string | undefined;
  /** The project's name. */
  project: string;
  /** A person's or a plan's words: shown as plain text, cut. */
  title: string;
  createdAt: string;
  expiresAt?: string | undefined;
  /** Where the full page for this decision is: a same-origin relative path. */
  openPath: string;
  /** Set when a standing rule answered the item (a high card ignores it). */
  answeredByRule?: { ruleId: string; at: string } | undefined;
  /** Set when the item is no longer waiting (history); such a card has no actions. */
  outcome?: "approved" | "rejected" | "expired" | "cancelled" | undefined;
}

export interface Cost { lowUsd?: number | undefined; highUsd: number; minutes?: { low: number; high: number } | undefined }
export interface ProofCounts { proven: number; passed: number; failed: number; notTested: number }

export type DecisionItem =
  | (ItemBase & { kind: "approve_plan"; path: "quick" | "full"; files: readonly string[]; claims: number; untestedClaims: number; cost?: Cost | undefined; tooBig?: boolean | undefined })
  | (ItemBase & { kind: "approve_requirements"; claims: number })
  | (ItemBase & { kind: "approve_design"; files: readonly string[] })
  | (ItemBase & { kind: "merge"; prRisk: DecisionRisk; prReasons: readonly string[]; proof: ProofCounts; reviewVerdict: "approved" | "concerns" | "none"; ci: "passing" | "failing" | "pending"; securityFindingsHigh: number; fullSuitePending: boolean })
  | (ItemBase & { kind: "answer_question"; question: string; index: number; of: number })
  | (ItemBase & { kind: "choose_checks"; defaultLabels: readonly string[] })
  | (ItemBase & { kind: "approve_dependency"; packages: number; newInstallScripts: boolean })
  | (ItemBase & { kind: "approve_e2e_plan"; scenarios: number; usesAiNavigation: boolean })
  | (ItemBase & { kind: "review_feedback"; comments: number; touchesSensitivePaths: boolean })
  | (ItemBase & { kind: "autofix_ask"; reasonWords: string; attempts: number })
  | (ItemBase & { kind: "approve_setting"; settingLabel: string; secondPerson: boolean })
  | (ItemBase & { kind: "approve_spend"; amountUsd: number; scopeLabel: string })
  | (ItemBase & { kind: "approve_test_env"; risk: DecisionRisk; riskReasons: readonly string[]; tier: string })
  | (ItemBase & { kind: "confirm_env_change"; what: "accounts" | "selection" | "environment" });

export interface ProjectOptions {
  /** A company's locks: raise a kind's tier, never lower it. */
  locks?: DecisionLocks | undefined;
  /** Show a Full-path requirements and design pair as one card with two tabs (owner Q1: yes). Default true. */
  pairFullCards?: boolean | undefined;
}

export interface Projection {
  cards: DecisionCard[];
  /** The tabs of the cards that have them, by card id. */
  tabs: Record<string, DecisionTab[]>;
  /** For a card with tabs: the pending item each tab approves (its `subjectId`), so the performer acts on the right document. */
  tabSubjects: Record<string, Record<DecisionTabId, string>>;
  /** Items left out because they could not become a safe card (a bad id or path, a missing input), counted, never described. */
  dropped: number;
}

/** The card routes this server mounts (decisions/routes.ts). The id's colon is encoded, so it is one path segment. */
export const DECISION_ROUTE_BASE = "/v1/app/decisions";
export const decisionCardPath = (cardId: string): string => `${DECISION_ROUTE_BASE}/${encodeURIComponent(cardId)}`;

const APPROVABLE: ReadonlySet<DecisionKind> = new Set<DecisionKind>([
  "approve_plan", "approve_requirements", "approve_design", "merge", "approve_dependency", "approve_e2e_plan", "review_feedback", "autofix_ask",
  "approve_spend", "approve_test_env", "confirm_env_change",
]);

const usd = (value: number): string => `$${value.toFixed(2)}`;
const plural = (count: number, one: string, many: string): string => `${String(count)} ${count === 1 ? one : many}`;
const chip = (kind: EvidenceChip["kind"], label: string, value: string, state: EvidenceChip["state"]): EvidenceChip => ({ kind, label: plainLine(label, 60), value: plainLine(value, 80), state });

function costText(cost: Cost | undefined): string | undefined {
  if (cost === undefined) return undefined;
  const money = cost.lowUsd === undefined || cost.lowUsd === cost.highUsd ? `about ${usd(cost.highUsd)}` : `about ${usd(cost.lowUsd)} to ${usd(cost.highUsd)}`;
  return cost.minutes === undefined ? money : `${money}, ${String(cost.minutes.low)} to ${String(cost.minutes.high)} minutes`;
}

/** What each kind says in the card: the fixed question, what happens next, and the evidence chips. Only counts and fixed words, plus plain text of the item's own title or question. */
function wordsOf(item: DecisionItem): { question: string; next: string; costUsd?: number; minutes?: number; evidence: EvidenceChip[]; why: string } {
  switch (item.kind) {
    case "approve_plan": {
      const money = costText(item.cost);
      return {
        question: item.path === "full" ? "Approve this coding plan?" : "Approve this plan and start the build?",
        next: `${money === undefined ? "Rovara builds the change and opens a pull request" : `Builds in ${item.cost?.minutes === undefined ? "a few minutes" : `${String(item.cost.minutes.low)} to ${String(item.cost.minutes.high)} minutes`}, ${money}, and opens a pull request`}.`,
        ...(item.cost === undefined ? {} : { costUsd: item.cost.highUsd }),
        ...(item.cost?.minutes === undefined ? {} : { minutes: item.cost.minutes.high }),
        evidence: [
          chip("other", "Files", plural(item.files.length, "file", "files"), item.files.length > 25 ? "warning" : "good"),
          chip("test_proof", "Planned proof", item.untestedClaims === 0 ? "every claim has a check" : `${plural(item.untestedClaims, "claim", "claims")} with none`, item.untestedClaims === 0 ? "good" : "warning"),
          ...(item.tooBig === true ? [chip("other", "Size", "too big for one screen", "warning")] : []),
        ],
        why: item.untestedClaims === 0 ? "Every claim in the plan has a planned check." : "Some claims have no planned check; look before you approve.",
      };
    }
    case "approve_requirements":
      return { question: "Approve these requirements?", next: "Rovara moves on to the design.", evidence: [chip("other", "Requirements", plural(item.claims, "claim", "claims"), "unknown")], why: "Requirements are the cheapest place to catch a wrong turn." };
    case "approve_design":
      return { question: "Approve this design?", next: "Rovara writes the coding plan from it.", evidence: [chip("other", "Files named", plural(item.files.length, "file", "files"), "unknown")], why: "The design fixes the approach before any code is written." };
    case "merge": {
      const proof = item.proof;
      const failing = proof.failed > 0 || item.ci === "failing";
      return {
        question: "Merge this pull request?",
        next: "The pull request is merged into the base branch.",
        evidence: [
          chip("test_proof", "Proof", `${String(proof.proven + proof.passed)} proven or passed, ${String(proof.failed)} failed, ${String(proof.notTested)} not tested`, proof.failed > 0 ? "bad" : proof.notTested > 0 ? "warning" : "good"),
          chip("review", "Review", item.reviewVerdict === "approved" ? "no concerns" : item.reviewVerdict === "concerns" ? "concerns raised" : "not reviewed", item.reviewVerdict === "approved" ? "good" : item.reviewVerdict === "concerns" ? "warning" : "unknown"),
          chip("checks", "CI", item.ci, item.ci === "passing" ? "good" : item.ci === "failing" ? "bad" : "unknown"),
          chip("risk", "Risk", item.prRisk, item.prRisk === "low" ? "good" : item.prRisk === "medium" ? "warning" : "bad"),
          ...(item.fullSuitePending ? [chip("checks", "Full suite", "still running", "warning")] : []),
        ],
        why: failing ? "Something failed: open it and look first." : "The checks passed and the review has no open concerns.",
      };
    }
    case "answer_question":
      return { question: plainLine(item.question, 160), next: "Rovara goes on with your answer.", evidence: [chip("other", "Question", `${String(item.index)} of ${String(item.of)}`, "unknown")], why: "Rovara asks instead of guessing." };
    case "choose_checks":
      return { question: "Which optional checks should run?", next: "The chosen checks run with the build.", evidence: [chip("checks", "Default", plural(item.defaultLabels.length, "check", "checks"), "unknown")], why: "The project's default choice is pre-selected." };
    case "approve_dependency":
      return {
        question: "Allow these new packages?", next: "The packages are added to the change.",
        evidence: [chip("other", "Packages", plural(item.packages, "package", "packages"), "warning"), chip("risk", "Install scripts", item.newInstallScripts ? "a new package runs one" : "none new", item.newInstallScripts ? "bad" : "good")],
        why: item.newInstallScripts ? "A new package runs code when it installs." : "No new package runs an install script.",
      };
    case "approve_e2e_plan":
      return { question: "Approve this browser and API test plan?", next: "The scenarios run against the changed app.", evidence: [chip("test_proof", "Scenarios", plural(item.scenarios, "scenario", "scenarios"), "unknown"), chip("other", "AI navigation", item.usesAiNavigation ? "used" : "not used", item.usesAiNavigation ? "warning" : "good")], why: "These scenarios decide what the app is tested for." };
    case "review_feedback":
      return { question: "Act on this review feedback?", next: "Rovara makes the fix on the same pull request.", evidence: [chip("review", "Comments", plural(item.comments, "comment", "comments"), "unknown")], why: "The fix stays on the same pull request." };
    case "autofix_ask":
      return { question: "Let Rovara try to fix this?", next: "Rovara tries one more fix and re-runs the checks.", evidence: [chip("checks", "Attempts so far", String(item.attempts), item.attempts > 0 ? "warning" : "unknown"), chip("other", "Why asking", plainLine(item.reasonWords, 80), "warning")], why: "Rovara already tried and wants your go-ahead." };
    case "approve_setting":
      return { question: plainLine(`Change this setting: ${item.settingLabel}?`, 160), next: "Rovara works less safely until the setting is changed back.", evidence: [chip("risk", "Effect", "less safe", "bad")], why: "A less-safe setting needs a full look." };
    case "approve_spend":
      return { question: plainLine(`Raise the limit for ${item.scopeLabel}?`, 160), next: `The limit goes up by ${usd(item.amountUsd)}.`, costUsd: item.amountUsd, evidence: [chip("cost", "Amount", usd(item.amountUsd), item.amountUsd > DECISION_SPEND_LOW_MAX_USD ? "warning" : "good")], why: "The task is paused until the limit is raised." };
    case "approve_test_env":
      return { question: "Approve this test setup?", next: "Tasks in this project use it from now on.", evidence: [chip("environment", "Tier", item.tier, item.risk === "high" ? "warning" : "unknown"), chip("risk", "Risk", item.risk, item.risk === "high" ? "bad" : "warning")], why: "Rovara booted the app and proved the setup." };
    case "confirm_env_change":
      return { question: "Accept this change to the test setup?", next: "The running task continues on the new setup.", evidence: [chip("environment", "Changed", item.what, "warning")], why: "The setup changed while the task was running." };
  }
}

function tierInputsOf(item: DecisionItem): TierInputs {
  switch (item.kind) {
    case "approve_plan": return { plan: { files: item.files, untestedClaims: item.untestedClaims, costHighUsd: item.cost?.highUsd } };
    case "approve_design": return { design: { files: item.files } };
    case "merge": return { merge: { prRisk: item.prRisk, prReasons: item.prReasons, failedChecks: item.proof.failed, untestedClaims: item.proof.notTested, securityFindingsHigh: item.securityFindingsHigh, fullSuitePending: item.fullSuitePending, ciFailing: item.ci === "failing" } };
    case "approve_dependency": return { dependency: { newInstallScripts: item.newInstallScripts } };
    case "review_feedback": return { feedback: { touchesSensitivePaths: item.touchesSensitivePaths } };
    case "approve_setting": return { setting: { secondPerson: item.secondPerson } };
    case "approve_spend": return { spend: { amountUsd: item.amountUsd } };
    case "approve_test_env": return { testEnv: { risk: item.risk, reasons: item.riskReasons } };
    default: return {};
  }
}

function actionsOf(item: DecisionItem, cardId: string, risk: DecisionRisk): { actions: CardAction[]; recommended: CardAction["kind"] } {
  const base = decisionCardPath(cardId);
  const open: CardAction = { kind: "open", label: risk === "high" ? "Open to decide" : "Open the details", href: item.openPath, method: "GET" };
  if (risk === "high") return { actions: [open], recommended: "open" };
  if (item.kind === "answer_question") return { actions: [{ kind: "answer", label: "Answer", href: item.openPath, method: "GET" }], recommended: "answer" };
  if (item.kind === "choose_checks") return { actions: [{ kind: "choose", label: "Choose checks", href: item.openPath, method: "GET" }], recommended: "choose" };
  if (!APPROVABLE.has(item.kind)) return { actions: [open], recommended: "open" };
  const approve: CardAction = { kind: "approve", label: "Approve", href: `${base}/approve`, method: "POST" };
  const reject: CardAction = { kind: "reject", label: "Not now", href: `${base}/reject`, method: "POST" };
  // The recommendation follows the evidence: something failed, so look first.
  const look = item.kind === "merge" && (item.proof.failed > 0 || item.ci === "failing");
  return look ? { actions: [open, reject, approve], recommended: "open" } : { actions: [approve, reject, open], recommended: "approve" };
}

const REJECTABLE_REASONS: readonly DecisionRejectReason[] = DECISION_REJECT_REASONS;

/** The card for one item, or undefined when the item cannot become a safe one. */
export function cardOfItem(item: DecisionItem, locks: DecisionLocks = {}): { card: DecisionCard; tier: TierResult } | undefined {
  if (!SUBJECT_ID.test(item.subjectId) || !isSafeRelativePath(item.openPath)) return undefined;
  const id = `${item.kind}:${item.subjectId}`;
  if (!DecisionCardIdSchema.safeParse(id).success) return undefined;
  let tier: TierResult;
  try { tier = riskTierOf(item.kind, tierInputsOf(item), locks); } catch { return undefined; }
  const words = wordsOf(item);
  const { risk } = tier;
  const answered = item.answeredByRule !== undefined && risk !== "high" ? item.answeredByRule : undefined;
  const closed = item.outcome !== undefined || answered !== undefined;
  const { actions, recommended } = actionsOf(item, id, risk);
  const status = answered !== undefined ? "answered_by_rule" : item.outcome ?? "pending";
  const candidate = {
    id, kind: item.kind, ...(item.taskId === undefined ? {} : { taskId: item.taskId }),
    project: plainLine(item.project, 100), title: plainLine(item.title, 80),
    question: plainLine(words.question, 160),
    recommended: { action: closed ? "open" : recommended, why: plainLine(words.why, 120) },
    next: { text: plainLine(words.next, 160), ...(words.costUsd === undefined ? {} : { costUsd: words.costUsd }), ...(words.minutes === undefined ? {} : { minutes: words.minutes }) },
    evidence: words.evidence.slice(0, 6),
    risk, riskReasons: tier.reasons,
    friction: decisionFriction(risk, tier.secondPerson),
    actions: closed ? [] : actions,
    rejectReasons: closed || !actions.some((action) => action.kind === "reject") ? [] : [...REJECTABLE_REASONS],
    ...(answered === undefined ? {} : { answeredByRule: { ruleId: plainLine(answered.ruleId, 64), at: answered.at } }),
    status, createdAt: item.createdAt, ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt }),
  };
  const parsed = DecisionCardSchema.safeParse(candidate);
  return parsed.success ? { card: parsed.data, tier } : undefined;
}

const TAB_TITLES = { requirements: "Requirements", design: "Design" } as const;

/** One card for a task's requirements and design: the requirements card, at the higher of the two tiers, with a tab for each document. Each tab is still its own approval. */
function pairCards(requirements: { card: DecisionCard; item: DecisionItem }, design: { card: DecisionCard; item: DecisionItem }): { card: DecisionCard; tabs: DecisionTab[] } | undefined {
  const risk = requirements.card.risk === "high" || design.card.risk === "high" ? "high" : requirements.card.risk === "medium" || design.card.risk === "medium" ? "medium" : "low";
  const base = requirements.card;
  const high = risk === "high";
  const approve = (action: CardAction) => action.kind === "approve" && !high;
  const actions = base.actions.filter((action) => action.kind === "open" || approve(action) || (action.kind === "reject" && !high)).slice(0, 4);
  const shown: CardAction[] = high ? [{ kind: "open", label: "Open to decide", href: requirements.item.openPath, method: "GET" }] : actions;
  const merged = DecisionCardSchema.safeParse({
    ...base,
    title: plainLine(requirements.item.title, 80),
    question: "Approve the requirements and the design?",
    next: { text: "Each document is approved on its own; when both are, Rovara writes the coding plan." },
    evidence: [...requirements.card.evidence.slice(0, 3), ...design.card.evidence.slice(0, 3)],
    risk,
    riskReasons: [...new Set([...requirements.card.riskReasons, ...design.card.riskReasons])].slice(0, 5),
    friction: decisionFriction(risk, false),
    recommended: { action: high ? "open" : "approve", why: "Two approvals, one for each document." },
    actions: shown,
    rejectReasons: high ? [] : base.rejectReasons,
  });
  if (!merged.success) return undefined;
  const tabs = DecisionTabsSchema.safeParse([
    { id: "requirements", title: TAB_TITLES.requirements, summary: plainLine(requirements.card.question, 300), evidence: requirements.card.evidence, approved: false },
    { id: "design", title: TAB_TITLES.design, summary: plainLine(design.card.question, 300), evidence: design.card.evidence, approved: false },
  ]);
  return tabs.success ? { card: merged.data, tabs: tabs.data } : undefined;
}

const RISK_RANK: Record<DecisionRisk, number> = { high: 0, medium: 1, low: 2 };

/**
 * Items in, cards out. Newest-first within a tier, high first. A Full-path requirements and design pair for one task is merged into one card when `pairFullCards` (the default). The same items
 * and locks always give the same cards, in the same order.
 */
export function projectDecisionCards(items: readonly DecisionItem[], options: ProjectOptions = {}): Projection {
  const locks = options.locks ?? {};
  let dropped = 0;
  const built: Array<{ item: DecisionItem; card: DecisionCard }> = [];
  const seen = new Set<string>();
  for (const item of items) {
    const result = cardOfItem(item, locks);
    if (result === undefined || seen.has(result.card.id)) { dropped += 1; continue; }
    seen.add(result.card.id);
    built.push({ item, card: result.card });
  }
  const cards: DecisionCard[] = [];
  const tabs: Record<string, DecisionTab[]> = {};
  const tabSubjects: Record<string, Record<DecisionTabId, string>> = {};
  const merged = new Set<string>();
  if (options.pairFullCards !== false) {
    for (const first of built) {
      if (first.item.kind !== "approve_requirements" || first.card.status !== "pending" || first.item.taskId === undefined) continue;
      const second = built.find((other) => other.item.kind === "approve_design" && other.card.status === "pending" && other.item.taskId === first.item.taskId);
      if (second === undefined) continue;
      const pair = pairCards(first, second);
      if (pair === undefined) continue;
      merged.add(first.card.id);
      merged.add(second.card.id);
      cards.push(pair.card);
      tabs[pair.card.id] = pair.tabs;
      tabSubjects[pair.card.id] = { requirements: first.item.subjectId, design: second.item.subjectId };
    }
  }
  for (const entry of built) if (!merged.has(entry.card.id)) cards.push(entry.card);
  cards.sort((a, b) => RISK_RANK[a.risk] - RISK_RANK[b.risk] || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  return { cards, tabs, tabSubjects, dropped };
}
