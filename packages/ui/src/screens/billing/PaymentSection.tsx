// Auto-billing, the payment method (masked only) and the billing contact. A card is never entered here: "Add" and "Change" ask the server for the provider-hosted page and open it. Every refusal is shown as the server wrote it.
import { useState } from "react";
import { Link } from "react-router";
import type { BillingState } from "../../api/trial-billing.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { TextField } from "../../design/TextField.js";
import { VisibleText } from "../../design/VisibleText.js";
import { Usd, dayText } from "./format.js";
import { expiryWords, methodStatusWords, paymentMethodWords, SPENDING_PATH, unavailableWords } from "./trial-logic.js";
import { useBillingWrite } from "./use-billing-write.js";

export const PAYMENT_WORDS = {
 AUTO_HEADING: "Auto-billing", AUTO_ON: "Auto-billing is on. Rovara-provided usage is billed to your payment method.", AUTO_OFF: "Auto-billing is off.",
 TURN_ON: "Turn on auto-billing", TURN_OFF: "Turn off auto-billing", OFF_SURE: "Turn off auto-billing? Rovara-paid use ends and the company moves to Stopped. Nothing is deleted.", OFF_YES: "Yes, turn it off", CANCEL: "Cancel",
 NEEDS_CARD: "You'll add a payment method on the billing provider's secure page first.",
 METHOD_HEADING: "Payment method", NO_METHOD: "No payment method on file.", ADD: "Add a payment method", CHANGE: "Change payment method", REMOVE: "Remove payment method", REMOVE_SURE: "Remove this payment method?", REMOVE_YES: "Yes, remove it",
 SECURE: "Card details are entered on the billing provider's secure page. Rovara never sees them.",
 LIMIT_HEADING: "Monthly limit", LIMIT_NONE: "No monthly limit is set.", LIMIT_HELP: "This limit stays a ceiling on auto-billed use.", LIMIT_LINK: "See the limits on the Spending page",
 CONTACT_HEADING: "Billing contact", CONTACT_HINT: "Invoices are sent to this address.", SAVE: "Save billing contact", PORTAL: "Manage tax details and receipts", PORTAL_HELP: "Opens the billing provider's secure page.",
} as const;

export function AutoBillSection({ state }: { state: BillingState }) {
 const host = useAppHost(), write = useBillingWrite(), [confirm, setConfirm] = useState(false), auto = state.autoBill, reason = unavailableWords(auto.unavailableReason);
 return <section className="rv-tb-card" aria-labelledby="tb-auto"><h2 id="tb-auto">{PAYMENT_WORDS.AUTO_HEADING}</h2>
  <p>{auto.enabled ? PAYMENT_WORDS.AUTO_ON : PAYMENT_WORDS.AUTO_OFF}</p>
  {auto.enabled ? (confirm
   ? <div className="rv-tb-confirm"><p>{PAYMENT_WORDS.OFF_SURE}</p><div className="rv-tb-actions"><Button variant="danger" busy={write.busy} onClick={() => { void write.run({ action: "auto-bill", enabled: false }, "Auto-billing is off.").then(answer => { if (answer !== undefined) setConfirm(false); }); }}>{PAYMENT_WORDS.OFF_YES}</Button><Button variant="quiet" onClick={() => { setConfirm(false); }}>{PAYMENT_WORDS.CANCEL}</Button></div></div>
   : <div><Button onClick={() => { setConfirm(true); }}>{PAYMENT_WORDS.TURN_OFF}</Button></div>)
   : auto.unavailableReason === "no_payment_method" ? <><div><Button variant="primary" busy={write.busy} onClick={() => { void write.run({ action: "payment-method-setup", returnPath: host.currentPath() }, ""); }}>{PAYMENT_WORDS.TURN_ON}</Button></div><p className="rv-muted">{PAYMENT_WORDS.NEEDS_CARD}</p></>
   : !auto.available ? <><div><Button disabled>{PAYMENT_WORDS.TURN_ON}</Button></div><p className="rv-muted">{reason === "" ? "Not available right now." : reason}</p></>
   : <div><Button variant="primary" busy={write.busy} onClick={() => { void write.run({ action: "auto-bill", enabled: true }, "Auto-billing is on."); }}>{PAYMENT_WORDS.TURN_ON}</Button></div>}
  {write.view}
 </section>;
}

