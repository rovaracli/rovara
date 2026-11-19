import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLessonsExtrasApi } from "../../../api/lessons-extras.js";
import { learnedKey, useLessonMode } from "../../../api/learned.js";
import { Button } from "../../../design/Button.js";
import { ApiError } from "../../../api/errors.js";
import { useAnnounce } from "../../../design/Announcer.js";

export function TrialOfferCard({ project }: { project: string }) {
 const mode = useLessonMode(project), api = useLessonsExtrasApi(), query = useQueryClient(), [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), announce = useAnnounce();
 const offer = mode.data?.trialOffer;
 if (offer === undefined) return null;
 const total = offer.approvals + offer.drops;
 async function decide(decision: "accept" | "not_now") {
  if (busy) return;setBusy(true);setNotice("");
  try { await api.trial(project, decision);const said = decision === "accept" ? "Learning is now On. Low-risk lessons go live on trial." : "Okay. Rovara won't ask again for 30 days.";setNotice(said);announce(said);await query.invalidateQueries({ queryKey: learnedKey(project) }); }
  catch (failure) { if (failure instanceof ApiError && failure.status === 409) { setNotice("There is no offer to answer now.");announce("There is no offer to answer now.");await query.invalidateQueries({ queryKey: learnedKey(project) }); } else setNotice("That didn't go through. Nothing was changed."); }
  finally { setBusy(false); }
 }
 return <section className="rv-graduation-card" data-testid="trial-offer"><h3>Let low-risk lessons go live on trial?</h3><p>{offer.drops === 0 ? `Your team kept all ${offer.approvals} of the last suggestions.` : `Your team kept ${offer.approvals} of the last ${total} suggestions.`}</p><p>A low-risk lesson from a teammate's own correction would start being used right away, marked On trial. One “Not helpful” takes it out. Everything else still waits for a person.</p><Button variant="primary" busy={busy} onClick={() => { void decide("accept"); }}>Turn on trial</Button><Button variant="quiet" disabled={busy} onClick={() => { void decide("not_now"); }}>Not now</Button>{notice && <p role="status">{notice}</p>}</section>;
}
