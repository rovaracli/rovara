// The trial view and the billing state, built from figures that already exist (lane srv/trial-reads; design doc briefs/trial-billing-api.md). Pure: no store, no clock, no request. The routes
// (`aws/developer-routes/trial-billing.ts`) read the figures and call these. Everything built here is parsed by the strict contract schemas (`@agentx/contracts` app-billing.ts) before it leaves,
// so a field that is not in the contract cannot reach the browser, and a card number, a provider id or a token has no field to sit in: this lane has no provider, and returns none of them.
//
// Today's allowance REFRESHES MONTHLY (decision 34 plans a one-time allowance for later), so every allowance says `refresh: "monthly"` with its month, and the `ends` sentence says the allowance renews.
// `ended`, `stopped`, `own_key`, `billed`, `past_due` and `suspended` are not reachable yet: nothing records a choice, a payment or a suspension.
import {
  BUDGET_WARNING_RATIO, BillingStateSchema, TrialViewSchema, type Allowance, type BillingState, type OrgRole, type TrialPhase, type TrialView,
} from "@agentx/contracts";

const SECONDS_PER_HOUR = 3600;
/** Dollars and hours are shown to the cent, so a figure like 0.1 + 0.2 never reaches the page as 0.30000000000000004. */
const round = (value: number, places = 2): number => Number(value.toFixed(places));

export interface OrgTrialFacts {
  plan: "trial" | "team";
  /** The org's trial state as `orgTrial` reads it; undefined for a team plan or a system company. */
  trialState: "locked" | "unlocked" | "github_used" | undefined;
}

/** The phase a company is in today: `locked`, `github_used` or `active`. */
export function phaseOf(org: OrgTrialFacts): TrialPhase {
  if (org.trialState === "locked") return "locked";
  if (org.trialState === "github_used") return "github_used";
  return "active";
}

const stateOf = (usedShare: number, left: number): Allowance["state"] => (left <= 0 ? "used_up" : usedShare >= BUDGET_WARNING_RATIO ? "low" : "ok");

/** The models meter: US dollars, the month's counters and limit. Undefined for a company with no limit. `low` and `used_up` follow what admission refuses on: committed (spent plus held) against the limit. */
export function modelsAllowance(figures: { spentUsd: number; committedUsd: number; limitUsd?: number }, month: string): Allowance | undefined {
  if (figures.limitUsd === undefined) return undefined;
  const left = Math.max(0, figures.limitUsd - figures.committedUsd);
  return {
    kind: "models", unit: "usd", refresh: "monthly", period: { month },
    granted: round(figures.limitUsd), used: round(figures.spentUsd), held: round(Math.max(0, figures.committedUsd - figures.spentUsd)), left: round(left),
    state: stateOf(figures.limitUsd > 0 ? figures.committedUsd / figures.limitUsd : 1, left), source: "rovara",
  };
}

/** The machine meter: hours, the plan's allowance for the month and what is used (recorded plus running now). Undefined where the company has no machine allowance. */
export function machineAllowance(figures: { month: string; grantedHours: number; usedSeconds: number } | undefined): Allowance | undefined {
  if (figures === undefined) return undefined;
  const used = figures.usedSeconds / SECONDS_PER_HOUR;
  // Admission refuses at used >= granted, so the meter is used up at exactly that point (not after rounding).
  const left = Math.max(0, figures.grantedHours - used);
  return {
    kind: "machine", unit: "hours", refresh: "monthly", period: { month: figures.month },
    granted: figures.grantedHours, used: round(used), left: round(left), state: stateOf(figures.grantedHours > 0 ? used / figures.grantedHours : 1, left),
  };
}

/** The fixed sentences of `ends`. Never text from a provider, a person or an error. */
const ENDS_TEXT = {
  locked: "Connect GitHub to start your free trial.",
  github_used: "That GitHub account has already started a free trial for another company.",
  monthly: "Rovara pays for models until this month's allowance is used up. The allowance renews at the start of each UTC month.",
} as const;

const OPTION_SUMMARIES = {
  stop: "Running tasks pause after their current step. Nothing is deleted.",
  autoBill: "Keep working and be billed for usage, up to your monthly limit.",
  ownKey: "Connect your company's own AI provider key.",
} as const;

/** The people who may choose at the end of a trial (decision 91): an owner or an admin. */
export const canChooseAtTrialEnd = (role: OrgRole): boolean => role === "owner" || role === "admin";

function choiceSet(audience: "you" | "admins"): NonNullable<TrialView["choices"]> {
  return {
    audience, decided: null,
    options: [
      { id: "stop", available: false, unavailableReason: "not_built_yet", summary: OPTION_SUMMARIES.stop },
      { id: "auto_bill", available: false, unavailableReason: "billing_not_available", summary: OPTION_SUMMARIES.autoBill },
      { id: "own_key", available: true, unavailableReason: null, summary: OPTION_SUMMARIES.ownKey, next: { href: "/app/admin/models" } },
    ],
  };
}

export interface TrialViewInput {
  org: OrgTrialFacts;
  role: OrgRole;
  month: string;
  models: Allowance | undefined;
  machine: Allowance | undefined;
  member: { limitUsd?: number; spentUsd: number; committedUsd: number };
}

/**
 * GET /v1/app/trial. A locked trial, or one whose GitHub account another company used, has no allowance to show (no work can start), so `allowances` is empty and `choices` null.
 * `hitLimit` is read from the figures (an allowance is used up, so the next start would be refused): no refusal is recorded anywhere to read it from. The choices are told to owners and
 * admins (`admins`) and to anyone else whose allowance is used up (`you`), whenever an allowance is low or used up; the maintainer of a project is an org member here and is told only if they hit the limit.
 */
export function buildTrialView(input: TrialViewInput): TrialView {
  const phase = phaseOf(input.org);
  const open = phase === "active";
  const allowances = open ? [input.models, input.machine].filter((meter): meter is Allowance => meter !== undefined) : [];
  const hitLimit = allowances.some((meter) => meter.state === "used_up");
  const short = allowances.some((meter) => meter.state !== "ok");
  const canChoose = canChooseAtTrialEnd(input.role);
  const choices = short && (canChoose || hitLimit) ? choiceSet(canChoose ? "admins" : "you") : null;
  return TrialViewSchema.parse({
    phase, plan: input.org.plan, allowances,
    you: {
      member: input.member.limitUsd === undefined ? null : { limitUsd: round(input.member.limitUsd), spentUsd: round(input.member.spentUsd), committedUsd: round(input.member.committedUsd) },
      hitLimit, canChoose,
    },
    ends: { when: "monthly_refresh", text: ENDS_TEXT[phase === "locked" ? "locked" : phase === "github_used" ? "github_used" : "monthly"] },
    choices,
  });
}

/**
 * GET /v1/app/org/billing while no provider exists: `available: false`, nothing about a payment method, an invoice, a contact or a provider. The company's monthly limit is the only figure (the
 * ceiling auto-billing would be held to), null when none is set.
 */
export function buildBillingState(input: { org: OrgTrialFacts; monthlyLimitUsd: number | undefined }): BillingState {
  return BillingStateSchema.parse({
    available: false, provider: { configured: false }, plan: input.org.plan, phase: phaseOf(input.org),
    autoBill: { enabled: false, available: false, unavailableReason: "billing_not_available", monthlyCeilingUsd: input.monthlyLimitUsd === undefined ? null : round(input.monthlyLimitUsd) },
    paymentMethod: null, billingContact: null, pastDue: null,
    invoices: { count: 0, latest: null }, portal: { available: false }, lastEventAt: null,
  });
}
