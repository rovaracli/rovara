import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { NOTIFY_EMAIL_UNAVAILABLE, type NotifyChannel } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../../host.js";
import { notificationsKey, useNotificationPrefs } from "../../api/notifications.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";

const CHOICES: ReadonlyArray<{ value: NotifyChannel; label: string }> = [{ value: "slack", label: "Slack direct message" }, { value: "email", label: "Email" }, { value: "both", label: "Both" }];

/**
 * UX2 slice 2 item 5: your account page's notification setting: how Rovara tells you a task needs you (a decision waiting, blocked, paused for budget, ready to merge, failed, done for tasks you follow).
 * The email's "Stop these emails" link opens this page with `?notify=unsubscribe`, which asks once before it stops them (you are signed in; nothing is changed by opening a link).
 */
export function AccountScreen() {
 const host = useAppHost(), query = useQueryClient(), { api, query: prefs } = useNotificationPrefs();
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [saved, setSaved] = useState<string>();
 const asksUnsubscribe = new URLSearchParams(host.currentPath().split("?")[1]?.split("#")[0] ?? "").get("notify") === "unsubscribe";
 async function save(body: Parameters<typeof api.save>[0], said: string) {
  setBusy(true);setError(undefined);setSaved(undefined);
  try { query.setQueryData(notificationsKey, await api.save(body));setSaved(said); }
  catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't save that. Try again."); }
  finally { setBusy(false); }
 }
 const view = prefs.data;
 return <section className="rv-account"><PageHeader focusOnMount title="Your account" />
  <section id="notifications" aria-label="How you're notified"><h2>How you're notified</h2>
   <p className="rv-muted">When a task needs you (a decision waiting, a block, a budget pause, ready to merge, a failure) or a task you follow is done.</p>
   {prefs.isPending && <Skeleton label="Loading your setting" />}
   {prefs.isError && <p role="alert">Couldn't load your setting. Try again.</p>}
   {view !== undefined && <>
    {asksUnsubscribe && view.effective.email && <div className="rv-banner rv-banner-warning" role="region" aria-label="Stop these emails"><p>Stop the task emails? Slack direct messages, if you have them, keep coming, and Home still lists what needs you.</p><Button busy={busy} onClick={() => { void save({ emailUnsubscribed: true }, "Task emails stopped."); }}>Stop these emails</Button></div>}
    <fieldset className="rv-notify-options"><legend>Tell me by</legend>
     {CHOICES.map(choice => { const off = choice.value !== "slack" && !view.emailAvailable, slackOff = choice.value === "slack" && !view.slackLinked;return <label key={choice.value}><input type="radio" name="notify-channel" value={choice.value} checked={view.channel === choice.value} disabled={busy || off} onChange={() => { void save({ channel: choice.value }, "Saved."); }} /> {choice.label}{off ? " (unavailable)" : slackOff ? " (link your Slack first)" : ""}</label>; })}
    </fieldset>
    {!view.emailAvailable && <p className="rv-muted"><VisibleText text={NOTIFY_EMAIL_UNAVAILABLE} /></p>}
    {view.emailUnsubscribed && <p className="rv-muted">You stopped the task emails. Choose Email or Both to get them again.</p>}
    <p className="rv-muted">{view.effective.slack && view.effective.email ? "Messages go to Slack and email." : view.effective.slack ? "Messages go to Slack." : view.effective.email ? "Messages go to email." : "No messages can reach you now; Home still lists what needs you."}</p>
   </>}
   {error && <p role="alert"><VisibleText text={error} /></p>}
   {saved && <p role="status"><VisibleText text={saved} /></p>}
  </section>
 </section>;
}
