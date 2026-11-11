// Plain words and arithmetic for the trial and billing screens. No money rule lives here: this turns what the API returned into numbers and sentences. The server decides the phase, the allowance state
// ("low" at 80%, "used_up") and who may choose; this file never recomputes those, it only reads them.
import type { Allowance, BillingState, TrialView } from "../../api/trial-billing.js";
import { monthLabel } from "../admin/spending-format.js";

type Phase = TrialView["phase"];
export const TRIAL_PATH = "/app/trial", BILLING_PAGE_PATH = "/app/admin/billing", MODELS_PATH = "/app/admin/models/sources", SPENDING_PATH = "/app/admin/money/budgets";

const NAMES: Record<string, string> = { models: "AI models", machine: "Machine time" };
export const allowanceName = (kind: string): string => Object.hasOwn(NAMES, kind) ? NAMES[kind]! : "Allowance";
/** "12.5 hours", "1 hour". Hours are shown to one decimal. */
export function hoursText(hours: number): string {
 const rounded = Math.round(hours * 10) / 10;
 return `${rounded.toLocaleString("en-US", { maximumFractionDigits: 1 })} ${rounded === 1 ? "hour" : "hours"}`;
}
const micro = (value: number): number => Math.round(value * 1_000_000);
/** How much of the allowance is used, 0 to 100, to one decimal. A zero allowance with something used reads as fully used. */
export function usedPercent(allowance: Pick<Allowance, "granted" | "used">): number {
 if (allowance.granted <= 0) return allowance.used > 0 ? 100 : 0;
 return Math.round(Math.min(100, (micro(allowance.used) / micro(allowance.granted)) * 100) * 10) / 10;
}
/** Money set aside for work in progress, as a share of the allowance, never past the end of the bar. Models only (the doc gives `held` for models). */
export function heldPercent(allowance: Pick<Allowance, "granted" | "used" | "held">): number {
 if (allowance.held === undefined || allowance.held <= 0 || allowance.granted <= 0) return 0;
 return Math.round(Math.min(100 - usedPercent(allowance), (micro(allowance.held) / micro(allowance.granted)) * 100) * 10) / 10;
}
const STATE_WORDS: Record<string, string> = { ok: "Fine so far", low: "Running low", used_up: "Used up" };
export const stateWords = (state: string): string => Object.hasOwn(STATE_WORDS, state) ? STATE_WORDS[state]! : "Unknown";
/** Whether this allowance renews. The page reads `refresh`; it never writes "this month" on its own. */
export function refreshWords(allowance: Pick<Allowance, "refresh" | "period">): string {
 if (allowance.refresh === "never") return "One-time allowance. It does not renew.";
 if (allowance.refresh === "monthly") return allowance.period?.month === undefined || allowance.period === null ? "Renews every month." : `Renews every month. This period: ${monthLabel(allowance.period.month)}.`;
 return "";
}

const UNAVAILABLE: Record<string, string> = { not_built_yet: "Not available yet.", billing_not_available: "Billing isn't available yet.", no_payment_method: "Add a payment method first." };
export const unavailableWords = (reason: string | null): string => reason === null ? "" : Object.hasOwn(UNAVAILABLE, reason) ? UNAVAILABLE[reason]! : "Not available right now.";
const CHOICE_WORDS: Record<string, string> = { stop: "Stop", auto_bill: "Turn on auto-billing", own_key: "Connect your own AI key" };
export const choiceWords = (id: string): string => Object.hasOwn(CHOICE_WORDS, id) ? CHOICE_WORDS[id]! : "Another option";
const DECIDED_WORDS: Record<string, string> = { stop: "Stop", auto_bill: "Auto-billing", own_key: "Connect your own AI key" };
export const decidedWords = (id: string): string => Object.hasOwn(DECIDED_WORDS, id) ? DECIDED_WORDS[id]! : "A choice";

