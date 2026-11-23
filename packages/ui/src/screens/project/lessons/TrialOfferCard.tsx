import { useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLessonsExtrasApi } from "../../../api/lessons-extras.js";
import { learnedKey, useLessonMode } from "../../../api/learned.js";
import { Button } from "../../../design/Button.js";
import { ApiError } from "../../../api/errors.js";
import { useAnnounce } from "../../../design/Announcer.js";
import { servedReadState } from "../../../api/served-read.js";
import { RECONNECTING_TEXT, WriteRegion } from "../write-freeze.js";

export function TrialOfferCard({ project }: { project: string }) {
 const mode = useLessonMode(project), api = useLessonsExtrasApi(), query = useQueryClient(), [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), announce = useAnnounce();
 const served = servedReadState(mode), offer = served.data?.trialOffer, stale = served.staleSince !== undefined, staleRef = useRef(stale);
 // Rule 14: the answer needs the mode read fresh (and the identity read: WriteRegion + the transport gate); a click in flight when it failed is refused.
 useLayoutEffect(() => { staleRef.current = stale; });
 if (offer === undefined) return null;
 const total = offer.approvals + offer.drops;
 async function decide(decision: "accept" | "not_now") {
  if (busy) return;
  if (staleRef.current) { setNotice(RECONNECTING_TEXT);return; }
  setBusy(true);setNotice("");
  try { await api.trial(project, decision);const said = decision === "accept" ? "Learning is now On. Low-risk lessons go live on trial." : "Okay. Rovara won't ask again for 30 days.";setNotice(said);announce(said);await query.invalidateQueries({ queryKey: learnedKey(project) }); }
  catch (failure) { if (failure instanceof ApiError && failure.status === 409) { setNotice("There is no offer to answer now.");announce("There is no offer to answer now.");await query.invalidateQueries({ queryKey: learnedKey(project) }); } else setNotice("That didn't go through. Reload to check where it stands."); }
  finally { setBusy(false); }
 }
 return <section className="rv-graduation-card" data-testid="trial-offer"><WriteRegion stale={stale}><h3>Let low-risk lessons go live on trial?</h3><p>{offer.drops === 0 ? `Your team kept all ${offer.approvals} of the last suggestions.` : `Your team kept ${offer.approvals} of the last ${total} suggestions.`}</p><p>A low-risk lesson from a teammate's own correction would start being used right away, marked On trial. One “Not helpful” takes it out. Everything else still waits for a person.</p><Button variant="primary" busy={busy} onClick={() => { void decide("accept"); }}>Turn on trial</Button><Button variant="quiet" disabled={busy} onClick={() => { void decide("not_now"); }}>Not now</Button>{notice && <p role="status">{notice}</p>}</WriteRegion></section>;
}
