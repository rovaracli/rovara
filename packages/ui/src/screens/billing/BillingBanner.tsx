// The trial banner in the shell (switch `rovara.billing` = "v2"): near the end for owners and admins, and used up, ended or stopped for everyone the server tells. It is loaded only when the switch is on.
import { Link, useLocation } from "react-router";
import { useTrial } from "../../api/trial-billing.js";
import { Usd } from "./format.js";
import { allowanceName, BILLING_PAGE_PATH, bannerFor, hoursText, TRIAL_PATH, usedUpWords, type BannerPlan } from "./trial-logic.js";
import "./trial-billing.css";

export const BANNER_WORDS = {
 NEAR_TITLE: "Your trial allowance is running low", NEAR_ACTION: "Choose what happens next",
 USED_TITLE: "Your trial allowance is used up", USED_BODY: "New work on Rovara-provided models can't start until an owner or admin chooses what happens next.", USED_OTHER: "Ask an admin to choose what happens next.",
 STOPPED_TITLE: "Work on Rovara-provided models is stopped", STOPPED_BODY: "Your company chose to stop after the trial. Nothing is deleted.", STOPPED_ACTION: "Review the choices",
 PAST_TITLE: "A payment failed", PAST_BODY: "Update the payment method to keep work going.", PAST_OTHER: "Ask an admin to update the payment method.", PAST_ACTION: "Open Billing",
 SUSPENDED_TITLE: "This company's account is suspended", SUSPENDED_BODY: "Contact Rovara to find out why.",
 DETAILS: "See details",
} as const;

function leftWords(plan: BannerPlan) {
 return plan.lowAllowances.map((allowance, index) => <span key={`${allowance.kind}-${String(index)}`}>{index > 0 && "; "}{allowanceName(allowance.kind)}: {allowance.unit === "usd" ? <Usd usd={allowance.left} /> : hoursText(allowance.left)} left</span>);
}
function content(plan: BannerPlan): { tone: "warning" | "danger" | "info"; title: string; body: React.ReactNode; to: string; action: string } {
 switch (plan.kind) {
  case "near_end": return { tone: "warning", title: BANNER_WORDS.NEAR_TITLE, body: leftWords(plan), to: TRIAL_PATH, action: BANNER_WORDS.NEAR_ACTION };
  case "used_up": { const words = usedUpWords(plan.plan, plan.usedUp); return { tone: "danger", title: words.title, body: words.body, to: TRIAL_PATH, action: BANNER_WORDS.DETAILS }; }
  case "ended": return { tone: "danger", title: BANNER_WORDS.USED_TITLE, body: plan.chooser ? BANNER_WORDS.USED_BODY : <>{BANNER_WORDS.USED_BODY} {BANNER_WORDS.USED_OTHER}</>, to: TRIAL_PATH, action: plan.chooser ? BANNER_WORDS.NEAR_ACTION : BANNER_WORDS.DETAILS };
  case "stopped": return { tone: "info", title: BANNER_WORDS.STOPPED_TITLE, body: BANNER_WORDS.STOPPED_BODY, to: TRIAL_PATH, action: plan.chooser ? BANNER_WORDS.STOPPED_ACTION : BANNER_WORDS.DETAILS };
  case "past_due": return { tone: "danger", title: BANNER_WORDS.PAST_TITLE, body: plan.chooser ? BANNER_WORDS.PAST_BODY : BANNER_WORDS.PAST_OTHER, to: plan.chooser ? BILLING_PAGE_PATH : TRIAL_PATH, action: plan.chooser ? BANNER_WORDS.PAST_ACTION : BANNER_WORDS.DETAILS };
  default: return { tone: "danger", title: BANNER_WORDS.SUSPENDED_TITLE, body: BANNER_WORDS.SUSPENDED_BODY, to: TRIAL_PATH, action: BANNER_WORDS.DETAILS };
 }
}

export default function BillingBanner() {
 const trial = useTrial(), location = useLocation();
 // The trial page and the Billing page say all of this themselves.
 if (trial.data === undefined || location.pathname === TRIAL_PATH || location.pathname.startsWith(BILLING_PAGE_PATH)) return null;
 const plan = bannerFor(trial.data);
 if (plan === undefined) return null;
 const shown = content(plan);
 return <section className={`rv-banner rv-banner-${shown.tone} rv-tb-banner`} aria-label="Trial allowance" data-kind={plan.kind}><div><strong>{shown.title}</strong><p>{shown.body}</p></div><Link to={shown.to} className="rv-button rv-button-secondary">{shown.action}</Link></section>;
}
