import { Link } from "react-router";
import { ApiError } from "../../api/errors.js";
import { useAdminNames, useTrial } from "../../api/trial-billing.js";
import { Button } from "../../design/Button.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { TrialCard } from "./TrialCard.js";
import { TrialChoices } from "./TrialChoices.js";
import { BILLING_PAGE_PATH, phaseWords } from "./trial-logic.js";
import "./trial-billing.css";

export const TRIAL_SCREEN_WORDS = { NONE: "There is no trial or plan to show on this install.", LOAD_FAILED: "Couldn't load your trial. Try again.", RETRY: "Try again", BILLING: "Open Billing settings" } as const;

/**
 * The trial page, for every member (switch `rovara.billing` = "v2"): the state of the trial in plain words, the allowance, and what happens when it runs out. Everyone affected sees the choices; owners and admins
 * choose; everyone else sees "Ask an admin". Everything the server decides comes from `GET /v1/app/trial`.
 */
export function TrialScreen() {
 const read = useTrial(), admins = useAdminNames(read.data?.you.canChoose === false && read.data.choices !== null);
 if (read.isPending) return <section aria-label="Your trial" aria-busy="true"><Skeleton label="Loading your trial" /></section>;
 if (read.error instanceof ApiError && read.error.status === 404) return <section><PageHeader focusOnMount title="Your trial" /><p role="status">{TRIAL_SCREEN_WORDS.NONE}</p></section>;
 if (read.data === undefined) return <section><PageHeader focusOnMount title="Your trial" /><p role="alert"><VisibleText text={read.error instanceof ApiError ? read.error.message : TRIAL_SCREEN_WORDS.LOAD_FAILED} /></p><div><Button onClick={() => { void read.refetch(); }}>{TRIAL_SCREEN_WORDS.RETRY}</Button></div></section>;
 const trial = read.data, words = phaseWords(trial.phase, trial.plan);
 return <section aria-label="Your trial" className="rv-tb"><PageHeader focusOnMount title={trial.plan === "team" ? "Your plan" : "Your trial"} description={words.text} />
  <p className="rv-tb-phase" role="status"><strong>{words.heading}.</strong></p>
  <TrialCard trial={trial} />
  <TrialChoices trial={trial} admins={admins.data ?? []} />
  {trial.you.canChoose && <p><Link to={BILLING_PAGE_PATH} className="rv-tb-link">{TRIAL_SCREEN_WORDS.BILLING}</Link></p>}
 </section>;
}