export function PaymentMethodSection({ state }: { state: BillingState }) {
 const host = useAppHost(), write = useBillingWrite(), [confirm, setConfirm] = useState(false), method = state.paymentMethod;
 const setup = () => { void write.run({ action: "payment-method-setup", returnPath: host.currentPath() }, ""); };
 return <section className="rv-tb-card" aria-labelledby="tb-method"><h2 id="tb-method">{PAYMENT_WORDS.METHOD_HEADING}</h2>
  {method === null ? <><p>{PAYMENT_WORDS.NO_METHOD}</p><div><Button variant="primary" busy={write.busy} onClick={setup}>{PAYMENT_WORDS.ADD}</Button></div></>
   : <>
    <dl className="rv-tb-facts"><div><dt>On file</dt><dd>{paymentMethodWords(method)}</dd></div>
     {expiryWords(method.expMonth, method.expYear) !== undefined && <div><dt>Expires</dt><dd>{expiryWords(method.expMonth, method.expYear)}</dd></div>}
     <div><dt>Status</dt><dd>{methodStatusWords(method.status)}</dd></div><div><dt>Updated</dt><dd>{dayText(method.updatedAt)}</dd></div></dl>
    {confirm ? <div className="rv-tb-confirm"><p>{PAYMENT_WORDS.REMOVE_SURE}</p><div className="rv-tb-actions"><Button variant="danger" busy={write.busy} onClick={() => { void write.run({ action: "payment-method-remove" }, "The payment method was removed.").then(answer => { if (answer !== undefined) setConfirm(false); }); }}>{PAYMENT_WORDS.REMOVE_YES}</Button><Button variant="quiet" onClick={() => { setConfirm(false); }}>{PAYMENT_WORDS.CANCEL}</Button></div></div>
     : <div className="rv-tb-actions"><Button busy={write.busy} onClick={setup}>{PAYMENT_WORDS.CHANGE}</Button><Button variant="quiet" onClick={() => { setConfirm(true); }}>{PAYMENT_WORDS.REMOVE}</Button></div>}
   </>}
  <p className="rv-muted">{PAYMENT_WORDS.SECURE}</p>
  {write.view}
 </section>;
}

export function LimitSection({ state }: { state: BillingState }) {
 const ceiling = state.autoBill.monthlyCeilingUsd;
 return <section className="rv-tb-card" aria-labelledby="tb-limit"><h2 id="tb-limit">{PAYMENT_WORDS.LIMIT_HEADING}</h2>
  <p>{ceiling === null ? PAYMENT_WORDS.LIMIT_NONE : <>The company's monthly limit is <Usd usd={ceiling} />.</>} {PAYMENT_WORDS.LIMIT_HELP}</p>
  <p><Link to={SPENDING_PATH} className="rv-tb-link">{PAYMENT_WORDS.LIMIT_LINK}</Link></p>
 </section>;
}

export function ContactSection({ state }: { state: BillingState }) {
 const host = useAppHost(), contact = useBillingWrite(), portal = useBillingWrite(), [email, setEmail] = useState(state.billingContact?.email ?? ""), current = state.billingContact?.email ?? "";
 return <section className="rv-tb-card" aria-labelledby="tb-contact"><h2 id="tb-contact">{PAYMENT_WORDS.CONTACT_HEADING}</h2>
  <form className="rv-tb-form" onSubmit={event => { event.preventDefault();void contact.run({ action: "billing-contact", email }, "The billing contact was saved."); }}>
   <TextField label="Billing email" type="email" autoComplete="email" hint={PAYMENT_WORDS.CONTACT_HINT} value={email} onChange={event => { setEmail(event.target.value); }} />
   <div><Button type="submit" busy={contact.busy} disabled={email.trim() === "" || email.trim() === current}>{PAYMENT_WORDS.SAVE}</Button></div>
  </form>
  {contact.view}
  {state.portal.available && <><div><Button busy={portal.busy} onClick={() => { void portal.run({ action: "portal", returnPath: host.currentPath() }, ""); }}>{PAYMENT_WORDS.PORTAL}</Button></div><p className="rv-muted">{PAYMENT_WORDS.PORTAL_HELP}</p>{portal.view}</>}
  {current !== "" && <p className="rv-muted">Current: <VisibleText text={current} /></p>}
 </section>;
}
