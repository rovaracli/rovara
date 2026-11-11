import { ApiError } from "../../api/errors.js";
import { useBilling, useTrial } from "../../api/trial-billing.js";
import { Button } from "../../design/Button.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { SettingsNote } from "../admin/SettingsNote.js";
import { dayText, MinorMoney } from "./format.js";
import { InvoicesSection } from "./InvoicesSection.js";
import { AutoBillSection, ContactSection, LimitSection, PaymentMethodSection } from "./PaymentSection.js";
import { TrialCard } from "./TrialCard.js";
import { TrialChoices } from "./TrialChoices.js";
import { phaseWords, planWords } from "./trial-logic.js";
import "./trial-billing.css";

export const BILLING_WORDS = {
 TITLE: "Billing", INTRO: "Your plan, the trial allowance, auto-billing, the payment method and invoices.",
 SWITCHED_OFF: "Billing isn't turned on for this install.", FORBIDDEN: "Only company owners and admins can see billing.", LOAD_FAILED: "Couldn't load billing. Try again.", RETRY: "Try again",
 NOT_AVAILABLE: "Payment methods and invoices aren't available on this install yet. The trial allowance and your monthly limit still apply.",
} as const;

/**
 * Settings > Billing (switch `rovara.billing` = "v2"; owners and admins): plan, trial allowance and choices, auto-billing, the masked payment method, the monthly limit, the billing contact and invoices. Everything the
 * server decides comes from it. With the server's `BillingEnabled` off it answers 404 and the page says so.
 */
export function BillingScreen() {
 const read = useBilling(), trial = useTrial();
 if (read.isPending) return <section aria-label={BILLING_WORDS.TITLE} aria-busy="true"><Skeleton label="Loading billing" /></section>;
 if (read.error instanceof ApiError && read.error.status === 404) return <section><PageHeader focusOnMount title={BILLING_WORDS.TITLE} description={BILLING_WORDS.INTRO} /><SettingsNote area="billing" /><p role="status">{BILLING_WORDS.SWITCHED_OFF}</p></section>;
 if (read.error instanceof ApiError && read.error.status === 403) return <section><PageHeader focusOnMount title={BILLING_WORDS.TITLE} /><p role="alert">{BILLING_WORDS.FORBIDDEN}</p></section>;
 if (read.data === undefined) return <section><PageHeader focusOnMount title={BILLING_WORDS.TITLE} /><p role="alert"><VisibleText text={read.error instanceof ApiError ? read.error.message : BILLING_WORDS.LOAD_FAILED} /></p><div><Button onClick={() => { void read.refetch(); }}>{BILLING_WORDS.RETRY}</Button></div></section>;
 const state = read.data, words = phaseWords(state.phase, state.plan);
 return <section aria-label={BILLING_WORDS.TITLE} className="rv-tb"><PageHeader focusOnMount title={BILLING_WORDS.TITLE} description={BILLING_WORDS.INTRO} />
  <SettingsNote area="billing" />
  <section className="rv-tb-card" aria-labelledby="tb-plan"><h2 id="tb-plan">Plan</h2>
   <dl className="rv-tb-facts"><div><dt>Plan</dt><dd>{planWords(state.plan)}</dd></div><div><dt>Status</dt><dd>{words.heading}</dd></div></dl>
   <p>{words.text}</p>
   {state.pastDue !== null && <div role="alert" className="rv-tb-alert"><p><strong>A payment of <MinorMoney minor={state.pastDue.amountMinor} currency={state.pastDue.currency} /> failed on {dayText(state.pastDue.since)}.</strong></p>
    {state.pastDue.retryAt !== null && <p>Rovara will try again on {dayText(state.pastDue.retryAt)}.</p>}{state.pastDue.workPausesAt !== null && <p>Work pauses on {dayText(state.pastDue.workPausesAt)} unless the payment goes through.</p>}</div>}
  </section>
  {trial.data !== undefined && <><TrialCard trial={trial.data} /><TrialChoices trial={trial.data} admins={[]} /></>}
  {!state.available && <p role="note" className="rv-tb-note">{BILLING_WORDS.NOT_AVAILABLE}</p>}
  {state.available && <><AutoBillSection state={state} /><PaymentMethodSection state={state} /></>}
  <LimitSection state={state} />
  {state.available && <ContactSection state={state} />}
  {(state.available || state.invoices.count > 0) && <InvoicesSection enabled />}
 </section>;
}
