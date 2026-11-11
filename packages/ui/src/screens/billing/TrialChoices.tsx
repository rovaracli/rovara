// What happens when the allowance runs out. Everyone the server tells sees the same choices and facts. Only owners and admins (`you.canChoose`) get buttons; everyone else sees "Ask an admin", with the names of the
// company's owners and admins that the same answer carries (`admins`). The sentences about each option come from the server; a reason an option is unavailable is a fixed code that this page turns into words.
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { navigatePath, type ChoiceSet, type TrialView } from "../../api/trial-billing.js";
import { safeAppPath } from "../../text/links.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { dayText } from "./format.js";
import { choiceWords, decidedWords, MODELS_PATH, unavailableWords } from "./trial-logic.js";
import { useBillingWrite } from "./use-billing-write.js";

type Option = ChoiceSet["options"][number];
export const CHOICES_WORDS = {
 HEADING: "What happens when the allowance runs out",
 YOU: "You're seeing this because your work reached the allowance.",
 ADMINS: "You're seeing this because you can decide for the company.",
 ASK: "Ask an admin.",
 ASK_WHY: "Only company owners and admins can choose.",
 STOP_SURE: "Stop work on Rovara-provided models? Nothing is deleted.",
 STOP_YES: "Yes, stop",
 CANCEL: "Cancel",
 ADD_CARD: "Add a payment method",
 NEEDS_CARD: "You'll add a payment method on the billing provider's secure page first.",
 OPEN_MODELS: "Open AI models",
} as const;

function OptionRow({ option, trial }: { option: Option; trial: TrialView }) {
 const host = useAppHost(), navigate = useNavigate(), write = useBillingWrite(), [confirm, setConfirm] = useState(false), canChoose = trial.you.canChoose;
 const reason = unavailableWords(option.unavailableReason);
 const body = (() => {
  if (!canChoose) return reason === "" ? null : <p className="rv-muted">{reason}</p>;
  if (option.id === "stop") {
   if (!option.available) return <><Button disabled>{choiceWords("stop")}</Button><p className="rv-muted">{reason}</p></>;
   if (!confirm) return <Button onClick={() => { setConfirm(true); }}>{choiceWords("stop")}</Button>;
   return <div className="rv-tb-confirm"><p>{CHOICES_WORDS.STOP_SURE}</p><div className="rv-tb-actions"><Button variant="danger" busy={write.busy} onClick={() => { void write.run({ action: "choose-trial-end", choice: "stop" }, "Done. Work on Rovara-provided models is stopped.").then(answer => { if (answer !== undefined) setConfirm(false); }); }}>{CHOICES_WORDS.STOP_YES}</Button><Button variant="quiet" onClick={() => { setConfirm(false); }}>{CHOICES_WORDS.CANCEL}</Button></div></div>;
  }
  if (option.id === "auto_bill") {
   if (option.unavailableReason === "no_payment_method") return <><Button variant="primary" busy={write.busy} onClick={() => { void write.run({ action: "payment-method-setup", returnPath: host.currentPath() }, ""); }}>{CHOICES_WORDS.ADD_CARD}</Button><p className="rv-muted">{CHOICES_WORDS.NEEDS_CARD}</p></>;
   if (!option.available) return <><Button disabled>{choiceWords("auto_bill")}</Button><p className="rv-muted">{reason}</p></>;
   return <Button variant="primary" busy={write.busy} onClick={() => { void write.run({ action: "choose-trial-end", choice: "auto_bill" }, "Done. Auto-billing is on."); }}>{choiceWords("auto_bill")}</Button>;
  }
  if (option.id === "own_key") {
   // The server names the page (`next`, and the answer's `navigate`); `next` is optional in the contract, so a safe fallback stays.
   const href = option.next !== undefined && typeof option.next.href === "string" && safeAppPath(option.next.href) ? option.next.href : MODELS_PATH;
   if (!option.available) return <><Button disabled>{choiceWords("own_key")}</Button><p className="rv-muted">{reason}</p></>;
   return <><Button busy={write.busy} onClick={() => { void write.run({ action: "choose-trial-end", choice: "own_key" }, "Done.").then(answer => { if (answer !== undefined) void navigate(navigatePath(answer) ?? href); }); }}>{choiceWords("own_key")}</Button>{write.failed && <p><Link to={href}>{CHOICES_WORDS.OPEN_MODELS}</Link></p>}</>;
  }
  return null;
 })();
 return <li className="rv-tb-choice" data-option={option.id}><h3>{choiceWords(option.id)}</h3><p><VisibleText text={option.summary} /></p>{body}{write.view}</li>;
}

const askLine = (admins: TrialView["admins"]) => <p className="rv-tb-ask"><strong>{CHOICES_WORDS.ASK}</strong> {CHOICES_WORDS.ASK_WHY}{admins.length > 0 && <> Owners and admins: {admins.map((person, index) => <span key={`${person.id}-${String(index)}`}>{index > 0 && ", "}<VisibleText text={person.name} /></span>)}.</>}</p>;

/** The caller's own monthly limit is used up (the company may still have room). The sentence is the server's; "Ask an admin" and the names come from the same answer (`admins`). Owners and admins can choose themselves, so they are not told to ask. */
export function PersonalLimitNotice({ trial }: { trial: TrialView }) {
 const notice = trial.you.notice;
 if (notice === null) return null;
 return <section className="rv-tb-card" aria-labelledby="tb-personal"><h2 id="tb-personal">Your personal limit</h2><p role="status"><VisibleText text={notice.text} /></p>{!trial.you.canChoose && askLine(trial.admins)}</section>;
}

export function TrialChoices({ trial }: { trial: TrialView }) {
 const choices = trial.choices;
 if (choices === null) return null;
 return <section className="rv-tb-card" aria-labelledby="tb-choices">
  <h2 id="tb-choices">{CHOICES_WORDS.HEADING}</h2>
  <p>{choices.audience === "you" ? CHOICES_WORDS.YOU : choices.audience === "admins" ? CHOICES_WORDS.ADMINS : ""}</p>
  {choices.decided !== null && <p role="status"><strong>Chosen: {decidedWords(choices.decided.choice)}.</strong> By <VisibleText text={choices.decided.by.name} /> on {dayText(choices.decided.at)}.</p>}
  <ul className="rv-tb-choices" aria-label="Choices">{choices.options.map(option => <OptionRow key={option.id} option={option} trial={trial} />)}</ul>
  {!trial.you.canChoose && trial.you.notice === null && askLine(trial.admins)}
 </section>;
}