/** The headline and a plain sentence for each phase. Nothing here promises what the server may not do yet: it states the phase and what the API says about new work. */
export function phaseWords(phase: Phase, plan: string): { heading: string; text: string } {
 switch (phase) {
  case "locked": return { heading: "Waiting for GitHub", text: "Connect GitHub to start your trial. No work starts until then." };
  case "github_used": return { heading: "Trial already used", text: "This GitHub account already started a trial for another company." };
  case "active": return { heading: plan === "team" ? "Your plan is active" : "Your trial is running", text: "Rovara pays for work on Rovara-provided models while an allowance lasts." };
  case "ended": return { heading: "Your trial allowance is used up", text: "New work on Rovara-provided models can't start until an owner or admin chooses what happens next." };
  case "stopped": return { heading: "Work on Rovara-provided models is stopped", text: "Your company chose to stop after the trial. Nothing is deleted." };
  case "own_key": return { heading: "Using your company's own AI key", text: "Rovara-provided models are off. Work runs on your company's own key." };
  case "billed": return { heading: "Auto-billing is on", text: "Usage is billed to your payment method, up to your monthly limit." };
  case "past_due": return { heading: "A payment failed", text: "Update the payment method to keep work going." };
  case "suspended": return { heading: "This company's account is suspended", text: "Contact Rovara to find out why." };
  default: return { heading: "Trial status unavailable", text: "This version of the app doesn't know this state of your trial. Reload the page, or update the app." };
 }
}

export type BannerKind = "near_end" | "used_up" | "ended" | "stopped" | "past_due" | "suspended";
export interface BannerPlan { kind: BannerKind; chooser: boolean; lowAllowances: Allowance[] }
/** The worst state of any allowance. */
export function worstState(allowances: readonly Allowance[]): "ok" | "low" | "used_up" {
 return allowances.some(item => item.state === "used_up") ? "used_up" : allowances.some(item => item.state === "low") ? "low" : "ok";
}
/**
 * Whether the shell shows a banner, and which. Near the end (the server's `low`, 80%): only to people who can choose. Used up or ended: to everyone the server tells (they see the choices; only owners and admins choose).
 * `locked` and `github_used` keep today's banner (from the navigation answer). A phase this app doesn't know shows nothing.
 */
export function bannerFor(trial: TrialView): BannerPlan | undefined {
 const chooser = trial.you.canChoose, worst = worstState(trial.allowances), low = trial.allowances.filter(item => item.state === "low" || item.state === "used_up");
 switch (trial.phase) {
  case "ended": return { kind: "ended", chooser, lowAllowances: low };
  case "stopped": return { kind: "stopped", chooser, lowAllowances: low };
  case "past_due": return { kind: "past_due", chooser, lowAllowances: [] };
  case "suspended": return { kind: "suspended", chooser, lowAllowances: [] };
  case "active":
   if (worst === "used_up" && (chooser || trial.you.hitLimit || trial.choices !== null)) return { kind: "used_up", chooser, lowAllowances: low };
   if (worst === "low" && chooser) return { kind: "near_end", chooser, lowAllowances: low };
   return undefined;
  default: return undefined;
 }
}

const BRANDS: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express" };
const KINDS: Record<string, string> = { card: "Card", bank_account: "Bank account", other: "Payment method" };
/** "Visa ending 4242". The only digits ever shown are the last four the server gives. */
export function paymentMethodWords(method: NonNullable<BillingState["paymentMethod"]>): string {
 const brand = method.brand !== null && method.brand !== undefined && Object.hasOwn(BRANDS, method.brand) ? BRANDS[method.brand]! : undefined;
 return `${brand ?? (Object.hasOwn(KINDS, method.kind) ? KINDS[method.kind]! : "Payment method")} ending ${method.last4}`;
}
const METHOD_STATUS: Record<string, string> = { valid: "Valid", expiring: "Expiring soon", expired: "Expired", failed: "The last payment failed" };
export const methodStatusWords = (status: string): string => Object.hasOwn(METHOD_STATUS, status) ? METHOD_STATUS[status]! : "Status unknown";
export const expiryWords = (month: number | undefined, year: number | undefined): string | undefined => month === undefined || year === undefined ? undefined : `${String(month).padStart(2, "0")}/${String(year)}`;
const INVOICE_STATUS: Record<string, string> = { draft: "Draft", open: "Open", paid: "Paid", void: "Void", uncollectible: "Not collected" };
export const invoiceStatusWords = (status: string): string => Object.hasOwn(INVOICE_STATUS, status) ? INVOICE_STATUS[status]! : "Unknown";
const PLAN_WORDS: Record<string, string> = { trial: "Trial", team: "Team" };
export const planWords = (plan: string): string => Object.hasOwn(PLAN_WORDS, plan) ? PLAN_WORDS[plan]! : "Unknown";
